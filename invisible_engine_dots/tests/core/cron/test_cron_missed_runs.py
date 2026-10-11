"""What the cron service does with the jobs that came due while the process was off, and what it tells its owner.

A Dot's computer powers off when it is idle and the process ends with it. A job whose time passed meanwhile
must run once when the process starts again: a one-time job (it would never run otherwise) and a recurring
one (its last missed occurrence, never one run for each occurrence it missed). The owner of the service is also
told, after every change, when the earliest enabled job is next due, so the host can wake the computer for it.
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

from nanobot.cron.service import CronService
from nanobot.cron.types import CronJob, CronSchedule

HOUR_MS = 3_600_000


def now_ms() -> int:
    return int(time.time() * 1000)


def write_jobs(path: Path, jobs: list[dict[str, object]]) -> None:
    """A jobs.json as an earlier process left it."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(json.dumps({"version": 1, "jobs": jobs}).encode("utf-8"))


def stored_job(job_id: str, schedule: dict[str, object], next_run_at_ms: int | None, **extra: object) -> dict[str, object]:
    return {
        "id": job_id,
        "name": f"name of {job_id}",
        "enabled": True,
        "schedule": schedule,
        "payload": {"kind": "agent_turn", "message": f"do {job_id}"},
        "state": {"nextRunAtMs": next_run_at_ms},
        "createdAtMs": 1,
        "updatedAtMs": 1,
        **extra,
    }


class Fired:
    """The jobs the service ran, in order, with the due time each had when it ran."""

    def __init__(self) -> None:
        self.runs: list[tuple[str, int | None]] = []

    async def on_job(self, job: CronJob) -> None:
        self.runs.append((job.id, job.state.next_run_at_ms))

    @property
    def ids(self) -> list[str]:
        return [job_id for job_id, _ in self.runs]


async def until(predicate, timeout: float = 5.0) -> None:  # type: ignore[no-untyped-def]
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.01)
    assert predicate()


async def tick_done(service: CronService) -> None:
    """The tick that ran the jobs (one was seen running) has finished, its results saved."""
    await until(lambda: service._active_executions == 0)


async def started(path: Path, fired: Fired) -> CronService:
    service = CronService(path, on_job=fired.on_job)
    await service.start()
    return service


class TestJobsMissedWhileOff:
    async def test_a_one_time_job_whose_time_passed_runs_once_at_start(self, tmp_path: Path) -> None:
        path = tmp_path / "cron" / "jobs.json"
        due = now_ms() - 3 * HOUR_MS
        write_jobs(path, [stored_job("remind", {"kind": "at", "atMs": due}, due, deleteAfterRun=False)])
        fired = Fired()

        service = await started(path, fired)
        await until(lambda: fired.ids)
        await tick_done(service)
        service.stop()

        assert fired.runs == [("remind", due)]
        job = service.get_job("remind")
        assert job is not None and job.enabled is False and job.state.next_run_at_ms is None
        assert job.state.last_status == "ok"

    async def test_a_one_time_job_that_deletes_itself_is_gone_after_its_late_run(self, tmp_path: Path) -> None:
        path = tmp_path / "cron" / "jobs.json"
        due = now_ms() - HOUR_MS
        write_jobs(path, [stored_job("once", {"kind": "at", "atMs": due}, due, deleteAfterRun=True)])
        fired = Fired()

        service = await started(path, fired)
        await until(lambda: fired.ids)
        await tick_done(service)
        service.stop()

        assert fired.ids == ["once"]
        assert json.loads(path.read_text(encoding="utf-8"))["jobs"] == []

    async def test_a_recurring_job_that_missed_many_occurrences_runs_once_and_is_next_due_after_now(
        self, tmp_path: Path
    ) -> None:
        path = tmp_path / "cron" / "jobs.json"
        # Every minute, off for a day: 1440 occurrences passed.
        due = now_ms() - 24 * HOUR_MS
        write_jobs(
            path,
            [
                stored_job("minutely", {"kind": "every", "everyMs": 60_000}, due),
                stored_job("cron-minutely", {"kind": "cron", "expr": "* * * * *", "tz": "UTC"}, due),
            ],
        )
        fired = Fired()

        service = await started(path, fired)
        await until(lambda: len(fired.ids) >= 2)
        await tick_done(service)
        service.stop()

        assert sorted(fired.ids) == ["cron-minutely", "minutely"]
        for job_id in ("minutely", "cron-minutely"):
            job = service.get_job(job_id)
            assert job is not None and job.state.next_run_at_ms is not None
            assert job.state.next_run_at_ms > now_ms() - 1_000
            assert len(job.state.run_history) == 1

    async def test_the_missed_run_is_recorded_before_the_service_goes_on(self, tmp_path: Path) -> None:
        path = tmp_path / "cron" / "jobs.json"
        due = now_ms() - HOUR_MS
        write_jobs(path, [stored_job("late", {"kind": "every", "everyMs": 6 * HOUR_MS}, due)])
        fired = Fired()

        service = await started(path, fired)
        await until(lambda: fired.ids)
        await tick_done(service)
        service.stop()

        saved = json.loads(path.read_text(encoding="utf-8"))["jobs"][0]["state"]
        assert saved["lastRunAtMs"] is not None and saved["nextRunAtMs"] > now_ms()

    async def test_a_disabled_job_is_not_run_whatever_time_it_has(self, tmp_path: Path) -> None:
        path = tmp_path / "cron" / "jobs.json"
        due = now_ms() - HOUR_MS
        write_jobs(path, [stored_job("paused", {"kind": "at", "atMs": due}, due, enabled=False)])
        fired = Fired()

        service = await started(path, fired)
        # A tick, which runs every job that is due: none is.
        await service._on_timer()
        service.stop()

        assert fired.runs == []
        assert service.status()["next_wake_at_ms"] is None


