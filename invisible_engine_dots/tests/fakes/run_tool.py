"""Run one tool call the way the engine does, for the tests of the tools and the registry."""

from __future__ import annotations

import uuid
from typing import Any

from fakes.allow_all_gate import AllowAllGate
from nanobot.agent.hook import AgentHook, AgentHookContext
from nanobot.agent.tools.base import ToolResult
from nanobot.agent.tools.execution import execute_tool_calls
from nanobot.agent.tools.registry import ToolRegistry
from nanobot.providers.base import ToolCallRequest


async def run_tool(registry: ToolRegistry, name: str, params: Any) -> Any:
    """The result of calling `name` through `execute_tool_calls`: an allow-all gate, and no model input.

    Registry resolution, casting, validation and the error wrapping are the real ones;
    nothing else runs a tool. A call that ended in an error comes back as an error ToolResult.
    """
    results, events = await execute_tool_calls(
        registry,
        [ToolCallRequest(id=f"call-{uuid.uuid4().hex[:8]}", name=name, arguments=params)],
        hook=AgentHook(),
        context=AgentHookContext(iteration=0, messages=[]),
        gate=AllowAllGate(),
    )
    if events[0]["status"] == "error":
        return ToolResult.error(str(results[0]))
    return results[0]
