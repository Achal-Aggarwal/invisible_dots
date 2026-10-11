"""Job-store edits must not cancel the timer task executing an agent turn."""

import asyncio
from pathlib import Path

import pytest

from nanobot.cron.service import CronService
from nanobot.cron.types import CronJob, CronSchedule


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["add", "remove"])
@pytest.mark.parametrize("edit_from_callback", [True, False])
async def test_edit_during_timer_execution_preserves_turn(
    tmp_path: Path, action: str, edit_from_callback: bool,
) -> None:
    entered = asyncio.Event()
    release = asyncio.Event()
    settled = asyncio.Event()
    outcomes: list[str] = []

    def add_job(name: str) -> CronJob:
        return service.add_job(
            name=name,
            schedule=CronSchedule(kind="every", every_ms=3_600_000),
            message=name,
        )

    def edit_store() -> None:
        if action == "add":
            add_job("new-job")
        else:
            service.remove_job(other.id)

    async def on_job(job: CronJob) -> None:
        entered.set()
        try:
            if edit_from_callback:
                edit_store()
            await release.wait()
            outcomes.append("completed")
        except asyncio.CancelledError:
            outcomes.append("cancelled")
            raise
        finally:
            settled.set()

    service = CronService(tmp_path / "cron" / "jobs.json", on_job=on_job)
    await service.start()
    try:
        other = add_job("other")
        active = add_job("active")
        active.state.next_run_at_ms = 1
        service._save_store()
        service._arm_timer()
        async with asyncio.timeout(2):
            await entered.wait()
            if not edit_from_callback:
                edit_store()
            release.set()
            await settled.wait()
        assert outcomes == ["completed"]

        async with asyncio.timeout(2):
            while service._active_executions:
                await asyncio.sleep(0)
        restored = CronService(service.store_path).get_job(active.id)
        assert restored is not None
        assert restored.state.last_status == "ok"
        assert len(restored.state.run_history) == 1
        assert restored.state.next_run_at_ms is not None
        assert restored.state.last_run_at_ms is not None
        assert restored.state.next_run_at_ms > restored.state.last_run_at_ms
        assert service._timer_task is not None
        assert not service._timer_task.done()
    finally:
        timer = service._timer_task
        service.stop()
        if timer is not None:
            await asyncio.gather(timer, return_exceptions=True)


@pytest.mark.asyncio
async def test_due_job_removed_while_waiting_is_skipped(tmp_path: Path) -> None:
    entered = asyncio.Event()
    release = asyncio.Event()
    finished = asyncio.Event()
    calls: list[str] = []

    async def on_job(job: CronJob) -> None:
        calls.append(job.name)
        if job.name == "first":
            entered.set()
            await release.wait()
        elif job.name == "last":
            finished.set()

    service = CronService(tmp_path / "cron" / "jobs.json", on_job=on_job)
    await service.start()
    try:
        for name in ("first", "waiting", "last"):
            service.add_job(
                name=name,
                schedule=CronSchedule(kind="every", every_ms=3_600_000),
                message=name,
            )
        jobs = service.list_jobs()
        waiting = next(job for job in jobs if job.name == "waiting")
        for job in jobs:
            job.state.next_run_at_ms = 1
        service._save_store()
        service._arm_timer()

        async with asyncio.timeout(2):
            await entered.wait()
            assert service.remove_job(waiting.id) == "removed"
            release.set()
            await finished.wait()
            while service._active_executions:
                await asyncio.sleep(0)

        assert calls == ["first", "last"]
        restored = CronService(service.store_path)
        for job in jobs:
            if job.id == waiting.id:
                continue
            completed = restored.get_job(job.id)
            assert completed is not None
            assert completed.state.last_status == "ok"
            assert len(completed.state.run_history) == 1
        assert restored.get_job(waiting.id) is None
        assert service._timer_task is not None
        assert not service._timer_task.done()
    finally:
        timer = service._timer_task
        service.stop()
        if timer is not None:
            await asyncio.gather(timer, return_exceptions=True)