class TestJobsNotYetDue:
    async def test_a_job_keeps_the_time_it_was_due_at_across_a_restart(self, tmp_path: Path) -> None:
        path = tmp_path / "cron" / "jobs.json"
        due = now_ms() + 2 * HOUR_MS
        write_jobs(path, [stored_job("later", {"kind": "every", "everyMs": 6 * HOUR_MS}, due)])
        fired = Fired()

        service = await started(path, fired)
        await service._on_timer()
        service.stop()

        assert fired.runs == []
        job = service.get_job("later")
        assert job is not None and job.state.next_run_at_ms == due

    async def test_a_job_that_has_no_time_yet_gets_one_from_now(self, tmp_path: Path) -> None:
        path = tmp_path / "cron" / "jobs.json"
        write_jobs(path, [stored_job("fresh", {"kind": "every", "everyMs": HOUR_MS}, None)])

        service = await started(path, Fired())
        service.stop()

        job = service.get_job("fresh")
        assert job is not None and job.state.next_run_at_ms is not None
        assert abs(job.state.next_run_at_ms - (now_ms() + HOUR_MS)) < 5_000


class TestTheNextRunIsReported:
    """`on_next_wake` hears the earliest next run of the enabled jobs (None: no job is due ever) after every change."""

    def make(self, tmp_path: Path) -> tuple[CronService, list[int | None]]:
        heard: list[int | None] = []
        service = CronService(tmp_path / "cron" / "jobs.json", on_next_wake=heard.append)
        return service, heard

    async def test_start_reports_the_state_it_found(self, tmp_path: Path) -> None:
        service, heard = self.make(tmp_path)
        due = now_ms() + 5 * HOUR_MS
        write_jobs(service.store_path, [stored_job("a", {"kind": "every", "everyMs": 6 * HOUR_MS}, due)])

        await service.start()
        service.stop()

        assert heard[-1] == due

    async def test_start_with_no_job_reports_none(self, tmp_path: Path) -> None:
        service, heard = self.make(tmp_path)

        await service.start()
        service.stop()

        assert heard[-1] is None

    async def test_adding_and_removing_a_job_each_report_the_new_earliest_time(
        self, tmp_path: Path
    ) -> None:
        service, heard = self.make(tmp_path)
        await service.start()
        try:
            soon = service.add_job("soon", CronSchedule(kind="every", every_ms=HOUR_MS), "go")
            assert heard[-1] == soon.state.next_run_at_ms
            far = service.add_job("far", CronSchedule(kind="every", every_ms=10 * HOUR_MS), "go")
            assert heard[-1] == soon.state.next_run_at_ms

            service.remove_job(soon.id)
            assert heard[-1] == far.state.next_run_at_ms
            service.remove_job(far.id)
            assert heard[-1] is None
        finally:
            service.stop()

    async def test_a_firing_reports_the_time_after_it(self, tmp_path: Path) -> None:
        heard: list[int | None] = []
        fired = Fired()
        path = tmp_path / "cron" / "jobs.json"
        due = now_ms() - 1_000
        write_jobs(path, [stored_job("tick", {"kind": "every", "everyMs": 6 * HOUR_MS}, due)])
        service = CronService(path, on_job=fired.on_job, on_next_wake=heard.append)

        await service.start()
        await until(lambda: fired.ids)
        await until(lambda: heard and heard[-1] is not None and heard[-1] > now_ms())
        service.stop()

        job = service.get_job("tick")
        assert job is not None and heard[-1] == job.state.next_run_at_ms

    async def test_a_one_time_job_that_ran_reports_that_nothing_is_due(self, tmp_path: Path) -> None:
        heard: list[int | None] = []
        fired = Fired()
        path = tmp_path / "cron" / "jobs.json"
        due = now_ms() - 1_000
        write_jobs(path, [stored_job("once", {"kind": "at", "atMs": due}, due)])
        service = CronService(path, on_job=fired.on_job, on_next_wake=heard.append)

        await service.start()
        await until(lambda: fired.ids)
        await until(lambda: heard[-1] is None)
        service.stop()

    async def test_a_listener_that_fails_does_not_stop_the_service_and_is_told_again_at_the_next_change(
        self, tmp_path: Path
    ) -> None:
        heard: list[int | None] = []
        failures = [True]

        def listener(at: int | None) -> None:
            if failures:
                failures.pop()
                raise RuntimeError("the store is busy")
            heard.append(at)

        service = CronService(tmp_path / "cron" / "jobs.json", on_next_wake=listener)
        await service.start()
        try:
            job = service.add_job("a", CronSchedule(kind="every", every_ms=HOUR_MS), "go")
            assert heard == [job.state.next_run_at_ms]
        finally:
            service.stop()

    async def test_a_stopped_service_reports_nothing(self, tmp_path: Path) -> None:
        service, heard = self.make(tmp_path)
        await service.start()
        service.stop()
        reported = len(heard)

        service.add_job("quiet", CronSchedule(kind="every", every_ms=HOUR_MS), "go")

        assert len(heard) == reported
