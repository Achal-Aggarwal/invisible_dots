"""The turn runner: transcripts, commit points, the gate and how a turn ends."""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Callable
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest
from fakes.scripted_provider import ScriptedProvider, call, calls, says
from fakes.turn_harness import KEY, Harness

from nanobot.agent.tools.gate_types import SKIPPED_MESSAGE
from nanobot.agent.transcript_metadata import METADATA_KEY
from nanobot.dots import store as s
from nanobot.dots.gate import park_message
from nanobot.dots.protocol import parse_runtime_config
from nanobot.dots.transcript_outbox import (
    CLOSED,
    CLOSED_INTERRUPTED,
    CLOSED_NOT_RUN,
    INBOUND_ID,
)
from nanobot.dots.turns import OpeningMessage, TurnOutcome, TurnUnit
from nanobot.providers.base import LLMResponse, ModelLimits

CHAT = s.CHAT_SESSION_KEY
MakeHarness = Callable[..., Harness]
# What a Dot with only files.read is offered.
READ_TOOLS = ["find_files", "grep", "list_dir", "read_file"]


def chat_unit(text: str = "hello", inbound_id: str = "in1") -> TurnUnit:
    return TurnUnit(CHAT, None, (OpeningMessage(text, {INBOUND_ID: inbound_id}),))


def roles(messages: list[dict[str, Any]]) -> list[str]:
    return [message["role"] for message in messages]


