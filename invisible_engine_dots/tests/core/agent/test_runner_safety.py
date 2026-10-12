"""Tests for AgentRunner: a tool that fails hands the error back to the model."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

from agent.runner_helpers import ScriptedTools, make_run_spec
from nanobot.agent.runner import AgentRunner
from nanobot.providers.base import LLMResponse, ToolCallRequest



async def test_runner_does_not_abort_when_a_tool_is_refused_by_the_os():
    """What the Dot may touch is decided by the OS, as the user dot.

    A refusal arrives as an error the model can recover from, not as a fatal
    abort of the turn: the model hears about it and finishes the answer.
    """
    provider = MagicMock()
    provider.chat_stream_with_retry = AsyncMock(side_effect=[
        LLMResponse(
            content="trying a file dot may not read",
            tool_calls=[ToolCallRequest(
                id="call_1", name="read_file", arguments={"path": "/root/secret.md"},
            )],
        ),
        LLMResponse(content="ok, telling the user instead", tool_calls=[]),
    ])
    tools = ScriptedTools(AsyncMock(side_effect=PermissionError("Permission denied: /root/secret.md")), definitions=[])

    result = await AgentRunner().run(make_run_spec(provider,
        initial_messages=[{"role": "user", "content": "start"}],
        tools=tools,
        model="test-model",
        max_iterations=3,
    ))

    assert provider.chat_stream_with_retry.await_count == 2, (
        "a refused tool call must NOT short-circuit the loop"
    )
    assert result.stop_reason != "tool_error"
    assert result.error is None
    assert result.final_content == "ok, telling the user instead"
    assert result.tool_events and result.tool_events[0]["status"] == "error"
    assert "Permission denied" in result.tool_events[0]["detail"]
