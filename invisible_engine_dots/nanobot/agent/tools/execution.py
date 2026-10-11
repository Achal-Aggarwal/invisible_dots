"""Execute tool calls and turn their outcomes into model observations.

`_admit_tool_call` and `_run_tool_call` are the one boundary every tool execution
crosses. The policy gate (a `ToolGate`, required: no call runs without one) decides
in `_admit_tool_call`, on the final arguments the tool would run with and before
anything runs: nothing else in the engine can start a tool. The calls of one
response run one at a time, in the order of the response.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from contextlib import nullcontext
from dataclasses import dataclass
from functools import cache
from typing import Any

from nanobot.agent.hook import AgentHook, AgentHookContext
from nanobot.agent.tools.base import Tool, ToolResult
from nanobot.agent.tools.file_state import file_read_context
from nanobot.agent.tools.gate_types import SKIPPED_MESSAGE, Deny, GateCall, Park, ToolGate
from nanobot.agent.tools.registry import ToolRegistry, is_tool_error_result
from nanobot.providers.base import ToolCallRequest

_RETRY_HINT = "\n\n[Analyze the error above and try a different approach.]"

# Event statuses besides "ok" and "error": a call that waits for the user's approval,
# and a call of the same response that came after it and was not run either.
STATUS_PARKED = "parked"
STATUS_SKIPPED = "skipped"


@dataclass(frozen=True)
class _Admitted:
    """A call the gate let through: the tool and the arguments it runs with."""

    tool: Tool
    params: Any


# What a call came to without running: its result and its event.
_Outcome = tuple[Any, dict[str, str]]


# Awaited with a call, its result and its event as soon as the call has one.
ResultCallback = Callable[[ToolCallRequest, Any, dict[str, str]], Awaitable[None]]


def _with_retry_hint(payload: str) -> str:
    """Append the recovery hint exactly once."""
    if payload.endswith(_RETRY_HINT):
        return payload
    return payload + _RETRY_HINT


async def execute_tool_calls(
    tools: ToolRegistry,
    tool_calls: list[ToolCallRequest],
    *,
    hook: AgentHook,
    context: AgentHookContext,
    gate: ToolGate,
    model_messages: list[dict[str, Any]] | None = None,
    on_result: ResultCallback | None = None,
) -> tuple[list[Any], list[dict[str, str]]]:
    """Execute one model response's tool calls, one at a time, in the order of the response.

    The gate decides each call before it runs. A call it parks ends the round: every
    call of the response after it is not decided, not run and says so. The calls
    before it were allowed and run. `on_result` is awaited with each call's result
    and event right after the call.
    """
    @cache
    def read_results() -> dict[str, str]:
        """Index once, on the first read-dedup check in this response."""
        return {
            message["tool_call_id"]: message["content"]
            for message in model_messages or []
            if message.get("role") == "tool"
            and isinstance(message.get("tool_call_id"), str)
            and isinstance(message.get("content"), str)
        }
    results: list[Any] = []
    events: list[dict[str, str]] = []
    parked = False
    for tool_call in tool_calls:
        admission = (
            _skip_tool_call(tool_call, context, gate)
            if parked
            else _admit_tool_call(tools, tool_call, context, gate)
        )
        if isinstance(admission, _Admitted):
            result, event = await _run_tool_call(tool_call, admission, hook, context, read_results)
        else:
            result, event = admission
            if event["status"] == STATUS_PARKED:
                parked = True
        if on_result is not None:
            await on_result(tool_call, result, event)
        results.append(result)
        events.append(event)
    return results, events


def _skip_tool_call(tool_call: ToolCallRequest, context: AgentHookContext, gate: ToolGate) -> _Outcome:
    """The outcome of a call that is not run because an earlier call of its response parked."""
    gate.skip(tool_call.id, context.session_key)
    event = {
        "name": tool_call.name,
        "status": STATUS_SKIPPED,
        "detail": "an earlier call is waiting for approval",
    }
    return SKIPPED_MESSAGE, event


def _admit_tool_call(
    tools: ToolRegistry,
    tool_call: ToolCallRequest,
    context: AgentHookContext,
    gate: ToolGate,
) -> _Admitted | _Outcome:
    """Prepare one call and put it to the gate: the call to run, or the outcome that stands in for it."""
    tool, params, prep_error = tools.prepare_call(tool_call.name, tool_call.arguments)
    if prep_error:
        payload = _with_retry_hint(prep_error)
        event = {
            "name": tool_call.name,
            "status": "error",
            "detail": prep_error.split(": ", 1)[-1][:120],
        }
        return payload, event
    assert tool is not None  # prepare_call yields the tool whenever it reports no error

    decision = gate.decide(GateCall(tool_call.name, params, tool_call.id, context.session_key))
    if isinstance(decision, Deny):
        # A policy denial is final: no hint to try another way round it.
        event = {
            "name": tool_call.name,
            "status": "error",
            "detail": decision.reason[:120],
        }
        return ToolResult.error(decision.reason), event
    if isinstance(decision, Park):
        event = {
            "name": tool_call.name,
            "status": STATUS_PARKED,
            "detail": f"waiting for approval {decision.approval_id}",
        }
        return decision.message, event
    return _Admitted(tool, params)


async def _run_tool_call(
    tool_call: ToolCallRequest,
    admitted: _Admitted,
    hook: AgentHook,
    context: AgentHookContext,
    read_results: Callable[[], dict[str, str]],
) -> _Outcome:
    tool, params = admitted.tool, admitted.params
    await hook.before_execute_tool(context, tool_call, tool, params)
    try:
        with (
            file_read_context(tool_call.id, read_results)
            if tool_call.name == "read_file" else nullcontext()
        ):
            result = await tool.execute(**params)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        await hook.on_execute_tool_error(context, tool_call, tool, params, exc)
        event = {
            "name": tool_call.name,
            "status": "error",
            "detail": str(exc),
        }
        payload = _with_retry_hint(f"Error: {type(exc).__name__}: {exc}")
        return payload, event

    if is_tool_error_result(result):
        await hook.on_execute_tool_error(context, tool_call, tool, params, result)
        payload = _with_retry_hint(result)
        event = {
            "name": tool_call.name,
            "status": "error",
            "detail": result.replace("\n", " ").strip()[:120],
        }
        return payload, event

    await hook.after_execute_tool(context, tool_call, tool, params, result)

    detail = "" if result is None else str(result)
    detail = detail.replace("\n", " ").strip()
    if not detail:
        detail = "(empty)"
    elif len(detail) > 120:
        detail = detail[:120] + "..."
    return result, {"name": tool_call.name, "status": "ok", "detail": detail}

