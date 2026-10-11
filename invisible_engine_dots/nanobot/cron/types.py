"""Cron types."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, cast, overload

from nanobot.utils.dict_keys import get_camel_snake


# The last moment a job may run, in milliseconds since the epoch: 9999-12-31T23:59:59.999Z, the last one a datetime
# and a JavaScript Date both hold. The host's contract bounds `next_run_at_ms` at the same value
# (`MAX_RUN_AT_MS` of packages/shared/src/protocol.ts; `tests/dots/test_wire_shapes.py` pins the two equal), because a
# time past it cannot be stored by the host's database nor shown by its web page.
MAX_RUN_AT_MS = 253_402_300_799_999


@overload
def _store_int(value: Any, default: Literal[None]) -> int | None: ...


@overload
def _store_int(value: Any, default: int = 0) -> int: ...


def _store_int(value: Any, default: int | None = 0) -> int | None:
    """Coerce JSON numerics to int; treat null/blank like a missing key."""
    if value is None or value == "":
        return default
    return int(value)


@dataclass
class CronSchedule:
    """Schedule definition for a cron job."""
    kind: Literal["at", "every", "cron"]
    # For "at": timestamp in ms
    at_ms: int | None = None
    # For "every": interval in ms
    every_ms: int | None = None
    # For "cron": cron expression (e.g. "0 9 * * *")
    expr: str | None = None
    # Timezone for cron expressions
    tz: str | None = None

    @classmethod
    def from_store_dict(cls, data: dict[str, Any]) -> CronSchedule:
        return cls(
            kind=data["kind"],
            at_ms=_store_int(get_camel_snake(data, "atMs", "at_ms"), None),
            every_ms=_store_int(get_camel_snake(data, "everyMs", "every_ms"), None),
            expr=data.get("expr"),
            tz=data.get("tz"),
        )


@dataclass
class CronPayload:
    """What to do when the job runs."""
    kind: Literal["agent_turn"] = "agent_turn"
    message: str = ""
    @classmethod
    def from_store_dict(cls, data: dict[str, Any]) -> CronPayload:
        return cls(
            kind=data.get("kind", "agent_turn"),
            message=data.get("message", ""),
        )


@dataclass
class CronRunResult:
    """Result and durable record identity returned by a cron executor."""

    run_id: str
    response: str


@dataclass
class CronRunRecord:
    """A single execution record for a cron job."""
    run_at_ms: int
    status: Literal["ok", "error", "skipped"]
    duration_ms: int = 0
    error: str | None = None
    run_id: str | None = None

    @classmethod
    def from_store_dict(cls, data: dict[str, Any]) -> CronRunRecord:
        run_id = get_camel_snake(data, "runId", "run_id")
        return cls(
            run_at_ms=_store_int(get_camel_snake(data, "runAtMs", "run_at_ms", 0)),
            status=data["status"],
            duration_ms=_store_int(get_camel_snake(data, "durationMs", "duration_ms", 0)),
            error=data.get("error"),
            run_id=run_id if isinstance(run_id, str) else None,
        )


@dataclass
class CronJobState:
    """Runtime state of a job."""
    next_run_at_ms: int | None = None
    last_run_at_ms: int | None = None
    last_status: Literal["ok", "error", "skipped"] | None = None
    last_error: str | None = None
    run_history: list[CronRunRecord] = field(default_factory=list)

    @classmethod
    def from_store_dict(cls, data: dict[str, Any]) -> CronJobState:
        history = cast(
            list[object],
            get_camel_snake(data, "runHistory", "run_history", []) or [],
        )
        return cls(
            next_run_at_ms=_store_int(
                get_camel_snake(data, "nextRunAtMs", "next_run_at_ms"), None
            ),
            last_run_at_ms=_store_int(
                get_camel_snake(data, "lastRunAtMs", "last_run_at_ms"), None
            ),
            last_status=get_camel_snake(data, "lastStatus", "last_status"),
            last_error=get_camel_snake(data, "lastError", "last_error"),
            run_history=[
                record
                if isinstance(record, CronRunRecord)
                else CronRunRecord.from_store_dict(cast(dict[str, Any], record))
                for record in history
                if isinstance(record, (dict, CronRunRecord))
            ],
        )


@dataclass
class CronJob:
    """A scheduled job."""
    id: str
    name: str
    enabled: bool = True
    schedule: CronSchedule = field(default_factory=lambda: CronSchedule(kind="every"))
    payload: CronPayload = field(default_factory=CronPayload)
    state: CronJobState = field(default_factory=CronJobState)
    created_at_ms: int = 0
    updated_at_ms: int = 0
    delete_after_run: bool = False

    @classmethod
    def from_dict(cls, kwargs: dict[str, Any]) -> CronJob:
        state_kwargs = dict(cast(dict[str, Any], kwargs.get("state", {})))
        state_kwargs["run_history"] = [
            record
            if isinstance(record, CronRunRecord)
            else CronRunRecord(**cast(dict[str, Any], record))
            for record in cast(list[object], state_kwargs.get("run_history", []))
        ]
        kwargs["schedule"] = CronSchedule(
            **cast(dict[str, Any], kwargs.get("schedule", {"kind": "every"}))
        )
        kwargs["payload"] = CronPayload(**cast(dict[str, Any], kwargs.get("payload", {})))
        kwargs["state"] = CronJobState(**state_kwargs)
        return cls(**cast(Any, kwargs))

    @classmethod
    def from_store_dict(cls, data: dict[str, Any]) -> CronJob:
        """Load a job from jobs.json (camelCase with snake_case fallbacks)."""
        return cls(
            id=data["id"],
            name=data["name"],
            enabled=data.get("enabled", True),
            schedule=CronSchedule.from_store_dict(data["schedule"]),
            payload=CronPayload.from_store_dict(data.get("payload") or {}),
            state=CronJobState.from_store_dict(data.get("state") or {}),
            created_at_ms=_store_int(get_camel_snake(data, "createdAtMs", "created_at_ms", 0)),
            updated_at_ms=_store_int(get_camel_snake(data, "updatedAtMs", "updated_at_ms", 0)),
            delete_after_run=bool(
                get_camel_snake(data, "deleteAfterRun", "delete_after_run", False)
            ),
        )


@dataclass
class CronStore:
    """Persistent store for cron jobs."""
    version: int = 1
    jobs: list[CronJob] = field(default_factory=list)
