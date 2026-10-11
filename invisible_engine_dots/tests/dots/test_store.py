"""The Dot's database: the outbox, inbound events, the task queue, intents, approvals, decisions, transcripts."""

from __future__ import annotations

import json
import re
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fakes.store_queries import last_seq

from nanobot.dots import store as s
from nanobot.dots.store import DotStore, StoreOwnedError

TS = "2026-10-04T10:00:00.000Z"


def inbound(inbound_id: str, type_: str = "user.message", data: dict | None = None) -> dict:
    return {"id": inbound_id, "type": type_, "ts": TS, "data": data if data is not None else {"text": inbound_id}}


class TestOpen:
    def test_creates_the_parent_directory_and_the_tables(self, tmp_path: Path) -> None:
        store = DotStore.open(tmp_path / "a" / "b" / "engine.sqlite")
        try:
            names = store.read(
                lambda c: {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
            )
        finally:
            store.close()
        assert {
            "dots_outbox",
            "dots_inbound",
            "dots_tasks",
            "dots_tool_intents",
            "dots_spend",
            "dots_browser_identities",
            "dots_kv",
            "dots_approvals",
            "dots_tool_decisions",
            "sessions",
            "messages",
        } <= names

    def test_every_table_is_strict(self, dot_store: DotStore) -> None:
        rows = dot_store.read(lambda c: c.execute("PRAGMA table_list").fetchall())
        user_tables = [r for r in rows if r["schema"] == "main" and not r["name"].startswith("sqlite_")]
        assert len(user_tables) == 11
        assert all(r["strict"] == 1 for r in user_tables)

    def test_the_connection_is_wal_full_and_exclusive(self, dot_store: DotStore) -> None:
        def pragmas(c: sqlite3.Connection) -> tuple[str, int, str]:
            return (
                c.execute("PRAGMA journal_mode").fetchone()[0],
                c.execute("PRAGMA synchronous").fetchone()[0],
                c.execute("PRAGMA locking_mode").fetchone()[0],
            )

        assert dot_store.read(pragmas) == ("wal", 2, "exclusive")

    def test_reopening_after_close_keeps_the_rows(self, tmp_path: Path) -> None:
        path = tmp_path / "engine.sqlite"
        first = DotStore.open(path)
        first.write(lambda c: s.append_outbox(c, "agent.started", {}))
        first.close()
        second = DotStore.open(path)
        try:
            assert second.read(last_seq) == 1
        finally:
            second.close()

    def test_a_second_open_on_the_same_file_fails_naming_the_owner(self, tmp_path: Path) -> None:
        path = tmp_path / "engine.sqlite"
        first = DotStore.open(path)
        try:
            with pytest.raises(StoreOwnedError, match=re.escape(f"another engine owns {path}")):
                DotStore.open(path, open_timeout_s=0)
            # The owner is not disturbed by the attempt.
            first.write(lambda c: s.append_outbox(c, "agent.started", {}))
            assert first.read(last_seq) == 1
        finally:
            first.close()

    def test_the_file_is_free_again_once_the_owner_closes(self, tmp_path: Path) -> None:
        path = tmp_path / "engine.sqlite"
        DotStore.open(path).close()
        DotStore.open(path, open_timeout_s=0).close()

    @pytest.mark.parametrize("round_", range(3))
    def test_of_two_engines_opening_one_file_at_once_exactly_one_wins(self, tmp_path: Path, round_: int) -> None:
        # Two processes released at the same instant on a fresh file: the loser is refused as owned, not both.
        # A winner keeps its store open until stdin closes, so the loser meets a held file.
        child = "\n".join(
            [
                "import sys, time",
                "from nanobot.dots import store as s",
                "from nanobot.dots.store import DotStore, StoreOwnedError",
                "start = float(sys.argv[2])",
                "while time.time() < start: pass",
                "try:",
                "    store = DotStore.open(sys.argv[1], open_timeout_s=0.5)",
                "except StoreOwnedError:",
                "    print('owned', flush=True); sys.exit(0)",
                "print('won', flush=True)",
                "sys.stdin.read()",
                "store.close()",
            ]
        )
        path = tmp_path / "engine.sqlite"
        start = time.time() + 1.5
        procs = [
            subprocess.Popen(
                [sys.executable, "-c", child, str(path), str(start)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                text=True,
            )
            for _ in range(2)
        ]
        try:
            results = sorted(proc.stdout.readline().strip() for proc in procs)  # type: ignore[union-attr]
        finally:
            for proc in procs:
                proc.stdin.close()  # type: ignore[union-attr]
            for proc in procs:
                proc.wait(timeout=30)
        assert results == ["owned", "won"]

    def test_a_closed_store_refuses_work(self, tmp_path: Path) -> None:
        store = DotStore.open(tmp_path / "engine.sqlite")
        store.close()
        store.close()
        with pytest.raises(RuntimeError, match="is closed"):
            store.read(last_seq)


class TestOutbox:
    def test_numbers_events_in_commit_order_and_reads_them_back_after_a_seq(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.append_outbox(c, "agent.started", {}))
        dot_store.write(lambda c: s.append_outbox(c, "agent.state", {"state": "IDLE"}))
        dot_store.write(lambda c: s.append_outbox(c, "message.assistant", {"text": "hi"}))
        events = dot_store.read(lambda c: s.read_outbox_after(c, 0, 10))
        assert [e["seq"] for e in events] == [1, 2, 3]
        assert [e["type"] for e in events] == ["agent.started", "agent.state", "message.assistant"]
        assert [e["data"] for e in dot_store.read(lambda c: s.read_outbox_after(c, 2, 10))] == [{"text": "hi"}]
        assert len(dot_store.read(lambda c: s.read_outbox_after(c, 0, 2))) == 2
        assert dot_store.read(last_seq) == 3

    def test_writes_nothing_for_a_transaction_that_rolls_back_and_never_reuses_a_committed_seq(
        self, dot_store: DotStore
    ) -> None:
        dot_store.write(lambda c: s.append_outbox(c, "agent.started", {}))

        def failing(c: sqlite3.Connection) -> None:
            s.append_outbox(c, "agent.state", {"state": "THINKING"})
            raise RuntimeError("boom")

        with pytest.raises(RuntimeError, match="boom"):
            dot_store.write(failing)
        assert [e["seq"] for e in dot_store.read(lambda c: s.read_outbox_after(c, 0, 10))] == [1]
        dot_store.write(lambda c: s.append_outbox(c, "agent.state", {"state": "IDLE"}))
        dot_store.write(lambda c: c.execute("DELETE FROM dots_outbox WHERE seq = 2"))
        assert dot_store.write(lambda c: s.append_outbox(c, "agent.state", {"state": "DONE"}))["seq"] == 3

    def test_an_event_has_an_id_and_a_utc_timestamp_with_milliseconds(self, dot_store: DotStore) -> None:
        moment = datetime(2026, 10, 4, 12, 30, 5, 123456, tzinfo=timezone.utc)
        event = dot_store.write(lambda c: s.append_outbox(c, "agent.started", {"a": 1}, now=moment))
        assert event["ts"] == "2026-10-04T12:30:05.123Z"
        assert event["data"] == {"a": 1}
        assert len(event["id"]) == 36
        stored = dot_store.read(lambda c: s.read_outbox_after(c, 0, 1))[0]
        assert stored == event

    def test_refuses_a_type_the_host_does_not_know(self, dot_store: DotStore) -> None:
        with pytest.raises(ValueError, match="not an outbound event type"):
            dot_store.write(lambda c: s.append_outbox(c, "user.message", {}))
        assert dot_store.read(last_seq) == 0

    def test_keeps_non_ascii_text_and_lone_surrogates(self, dot_store: DotStore) -> None:
        text = "caf\u00e9 \u4e2d\u6587 \ud800"
        dot_store.write(lambda c: s.append_outbox(c, "message.assistant", {"text": text}))
        assert dot_store.read(lambda c: s.read_outbox_after(c, 0, 1))[0]["data"]["text"] == text

    def test_records_an_agent_state_once_and_again_only_when_forced(self, dot_store: DotStore) -> None:
        assert dot_store.write(lambda c: s.record_agent_state(c, "IDLE")) is True
        assert dot_store.write(lambda c: s.record_agent_state(c, "IDLE")) is False
        assert dot_store.write(lambda c: s.record_agent_state(c, "IDLE", force=True)) is True
        assert len(dot_store.read(lambda c: s.read_outbox_after(c, 0, 10))) == 2
        assert dot_store.read(lambda c: s.read_kv(c, s.KV_AGENT_STATE)) == "IDLE"

    def test_refuses_a_state_the_host_does_not_know(self, dot_store: DotStore) -> None:
        with pytest.raises(ValueError, match="not an agent state"):
            dot_store.write(lambda c: s.record_agent_state(c, "SLEEPING"))


class TestOutboxListeners:
    def test_is_called_once_after_a_commit_that_added_rows(self, dot_store: DotStore) -> None:
        calls: list[int] = []
        dot_store.on_append(lambda: calls.append(dot_store.read(last_seq)))

        def two_events(c: sqlite3.Connection) -> None:
            s.append_outbox(c, "agent.started", {})
            s.append_outbox(c, "agent.state", {"state": "IDLE"})

        dot_store.write(two_events)
        # The listener runs after the commit: it sees both rows, and runs once.
        assert calls == [2]

    def test_is_not_called_for_a_commit_that_added_none_or_that_rolled_back(self, dot_store: DotStore) -> None:
        calls: list[int] = []
        dot_store.on_append(lambda: calls.append(1))
        dot_store.write(lambda c: s.write_kv(c, "k", 1))

        def failing(c: sqlite3.Connection) -> None:
            s.append_outbox(c, "agent.started", {})
            raise RuntimeError("boom")

        with pytest.raises(RuntimeError):
            dot_store.write(failing)
        assert calls == []

    def test_a_failing_listener_does_not_break_the_write_or_the_others(self, dot_store: DotStore) -> None:
        calls: list[str] = []

        def broken() -> None:
            raise RuntimeError("listener bug")

        dot_store.on_append(broken)
        dot_store.on_append(lambda: calls.append("second"))
        event = dot_store.write(lambda c: s.append_outbox(c, "agent.started", {}))
        assert event["seq"] == 1
        assert calls == ["second"]

    def test_a_removed_listener_is_not_called(self, dot_store: DotStore) -> None:
        calls: list[int] = []
        remove = dot_store.on_append(lambda: calls.append(1))
        remove()
        remove()
        dot_store.write(lambda c: s.append_outbox(c, "agent.started", {}))
        assert calls == []


class TestWrite:
    def test_a_write_inside_a_write_is_refused(self, dot_store: DotStore) -> None:
        with pytest.raises(sqlite3.OperationalError, match="within a transaction"):
            dot_store.write(lambda c: dot_store.write(lambda c2: None))
        # The outer transaction is rolled back and the store still works.
        assert dot_store.write(lambda c: 5) == 5

    def test_returns_what_the_function_returns(self, dot_store: DotStore) -> None:
        assert dot_store.write(lambda c: "result") == "result"

    def test_a_base_exception_rolls_back_too(self, dot_store: DotStore) -> None:
        def cancelled(c: sqlite3.Connection) -> None:
            s.append_outbox(c, "agent.started", {})
            raise KeyboardInterrupt

        with pytest.raises(KeyboardInterrupt):
            dot_store.write(cancelled)
        assert dot_store.read(last_seq) == 0

    def test_a_checkpoint_empties_the_wal(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.append_outbox(c, "agent.started", {}))
        dot_store.checkpoint()
        wal = Path(str(dot_store.path) + "-wal")
        assert not wal.exists() or wal.stat().st_size == 0


class TestInbound:
    def test_accepts_an_event_id_once(self, dot_store: DotStore) -> None:
        event = inbound("e1", data={"text": "hello"})
        assert dot_store.write(lambda c: s.record_inbound(c, event, "accepted")) is True
        assert dot_store.write(lambda c: s.record_inbound(c, event, "accepted")) is False
        rows = dot_store.read(lambda c: s.list_inbound(c, "accepted"))
        assert [r.id for r in rows] == ["e1"]
        assert rows[0].data == {"text": "hello"} and rows[0].type == "user.message" and rows[0].ts == TS

    def test_moves_a_user_message_to_the_transcript_then_applies_every_one_the_transcript_holds(
        self, dot_store: DotStore
    ) -> None:
        for inbound_id in ("a", "b", "c"):
            dot_store.write(lambda c, i=inbound_id: s.record_inbound(c, inbound(i), "accepted"))
        assert dot_store.write(lambda c: s.mark_inbound_in_transcript(c, "a")) is True
        assert dot_store.write(lambda c: s.mark_inbound_in_transcript(c, "a")) is False
        assert dot_store.write(lambda c: s.mark_inbound_in_transcript(c, "b")) is True
        assert dot_store.write(s.apply_answered_inputs) == ["a", "b"]
        assert [r.id for r in dot_store.read(lambda c: s.list_inbound(c, "applied"))] == ["a", "b"]
        assert [r.id for r in dot_store.read(lambda c: s.list_inbound(c, "accepted"))] == ["c"]
        assert dot_store.write(s.apply_answered_inputs) == []

    def test_does_not_move_other_inbound_types_to_the_transcript(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.record_inbound(c, inbound("x", "approval.received", {}), "accepted"))
        assert dot_store.write(lambda c: s.mark_inbound_in_transcript(c, "x")) is False

    def test_an_automation_firing_is_applied_with_the_messages_but_never_named(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.record_inbound(c, inbound("m1"), "accepted"))
        dot_store.write(lambda c: s.record_inbound(c, inbound("cron:j:1", "automation.fired", {"name": "n"}), "accepted"))
        assert dot_store.write(lambda c: s.mark_inbound_in_transcript(c, "cron:j:1")) is True
        assert dot_store.write(lambda c: s.mark_inbound_in_transcript(c, "m1")) is True
        assert dot_store.write(s.apply_answered_inputs) == ["m1"]
        assert [r.id for r in dot_store.read(lambda c: s.list_inbound(c, "applied"))] == ["m1", "cron:j:1"]

    def test_an_automation_alone_applies_and_names_nobody(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.record_inbound(c, inbound("cron:j:2", "automation.fired", {}), "accepted"))
        dot_store.write(lambda c: s.mark_inbound_in_transcript(c, "cron:j:2"))
        assert dot_store.write(s.apply_answered_inputs) == []
        assert [r.id for r in dot_store.read(lambda c: s.list_inbound(c, "applied"))] == ["cron:j:2"]

    def test_lists_in_the_order_they_were_accepted(self, dot_store: DotStore) -> None:
        for inbound_id in ("z", "a", "m"):
            dot_store.write(lambda c, i=inbound_id: s.record_inbound(c, inbound(i), "accepted"))
        assert [r.id for r in dot_store.read(lambda c: s.list_inbound(c, "accepted"))] == ["z", "a", "m"]

    def test_refuses_a_type_it_does_not_store(self, dot_store: DotStore) -> None:
        with pytest.raises(ValueError, match="not an inbound event type"):
            dot_store.write(lambda c: s.record_inbound(c, inbound("x", "message.assistant", {}), "accepted"))

    def test_an_event_recorded_as_applied_has_its_time(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.record_inbound(c, inbound("e"), "applied", now_ms=1234))
        row = dot_store.read(lambda c: c.execute("SELECT accepted_at, applied_at FROM dots_inbound").fetchone())
        assert (row["accepted_at"], row["applied_at"]) == (1234, 1234)


class TestTasks:
    def test_runs_the_highest_priority_first_then_the_oldest(self, dot_store: DotStore) -> None:
        def enqueue(task_id: str, priority: int, description: str = "d") -> bool:
            return dot_store.write(
                lambda c: s.enqueue_task(c, task_id=task_id, description=description, priority=priority)
            )

        enqueue("low", 0)
        enqueue("high-old", 5)
        enqueue("high-new", 5)
        assert enqueue("low", 9, "again") is False
        assert dot_store.read(s.next_queued_task).task_id == "high-old"
        dot_store.write(lambda c: s.start_task(c, "high-old"))
        assert dot_store.read(s.next_queued_task).task_id == "high-new"
        started = dot_store.read(lambda c: s.get_task(c, "high-old"))
        assert (started.status, started.attempts) == ("running", 1)
        assert dot_store.read(lambda c: s.get_task_by_session(c, s.task_session_key("low"))).task_id == "low"
        assert dot_store.read(lambda c: s.get_task(c, "low")).description == "d"
        assert dot_store.read(s.get_running_task).task_id == "high-old"

    def test_there_is_no_next_task_and_no_running_task_in_an_empty_queue(self, dot_store: DotStore) -> None:
        assert dot_store.read(s.next_queued_task) is None
        assert dot_store.read(s.get_running_task) is None
        assert dot_store.read(lambda c: s.get_task(c, "nope")) is None
        assert dot_store.read(lambda c: s.get_task_by_session(c, "task:nope")) is None

    def test_ends_a_task_once(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.enqueue_task(c, task_id="t", description="d", priority=0))
        dot_store.write(lambda c: s.start_task(c, "t"))
        assert dot_store.write(lambda c: s.finish_task(c, "t", "cancelled")) is True
        assert dot_store.write(lambda c: s.finish_task(c, "t", "completed", summary="late")) is False
        assert dot_store.read(lambda c: s.get_task(c, "t")).status == "cancelled"

    def test_a_queued_task_can_be_cancelled(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.enqueue_task(c, task_id="t", description="d", priority=0))
        assert dot_store.write(lambda c: s.finish_task(c, "t", "cancelled")) is True

    def test_a_completion_needs_a_summary_and_a_failure_an_error(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.enqueue_task(c, task_id="t", description="d", priority=0))
        with pytest.raises(ValueError, match="summary"):
            dot_store.write(lambda c: s.finish_task(c, "t", "completed"))
        with pytest.raises(ValueError, match="error"):
            dot_store.write(lambda c: s.finish_task(c, "t", "failed"))
        assert dot_store.write(lambda c: s.finish_task(c, "t", "failed", error="it broke")) is True
        row = dot_store.read(lambda c: c.execute("SELECT status, summary, error FROM dots_tasks").fetchone())
        assert (row["status"], row["summary"], row["error"]) == ("failed", None, "it broke")

    def test_gives_back_an_attempt_abandoned_by_a_sleep(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.enqueue_task(c, task_id="t", description="d", priority=0))
        dot_store.write(lambda c: s.start_task(c, "t"))
        dot_store.write(lambda c: s.uncount_task_attempt(c, "t"))
        assert dot_store.read(lambda c: s.get_task(c, "t")).attempts == 0
        dot_store.write(lambda c: s.uncount_task_attempt(c, "t"))
        assert dot_store.read(lambda c: s.get_task(c, "t")).attempts == 0

    def test_every_start_counts_an_attempt(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.enqueue_task(c, task_id="t", description="d", priority=0))
        for expected in (1, 2, 3):
            dot_store.write(lambda c: s.start_task(c, "t"))
            assert dot_store.read(lambda c: s.get_task(c, "t")).attempts == expected


class TestKv:
    def test_reads_back_what_was_written_and_a_default_when_missing(self, dot_store: DotStore) -> None:
        assert dot_store.read(lambda c: s.read_kv(c, "k")) is None
        assert dot_store.read(lambda c: s.read_kv(c, "k", "fallback")) == "fallback"
        dot_store.write(lambda c: s.write_kv(c, "k", {"a": [1, 2]}))
        dot_store.write(lambda c: s.write_kv(c, "k", {"a": [3]}))
        assert dot_store.read(lambda c: s.read_kv(c, "k")) == {"a": [3]}


class TestSpend:
    def test_a_session_that_spent_nothing_has_spent_zero(self, dot_store: DotStore) -> None:
        assert dot_store.read(lambda c: s.get_spend(c, "task:t1")) == 0.0

    def test_adding_returns_the_total_and_keeps_the_sessions_apart(self, dot_store: DotStore) -> None:
        assert dot_store.write(lambda c: s.add_spend(c, "task:t1", 0.25)) == 0.25
        assert dot_store.write(lambda c: s.add_spend(c, "task:t1", 0.5)) == 0.75
        assert dot_store.write(lambda c: s.add_spend(c, "chat", 0.125)) == 0.125
        assert dot_store.read(lambda c: s.get_spend(c, "task:t1")) == 0.75
        assert dot_store.read(lambda c: s.get_spend(c, "chat")) == 0.125

    def test_resetting_one_session_leaves_the_others(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.add_spend(c, "task:t1", 0.75))
        dot_store.write(lambda c: s.add_spend(c, "chat", 0.125))
        dot_store.write(lambda c: s.reset_spend(c, "chat"))
        assert dot_store.read(lambda c: s.get_spend(c, "chat")) == 0.0
        assert dot_store.read(lambda c: s.get_spend(c, "task:t1")) == 0.75
        # Nothing to reset is no error.
        dot_store.write(lambda c: s.reset_spend(c, "never"))

    def test_an_event_that_reports_spend_carries_the_spend_of_its_session_read_at_that_moment(
        self, dot_store: DotStore
    ) -> None:
        dot_store.write(lambda c: s.add_spend(c, "task:t1", 0.25))
        dot_store.write(lambda c: s.add_spend(c, "chat", 0.125))
        first = dot_store.write(
            lambda c: s.append_outbox_spent(c, "task.progress", {"task_id": "t1", "text": "x"}, "task:t1")
        )
        dot_store.write(lambda c: s.add_spend(c, "task:t1", 0.5))
        second = dot_store.write(
            lambda c: s.append_outbox_spent(c, "task.completed", {"task_id": "t1", "summary": "y"}, "task:t1")
        )
        chat = dot_store.write(lambda c: s.append_outbox_spent(c, "message.assistant", {"text": "z"}, "chat"))
        assert first["data"] == {"task_id": "t1", "text": "x", "spent_usd": 0.25}
        assert second["data"] == {"task_id": "t1", "summary": "y", "spent_usd": 0.75}
        assert chat["data"] == {"text": "z", "spent_usd": 0.125}
        stored = dot_store.read(lambda c: s.read_outbox_after(c, 0, 10))
        assert [e["data"]["spent_usd"] for e in stored] == [0.25, 0.75, 0.125]

    def test_an_answer_of_the_chat_takes_its_spend_with_it_and_a_task_event_leaves_the_spend_of_its_task(
        self, dot_store: DotStore
    ) -> None:
        dot_store.write(lambda c: s.add_spend(c, "chat", 0.25))
        dot_store.write(lambda c: s.add_spend(c, "task:t1", 0.5))
        dot_store.write(lambda c: s.append_outbox_spent(c, "task.progress", {"task_id": "t1", "text": "x"}, "task:t1"))
        dot_store.write(lambda c: s.add_spend(c, "chat", 0.125))
        first = dot_store.write(lambda c: s.append_outbox_spent(c, "message.assistant", {"text": "a"}, "chat"))
        second = dot_store.write(lambda c: s.append_outbox_spent(c, "message.assistant", {"text": "b"}, "chat"))
        assert (first["data"]["spent_usd"], second["data"]["spent_usd"]) == (0.375, 0.0)
        assert dot_store.read(lambda c: s.get_spend(c, "chat")) == 0.0
        assert dot_store.read(lambda c: s.get_spend(c, "task:t1")) == 0.5

    def test_a_session_that_spent_nothing_reports_zero_and_the_sum_shows_no_float_noise(
        self, dot_store: DotStore
    ) -> None:
        zero = dot_store.write(lambda c: s.append_outbox_spent(c, "message.assistant", {"text": "a"}, "chat"))
        assert zero["data"]["spent_usd"] == 0.0
        for usd in (0.1, 0.2):
            dot_store.write(lambda c, usd=usd: s.add_spend(c, "task:t1", usd))
        total = dot_store.write(
            lambda c: s.append_outbox_spent(c, "task.failed", {"task_id": "t1", "error": "e"}, "task:t1")
        )
        assert total["data"]["spent_usd"] == 0.3

    @pytest.mark.parametrize("event_type", ["tool.called", "task.started", "agent.state"])
    def test_an_event_that_does_not_report_spend_is_refused(self, dot_store: DotStore, event_type: str) -> None:
        with pytest.raises(ValueError, match="not an event that reports spend"):
            dot_store.write(lambda c: s.append_outbox_spent(c, event_type, {}, "chat"))
        assert dot_store.read(lambda c: s.read_outbox_after(c, 0, 10)) == []

    def test_the_spend_is_there_after_the_file_is_opened_again(self, tmp_path: Path) -> None:
        path = tmp_path / "engine.sqlite"
        first = DotStore.open(path)
        first.write(lambda c: s.add_spend(c, "task:t1", 0.4))
        first.close()
        second = DotStore.open(path)
        try:
            assert second.read(lambda c: s.get_spend(c, "task:t1")) == 0.4
        finally:
            second.close()

    def test_a_request_with_no_cost_is_noted_on_its_session_and_only_there(self, dot_store: DotStore) -> None:
        assert dot_store.read(lambda c: s.has_unpriced(c, "task:t1")) is False
        dot_store.write(lambda c: s.add_spend(c, "task:t1", 0.25))
        dot_store.write(lambda c: s.note_unpriced(c, "task:t1"))
        dot_store.write(lambda c: s.note_unpriced(c, "task:t1"))
        # What was spent stays, and the note does not belong to the other sessions.
        assert dot_store.read(lambda c: s.get_spend(c, "task:t1")) == 0.25
        assert dot_store.read(lambda c: s.has_unpriced(c, "task:t1")) is True
        assert dot_store.read(lambda c: s.has_unpriced(c, "chat")) is False
        # Money added after the note does not clear it.
        dot_store.write(lambda c: s.add_spend(c, "task:t1", 0.5))
        assert dot_store.read(lambda c: s.has_unpriced(c, "task:t1")) is True

    def test_a_note_on_a_session_that_spent_nothing_leaves_its_spend_at_zero(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.note_unpriced(c, "chat"))
        assert dot_store.read(lambda c: s.get_spend(c, "chat")) == 0.0
        assert dot_store.read(lambda c: s.has_unpriced(c, "chat")) is True

    def test_an_answer_of_the_chat_takes_the_note_with_it_and_a_task_event_leaves_the_note_of_its_task(
        self, dot_store: DotStore
    ) -> None:
        dot_store.write(lambda c: s.note_unpriced(c, "chat"))
        dot_store.write(lambda c: s.note_unpriced(c, "task:t1"))
        dot_store.write(lambda c: s.append_outbox_spent(c, "task.progress", {"task_id": "t1", "text": "x"}, "task:t1"))
        assert dot_store.read(lambda c: s.has_unpriced(c, "task:t1")) is True
        dot_store.write(lambda c: s.append_outbox_spent(c, "message.assistant", {"text": "a"}, "chat"))
        assert dot_store.read(lambda c: s.has_unpriced(c, "chat")) is False

    def test_the_note_is_there_after_the_file_is_opened_again(self, tmp_path: Path) -> None:
        path = tmp_path / "engine.sqlite"
        first = DotStore.open(path)
        first.write(lambda c: s.note_unpriced(c, "task:t1"))
        first.close()
        second = DotStore.open(path)
        try:
            assert second.read(lambda c: s.has_unpriced(c, "task:t1")) is True
        finally:
            second.close()


class TestBrowserIdentities:
    def test_a_new_identity_is_never_used(self, dot_store: DotStore) -> None:
        added = dot_store.write(
            lambda c: s.insert_identity(c, identity_id="research-abc123", name="Research", now_ms=1000)
        )
        assert added is True
        assert dot_store.read(lambda c: s.get_identity(c, "research-abc123")) == s.BrowserIdentityRow(
            "research-abc123", "Research", None, 1000, None
        )

    def test_the_proxy_is_kept_as_given_and_the_clock_stamps_the_creation_when_no_time_is_given(
        self, dot_store: DotStore
    ) -> None:
        proxy = "http://user:secret@proxy.example:8080"
        before = s.clock_ms()
        dot_store.write(lambda c: s.insert_identity(c, identity_id="a-1", name="A", proxy=proxy))
        row = dot_store.read(lambda c: s.get_identity(c, "a-1"))
        assert row is not None and row.proxy == proxy
        assert before <= row.created_at <= s.clock_ms()

    def test_an_id_known_already_keeps_the_first_identity(self, dot_store: DotStore) -> None:
        assert dot_store.write(lambda c: s.insert_identity(c, identity_id="a-1", name="First", now_ms=1)) is True
        second = dot_store.write(
            lambda c: s.insert_identity(c, identity_id="a-1", name="Second", proxy="http://p", now_ms=2)
        )
        assert second is False
        assert dot_store.read(lambda c: s.get_identity(c, "a-1")) == s.BrowserIdentityRow(
            "a-1", "First", None, 1, None
        )

    def test_an_identity_that_does_not_exist_is_none_and_every_change_of_it_says_so(self, dot_store: DotStore) -> None:
        assert dot_store.read(lambda c: s.get_identity(c, "nobody")) is None
        assert dot_store.write(lambda c: s.touch_identity(c, "nobody")) is False
        assert dot_store.write(lambda c: s.delete_identity(c, "nobody")) is False

    def test_the_list_is_oldest_first_and_the_count_agrees(self, dot_store: DotStore) -> None:
        assert dot_store.read(s.list_identities) == []
        assert dot_store.read(s.count_identities) == 0
        for identity_id, created in (("c-3", 30), ("a-1", 10), ("b-2", 20), ("b-1", 20)):
            dot_store.write(
                lambda c, i=identity_id, t=created: s.insert_identity(c, identity_id=i, name=i.upper(), now_ms=t)
            )
        assert [r.id for r in dot_store.read(s.list_identities)] == ["a-1", "b-1", "b-2", "c-3"]
        assert dot_store.read(s.count_identities) == 4

    def test_touching_stamps_the_last_use_and_changes_nothing_else(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.insert_identity(c, identity_id="a-1", name="A", proxy="socks5://p:1", now_ms=5))
        dot_store.write(lambda c: s.insert_identity(c, identity_id="b-1", name="B", now_ms=6))
        assert dot_store.write(lambda c: s.touch_identity(c, "a-1", 700)) is True
        assert dot_store.read(lambda c: s.get_identity(c, "a-1")) == s.BrowserIdentityRow(
            "a-1", "A", "socks5://p:1", 5, 700
        )
        assert dot_store.write(lambda c: s.touch_identity(c, "a-1", 900)) is True
        a = dot_store.read(lambda c: s.get_identity(c, "a-1"))
        assert a is not None and a.last_used_at == 900
        b = dot_store.read(lambda c: s.get_identity(c, "b-1"))
        assert b is not None and b.last_used_at is None

    def test_deleting_removes_one_identity_and_frees_its_place_in_the_count(self, dot_store: DotStore) -> None:
        for identity_id in ("a-1", "b-1"):
            dot_store.write(lambda c, i=identity_id: s.insert_identity(c, identity_id=i, name=i, now_ms=1))
        assert dot_store.write(lambda c: s.delete_identity(c, "a-1")) is True
        assert dot_store.write(lambda c: s.delete_identity(c, "a-1")) is False
        assert [r.id for r in dot_store.read(s.list_identities)] == ["b-1"]
        assert dot_store.read(s.count_identities) == 1

    def test_a_row_written_in_a_transaction_that_fails_is_not_there(self, dot_store: DotStore) -> None:
        def write_then_fail(c: sqlite3.Connection) -> None:
            s.insert_identity(c, identity_id="a-1", name="A", now_ms=1)
            raise RuntimeError("boom")

        with pytest.raises(RuntimeError, match="boom"):
            dot_store.write(write_then_fail)
        assert dot_store.read(s.count_identities) == 0

    def test_the_identities_are_there_after_the_file_is_opened_again(self, tmp_path: Path) -> None:
        path = tmp_path / "engine.sqlite"
        first = DotStore.open(path)
        first.write(lambda c: s.insert_identity(c, identity_id="a-1", name="A", proxy="http://p:1", now_ms=3))
        first.write(lambda c: s.touch_identity(c, "a-1", 4))
        first.close()
        second = DotStore.open(path)
        try:
            assert second.read(s.list_identities) == [s.BrowserIdentityRow("a-1", "A", "http://p:1", 3, 4)]
        finally:
            second.close()

class TestToolIntents:
    def test_keeps_the_first_start_of_a_call_hands_it_back_once_and_clears_what_is_left(
        self, dot_store: DotStore
    ) -> None:
        intent = s.ToolIntent("c1", "exec", "s", None, 100)
        dot_store.write(lambda c: s.record_tool_intent(c, intent))
        dot_store.write(lambda c: s.record_tool_intent(c, s.ToolIntent("c1", "exec", "s", None, 999)))
        dot_store.write(lambda c: s.record_tool_intent(c, s.ToolIntent("c2", "exec", "s", "t1", 200)))
        taken = dot_store.write(lambda c: s.take_tool_intent(c, "s", "c1"))
        assert taken == intent
        assert dot_store.write(lambda c: s.take_tool_intent(c, "s", "c1")) is None
        left = dot_store.write(s.take_all_tool_intents)
        assert [(i.tool_call_id, i.task_id) for i in left] == [("c2", "t1")]
        assert dot_store.write(s.take_all_tool_intents) == []

    def test_listing_the_intents_leaves_them_in_place_oldest_first(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.record_tool_intent(c, s.ToolIntent("late", "exec", "s", None, 300)))
        dot_store.write(lambda c: s.record_tool_intent(c, s.ToolIntent("early", "exec", "t", "t1", 100)))
        listed = dot_store.read(s.list_tool_intents)
        assert [(i.tool_call_id, i.session_key) for i in listed] == [("early", "t"), ("late", "s")]
        assert dot_store.read(s.list_tool_intents) == listed

    def test_an_intent_carries_the_target_its_call_acted_on_and_none_by_default(self, dot_store: DotStore) -> None:
        named = s.ToolIntent("c1", "exec", "s", "t1", 100, "ls -la")
        dot_store.write(lambda c: s.record_tool_intent(c, named))
        dot_store.write(lambda c: s.record_tool_intent(c, s.ToolIntent("c2", "exec", "s", None, 200)))
        assert s.ToolIntent("c2", "exec", "s", None, 200).target is None
        assert dot_store.read(lambda c: s.peek_tool_intent(c, "s", "c1")) == named
        assert dot_store.read(lambda c: s.peek_tool_intent(c, "s", "c2")).target is None  # type: ignore[union-attr]
        assert dot_store.write(lambda c: s.take_tool_intent(c, "s", "c1")) == named
        assert [i.target for i in dot_store.read(s.list_tool_intents)] == [None]

    def test_the_first_start_of_a_call_keeps_its_target_too(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.record_tool_intent(c, s.ToolIntent("c1", "exec", "s", None, 1, "first")))
        dot_store.write(lambda c: s.record_tool_intent(c, s.ToolIntent("c1", "exec", "s", None, 2, "second")))
        assert dot_store.read(lambda c: s.peek_tool_intent(c, "s", "c1")).target == "first"  # type: ignore[union-attr]

    def test_an_intent_says_whether_its_call_started_a_terminal_session_and_does_not_by_default(
        self, dot_store: DotStore
    ) -> None:
        terminal = s.ToolIntent("c1", "exec", "s", None, 1, "python3", True)
        dot_store.write(lambda c: s.record_tool_intent(c, terminal))
        dot_store.write(lambda c: s.record_tool_intent(c, s.ToolIntent("c2", "exec", "s", None, 2, "ls")))
        assert s.ToolIntent("c2", "exec", "s", None, 2).tty is False
        assert dot_store.read(lambda c: s.peek_tool_intent(c, "s", "c1")) == terminal
        assert dot_store.read(lambda c: s.peek_tool_intent(c, "s", "c2")).tty is False  # type: ignore[union-attr]
        assert dot_store.write(lambda c: s.take_tool_intent(c, "s", "c1")) == terminal
        assert [i.tty for i in dot_store.read(s.list_tool_intents)] == [False]

    def test_a_file_made_when_an_intent_listed_the_notes_its_call_wrote_keeps_working(self, tmp_path: Path) -> None:
        # A Dot's disk outlives an upgrade: its intents table still has the column the notes were kept in.
        path = tmp_path / "engine.sqlite"
        DotStore.open(path).close()
        conn = sqlite3.connect(path)
        conn.execute("ALTER TABLE dots_tool_intents ADD COLUMN memory_keys_json TEXT NOT NULL DEFAULT '[]'")
        conn.commit()
        conn.close()
        store = DotStore.open(path)
        try:
            intent = s.ToolIntent("c1", "write_file", "s", None, 1, "/home/dot/memory/a.md")
            store.write(lambda c: s.record_tool_intent(c, intent))
            assert store.read(lambda c: s.peek_tool_intent(c, "s", "c1")) == intent
        finally:
            store.close()

class TestCanonicalArguments:
    def test_ignores_key_order_at_every_level(self) -> None:
        assert s.canonical_arguments({"b": 1, "a": {"d": 2, "c": [{"y": 1, "x": 2}]}}) == s.canonical_arguments(
            {"a": {"c": [{"x": 2, "y": 1}], "d": 2}, "b": 1}
        )
        assert s.canonical_arguments({"a": [1, 2]}) != s.canonical_arguments({"a": [2, 1]})
        assert s.canonical_arguments({"a": 1}) == '{"a":1}'


class TestApprovals:
    def request(self, store: DotStore, tool_call_id: str = "call-1", session_key: str = "chat") -> tuple[s.Approval, bool]:
        return store.write(
            lambda c: s.request_approval(
                c,
                session_key=session_key,
                task_id=None,
                tool_call_id=tool_call_id,
                tool="exec",
                permission="computer.exec",
                arguments={"command": "ls", "n": [1, {"b": 2}]},
            )
        )

    def test_creates_one_pending_approval_per_call(self, dot_store: DotStore) -> None:
        approval, created = self.request(dot_store)
        again, created_again = self.request(dot_store)
        assert created is True and created_again is False
        assert again == approval
        assert approval.approval_id.startswith("appr_")
        assert (approval.status, approval.note, approval.run_tool_call_id, approval.resolved_at) == ("pending", None, None, None)
        assert approval.arguments == {"command": "ls", "n": [1, {"b": 2}]}

    def test_each_call_gets_its_own_id(self, dot_store: DotStore) -> None:
        first, _ = self.request(dot_store, "call-1")
        second, _ = self.request(dot_store, "call-2")
        assert first.approval_id != second.approval_id
        assert [a.tool_call_id for a in dot_store.read(lambda c: s.list_approvals(c, "pending"))] == ["call-1", "call-2"]

    def test_approvals_asked_in_one_millisecond_keep_the_order_they_were_asked_in(self, dot_store: DotStore) -> None:
        # An approval's id is random: within one millisecond it says nothing about which came first.
        calls = [f"call-{n}" for n in range(10)]
        for call in calls:
            dot_store.write(
                lambda c, call=call: s.request_approval(
                    c,
                    session_key="chat",
                    task_id=None,
                    tool_call_id=call,
                    tool="exec",
                    permission="computer.exec",
                    arguments={"command": call},
                    now_ms=1000,
                )
            )
        assert [a.tool_call_id for a in dot_store.read(lambda c: s.list_approvals(c, "pending"))] == calls
        oldest = dot_store.read(lambda c: s.open_approval_for_session(c, "chat"))
        assert oldest is not None and oldest.tool_call_id == "call-0"

    def test_advances_only_from_the_status_it_is_in(self, dot_store: DotStore) -> None:
        approval, _ = self.request(dot_store)
        aid = approval.approval_id
        assert dot_store.write(lambda c: s.advance_approval(c, aid, "approved", "granted")) is False
        assert dot_store.write(lambda c: s.advance_approval(c, aid, "pending", "approved", note="go", now_ms=77)) is True
        assert dot_store.write(lambda c: s.advance_approval(c, aid, "pending", "rejected")) is False
        approved = dot_store.read(lambda c: s.get_approval(c, aid))
        assert (approved.status, approved.note, approved.resolved_at) == ("approved", "go", 77)
        assert dot_store.write(lambda c: s.advance_approval(c, aid, "approved", "granted")) is True
        granted = dot_store.read(lambda c: s.get_approval(c, aid))
        # The note and the time of the decision survive the later steps.
        assert (granted.status, granted.note, granted.resolved_at) == ("granted", "go", 77)

    def test_the_run_ends_when_the_result_reaches_the_transcript(self, dot_store: DotStore) -> None:
        approval, _ = self.request(dot_store)
        aid = approval.approval_id
        for before, after in (("pending", "approved"), ("approved", "granted")):
            dot_store.write(lambda c, b=before, a=after: s.advance_approval(c, aid, b, a))
        dot_store.write(lambda c: s.advance_approval(c, aid, "granted", "running", run_tool_call_id="call-2"))
        assert dot_store.write(lambda c: s.finish_approval_run(c, "chat", "call-9")) is False
        assert dot_store.write(lambda c: s.finish_approval_run(c, "chat", "call-2")) is True
        assert dot_store.write(lambda c: s.finish_approval_run(c, "chat", "call-2")) is False
        done = dot_store.read(lambda c: s.get_approval(c, aid))
        assert (done.status, done.run_tool_call_id) == ("done", "call-2")

    def test_an_approval_holds_its_session_until_it_is_done(self, dot_store: DotStore) -> None:
        approval, _ = self.request(dot_store, session_key="task:t1")
        aid = approval.approval_id
        assert dot_store.read(lambda c: s.open_approval_for_session(c, "task:t1")).approval_id == aid
        assert dot_store.read(lambda c: s.open_approval_for_session(c, "chat")) is None
        for before, after in (("pending", "rejected"), ("rejected", "told")):
            dot_store.write(lambda c, b=before, a=after: s.advance_approval(c, aid, b, a))
        assert dot_store.read(lambda c: s.open_approval_for_session(c, "task:t1")) is not None
        dot_store.write(lambda c: s.advance_approval(c, aid, "told", "done"))
        assert dot_store.read(lambda c: s.open_approval_for_session(c, "task:t1")) is None

    def test_an_unknown_approval_is_none(self, dot_store: DotStore) -> None:
        assert dot_store.read(lambda c: s.get_approval(c, "appr_nope")) is None


class TestToolDecisions:
    def test_a_decision_is_handed_back_once(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.record_tool_decision(c, "chat", "c1", "park"))
        assert dot_store.read(lambda c: s.peek_tool_decision(c, "chat", "c1")) == "park"
        assert dot_store.read(lambda c: s.peek_tool_decision(c, "chat", "c1")) == "park"
        assert dot_store.write(lambda c: s.take_tool_decision(c, "chat", "c1")) == "park"
        assert dot_store.write(lambda c: s.take_tool_decision(c, "chat", "c1")) is None
        assert dot_store.read(lambda c: s.peek_tool_decision(c, "chat", "c1")) is None

    def test_a_later_decision_replaces_the_earlier_one(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.record_tool_decision(c, "chat", "c1", "deny"))
        dot_store.write(lambda c: s.record_tool_decision(c, "chat", "c1", "skipped"))
        assert dot_store.write(lambda c: s.take_tool_decision(c, "chat", "c1")) == "skipped"

    def test_refuses_a_decision_it_does_not_know(self, dot_store: DotStore) -> None:
        with pytest.raises(ValueError, match="not a tool decision"):
            dot_store.write(lambda c: s.record_tool_decision(c, "chat", "c1", "allow"))  # type: ignore[arg-type]


class TestTranscripts:
    def test_appends_in_order_and_reads_back(self, dot_store: DotStore) -> None:
        first = {"role": "user", "content": "one"}
        second = {"role": "assistant", "content": None, "tool_calls": [{"id": "x", "type": "function"}]}
        third = {"role": "tool", "tool_call_id": "x", "name": "exec", "content": "ok"}
        dot_store.write(lambda c: s.append_messages(c, "chat", [first, second], final_index=None))
        dot_store.write(lambda c: s.append_messages(c, "chat", [third], final_index=None))
        dot_store.write(lambda c: s.append_messages(c, "task:t1", [{"role": "user", "content": "other"}], final_index=None))
        assert dot_store.read(lambda c: s.read_messages(c, "chat")) == [first, second, third]
        assert dot_store.read(lambda c: s.read_messages(c, "task:t1")) == [{"role": "user", "content": "other"}]
        assert dot_store.read(lambda c: s.read_messages(c, "task:none")) == []
        indices = dot_store.read(lambda c: [r[0] for r in c.execute("SELECT idx FROM messages WHERE session_key = 'chat' ORDER BY idx")])
        assert indices == [0, 1, 2]

    def test_a_rolled_back_transaction_leaves_no_message_and_no_outbox_row(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.record_inbound(c, inbound("m1"), "in_transcript"))

        def failing(c: sqlite3.Connection) -> None:
            s.append_messages(
                c, "chat", [{"role": "user", "content": "x"}, {"role": "assistant", "content": "answer"}], final_index=1
            )
            raise RuntimeError("the next commit point failed")

        with pytest.raises(RuntimeError):
            dot_store.write(failing)
        assert dot_store.read(lambda c: s.read_messages(c, "chat")) == []
        assert dot_store.read(lambda c: s.read_outbox_after(c, 0, 10)) == []
        assert [r.id for r in dot_store.read(lambda c: s.list_inbound(c, "in_transcript"))] == ["m1"]

    def test_the_final_message_answers_in_the_same_transaction(self, dot_store: DotStore) -> None:
        dot_store.write(lambda c: s.record_inbound(c, inbound("m1"), "accepted"))
        dot_store.write(
            lambda c: s.append_messages(
                c,
                "chat",
                [
                    {"role": "user", "content": "hello", "_dots": {"dots_inbound_id": "m1"}},
                    {"role": "assistant", "content": "hi there"},
                ],
                final_index=1,
            )
        )
        events = dot_store.read(lambda c: s.read_outbox_after(c, 0, 10))
        assert [(e["type"], e["data"]) for e in events] == [("message.assistant", {"text": "hi there", "in_reply_to": "m1", "spent_usd": 0.0})]

    def test_a_final_index_outside_the_messages_is_refused(self, dot_store: DotStore) -> None:
        for bad in (1, -1):
            with pytest.raises(ValueError, match="final_index"):
                dot_store.write(lambda c, b=bad: s.append_messages(c, "chat", [{"role": "assistant", "content": "x"}], final_index=b))
        with pytest.raises(ValueError, match="final_index"):
            dot_store.write(lambda c: s.append_messages(c, "chat", [], final_index=0))
        assert dot_store.read(lambda c: s.read_messages(c, "chat")) == []

    def test_a_session_has_metadata_that_starts_empty(self, dot_store: DotStore) -> None:
        assert dot_store.read(lambda c: s.read_session_metadata(c, "chat")) == {}
        dot_store.write(lambda c: s.append_messages(c, "chat", [{"role": "user", "content": "x"}], final_index=None))
        assert dot_store.read(lambda c: s.read_session_metadata(c, "chat")) == {}
        dot_store.write(lambda c: s.write_session_metadata(c, "chat", {"summary": "s", "last_consolidated": 3}))
        dot_store.write(lambda c: s.append_messages(c, "chat", [{"role": "user", "content": "y"}], final_index=None))
        assert dot_store.read(lambda c: s.read_session_metadata(c, "chat")) == {"summary": "s", "last_consolidated": 3}
        dot_store.write(lambda c: s.write_session_metadata(c, "chat", {"summary": "t"}, now_ms=5))
        assert dot_store.read(lambda c: s.read_session_metadata(c, "chat")) == {"summary": "t"}
        assert dot_store.read(lambda c: c.execute("SELECT updated_at FROM sessions WHERE key = 'chat'").fetchone()[0]) == 5

    def test_messages_survive_a_reopen_as_json(self, tmp_path: Path) -> None:
        path = tmp_path / "engine.sqlite"
        message = {"role": "assistant", "content": "caf\u00e9", "tool_calls": [{"id": "1", "function": {"arguments": "{}"}}]}
        store = DotStore.open(path)
        store.write(lambda c: s.append_messages(c, "chat", [message], final_index=None))
        store.close()
        store = DotStore.open(path)
        try:
            assert store.read(lambda c: s.read_messages(c, "chat")) == [message]
            raw = store.read(lambda c: c.execute("SELECT message_json FROM messages").fetchone()[0])
            assert json.loads(raw) == message
        finally:
            store.close()


class TestOpenToolCalls:
    def assistant(self, *ids: str) -> dict:
        return {"role": "assistant", "content": None, "tool_calls": [{"id": i, "type": "function"} for i in ids]}

    def result(self, call_id: str) -> dict:
        return {"role": "tool", "tool_call_id": call_id, "name": "exec", "content": "ok"}

    def append(self, store: DotStore, *messages: dict, key: str = "chat") -> None:
        store.write(lambda c: s.append_messages(c, key, list(messages), final_index=None))

    def open_ids(self, store: DotStore, key: str = "chat") -> list[str]:
        return [call["id"] for call in store.read(lambda c: s.open_tool_calls(c, key))]

    def test_an_empty_session_has_none(self, dot_store: DotStore) -> None:
        assert self.open_ids(dot_store) == []

    def test_every_call_of_the_newest_assistant_message_without_a_result_is_open(self, dot_store: DotStore) -> None:
        self.append(dot_store, {"role": "user", "content": "go"}, self.assistant("a", "b", "c"), self.result("a"))
        assert self.open_ids(dot_store) == ["b", "c"]
        self.append(dot_store, self.result("c"))
        assert self.open_ids(dot_store) == ["b"]
        self.append(dot_store, self.result("b"))
        assert self.open_ids(dot_store) == []

    def test_only_the_newest_assistant_message_counts(self, dot_store: DotStore) -> None:
        self.append(dot_store, self.assistant("old"), self.result("other"), self.assistant("new"))
        assert self.open_ids(dot_store) == ["new"]

    def test_a_newest_assistant_message_without_calls_has_none_open(self, dot_store: DotStore) -> None:
        self.append(dot_store, self.assistant("old"), {"role": "assistant", "content": "done"})
        assert self.open_ids(dot_store) == []

    def test_a_user_message_after_the_calls_does_not_close_them(self, dot_store: DotStore) -> None:
        self.append(dot_store, self.assistant("a"), {"role": "user", "content": "still there?"})
        assert self.open_ids(dot_store) == ["a"]

    def test_returns_the_calls_as_they_were_stored(self, dot_store: DotStore) -> None:
        call = {"id": "a", "type": "function", "function": {"name": "exec", "arguments": '{"command":"ls"}'}}
        self.append(dot_store, {"role": "assistant", "content": None, "tool_calls": [call]})
        assert dot_store.read(lambda c: s.open_tool_calls(c, "chat")) == [call]

    def test_sessions_are_independent(self, dot_store: DotStore) -> None:
        self.append(dot_store, self.assistant("a"))
        self.append(dot_store, self.assistant("t"), self.result("t"), key="task:t1")
        assert self.open_ids(dot_store) == ["a"]
        assert self.open_ids(dot_store, "task:t1") == []


class TestToolIntentsAndApprovalsByCall:
    def test_an_intent_can_be_looked_at_without_being_taken(self, dot_store: DotStore) -> None:
        intent = s.ToolIntent("c1", "exec", "chat", None, 10)
        assert dot_store.read(lambda c: s.peek_tool_intent(c, "chat", "c1")) is None
        dot_store.write(lambda c: s.record_tool_intent(c, intent))
        assert dot_store.read(lambda c: s.peek_tool_intent(c, "chat", "c1")) == intent
        assert dot_store.read(lambda c: s.peek_tool_intent(c, "chat", "c1")) == intent
        assert dot_store.write(lambda c: s.take_tool_intent(c, "chat", "c1")) == intent
        assert dot_store.read(lambda c: s.peek_tool_intent(c, "chat", "c1")) is None
        assert dot_store.write(lambda c: s.take_tool_intent(c, "chat", "c1")) is None

    def test_an_approval_is_found_by_the_call_that_asked_for_it(self, dot_store: DotStore) -> None:
        assert dot_store.read(lambda c: s.get_approval_by_tool_call(c, "chat", "c1")) is None
        approval, _ = dot_store.write(
            lambda c: s.request_approval(
                c, session_key="chat", task_id=None, tool_call_id="c1", tool="exec", permission="computer.exec", arguments={}
            )
        )
        assert dot_store.read(lambda c: s.get_approval_by_tool_call(c, "chat", "c1")) == approval
        assert dot_store.read(lambda c: s.get_approval_by_tool_call(c, "chat", "c2")) is None


class TestLoadingASession:
    def seed(self, store: DotStore, count: int) -> list[dict]:
        messages = [{"role": "user" if i % 2 == 0 else "assistant", "content": f"m{i}"} for i in range(count)]
        store.write(lambda c: s.append_messages(c, "chat", messages, final_index=None))
        return messages

    def test_an_unknown_session_is_empty(self, dot_store: DotStore) -> None:
        session = dot_store.read(lambda c: s.load_session(c, "chat"))
        assert (session.key, session.messages, session.metadata, session.last_consolidated) == ("chat", [], {}, 0)

    def test_the_session_holds_the_messages_the_metadata_and_the_offset(self, dot_store: DotStore) -> None:
        messages = self.seed(dot_store, 4)
        dot_store.write(lambda c: s.write_session_metadata(c, "chat", {"_last_summary": {"text": "t"}, "last_consolidated": 2}))
        session = dot_store.read(lambda c: s.load_session(c, "chat"))
        assert session.messages == messages
        assert session.last_consolidated == 2
        # The offset is a field of the session, not part of its metadata.
        assert session.metadata == {"_last_summary": {"text": "t"}}
        assert [m["content"] for m in session.get_history()] == ["m2", "m3"]

    def test_the_history_replay_copies_only_the_keys_of_a_model_message(self, dot_store: DotStore) -> None:
        dot_store.write(
            lambda c: s.append_messages(
                c,
                "chat",
                [
                    {"role": "user", "content": "go", "timestamp": "2026-10-05T10:00:00", "_dots": {"dots_inbound_id": "m1"}},
                    {"role": "assistant", "content": "ok", "timestamp": "2026-10-05T10:00:01", "_meta": {"x": 1}},
                ],
                final_index=None,
            )
        )
        history = dot_store.read(lambda c: s.load_session(c, "chat")).get_history()
        assert history == [{"role": "user", "content": "go"}, {"role": "assistant", "content": "ok"}]


class TestSummaryCheckpoints:
    def seed(self, store: DotStore, count: int) -> None:
        messages = [{"role": "user" if i % 2 == 0 else "assistant", "content": f"m{i}"} for i in range(count)]
        store.write(lambda c: s.append_messages(c, "chat", messages, final_index=None))

    def test_a_marker_is_inserted_at_the_boundary_and_the_later_rows_move_up(self, dot_store: DotStore) -> None:
        self.seed(dot_store, 6)
        dot_store.write(lambda c: s.commit_summary_checkpoint(c, "chat", "what happened", 3))

        session = dot_store.read(lambda c: s.load_session(c, "chat"))
        assert [m["content"] for m in session.messages if m["content"].startswith("m")] == [f"m{i}" for i in range(6)]
        assert len(session.messages) == 7
        marker = session.messages[3]
        assert marker["role"] == "user" and marker["content"].startswith("Continue the active task")
        assert [m["content"] for m in session.messages[4:]] == ["m3", "m4", "m5"]
        assert session.last_consolidated == 3
        assert session.metadata["_last_summary"]["text"] == "what happened"
        assert dot_store.read(lambda c: [r[0] for r in c.execute("SELECT idx FROM messages ORDER BY idx")]) == list(range(7))
        # The replay starts after the boundary, anchored on the marker, so a mid-turn start survives.
        assert [m["content"] for m in session.get_history()] == ["m3", "m4", "m5"]

    def test_a_second_checkpoint_replaces_the_first_summary(self, dot_store: DotStore) -> None:
        self.seed(dot_store, 4)
        dot_store.write(lambda c: s.commit_summary_checkpoint(c, "chat", "first", 2))
        self.seed(dot_store, 2)
        dot_store.write(lambda c: s.commit_summary_checkpoint(c, "chat", "second", 5))

        session = dot_store.read(lambda c: s.load_session(c, "chat"))
        assert session.metadata["_last_summary"]["text"] == "second"
        assert session.last_consolidated == 5
        assert len(session.messages) == 8

    def test_a_boundary_outside_the_session_is_refused_and_changes_nothing(self, dot_store: DotStore) -> None:
        self.seed(dot_store, 3)
        dot_store.write(lambda c: s.commit_summary_checkpoint(c, "chat", "first", 2))
        for bad in (1, 5):
            with pytest.raises(ValueError, match="summary boundary"):
                dot_store.write(lambda c, b=bad: s.commit_summary_checkpoint(c, "chat", "again", b))
        session = dot_store.read(lambda c: s.load_session(c, "chat"))
        assert (len(session.messages), session.last_consolidated, session.metadata["_last_summary"]["text"]) == (4, 2, "first")
