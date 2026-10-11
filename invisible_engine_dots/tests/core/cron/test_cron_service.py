import asyncio
import calendar
import json
import time
from datetime import datetime
from pathlib import Path

import pytest

from nanobot.cron.service import CronJobSkippedError, CronService
from nanobot.cron.types import MAX_RUN_AT_MS, CronJob, CronSchedule


async def _wait_until(predicate, *, timeout: float = 1.0, interval: float = 0.01) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        await asyncio.sleep(interval)
    assert predicate()


def _ticking_service(store_path: Path, on_job=None) -> CronService:
    """A service that owns its store, as a started one does, and whose timer the test fires (`_tick_due`)."""
    service = CronService(store_path, on_job=on_job)
    service._running = True
    service._load_store()
    service._arm_timer = lambda: None
    return service


async def _tick_due(service: CronService, job_id: str) -> None:
    """Make a job due and fire the timer once: the path every run of a job takes."""
    job = service.get_job(job_id)
    assert job is not None
    job.state.next_run_at_ms = int(time.time() * 1000) - 1
    service._save_store()
    await service._on_timer()


def test_load_jobs_accepts_snake_case_schedule_and_run_history(tmp_path) -> None:
    store_path = tmp_path / "cron" / "jobs.json"
    store_path.parent.mkdir(parents=True)
    store_path.write_text(
        json.dumps(
            {
                "version": 1,
                "jobs": [
                    {
                        "id": "j1",
                        "name": "t",
                        "enabled": True,
                        "schedule": {"kind": "every", "every_ms": 60_000},
                        "payload": {
                            "kind": "agent_turn",
                            "message": "hi",
                        },
                        "state": {
                            "run_history": [
                                {"run_at_ms": 1000, "status": "ok", "duration_ms": 12},
                            ],
                        },
                        "created_at_ms": 0,
                        "updated_at_ms": 0,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    jobs, _version = CronService(store_path)._load_jobs()
    assert jobs is not None
    assert jobs[0].schedule.every_ms == 60_000
    assert jobs[0].state.run_history[0].run_at_ms == 1000
    assert jobs[0].state.run_history[0].duration_ms == 12


def test_cron_job_from_dict_rejects_malformed_run_history() -> None:
    with pytest.raises(TypeError):
        CronJob.from_dict(
            {
                "id": "j1",
                "name": "t",
                "state": {"run_history": [None]},
            }
        )


def test_load_jobs_coerces_string_schedule_and_state_ms(tmp_path) -> None:
    store_path = tmp_path / "cron" / "jobs.json"
    store_path.parent.mkdir(parents=True)
    store_path.write_text(
        json.dumps(
            {
                "version": 1,
                "jobs": [
                    {
                        "id": "j1",
                        "name": "t",
                        "enabled": True,
                        "schedule": {"kind": "every", "everyMs": "60000"},
                        "payload": {
                            "kind": "agent_turn",
                            "message": "hi",
                            "sessionKey": "websocket:chat-1",
                        },
                        "state": {
                            "nextRunAtMs": "100",
                            "lastRunAtMs": "50",
                        },
                        "createdAtMs": 0,
                        "updatedAtMs": 0,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    jobs, _version = CronService(store_path)._load_jobs()
    assert jobs is not None
    assert jobs[0].schedule.every_ms == 60_000
    assert jobs[0].state.next_run_at_ms == 100
    assert jobs[0].state.last_run_at_ms == 50


def test_add_job_rejects_unknown_timezone(tmp_path) -> None:
    service = CronService(tmp_path / "cron" / "jobs.json")

    with pytest.raises(ValueError, match="unknown timezone 'America/Vancovuer'"):
        service.add_job(
            name="tz typo",
            schedule=CronSchedule(kind="cron", expr="0 9 * * *", tz="America/Vancovuer"),
            message="hello",
        )

    assert service.list_jobs(include_disabled=True) == []


def test_add_job_accepts_valid_timezone(tmp_path) -> None:
    service = CronService(tmp_path / "cron" / "jobs.json")

    job = service.add_job(
        name="tz ok",
        schedule=CronSchedule(kind="cron", expr="0 9 * * *", tz="America/Vancouver"),
        message="hello",
    )

    assert job.schedule.tz == "America/Vancouver"
    assert job.state.next_run_at_ms is not None


@pytest.mark.parametrize("expr", [None, "", "   "])
def test_add_job_rejects_missing_cron_expression(tmp_path, expr: str | None) -> None:
    service = CronService(tmp_path / "cron" / "jobs.json")

    with pytest.raises(ValueError, match="requires a non-empty 'expr'"):
        service.add_job(
            name="missing expression",
            schedule=CronSchedule(kind="cron", expr=expr),
            message="hello",
        )

    assert service.list_jobs(include_disabled=True) == []


@pytest.mark.parametrize("every_ms", [None, 0, -60_000])
def test_add_job_rejects_non_positive_interval(tmp_path, every_ms: int | None) -> None:
    service = CronService(tmp_path / "cron" / "jobs.json")

    with pytest.raises(ValueError, match="requires a positive 'every_ms'"):
        service.add_job(
            name="never runs",
            schedule=CronSchedule(kind="every", every_ms=every_ms),
            message="hello",
        )

    assert service.list_jobs(include_disabled=True) == []


def test_add_job_rejects_invalid_cron_expression_before_persisting(tmp_path) -> None:
    service = CronService(tmp_path / "cron" / "jobs.json")

    with pytest.raises(ValueError, match="invalid cron expression"):
        service.add_job(
            name="bad expression",
            schedule=CronSchedule(kind="cron", expr="not a cron expression"),
            message="hello",
        )

    assert service.list_jobs(include_disabled=True) == []


@pytest.mark.asyncio
async def test_execute_job_records_run_history(tmp_path) -> None:
    store_path = tmp_path / "cron" / "jobs.json"
    service = _ticking_service(store_path, on_job=lambda _: asyncio.sleep(0))
    job = service.add_job(
        name="hist",
        schedule=CronSchedule(kind="every", every_ms=60_000),
        message="hello",
    )
    await _tick_due(service, job.id)

    loaded = service.get_job(job.id)
    assert loaded is not None
    assert len(loaded.state.run_history) == 1
    rec = loaded.state.run_history[0]
    assert rec.status == "ok"
    assert rec.duration_ms >= 0
    assert rec.error is None


@pytest.mark.asyncio
async def test_run_history_records_errors(tmp_path) -> None:
    store_path = tmp_path / "cron" / "jobs.json"

    async def fail(_):
        raise RuntimeError("boom")

    service = _ticking_service(store_path, on_job=fail)
    job = service.add_job(
        name="fail",
        schedule=CronSchedule(kind="every", every_ms=60_000),
        message="hello",
    )
    await _tick_due(service, job.id)

    loaded = service.get_job(job.id)
    assert len(loaded.state.run_history) == 1
    assert loaded.state.run_history[0].status == "error"
    assert loaded.state.run_history[0].error == "boom"


@pytest.mark.asyncio
async def test_run_history_records_skipped_jobs(tmp_path) -> None:
    store_path = tmp_path / "cron" / "jobs.json"

    async def skip(_):
        raise CronJobSkippedError("missing session binding")

    service = _ticking_service(store_path, on_job=skip)
    job = service.add_job(
        name="skip",
        schedule=CronSchedule(kind="every", every_ms=60_000),
        message="hello",
    )
    await _tick_due(service, job.id)

    loaded = service.get_job(job.id)
    assert loaded is not None
    assert loaded.state.last_status == "skipped"
    assert loaded.state.last_error == "missing session binding"
    assert len(loaded.state.run_history) == 1
    assert loaded.state.run_history[0].status == "skipped"
    assert loaded.state.run_history[0].error == "missing session binding"


@pytest.mark.asyncio
async def test_run_history_records_job_cancellation(tmp_path) -> None:
    store_path = tmp_path / "cron" / "jobs.json"

    async def cancel(_):
        raise asyncio.CancelledError("turn cancelled")

    service = _ticking_service(store_path, on_job=cancel)
    job = service.add_job(
        name="cancel",
        schedule=CronSchedule(kind="every", every_ms=60_000),
        message="hello",
    )

    await _tick_due(service, job.id)

    loaded = service.get_job(job.id)
    assert loaded is not None
    assert loaded.state.last_status == "error"
    assert loaded.state.last_error == "turn cancelled"
    assert len(loaded.state.run_history) == 1
    assert loaded.state.run_history[0].status == "error"
    assert loaded.state.run_history[0].error == "turn cancelled"
    assert loaded.state.next_run_at_ms is not None


@pytest.mark.asyncio
async def test_run_history_trimmed_to_max(tmp_path) -> None:
    store_path = tmp_path / "cron" / "jobs.json"
    service = _ticking_service(store_path, on_job=lambda _: asyncio.sleep(0))
    job = service.add_job(
        name="trim",
        schedule=CronSchedule(kind="every", every_ms=60_000),
        message="hello",
    )
    for _ in range(25):
        await _tick_due(service, job.id)

    loaded = service.get_job(job.id)
    assert len(loaded.state.run_history) == CronService._MAX_RUN_HISTORY


@pytest.mark.asyncio
async def test_run_history_persisted_to_disk(tmp_path) -> None:
    store_path = tmp_path / "cron" / "jobs.json"
    service = _ticking_service(store_path, on_job=lambda _: asyncio.sleep(0))
    job = service.add_job(
        name="persist",
        schedule=CronSchedule(kind="every", every_ms=60_000),
        message="hello",
    )
    await _tick_due(service, job.id)

    raw = json.loads(store_path.read_text())
    history = raw["jobs"][0]["state"]["runHistory"]
    assert len(history) == 1
    assert history[0]["status"] == "ok"
    assert "runAtMs" in history[0]
    assert "durationMs" in history[0]

    fresh = CronService(store_path)
    loaded = fresh.get_job(job.id)
    assert len(loaded.state.run_history) == 1
    assert loaded.state.run_history[0].status == "ok"


@pytest.mark.asyncio
async def test_running_service_honors_external_remove(tmp_path) -> None:
    store_path = tmp_path / "cron" / "jobs.json"
    called: list[str] = []

    async def on_job(job) -> None:
        called.append(job.id)

    service = CronService(store_path, on_job=on_job)
    job = service.add_job(
        name="external-remove",
        schedule=CronSchedule(kind="every", every_ms=200),
        message="hello",
    )
    await service.start()
    try:
        # Remove before yielding back to the event loop. On slower Windows CI
        # a short sleep here can overrun the 200ms schedule and let the job fire
        # before the external update is written.
        external = CronService(store_path)
        assert external.remove_job(job.id) == "removed"

        await asyncio.sleep(0.35)
        assert called == []
    finally:
        service.stop()


@pytest.mark.asyncio
async def test_start_server_not_jobs(tmp_path):
    store_path = tmp_path / "cron" / "jobs.json"
    called = []
    async def on_job(job):
        called.append(job.name)

    service = CronService(store_path, on_job=on_job, max_sleep_ms=100)
    await service.start()
    assert len(service.list_jobs()) == 0

    service2 = CronService(tmp_path / "cron" / "jobs.json")
    service2.add_job(
        name="hist",
        schedule=CronSchedule(kind="every", every_ms=100),
        message="hello",
    )
    assert len(service.list_jobs()) == 1
    await _wait_until(lambda: bool(called), timeout=0.8)
    assert len(called) != 0
    service.stop()


@pytest.mark.asyncio
async def test_subsecond_job_not_delayed_to_one_second(tmp_path):
    store_path = tmp_path / "cron" / "jobs.json"
    called = []

    async def on_job(job):
        called.append(job.name)

    service = CronService(store_path, on_job=on_job, max_sleep_ms=5000)
    service.add_job(
        name="fast",
        schedule=CronSchedule(kind="every", every_ms=100),
        message="hello",
    )
    await service.start()
    try:
        await asyncio.sleep(0.35)
        assert called
    finally:
        service.stop()


@pytest.mark.asyncio
async def test_running_service_picks_up_external_add(tmp_path):
    """A running service should detect and execute a job added by another instance."""
    store_path = tmp_path / "cron" / "jobs.json"
    called: list[str] = []

    async def on_job(job):
        called.append(job.name)

    service = CronService(store_path, on_job=on_job, max_sleep_ms=100)
    service.add_job(
        name="heartbeat",
        schedule=CronSchedule(kind="every", every_ms=100),
        message="tick",
    )
    await service.start()
    try:
        await asyncio.sleep(0.05)

        external = CronService(store_path)
        external.add_job(
            name="external",
            schedule=CronSchedule(kind="every", every_ms=100),
            message="ping",
        )

        await _wait_until(lambda: "external" in called, timeout=0.8)
        assert "external" in called
    finally:
        service.stop()


@pytest.mark.asyncio
async def test_add_job_during_jobs_exec(tmp_path):
    store_path = tmp_path / "cron" / "jobs.json"
    run_once = True

    async def on_job(job):
        nonlocal run_once
        if run_once:
            service2 = CronService(store_path, on_job=lambda x: asyncio.sleep(0))
            service2.add_job(
                name="test",
                schedule=CronSchedule(kind="every", every_ms=150),
                message="tick",
            )
            run_once = False

    service = CronService(store_path, on_job=on_job, max_sleep_ms=100)
    service.add_job(
        name="heartbeat",
        schedule=CronSchedule(kind="every", every_ms=100),
        message="tick",
    )
    assert len(service.list_jobs()) == 1
    await service.start()
    try:
        await _wait_until(lambda: len(service.list_jobs()) == 2, timeout=0.8)
        jobs = service.list_jobs()
        assert len(jobs) == 2
        assert "test" in [j.name for j in jobs]
    finally:
        service.stop()


@pytest.mark.asyncio
async def test_external_change_preserves_run_history_records(tmp_path):
    store_path = tmp_path / "cron" / "jobs.json"
    service = _ticking_service(store_path, on_job=lambda _: asyncio.sleep(0))
    job = service.add_job(
        name="history",
        schedule=CronSchedule(kind="every", every_ms=60_000),
        message="hello",
    )
    other = service.add_job(
        name="other",
        schedule=CronSchedule(kind="every", every_ms=60_000),
        message="hello",
    )
    await _tick_due(service, job.id)

    external = CronService(store_path)
    assert external.remove_job(other.id) == "removed"

    fresh = CronService(store_path)
    loaded = fresh.get_job(job.id)
    assert loaded is not None
    assert loaded.state.run_history
    assert loaded.state.run_history[0].status == "ok"

    fresh._running = True
    fresh._save_store()


def test_stale_instance_remove_preserves_external_add(tmp_path) -> None:
    """A stopped instance must not save a stale snapshot over another instance's job."""
    store_path = tmp_path / "cron" / "jobs.json"
    schedule = CronSchedule(kind="every", every_ms=60_000)
    service_a = CronService(store_path)
    service_b = CronService(store_path)

    first = service_a.add_job(
        name="first",
        schedule=schedule,
        message="first",
    )

    # Prime service_b with a view that does not include later external changes.
    assert [job.name for job in service_b.list_jobs(include_disabled=True)] == ["first"]

    service_a.add_job(
        name="second",
        schedule=schedule,
        message="second",
    )

    assert service_b.remove_job(first.id) == "removed"

    reloaded = CronService(store_path)
    assert [job.name for job in reloaded.list_jobs(include_disabled=True)] == ["second"]


# ── timer race regression tests ──


@pytest.mark.asyncio
async def test_save_store_failure_retries_without_replaying_job(tmp_path, monkeypatch):
    """A failed post-run save must be retried before jobs can execute again."""
    store_path = tmp_path / "cron" / "jobs.json"
    calls: list[str] = []
    arm_calls: list[str] = []

    async def on_job(job):
        calls.append(job.id)

    service = CronService(store_path, on_job=on_job)
    service._running = True
    service._load_store()

    # Spy on _arm_timer so we can assert the scheduler is re-armed even when
    # the tick fails, without actually scheduling a real timer task.
    def arm_spy() -> None:
        arm_calls.append("arm")

    monkeypatch.setattr(service, "_arm_timer", arm_spy)

    job = service.add_job(
        name="persist-failure",
        schedule=CronSchedule(kind="every", every_ms=60_000),
        message="hello",
    )
    job.state.next_run_at_ms = max(1, int(time.time() * 1000) - 1_000)
    service._save_store()
    arm_calls.clear()

    real_atomic_write = service._atomic_write
    save_attempts = 0
    writes_fail = True

    def flaky_atomic_write(path: Path, content: str) -> None:
        nonlocal save_attempts, writes_fail
        save_attempts += 1
        if writes_fail:
            raise OSError("disk full")
        real_atomic_write(path, content)

    monkeypatch.setattr(service, "_atomic_write", flaky_atomic_write)
    await service._on_timer()

    # The failed tick stays alive and retains the advanced in-memory state,
    # including when a public read would normally reload from disk.
    assert arm_calls == ["arm"], "scheduler must re-arm after a failed tick"
    assert service._active_executions == 0
    assert calls == [job.id]
    assert service._store_dirty is True
    loaded = service.get_job(job.id)
    assert loaded is not None
    assert loaded.state.last_run_at_ms is not None

    # The next healthy tick is reserved for persisting the dirty snapshot.  It
    # must not reload the stale due record or execute the side effect twice.
    writes_fail = False
    await service._on_timer()

    assert calls == [job.id]
    assert arm_calls == ["arm", "arm"]
    assert save_attempts == 2
    assert service._store_dirty is False

    persisted = CronService(store_path).get_job(job.id)
    assert persisted is not None
    assert persisted.state.last_run_at_ms is not None
    assert persisted.state.next_run_at_ms is not None
    assert persisted.state.next_run_at_ms > persisted.state.last_run_at_ms


@pytest.mark.asyncio
async def test_timer_execution_is_not_rolled_back_by_list_jobs_reload(tmp_path):
    """list_jobs() during _on_timer should not replace the active store and re-run the same due job."""
    store_path = tmp_path / "cron" / "jobs.json"
    calls: list[str] = []

    async def on_job(job):
        calls.append(job.id)
        # Simulate frontend polling list_jobs while the timer callback is mid-execution.
        service.list_jobs(include_disabled=True)
        await asyncio.sleep(0)

    service = CronService(store_path, on_job=on_job)
    service._running = True
    service._load_store()
    service._arm_timer = lambda: None

    job = service.add_job(
        name="race",
        schedule=CronSchedule(kind="every", every_ms=60_000),
        message="hello",
    )
    job.state.next_run_at_ms = max(1, int(time.time() * 1000) - 1_000)
    service._save_store()

    await service._on_timer()
    await service._on_timer()

    assert calls == [job.id]
    loaded = service.get_job(job.id)
    assert loaded is not None
    assert loaded.state.last_run_at_ms is not None
    assert loaded.state.next_run_at_ms is not None
    assert loaded.state.next_run_at_ms > loaded.state.last_run_at_ms


def test_load_jobs_accepts_null_run_history_ms(tmp_path) -> None:
    store_path = tmp_path / "cron" / "jobs.json"
    store_path.parent.mkdir(parents=True)
    store_path.write_text(
        json.dumps(
            {
                "version": 1,
                "jobs": [
                    {
                        "id": "j1",
                        "name": "t",
                        "enabled": True,
                        "schedule": {"kind": "every", "everyMs": 60_000},
                        "payload": {
                            "kind": "agent_turn",
                            "message": "hi",
                            "sessionKey": "websocket:chat-1",
                        },
                        "state": {
                            "runHistory": [
                                {"runAtMs": None, "status": "ok", "durationMs": None},
                            ],
                        },
                        "createdAtMs": None,
                        "updatedAtMs": None,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    jobs, _version = CronService(store_path)._load_jobs()
    assert jobs is not None
    assert jobs[0].state.run_history[0].run_at_ms == 0
    assert jobs[0].state.run_history[0].duration_ms == 0
    assert jobs[0].state.run_history[0].status == "ok"
    assert jobs[0].created_at_ms == 0
    assert jobs[0].updated_at_ms == 0


def test_load_jobs_skips_null_run_history_elements(tmp_path) -> None:
    """Null runHistory elements must be skipped like LocalTrigger.from_dict."""
    store_path = tmp_path / "cron" / "jobs.json"
    store_path.parent.mkdir(parents=True)
    store_path.write_text(
        json.dumps(
            {
                "version": 1,
                "jobs": [
                    {
                        "id": "j1",
                        "name": "t",
                        "enabled": True,
                        "schedule": {"kind": "every", "everyMs": 60_000},
                        "payload": {
                            "kind": "agent_turn",
                            "message": "hi",
                            "sessionKey": "websocket:chat-1",
                        },
                        "state": {
                            "runHistory": [
                                None,
                                {"runAtMs": 1, "status": "ok", "durationMs": 2},
                            ],
                        },
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    jobs, _version = CronService(store_path)._load_jobs()
    assert jobs is not None
    assert len(jobs[0].state.run_history) == 1
    assert jobs[0].state.run_history[0].run_at_ms == 1
    assert jobs[0].state.run_history[0].status == "ok"


@pytest.mark.asyncio
async def test_list_jobs_during_on_job_does_not_cause_stale_reload(tmp_path) -> None:
    """Regression: if the bot calls list_jobs (which reloads from disk) during
    on_job execution, the in-memory next_run_at_ms update must not be lost.
    Previously this caused an infinite re-trigger loop."""
    store_path = tmp_path / "cron" / "jobs.json"
    execution_count = 0

    async def on_job_that_lists(job):
        nonlocal execution_count
        execution_count += 1
        # Simulate the bot calling cron(action=list) mid-execution
        service.list_jobs()

    service = CronService(store_path, on_job=on_job_that_lists, max_sleep_ms=100)
    await service.start()

    # Add two jobs scheduled in the past so they're immediately due
    now_ms = int(time.time() * 1000)
    for name in ("job-a", "job-b"):
        service.add_job(
            name=name,
            schedule=CronSchedule(kind="every", every_ms=3_600_000),
            message="test",
        )
    # Force next_run to the past so _on_timer picks them up
    for job in service._store.jobs:
        job.state.next_run_at_ms = now_ms - 1000
    service._save_store()
    service._arm_timer()

    # Let the timer fire once
    await asyncio.sleep(0.3)
    service.stop()

    # Each job should have run exactly once, not looped
    assert execution_count == 2

    # Verify next_run_at_ms was persisted correctly (in the future)
    raw = json.loads(store_path.read_text())
    for j in raw["jobs"]:
        next_run = j["state"]["nextRunAtMs"]
        assert next_run is not None
        assert next_run > now_ms, f"Job '{j['name']}' next_run should be in the future"


def test_the_last_moment_a_job_may_run_is_the_last_one_a_datetime_holds() -> None:
    last = calendar.timegm(datetime.max.utctimetuple()) * 1000 + datetime.max.microsecond // 1000
    assert MAX_RUN_AT_MS == last


@pytest.mark.parametrize("every_ms", [8_700_000_000_000_000, MAX_RUN_AT_MS, MAX_RUN_AT_MS - 60_000])
def test_add_job_refuses_an_interval_whose_next_run_is_past_the_last_moment(tmp_path, every_ms: int) -> None:
    """A next run past year 9999 is a time the host cannot store and its web page cannot show: it would stop the Dot's
    whole event stream, so the schedule is refused where the time is made."""
    service = CronService(tmp_path / "cron" / "jobs.json")

    with pytest.raises(ValueError, match="past the year 9999"):
        service.add_job(name="too far", schedule=CronSchedule(kind="every", every_ms=every_ms), message="hello")

    assert service.list_jobs(include_disabled=True) == []


def test_add_job_refuses_a_one_time_job_past_the_last_moment(tmp_path) -> None:
    service = CronService(tmp_path / "cron" / "jobs.json")

    with pytest.raises(ValueError, match="past the year 9999"):
        service.add_job(name="too far", schedule=CronSchedule(kind="at", at_ms=MAX_RUN_AT_MS + 1), message="hello")

    assert service.list_jobs(include_disabled=True) == []


async def test_a_next_run_past_the_last_moment_is_no_next_run(tmp_path) -> None:
    """A job already in a store (written before the bound, or by hand) has no next run rather than one the host cannot hold."""
    store_path = tmp_path / "cron" / "jobs.json"
    store_path.parent.mkdir(parents=True)
    store_path.write_text(json.dumps({"version": 1, "jobs": [{
        "id": "far",
        "name": "too far",
        "enabled": True,
        "schedule": {"kind": "every", "everyMs": 8_700_000_000_000_000},
        "payload": {"kind": "agent_turn", "message": "hello"},
        "state": {},
    }]}), encoding="utf-8")
    service = CronService(store_path)

    await service.start()
    try:
        job = service.get_job("far")
        assert job is not None and job.state.next_run_at_ms is None
        assert service.status()["next_wake_at_ms"] is None
    finally:
        service.stop()


def test_the_last_moment_itself_is_still_a_next_run(tmp_path) -> None:
    service = CronService(tmp_path / "cron" / "jobs.json")

    job = service.add_job(name="last", schedule=CronSchedule(kind="at", at_ms=MAX_RUN_AT_MS), message="hello")

    assert job.state.next_run_at_ms == MAX_RUN_AT_MS