def outgrow_the_window(h: Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    """A chat thread too long for its budget, with a message waiting: the turn's first request is the summary."""

    def four_characters_a_token(provider: Any, model: str, messages: list[dict[str, Any]], tools: Any) -> Any:
        # The thread the test sizes, not the engine's own prompt, which grows with what it teaches the model.
        return sum(len(json.dumps(message)) for message in messages if message.get("role") != "system") // 4, "test"

    for module in ("nanobot.agent.context_governance", "nanobot.agent.memory"):
        monkeypatch.setattr(f"{module}.estimate_prompt_tokens_chain", four_characters_a_token)
    h.provider.default_limits = replace(h.provider.default_limits, context_tokens=2500)
    old: list[dict[str, Any]] = []
    for index in range(6):
        old += [
            {"role": "user", "content": f"question {index} " + "x" * 300},
            {"role": "assistant", "content": f"answer {index} " + "y" * 300},
        ]
    h.store.write(lambda conn: s.append_messages(conn, CHAT, old, final_index=None))
    h.accept("in1")


def approval_of(h: Harness, status: s.ApprovalStatus = "pending") -> s.Approval:
    (approval,) = h.store.read(lambda conn: s.list_approvals(conn, status))
    return approval


class TestAChatTurn:
    async def test_commits_the_message_and_the_answer(self, make_harness: MakeHarness) -> None:
        h = make_harness([says("hi there")])
        h.accept("in1")

        outcome = await h.run(chat_unit())

        assert outcome == TurnOutcome("completed")
        user, answer = h.messages()
        assert (user["role"], user["content"], user[METADATA_KEY]) == ("user", "hello", {INBOUND_ID: "in1"})
        assert (answer["role"], answer["content"]) == ("assistant", "hi there")
        assert h.events() == [("message.assistant", {"text": "hi there", "in_reply_to": "in1", "spent_usd": 0.0})]
        assert h.inbound_state("in1") == "applied"
        assert h.host.events == [("run_started", CHAT)]

    async def test_the_model_is_asked_with_the_dot_prompt_and_the_history(self, make_harness: MakeHarness) -> None:
        h = make_harness([says("one"), says("two")])
        h.accept("in1")
        await h.run(chat_unit("first"))
        h.accept("in2")
        await h.run(chat_unit("second", "in2"))

        system = h.provider.requests[1]["messages"][0]
        assert system["role"] == "system"
        assert 'You are the Dot "fare-watch"' in system["content"]
        assert "goal" not in system["content"].lower()
        assert "Tool Usage Notes" in system["content"]
        assert "your own Linux computer" in system["content"]
        assert [(m["role"], m["content"]) for m in h.provider.requests[1]["messages"][1:]] == [
            ("user", "first"),
            ("assistant", "one"),
            ("user", "second"),
        ]
        assert h.provider.requests[0]["model"] == "z-ai/glm-5.3-flash"

    async def test_an_injected_message_is_committed_and_answered_with_the_rest(self, make_harness: MakeHarness) -> None:
        h = make_harness([says("both answered")])
        h.accept("in1")
        h.accept("in2", "and this")
        h.injections = [[OpeningMessage("and this", {INBOUND_ID: "in2"})]]

        outcome = await h.run(chat_unit())

        assert outcome.kind == "completed"
        assert [(m["role"], m["content"]) for m in h.messages()] == [
            ("user", "hello"),
            ("user", "and this"),
            ("assistant", "both answered"),
        ]
        assert h.events() == [("message.assistant", {"text": "both answered", "in_reply_to": "in2", "spent_usd": 0.0})]
        assert h.inbound_state("in1") == h.inbound_state("in2") == "applied"
        # The model was asked once, with both user messages merged as for any request.
        (request,) = h.provider.requests
        assert roles(request["messages"]) == ["system", "user"]
        assert request["messages"][1]["content"] == "hello\n\nand this"

    async def test_a_task_does_not_drain_the_chat_inbox(self, make_harness: MakeHarness) -> None:
        h = make_harness([says("done")])
        session = h.start_task()
        h.injections = [[OpeningMessage("chat only", {INBOUND_ID: "in9"})]]

        await h.run(TurnUnit(session, "t1", (OpeningMessage("do it"),)))

        assert len(h.injections) == 1
        assert "chat only" not in json.dumps(h.provider.requests)


class TestATaskTurn:
    async def test_the_final_answer_completes_the_task(self, make_harness: MakeHarness) -> None:
        h = make_harness([says("the summary")])
        session = h.start_task()

        outcome = await h.run(TurnUnit(session, "t1", (OpeningMessage("do it"),)))

        assert outcome.kind == "completed"
        assert [(m["role"], m["content"]) for m in h.messages(session)] == [("user", "do it"), ("assistant", "the summary")]
        assert h.events() == [("task.completed", {"task_id": "t1", "summary": "the summary", "spent_usd": 0.0})]
        assert h.host.events == [("run_started", session)]

    async def test_the_text_beside_a_tool_call_is_reported_as_progress_before_the_call_and_the_completion(
        self, make_harness: MakeHarness
    ) -> None:
        h = make_harness(
            [
                calls(call("c1", "list_dir", path="."), text="Listing the workspace first."),
                calls(call("c2", "list_dir", path=".")),
                says("the summary"),
            ]
        )
        session = h.start_task()

        outcome = await h.run(TurnUnit(session, "t1", (OpeningMessage("do it"),)))

        assert outcome.kind == "completed"
        assert [(kind, data.get("text") or data.get("tool") or data.get("summary")) for kind, data in h.events()] == [
            ("task.progress", "Listing the workspace first."),
            ("tool.called", "list_dir"),
            ("tool.called", "list_dir"),
            ("task.completed", "the summary"),
        ]
        assert h.events()[0][1]["task_id"] == "t1"

    async def test_a_chat_turn_with_text_beside_a_tool_call_reports_no_progress(self, make_harness: MakeHarness) -> None:
        h = make_harness([calls(call("c1", "list_dir", path="."), text="Let me look."), says("done")])
        h.accept("in1")

        await h.run(chat_unit())

        assert [kind for kind, _ in h.events()] == ["tool.called", "message.assistant"]

    async def test_reaching_the_step_limit_fails_the_turn_with_the_limit(self, make_harness: MakeHarness) -> None:
        limits = {"max_steps_per_task": 2, "max_cost_per_task_usd": 1}
        h = make_harness(
            [calls(call("c1", "list_dir", path=".")), calls(call("c2", "list_dir", path="."))], limits=limits
        )
        session = h.start_task()

        outcome = await h.run(TurnUnit(session, "t1", (OpeningMessage("do it"),)))

        assert outcome == TurnOutcome.failed("stopped: the task reached limits.max_steps_per_task (2)")
        assert len(h.provider.requests) == 2
        # The task did not complete: only the engine ends it, from the outcome.
        assert [kind for kind, _ in h.events()] == ["tool.called", "tool.called"]
        assert h.messages(session)[-1]["role"] == "assistant"

    async def test_a_window_too_small_for_the_request_fails_the_turn_in_words_and_asks_nothing(
        self, make_harness: MakeHarness
    ) -> None:
        # A model whose whole window is less than the engine's own prompt: nothing fits, and no summary helps.
        h = make_harness([says("never")])
        h.provider.default_limits = ModelLimits(context_tokens=4000, answer_tokens=1000)

        outcome = await h.run(chat_unit())

        assert outcome.kind == "failed"
        assert outcome.reason is not None
        assert outcome.reason.startswith("the request needs ")
        assert "and the model z-ai/glm-5.3-flash takes " in outcome.reason
        assert outcome.reason.endswith("choose a model with a larger context window")
        assert "via tiktoken" not in outcome.reason
        assert h.provider.requests == []


class TestCommitPoints:
    async def test_every_step_of_a_tool_call_is_committed_before_the_next_starts(
        self, make_harness: MakeHarness
    ) -> None:
        seen: dict[str, Any] = {}

        def second_request(provider: ScriptedProvider) -> LLMResponse:
            seen["at_second_request"] = (roles(h.messages()), [kind for kind, _ in h.events()])
            return says("done")

        h = make_harness([calls(call("c1", "read_file", path="notes.txt")), second_request])
        (h.tmp_path / "home" / "dot" / "workspace" / "notes.txt").write_bytes(b"alpha\n")
        h.accept("in1")

        def tool_starts(intent: s.ToolIntent) -> None:
            messages = h.messages()
            # The assistant message with the call is in the database before the call runs...
            seen["at_tool_start"] = roles(messages)
            assert messages[-1]["tool_calls"][0]["id"] == "c1"
            # ...and so is the intent, with no tool.called yet.
            seen["intent"] = h.store.read(lambda conn: s.peek_tool_intent(conn, CHAT, "c1"))
            seen["events_at_tool_start"] = h.events()

        h.host.on_tool_started = tool_starts

        outcome = await h.run(chat_unit())

        assert outcome.kind == "completed"
        assert seen["at_tool_start"] == ["user", "assistant"]
        assert seen["intent"] is not None and seen["intent"].tool == "read_file"
        assert seen["events_at_tool_start"] == []
        # The result and its tool.called are committed before the model is asked again.
        assert seen["at_second_request"] == (["user", "assistant", "tool"], ["tool.called"])
        (called,) = h.events_of("tool.called")
        assert (called["tool"], called["permission"], called["decision"], called["ok"]) == (
            "read_file",
            "files.read",
            "allow",
            True,
        )
        assert isinstance(called["duration_ms"], int) and called["duration_ms"] >= 0
        # The intent was consumed by the result.
        assert h.store.read(lambda conn: s.peek_tool_intent(conn, CHAT, "c1")) is None
        assert h.host.events == [
            ("run_started", CHAT),
            ("tool_started", "read_file"),
            ("tool_ended", CHAT),
        ]
        tool_message = h.messages()[2]
        assert tool_message["tool_call_id"] == "c1" and "alpha" in tool_message["content"]

    async def test_every_message_has_the_time_it_was_written(self, make_harness: MakeHarness) -> None:
        h = make_harness([says("ok")])
        h.accept("in1")
        await h.run(chat_unit())

        for message in h.messages():
            assert datetime.fromisoformat(message["timestamp"]).year >= 2026

    async def test_a_failing_tool_is_reported_not_ok_and_flagged_in_the_transcript(
        self, make_harness: MakeHarness
    ) -> None:
        h = make_harness([calls(call("c1", "read_file", path="missing.txt")), says("sorry")])
        h.accept("in1")

        await h.run(chat_unit())

        (called,) = h.events_of("tool.called")
        assert called["ok"] is False and called["decision"] == "allow"
        tool_message = h.messages()[2]
        assert tool_message[METADATA_KEY] == {"is_error": True}
        assert h.host.events[-1] == ("tool_ended", CHAT)

    async def test_the_summary_checkpoint_is_stored_at_the_boundary_it_covers(
        self, make_harness: MakeHarness, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def four_characters_a_token(provider: Any, model: str, messages: list[dict[str, Any]], tools: Any) -> Any:
            # The thread the test sizes, not the engine's own prompt, which grows with what it teaches the model.
            return sum(len(json.dumps(message)) for message in messages if message.get("role") != "system") // 4, "test"

        for module in ("nanobot.agent.context_governance", "nanobot.agent.memory"):
            monkeypatch.setattr(f"{module}.estimate_prompt_tokens_chain", four_characters_a_token)
        monkeypatch.setattr(
            "nanobot.agent.memory.estimate_message_tokens", lambda message: len(str(message.get("content"))) // 4
        )
        h = make_harness(
            [says("summary of the old conversation"), says("a fresh answer")],
            {"files.read": "allow"},
            max_tokens=500,
        )
        # A budget of 976 tokens for the request, 2000 for the summary of it.
        h.provider.default_limits = replace(h.provider.default_limits, context_tokens=2500)
        old: list[dict[str, Any]] = []
        for index in range(6):
            old += [
                {"role": "user", "content": f"question {index} " + "x" * 300},
                {"role": "assistant", "content": f"answer {index} " + "y" * 300},
            ]
        h.store.write(lambda conn: s.append_messages(conn, CHAT, old, final_index=None))
        h.accept("in1")

        outcome = await h.run(chat_unit("a new question"))

        assert outcome.kind == "completed"
        stored = h.messages()
        metadata = h.store.read(lambda conn: s.read_session_metadata(conn, CHAT))
        # The model's summary, then the person's latest messages as they wrote them: newest first up to a quarter of
        # the request budget (976 tokens: 244 of four characters), the one across that line cut, put back in order.
        summary, latest = metadata["_last_summary"]["text"].split(
            "\n\n## The person's latest messages, as they wrote them\n\n"
        )
        assert summary == "summary of the old conversation"
        kept = latest.split("\n\n---\n\n")
        assert kept[-4:] == [f"question {index} " + "x" * 300 for index in (3, 4, 5)] + ["a new question"]
        assert kept[0].startswith("question 2") and len(kept[0]) < len("question 2 " + "x" * 300)
        assert len(kept) == 5
        boundary = metadata["last_consolidated"]
        # The old messages and the opening message the model was asked about are before the
        # marker, the answer it then gave is after it.
        assert boundary == len(old) + 1
        assert stored[boundary]["role"] == "user"
        assert stored[boundary]["content"] == "Continue the active task from the working-memory checkpoint above."
        assert [m["content"] for m in stored[boundary + 1 :]] == ["a fresh answer"]
        # The next turn replays from the boundary.
        session = h.store.read(lambda conn: s.load_session(conn, CHAT))
        assert [m["content"] for m in session.get_history()] == ["a fresh answer"]

    async def test_the_summary_is_asked_of_the_model_of_the_summary_role_and_offers_it_no_tools(
        self, make_harness: MakeHarness, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        h = make_harness(
            [says("the summary"), says("a fresh answer")],
            {"files.read": "allow"},
            max_tokens=500,
            models={"summary": "cheap/summarizer"},
        )
        outgrow_the_window(h, monkeypatch)

        outcome = await h.run(chat_unit("a new question"))

        assert outcome.kind == "completed"
        summary_request, answer_request = h.provider.requests
        assert summary_request["model"] == "cheap/summarizer"
        assert summary_request["tools"] == []
        assert answer_request["model"] == "z-ai/glm-5.3-flash"
        assert h.provider.tool_names[1] == READ_TOOLS
        metadata = h.store.read(lambda conn: s.read_session_metadata(conn, CHAT))
        assert metadata["_last_summary"]["text"].startswith("the summary\n\n## The person's latest messages")

    async def test_without_a_summary_role_the_dots_own_model_writes_the_summary_with_the_tools_of_the_turn(
        self, make_harness: MakeHarness, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        h = make_harness([says("the summary"), says("a fresh answer")], {"files.read": "allow"}, max_tokens=500)
        outgrow_the_window(h, monkeypatch)

        outcome = await h.run(chat_unit("a new question"))

        assert outcome.kind == "completed"
        summary_request, answer_request = h.provider.requests
        assert summary_request["model"] == answer_request["model"] == "z-ai/glm-5.3-flash"
        assert h.provider.tool_names == [READ_TOOLS, READ_TOOLS]

    async def test_the_summary_role_naming_the_dots_own_model_keeps_the_tools(
        self, make_harness: MakeHarness, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        h = make_harness(
            [says("the summary"), says("a fresh answer")],
            {"files.read": "allow"},
            max_tokens=500,
            models={"summary": "z-ai/glm-5.3-flash"},
        )
        outgrow_the_window(h, monkeypatch)

        await h.run(chat_unit("a new question"))

        assert h.provider.tool_names == [READ_TOOLS, READ_TOOLS]


    async def test_the_messages_of_the_turn_after_the_summarized_request_stay_after_the_marker(
        self, make_harness: MakeHarness, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def four_characters_a_token(provider: Any, model: str, messages: list[dict[str, Any]], tools: Any) -> Any:
            # The thread the test sizes, not the engine's own prompt, which grows with what it teaches the model.
            return sum(len(json.dumps(message)) for message in messages if message.get("role") != "system") // 4, "test"

        for module in ("nanobot.agent.context_governance", "nanobot.agent.memory"):
            monkeypatch.setattr(f"{module}.estimate_prompt_tokens_chain", four_characters_a_token)
        h = make_harness(
            [calls(call("c1", "read_file", path="big.txt")), says("summary of the history"), says("all read")],
            {"files.read": "allow"},
            max_tokens=500,
        )
        h.provider.default_limits = replace(h.provider.default_limits, context_tokens=2500)
        (h.tmp_path / "home" / "dot" / "workspace" / "big.txt").write_bytes(b"z" * 800)
        old = [
            {"role": "user", "content": "q1 " + "x" * 700},
            {"role": "assistant", "content": "a1 " + "y" * 700},
            {"role": "user", "content": "q2 " + "x" * 700},
            {"role": "assistant", "content": "a2 " + "y" * 700},
        ]
        h.store.write(lambda conn: s.append_messages(conn, CHAT, old, final_index=None))
        h.accept("in1")

        outcome = await h.run(chat_unit("read big.txt"))

        assert outcome.kind == "completed"
        # The model was asked: the call, the summary, the answer after it.
        assert len(h.provider.requests) == 3
        stored = h.messages()
        assert roles(stored) == ["user", "assistant", "user", "assistant", "user", "user", "assistant", "tool", "assistant"]
        boundary = h.store.read(lambda conn: s.read_session_metadata(conn, CHAT))["last_consolidated"]
        # Before the marker: the history and the opening message, which the summary replaced.
        assert boundary == 5 and stored[boundary]["content"].startswith("Continue the active task")
        session = h.store.read(lambda conn: s.load_session(conn, CHAT))
        assert roles(session.get_history()) == ["assistant", "tool", "assistant"]


class TestThePolicy:
    async def test_a_denied_call_does_not_run_and_the_model_is_told_why(self, make_harness: MakeHarness) -> None:
        h = make_harness([])

        def deny_then_call(provider: ScriptedProvider) -> LLMResponse:
            # A config pushed between the offer and the call applies to the call.
            h.config = parse_runtime_config({**h.config.model_dump(exclude_unset=True), "permissions": {"files.read": "deny"}})
            return calls(call("c1", "read_file", path="notes.txt"))

        h.provider.script = [deny_then_call, says("understood")]
        h.accept("in1")

        outcome = await h.run(chat_unit())

        assert outcome.kind == "completed"
        (called,) = h.events_of("tool.called")
        assert (called["decision"], called["ok"], called["permission"], called["duration_ms"]) == (
            "deny",
            False,
            "files.read",
            0,
        )
        # The call never started: nothing of it is shown, not even where it pointed.
        assert "target" not in called
        denial = h.provider.requests[1]["messages"][-1]
        assert denial["role"] == "tool"
        assert denial["content"] == "The Dot's policy denies files.read."
        assert ("tool_started", "read_file") not in h.host.events

    async def test_an_ask_parks_the_call_and_ends_the_turn_with_no_further_request(
        self, make_harness: MakeHarness
    ) -> None:
        h = make_harness(
            [
                calls(
                    call("c1", "write_file", path="a.txt", content="x"),
                    call("c2", "read_file", path="notes.txt"),
                ),
            ],
            {"files.write": "ask", "files.read": "allow"},
        )
        h.accept("in1")

        outcome = await h.run(chat_unit())

        assert outcome == TurnOutcome("parked")
        assert len(h.provider.requests) == 1
        approval = approval_of(h)
        (requested,) = h.events_of("approval.requested")
        assert requested == {
            "approval_id": approval.approval_id,
            "tool": "write_file",
            "permission": "files.write",
            "arguments": {"path": "a.txt", "content": "x"},
            "reason": "The Dot's policy asks before files.write.",
        }
        assert (approval.tool, approval.status, approval.tool_call_id) == ("write_file", "pending", "c1")
        # Neither the parked call nor the one skipped after it ran or reports anything.
        assert h.events_of("tool.called") == []
        assert [m["content"] for m in h.messages()[2:]] == [park_message(approval.approval_id), SKIPPED_MESSAGE]
        assert not (h.tmp_path / "home" / "dot" / "workspace" / "a.txt").exists()
        assert h.host.events == [("run_started", CHAT)]
        # Nothing is left half-recorded: the decisions were consumed by the results, no call has an intent.
        assert h.store.read(lambda conn: conn.execute("SELECT COUNT(*) FROM dots_tool_decisions").fetchone()[0]) == 0
        assert h.store.read(lambda conn: conn.execute("SELECT COUNT(*) FROM dots_tool_intents").fetchone()[0]) == 0
        # No answer: the chat still owes one.
        assert h.events_of("message.assistant") == []
        assert h.inbound_state("in1") == "in_transcript"

    async def test_the_approved_call_made_again_runs_once_and_ends_the_approval(
        self, make_harness: MakeHarness
    ) -> None:
        arguments = {"path": "a.txt", "content": "x"}
        h = make_harness([calls(call("c1", "write_file", **arguments))], {"files.write": "ask"})
        h.accept("in1")
        assert (await h.run(chat_unit())).kind == "parked"
        approval = approval_of(h)
        h.store.write(lambda conn: s.advance_approval(conn, approval.approval_id, "pending", "approved"))
        h.store.write(lambda conn: s.advance_approval(conn, approval.approval_id, "approved", "granted"))

        h.provider.script += [calls(call("c2", "write_file", **arguments)), says("written")]
        continuation = TurnUnit(
            CHAT,
            None,
            (OpeningMessage("The user approved. Make the call again.", {"dots_approval_id": approval.approval_id}),),
            approval.approval_id,
        )
        outcome = await h.run(continuation)

        assert outcome.kind == "completed"
        assert (h.tmp_path / "home" / "dot" / "workspace" / "a.txt").read_text(encoding="utf-8") == "x"
        (called,) = h.events_of("tool.called")
        assert (called["tool"], called["decision"], called["ok"], called["permission"]) == (
            "write_file",
            "ask",
            True,
            "files.write",
        )
        assert approval_of(h, "done").approval_id == approval.approval_id

    async def test_the_same_call_again_after_it_ran_asks_anew(self, make_harness: MakeHarness) -> None:
        arguments = {"path": "a.txt", "content": "x"}
        h = make_harness([calls(call("c1", "write_file", **arguments))], {"files.write": "ask"})
        h.accept("in1")
        await h.run(chat_unit())
        first = approval_of(h)
        h.store.write(lambda conn: s.advance_approval(conn, first.approval_id, "pending", "approved"))
        h.store.write(lambda conn: s.advance_approval(conn, first.approval_id, "approved", "granted"))
        h.provider.script += [calls(call("c2", "write_file", **arguments)), calls(call("c3", "write_file", **arguments))]

        assert (await h.run(TurnUnit(CHAT, None, (OpeningMessage("approved"),)))).kind == "parked"

        # c2 used the approval; c3 is a new call and needs a new one.
        assert approval_of(h, "done").tool_call_id == "c1"
        pending = approval_of(h)
        assert pending.tool_call_id == "c3"

    async def test_a_model_that_names_every_call_call_0_is_gated_call_by_call(self, make_harness: MakeHarness) -> None:
        # OpenRouter models reuse ids across responses: the id alone must never pick a row.
        arguments = {"path": "a.txt", "content": "x"}
        h = make_harness([calls(call("call_0", "write_file", **arguments))], {"files.write": "ask", "files.read": "allow"})
        h.accept("in1")
        assert (await h.run(chat_unit())).kind == "parked"
        first = approval_of(h)
        h.store.write(lambda conn: s.advance_approval(conn, first.approval_id, "pending", "approved"))
        h.store.write(lambda conn: s.advance_approval(conn, first.approval_id, "approved", "granted"))
        (h.tmp_path / "home" / "dot" / "workspace" / "notes.txt").write_bytes(b"alpha\n")
        h.provider.script += [
            calls(call("call_0", "write_file", **arguments)),
            calls(call("call_0", "read_file", path="notes.txt")),
            calls(call("call_0", "write_file", path="b.txt", content="y")),
        ]

        outcome = await h.run(TurnUnit(CHAT, None, (OpeningMessage("approved"),)))

        assert outcome.kind == "parked"
        assert first.approval_id == approval_of(h, "done").approval_id
        second = approval_of(h)
        assert second.approval_id != first.approval_id and second.arguments == {"path": "b.txt", "content": "y"}
        assert [e["arguments"]["path"] for e in h.events_of("approval.requested")] == ["a.txt", "b.txt"]
        assert [(e["tool"], e["decision"], e["ok"]) for e in h.events_of("tool.called")] == [
            ("write_file", "ask", True),
            ("read_file", "allow", True),
        ]
        assert not (h.tmp_path / "home" / "dot" / "workspace" / "b.txt").exists()
        assert h.store.read(lambda conn: conn.execute("SELECT COUNT(*) FROM dots_tool_decisions").fetchone()[0]) == 0
        assert h.store.read(lambda conn: conn.execute("SELECT COUNT(*) FROM dots_tool_intents").fetchone()[0]) == 0

    async def test_a_model_that_reuses_call_ids_across_turns_is_sent_every_result(self, make_harness: MakeHarness) -> None:
        h = make_harness(
            [
                calls(call("call_0", "read_file", path="a.txt")),
                says("one"),
                calls(call("call_0", "read_file", path="b.txt")),
                says("two"),
            ]
        )
        workspace = h.tmp_path / "home" / "dot" / "workspace"
        (workspace / "a.txt").write_bytes(b"alpha\n")
        (workspace / "b.txt").write_bytes(b"beta\n")
        h.accept("in1")
        await h.run(chat_unit())
        h.accept("in2", "again")
        assert (await h.run(chat_unit("again", "in2"))).kind == "completed"

        # The request after the second call carries both results, each after the call that made it.
        history = h.provider.requests[3]["messages"][1:]
        assert [m["role"] for m in history] == ["user", "assistant", "tool", "assistant", "user", "assistant", "tool"]
        assert "alpha" in history[2]["content"] and "beta" in history[6]["content"]

    async def test_other_arguments_than_the_approved_ones_park_anew(self, make_harness: MakeHarness) -> None:
        h = make_harness([calls(call("c1", "write_file", path="a.txt", content="x"))], {"files.write": "ask"})
        h.accept("in1")
        await h.run(chat_unit())
        first = approval_of(h)
        h.store.write(lambda conn: s.advance_approval(conn, first.approval_id, "pending", "approved"))
        h.store.write(lambda conn: s.advance_approval(conn, first.approval_id, "approved", "granted"))
        h.provider.script += [calls(call("c2", "write_file", path="a.txt", content="DIFFERENT"))]

        outcome = await h.run(TurnUnit(CHAT, None, (OpeningMessage("approved"),)))

        assert outcome.kind == "parked"
        assert not (h.tmp_path / "home" / "dot" / "workspace" / "a.txt").exists()
        approvals = h.store.read(lambda conn: s.list_approvals(conn, "pending"))
        assert [a.arguments["content"] for a in approvals] == ["DIFFERENT"]
        assert h.store.read(lambda conn: s.get_approval(conn, first.approval_id)).status == "granted"


class TestToolTargets:
    """`tool.called` names what each call acted on (architecture 5.4, 8.3), from the arguments the runner passed."""

    async def test_each_call_reports_the_target_of_its_tool(self, make_harness: MakeHarness) -> None:
        h = make_harness(
            [
                calls(call("c1", "write_file", path="/home/dot/workspace/a.txt", content="HUNTER2 BODY")),
                calls(call("c2", "read_file", path="/home/dot/workspace/a.txt")),
                calls(call("c3", "grep", pattern="HUNTER2", path="/home/dot/workspace")),
                calls(
                    call(
                        "c4",
                        "apply_patch",
                        edits=[
                            {"path": "/home/dot/workspace/b.txt", "action": "add", "new_text": "x"},
                            {"path": "/home/dot/workspace/c.txt", "action": "add", "new_text": "y"},
                        ],
                    )
                ),
                says("done"),
            ],
            {"files.read": "allow", "files.write": "allow"},
        )
        h.accept("in1")

        outcome = await h.run(chat_unit())

        assert outcome.kind == "completed"
        assert [(c["tool"], c["ok"], c.get("target")) for c in h.events_of("tool.called")] == [
            ("write_file", True, "/home/dot/workspace/a.txt"),
            ("read_file", True, "/home/dot/workspace/a.txt"),
            ("grep", True, "HUNTER2"),
            ("apply_patch", True, "2 files, first /home/dot/workspace/b.txt"),
        ]
        assert "HUNTER2 BODY" not in str(h.events())

    async def test_a_command_is_shown_by_its_first_line(
        self, make_harness: MakeHarness
    ) -> None:
        h = make_harness(
            [
                calls(call("c1", "exec", command="curl https://e.com/x\necho second")),
                says("done"),
            ],
            {"computer.exec": "allow"},
        )
        h.accept("in1")

        await h.run(chat_unit())

        (called,) = h.events_of("tool.called")
        assert called["tool"] == "exec"
        assert called["target"] == "curl https://e.com/x"

    async def test_a_command_run_in_a_terminal_says_so_and_one_that_was_not_does_not(
        self, make_harness: MakeHarness
    ) -> None:
        h = make_harness(
            [
                calls(call("c1", "exec", command="python3 -q", tty=True)),
                calls(call("c2", "exec", command="echo hi")),
                says("done"),
            ],
            {"computer.exec": "allow"},
        )
        h.accept("in1")

        await h.run(chat_unit())

        assert [(c["target"], c.get("tty")) for c in h.events_of("tool.called")] == [
            ("python3 -q", True),
            ("echo hi", None),
        ]

    async def test_a_task_call_that_fails_still_names_its_target(self, make_harness: MakeHarness) -> None:
        h = make_harness([calls(call("c1", "read_file", path="/home/dot/workspace/missing.txt")), says("done")], {"files.read": "allow"})
        session = h.start_task()

        await h.run(TurnUnit(session, "t1", (OpeningMessage("do it"),)))

        (called,) = h.events_of("tool.called")
        assert (called["task_id"], called["ok"], called["target"]) == ("t1", False, "/home/dot/workspace/missing.txt")

    async def test_the_intent_row_is_gone_once_the_result_reported_it(self, make_harness: MakeHarness) -> None:
        h = make_harness([calls(call("c1", "read_file", path="/home/dot/workspace/a.txt")), says("done")], {"files.read": "allow"})
        h.accept("in1")

        await h.run(chat_unit())

        assert h.store.read(lambda conn: conn.execute("SELECT COUNT(*) FROM dots_tool_intents").fetchone()[0]) == 0


class TestOffering:
    async def test_the_tools_offered_follow_the_permission_map(self, make_harness: MakeHarness) -> None:
        h = make_harness(
            [says("ok")],
            {"files.read": "allow", "files.write": "ask", "computer.exec": "deny"},
        )
        h.accept("in1")
        await h.run(chat_unit())

        assert h.provider.tool_names == [
            ["apply_patch", "edit_file", "find_files", "grep", "list_dir", "read_file", "write_file"]
        ]

    async def test_a_tool_that_is_not_offered_cannot_be_called(self, make_harness: MakeHarness) -> None:
        h = make_harness([calls(call("c1", "exec", command="echo hi")), says("ok")], {"files.read": "allow"})
        h.accept("in1")

        await h.run(chat_unit())

        message = h.messages()[2]
        assert "not found" in message["content"]
        assert ("tool_started", "exec") not in h.host.events

    async def test_a_call_that_fails_before_the_gate_is_reported_as_a_failed_allow(
        self, make_harness: MakeHarness
    ) -> None:
        # As the contract reported it: the gate decides a call that exists, so a call to a tool that
        # is not offered (or one whose arguments do not fit) has no decision, and `tool.called` says
        # allow with ok false. The gate's own denial of a tool outside the table is for a gate
        # asked directly (test_gate.py).
        h = make_harness(
            [calls(call("c1", "exec", command="echo hi"), call("c2", "read_file")), says("ok")],
            {"files.read": "allow"},
        )
        h.accept("in1")

        await h.run(chat_unit())

        assert h.events_of("tool.called") == [
            {"tool": "exec", "permission": "computer.exec", "decision": "allow", "ok": False, "duration_ms": 0},
            {"tool": "read_file", "permission": "files.read", "decision": "allow", "ok": False, "duration_ms": 0},
        ]

    async def test_the_memory_notes_are_named_newest_first_whatever_the_permissions(
        self, make_harness: MakeHarness
    ) -> None:
        h = make_harness([says("ok"), says("ok")])
        memory = h.tmp_path / "home" / "dot" / "memory"
        memory.mkdir(parents=True)
        for index in range(25):
            note = memory / f"note-{index:02d}.md"
            note.write_bytes(b"x")
            stamp = datetime(2026, 1, 1, tzinfo=timezone.utc).timestamp() + index * 60
            os.utime(note, (stamp, stamp))
        h.accept("in1")
        await h.run(chat_unit())

        system = h.provider.requests[0]["messages"][0]["content"]
        listed = system.split("Most recently changed notes: ")[1].split(".\n")[0].split(", ")
        assert listed == [f"note-{index:02d}.md" for index in range(24, 4, -1)]
        assert "Your long-term memory is /home/dot/memory" in system

        # The memory is the Dot's own, not a setting: a Dot that may only read files is still told of it.
        h.config = parse_runtime_config({**h.config.model_dump(exclude_unset=True), "permissions": {"files.read": "allow"}})
        h.accept("in2")
        await h.run(chat_unit("again", "in2"))
        assert "Most recently changed notes: note-24.md" in h.provider.requests[1]["messages"][0]["content"]


class TestWhatIsNeverSent:
    async def test_engine_metadata_never_reaches_the_model(self, make_harness: MakeHarness) -> None:
        h = make_harness([calls(call("c1", "read_file", path="missing.txt")), says("ok")])
        h.accept("in1")
        h.accept("in2", "and this")
        h.injections = [[OpeningMessage("and this", {INBOUND_ID: "in2"})]]

        await h.run(chat_unit())

        # The metadata is in the database...
        assert METADATA_KEY in json.dumps(h.messages())
        # ...and in none of the requests, which also carry none of the engine's keys.
        sent = json.dumps(h.provider.requests)
        # As keys (`"_dots"`): the prompt names paths, and a path may hold the same letters.
        assert all(f'"{key}"' not in sent for key in (METADATA_KEY, INBOUND_ID, "is_error"))
        assert all(set(m) <= {"role", "content", "tool_calls", "tool_call_id", "name"} for r in h.provider.requests for m in r["messages"])

    async def test_the_provider_is_asked_for_with_the_key_and_the_models_of_the_config(
        self, make_harness: MakeHarness
    ) -> None:
        h = make_harness([says("ok")])
        h.accept("in1")
        await h.run(chat_unit())

        assert h.providers.asked == [(KEY, "z-ai/glm-5.3-flash", None)]


class TestHowATurnFails:
    async def test_an_error_answer_from_the_model_fails_the_turn_with_its_text(self, make_harness: MakeHarness) -> None:
        h = make_harness([LLMResponse(content="provider exploded", finish_reason="error")])
        h.accept("in1")

        outcome = await h.run(chat_unit())

        assert outcome == TurnOutcome.failed("provider exploded")
        # The transcript stays legal, the chat is not answered here: the engine says why.
        assert roles(h.messages()) == ["user", "assistant"]
        assert h.events() == []
        assert h.inbound_state("in1") == "in_transcript"

    async def test_limits_that_cannot_be_read_fail_the_turn_in_words_and_ask_nothing(
        self, make_harness: MakeHarness
    ) -> None:
        h = make_harness([says("never")])

        async def unreachable(model: str) -> ModelLimits:
            raise ConnectionError("openrouter.ai did not answer")

        h.provider.model_limits = unreachable  # type: ignore[method-assign]
        h.accept("in1")

        outcome = await h.run(chat_unit())

        assert outcome == TurnOutcome.failed(
            "could not read the limits of the model z-ai/glm-5.3-flash from OpenRouter: openrouter.ai did not answer"
        )
        assert h.provider.requests == []

    async def test_every_request_of_a_turn_sends_the_longest_answer_of_its_model(self, make_harness: MakeHarness) -> None:
        h = make_harness([says("ok")])
        h.provider.default_limits = ModelLimits(context_tokens=1_000_000, answer_tokens=64_000)
        h.accept("in1")

        await h.run(chat_unit())

        assert [request["max_tokens"] for request in h.provider.requests] == [64_000]

    async def test_an_exception_fails_the_turn_with_its_message(self, make_harness: MakeHarness) -> None:
        h = make_harness([RuntimeError("the connection broke")])
        h.accept("in1")

        outcome = await h.run(chat_unit())

        assert outcome == TurnOutcome.failed("the connection broke")
        assert h.messages()[0]["content"] == "hello"

    async def test_an_empty_answer_fails_the_turn_without_an_answer(self, make_harness: MakeHarness) -> None:
        h = make_harness([says(""), says(""), says("")])
        h.accept("in1")

        outcome = await h.run(chat_unit())

        assert outcome == TurnOutcome.failed("the run ended without an answer")
        assert h.events_of("message.assistant") == []

    async def test_the_key_is_in_no_log_line_of_a_turn_that_failed(self, make_harness: MakeHarness) -> None:
        from loguru import logger

        h = make_harness([RuntimeError("the connection broke")])
        h.accept("in1")
        lines: list[str] = []
        # The strictest sink: tracebacks with the values of the variables of every frame.
        sink = logger.add(
            lines.append, format="{message}\n{exception}", diagnose=True, backtrace=True, level="DEBUG"
        )
        try:
            outcome = await h.run(chat_unit())
        finally:
            logger.remove(sink)

        assert outcome == TurnOutcome.failed("the connection broke")
        logged = "".join(lines)
        assert "the connection broke" in logged
        assert KEY not in logged

    async def test_without_a_key_nothing_is_committed(self, make_harness: MakeHarness) -> None:
        h = make_harness([])
        h.keys = type(h.keys)()
        h.runner._key_holder = h.keys

        outcome = await h.run(chat_unit())

        assert outcome == TurnOutcome.failed("the OpenRouter key has not arrived yet")
        assert h.messages() == []

    async def test_without_a_config_nothing_is_committed(self, make_harness: MakeHarness) -> None:
        h = make_harness([])
        h.config = None

        outcome = await h.run(chat_unit())

        assert outcome == TurnOutcome.failed("the Dot has no configuration yet")
        assert h.messages() == []


class TestHowATurnIsStopped:
    async def test_a_suspending_engine_abandons_the_turn_before_it_asks_the_model(
        self, make_harness: MakeHarness
    ) -> None:
        h = make_harness([])
        h.host.suspending = True
        h.accept("in1")

        outcome = await h.run(chat_unit())

        assert outcome == TurnOutcome("abandoned")
        assert h.provider.requests == []
        # What was opened stays in the transcript, owed an answer.
        assert [m["content"] for m in h.messages()] == ["hello"]
        assert h.inbound_state("in1") == "in_transcript"

    async def test_the_turn_is_abandoned_between_a_tools_result_and_the_next_request(
        self, make_harness: MakeHarness
    ) -> None:
        h = make_harness([calls(call("c1", "list_dir", path="."))])
        h.host.on_tool_started = lambda intent: setattr(h.host, "suspending", True)
        h.accept("in1")

        outcome = await h.run(chat_unit())

        assert outcome == TurnOutcome("abandoned")
        assert len(h.provider.requests) == 1
        # The call that was running finished and its result is committed.
        assert roles(h.messages()) == ["user", "assistant", "tool"]
        assert [kind for kind, _ in h.events()] == ["tool.called"]

    async def test_a_cancelled_turn_propagates_the_cancellation(self, make_harness: MakeHarness) -> None:
        h = make_harness([asyncio.CancelledError()])
        h.accept("in1")

        with pytest.raises(asyncio.CancelledError):
            await h.run(chat_unit())


class TestTheStartOfATurn:
    async def test_calls_the_previous_unit_left_open_are_closed_before_the_opening_message(
        self, make_harness: MakeHarness
    ) -> None:
        h = make_harness([says("recovered")])
        assistant = {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {"id": "c1", "type": "function", "function": {"name": "exec", "arguments": "{}"}},
                {"id": "c2", "type": "function", "function": {"name": "read_file", "arguments": "{}"}},
            ],
        }
        h.store.write(
            lambda conn: s.append_messages(conn, CHAT, [{"role": "user", "content": "go"}, assistant], final_index=None)
        )
        h.store.write(lambda conn: s.record_tool_intent(conn, s.ToolIntent("c1", "exec", CHAT, None, s.clock_ms())))
        h.accept("in1")

        outcome = await h.run(chat_unit("are you there?"))

        assert outcome.kind == "completed"
        messages = h.messages()
        assert roles(messages) == ["user", "assistant", "tool", "tool", "user", "assistant"]
        interrupted, not_run = messages[2], messages[3]
        assert interrupted["tool_call_id"] == "c1" and interrupted[METADATA_KEY][CLOSED] == CLOSED_INTERRUPTED
        assert "interrupted before its result was recorded" in interrupted["content"]
        assert not_run["tool_call_id"] == "c2" and not_run[METADATA_KEY][CLOSED] == CLOSED_NOT_RUN
        (called,) = h.events_of("tool.called")
        assert (called["tool"], called["ok"], called["interrupted"], called["duration_ms"]) == ("exec", False, True, 0)
        # The model was asked with every call answered.
        assert roles(h.provider.requests[0]["messages"]) == ["system", "user", "assistant", "tool", "tool", "user"]


NO_COST_TEXT = (
    "stopped: OpenRouter reported no cost for a request, so limits.max_cost_per_task_usd cannot be enforced"
)


def cap_limits(cap: float) -> dict[str, Any]:
    return {"max_steps_per_task": 60, "max_cost_per_task_usd": cap}


def cap_text(spent: str, cap: str, what: str = "task") -> str:
    return f"stopped: the {what} reached limits.max_cost_per_task_usd (spent {spent} USD of {cap})"


class TestTheCostCap:
    async def test_a_task_that_spent_the_cap_stops_before_the_next_request(self, make_harness: MakeHarness) -> None:
        h = make_harness(
            [
                calls(call("c1", "list_dir", path="."), cost=0.006),
                calls(call("c2", "list_dir", path="."), cost=0.006),
                says("never asked", cost=0.006),
            ],
            limits=cap_limits(0.01),
        )
        session = h.start_task()

        outcome = await h.run(TurnUnit(session, "t1", (OpeningMessage("do it"),)))

        assert outcome == TurnOutcome.failed(cap_text("0.0120", "0.01"))
        assert len(h.provider.requests) == 2
        # Both calls were answered before it stopped, and the task is the engine's to fail, not this turn's.
        assert roles(h.messages(session)) == ["user", "assistant", "tool", "assistant", "tool"]
        assert [kind for kind, _ in h.events()] == ["tool.called", "tool.called"]

    async def test_the_answer_that_crosses_the_cap_is_delivered(self, make_harness: MakeHarness) -> None:
        h = make_harness([says("the summary", cost=5.0)], limits=cap_limits(0.01))
        session = h.start_task()

        outcome = await h.run(TurnUnit(session, "t1", (OpeningMessage("do it"),)))

        assert outcome.kind == "completed"
        assert h.events() == [("task.completed", {"task_id": "t1", "summary": "the summary", "spent_usd": 5.0})]
        assert h.store.read(lambda conn: s.get_spend(conn, session)) == 5.0

    async def test_the_events_of_a_task_turn_report_what_the_task_has_spent_so_far(
        self, make_harness: MakeHarness
    ) -> None:
        h = make_harness(
            [
                calls(call("c1", "list_dir", path="."), text="Listing first.", cost=0.25),
                calls(call("c2", "list_dir", path="."), text="And once more.", cost=0.5),
                says("the summary", cost=0.125),
            ]
        )
        session = h.start_task()

        outcome = await h.run(TurnUnit(session, "t1", (OpeningMessage("do it"),)))

        assert outcome.kind == "completed"
        assert [(kind, data["spent_usd"]) for kind, data in h.events() if kind != "tool.called"] == [
            ("task.progress", 0.25),
            ("task.progress", 0.75),
            ("task.completed", 0.875),
        ]

    async def test_the_answer_of_a_chat_turn_reports_what_that_turn_spent(self, make_harness: MakeHarness) -> None:
        h = make_harness([calls(call("c1", "list_dir", path="."), cost=0.25), says("done", cost=0.5)])
        h.accept("in1")

        await h.run(chat_unit())

        assert [(kind, data["spent_usd"]) for kind, data in h.events() if kind == "message.assistant"] == [
            ("message.assistant", 0.75)
        ]

    async def test_a_chat_turn_says_the_turn_and_keeps_its_transcript_legal(self, make_harness: MakeHarness) -> None:
        h = make_harness(
            [calls(call("c1", "list_dir", path="."), cost=0.6), calls(call("c2", "list_dir", path="."), cost=0.6)],
            limits=cap_limits(1),
        )
        h.accept("in1")

        outcome = await h.run(chat_unit())

        assert outcome == TurnOutcome.failed(cap_text("1.2000", "1.00", "turn"))
        assert len(h.provider.requests) == 2
        assert roles(h.messages()) == ["user", "assistant", "tool", "assistant", "tool"]

    async def test_a_summary_request_counts_toward_the_cap(
        self, make_harness: MakeHarness, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def four_characters_a_token(provider: Any, model: str, messages: list[dict[str, Any]], tools: Any) -> Any:
            # The thread the test sizes, not the engine's own prompt, which grows with what it teaches the model.
            return sum(len(json.dumps(message)) for message in messages if message.get("role") != "system") // 4, "test"

        for module in ("nanobot.agent.context_governance", "nanobot.agent.memory"):
            monkeypatch.setattr(f"{module}.estimate_prompt_tokens_chain", four_characters_a_token)
        # The request, the summary the next request needs, the request after it. The requests alone cost
        # 0.005 and the summary 0.007: only with the summary counted is the cap met before the fourth.
        h = make_harness(
            [
                calls(call("c1", "read_file", path="big.txt"), cost=0.004),
                says("summary of the history", cost=0.007),
                calls(call("c2", "read_file", path="big.txt"), cost=0.001),
                says("never asked", cost=0.001),
            ],
            {"files.read": "allow"},
            max_tokens=500,
            limits=cap_limits(0.01),
        )
        h.provider.default_limits = replace(h.provider.default_limits, context_tokens=2500)
        (h.tmp_path / "home" / "dot" / "workspace" / "big.txt").write_bytes(b"z" * 800)
        old = [
            {"role": "user", "content": "q1 " + "x" * 700},
            {"role": "assistant", "content": "a1 " + "y" * 700},
            {"role": "user", "content": "q2 " + "x" * 700},
            {"role": "assistant", "content": "a2 " + "y" * 700},
        ]
        h.store.write(lambda conn: s.append_messages(conn, CHAT, old, final_index=None))
        h.accept("in1")

        outcome = await h.run(chat_unit("read big.txt"))

        assert outcome == TurnOutcome.failed(cap_text("0.0120", "0.01", "turn"))
        assert len(h.provider.requests) == 3

    async def test_a_response_with_no_cost_fails_the_turn_closed(self, make_harness: MakeHarness) -> None:
        h = make_harness([calls(call("c1", "list_dir", path=".")), says("never asked")], limits=cap_limits(1))
        h.provider.default_cost = None
        session = h.start_task()

        outcome = await h.run(TurnUnit(session, "t1", (OpeningMessage("do it"),)))

        assert outcome == TurnOutcome.failed(
            "stopped: OpenRouter reported no cost for a request, so limits.max_cost_per_task_usd cannot be enforced"
        )
        assert len(h.provider.requests) == 1

    async def test_the_tool_calls_of_a_response_with_no_cost_do_not_run(self, make_harness: MakeHarness) -> None:
        h = make_harness([calls(call("c1", "list_dir", path=".")), says("never asked")], limits=cap_limits(1))
        h.provider.default_cost = None
        session = h.start_task()

        outcome = await h.run(TurnUnit(session, "t1", (OpeningMessage("do it"),)))

        assert outcome == TurnOutcome.failed(NO_COST_TEXT)
        assert len(h.provider.requests) == 1
        # The turn does not act on a response it could not price: no call was recorded or run.
        assert roles(h.messages(session)) == ["user"]
        assert h.events_of("tool.called") == []

    async def test_a_final_answer_with_no_cost_fails_the_task_instead_of_completing_it(
        self, make_harness: MakeHarness
    ) -> None:
        h = make_harness([says("all done")], limits=cap_limits(1))
        h.provider.default_cost = None
        session = h.start_task()

        outcome = await h.run(TurnUnit(session, "t1", (OpeningMessage("do it"),)))

        assert outcome == TurnOutcome.failed(NO_COST_TEXT)
        assert len(h.provider.requests) == 1
        # The answer is what completes a task: it was not written.
        assert h.events_of("task.completed") == []

    async def test_a_final_answer_with_no_cost_fails_the_chat_turn(
        self, make_harness: MakeHarness
    ) -> None:
        h = make_harness([says("hello back")], limits=cap_limits(1))
        h.provider.default_cost = None
        h.accept("in1")

        outcome = await h.run(chat_unit())

        assert outcome == TurnOutcome.failed(NO_COST_TEXT)
        # The answer was not delivered, and the ledger remembers: the chat does not run on unmetered.
        assert h.events_of("message.assistant") == []
        assert h.store.read(lambda conn: s.has_unpriced(conn, CHAT)) is True

    async def test_the_spend_of_a_task_is_there_for_the_next_turn_on_it(self, make_harness: MakeHarness) -> None:
        h = make_harness(
            [calls(call("c1", "list_dir", path="."), cost=0.006), RuntimeError("the connection broke")],
            limits=cap_limits(0.01),
        )
        session = h.start_task()
        assert (await h.run(TurnUnit(session, "t1", (OpeningMessage("do it"),)))) == TurnOutcome.failed(
            "the connection broke"
        )

        # The turn that resumes it (after a restart, as the engine resumes a running task) starts from that spend.
        h.provider.script += [calls(call("c2", "list_dir", path="."), cost=0.006), says("never asked")]
        outcome = await h.run(TurnUnit(session, "t1", (OpeningMessage("resume"),)))

        assert outcome == TurnOutcome.failed(cap_text("0.0120", "0.01"))
        assert len(h.provider.requests) == 3

    async def test_the_turn_that_tells_a_task_its_approval_stops_at_once_when_the_cap_was_spent(
        self, make_harness: MakeHarness
    ) -> None:
        h = make_harness(
            [calls(call("c1", "write_file", path="a.txt", content="x"), cost=0.02)],
            {"files.write": "ask"},
            limits=cap_limits(0.01),
        )
        session = h.start_task()
        assert (await h.run(TurnUnit(session, "t1", (OpeningMessage("do it"),)))).kind == "parked"
        approval = approval_of(h)
        h.store.write(lambda conn: s.advance_approval(conn, approval.approval_id, "pending", "approved"))
        h.store.write(lambda conn: s.advance_approval(conn, approval.approval_id, "approved", "granted"))
        h.provider.script += [says("never asked")]
        opening = OpeningMessage("approved", {"dots_approval_id": approval.approval_id})

        outcome = await h.run(TurnUnit(session, "t1", (opening,), approval.approval_id))

        assert outcome == TurnOutcome.failed(cap_text("0.0200", "0.01"))
        assert len(h.provider.requests) == 1
        assert not (h.tmp_path / "home" / "dot" / "workspace" / "a.txt").exists()

    async def test_the_chat_starts_every_answer_with_nothing_spent(self, make_harness: MakeHarness) -> None:
        h = make_harness([says("one", cost=0.9), says("two", cost=0.9)], limits=cap_limits(1))
        h.accept("in1")
        assert (await h.run(chat_unit())).kind == "completed"
        # The answer took what the turn spent with it.
        assert h.store.read(lambda conn: s.get_spend(conn, CHAT)) == 0.0

        h.accept("in2")
        outcome = await h.run(chat_unit("again", "in2"))

        assert outcome.kind == "completed"
        assert h.store.read(lambda conn: s.get_spend(conn, CHAT)) == 0.0
        assert [data["spent_usd"] for data in h.events_of("message.assistant")] == [0.9, 0.9]

    async def test_the_cap_is_the_one_the_settings_have_when_the_turn_starts(self, make_harness: MakeHarness) -> None:
        h = make_harness(
            [calls(call("c1", "list_dir", path="."), cost=0.4), says("done", cost=0.4)], limits=cap_limits(1)
        )
        h.accept("in1")
        h.settings_override = {"max_cost_usd": 0.3}

        outcome = await h.run(chat_unit())

        assert outcome == TurnOutcome.failed(cap_text("0.4000", "0.30", "turn"))
