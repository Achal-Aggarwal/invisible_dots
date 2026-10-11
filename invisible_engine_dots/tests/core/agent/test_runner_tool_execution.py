"""Tests for AgentRunner tool execution."""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from fakes.allow_all_gate import AllowAllGate

from agent.runner_helpers import ScriptedTools, make_run_spec
from nanobot.agent.hook import AgentHook, AgentHookContext
from nanobot.agent.runner import AgentRunner
from nanobot.agent.tools.base import Tool, ToolResult
from nanobot.agent.tools.execution import execute_tool_calls
from nanobot.agent.tools.registry import ToolRegistry
from nanobot.providers.base import LLMResponse, ToolCallRequest
from nanobot.providers.openai_compat_provider import OpenAICompatProvider

_MAX_TOOL_RESULT_CHARS = 16_000


class _DelayTool(Tool):
    def __init__(
        self,
        name: str,
        *,
        delay: float,
        shared_events: list[str],
    ):
        self._name = name
        self._delay = delay
        self._shared_events = shared_events

    @property
    def name(self) -> str:
        return self._name

    @property
    def description(self) -> str:
        return self._name

    @property
    def parameters(self) -> dict:
        return {"type": "object", "properties": {}, "required": []}

    async def execute(self, **kwargs):
        self._shared_events.append(f"start:{self._name}")
        await asyncio.sleep(self._delay)
        self._shared_events.append(f"end:{self._name}")
        return self._name


class _StructuredSuccessTool(Tool):
    @property
    def name(self) -> str:
        return "structured_success"

    @property
    def description(self) -> str:
        return "tool returning a structured success"

    @property
    def parameters(self) -> dict:
        return {"type": "object", "properties": {}, "required": []}

    async def execute(self, **kwargs):
        return ToolResult("Error: generated report successfully")


async def _run_optional_tool_response(response: LLMResponse):
    provider = MagicMock()
    calls = {"n": 0}

    async def chat_stream_with_retry(*, messages, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            return response
        return LLMResponse(content="done", tool_calls=[], usage=None)

    provider.chat_stream_with_retry = chat_stream_with_retry
    tools = ToolRegistry()
    shared_events: list[str] = []
    tools.register(_DelayTool(
        "optional_tool",
        delay=0,
        shared_events=shared_events,
    ))

    result = await AgentRunner().run(make_run_spec(provider,
        initial_messages=[{"role": "user", "content": "try optional"}],
        tools=tools,
        model="test-model",
        max_iterations=2,
        max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
    ))
    return result, shared_events


def _tool_message(result, tool_call_id: str) -> dict:
    return [
        msg for msg in result.messages
        if msg.get("role") == "tool" and msg.get("tool_call_id") == tool_call_id
    ][0]


@pytest.mark.asyncio
async def test_tool_execution_propagates_preparation_failure():
    tools = ScriptedTools(AsyncMock())
    tools.prepare_call = MagicMock(side_effect=RuntimeError("tool preparation failed"))

    with pytest.raises(RuntimeError, match="tool preparation failed"):
        await execute_tool_calls(
            tools,
            [ToolCallRequest(id="call-1", name="demo", arguments={})],
            hook=AgentHook(),
            context=AgentHookContext(iteration=0, messages=[]),
            gate=AllowAllGate(),
        )

    tools.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_tool_execution_propagates_cancellation_without_error_hook():
    tools = ScriptedTools(AsyncMock(side_effect=asyncio.CancelledError))

    events: list[str] = []

    class RecordingHook(AgentHook):
        async def before_execute_tool(
            self,
            context: AgentHookContext,
            tool_call: ToolCallRequest,
            tool: Any,
            params: Any,
        ) -> None:
            events.append("before")

        async def on_execute_tool_error(
            self,
            context: AgentHookContext,
            tool_call: ToolCallRequest,
            tool: Any,
            params: Any,
            error: Any,
        ) -> None:
            events.append("error")

    with pytest.raises(asyncio.CancelledError):
        await execute_tool_calls(
            tools,
            [ToolCallRequest(id="call-1", name="demo", arguments={})],
            hook=RecordingHook(),
            context=AgentHookContext(iteration=0, messages=[]),
            gate=AllowAllGate(),
        )

    assert events == ["before"]


@pytest.mark.asyncio
async def test_runner_rejects_near_miss_tool_name_without_executing():
    provider = MagicMock()
    call_count = {"n": 0}
    captured_second_call: list[dict] = []

    async def chat_stream_with_retry(*, messages, **kwargs):
        call_count["n"] += 1
        if call_count["n"] == 1:
            return LLMResponse(
                content="",
                tool_calls=[
                    ToolCallRequest(
                        id="call_1",
                        name="readFile",
                        arguments={"path": "notes.txt"},
                    )
                ],
                finish_reason="tool_calls",
                usage=None,
            )
        captured_second_call[:] = messages
        return LLMResponse(content="done", tool_calls=[], usage=None)

    provider.chat_stream_with_retry = chat_stream_with_retry
    tools = ToolRegistry()
    shared_events: list[str] = []
    tools.register(_DelayTool(
        "read_file",
        delay=0,
        shared_events=shared_events,
    ))

    runner = AgentRunner()
    result = await runner.run(make_run_spec(provider,
        initial_messages=[{"role": "user", "content": "read notes"}],
        tools=tools,
        model="test-model",
        max_iterations=2,
        max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
    ))

    assert result.final_content == "done"
    assert result.tools_used == []
    assert shared_events == []
    assistant_message = [
        msg for msg in result.messages
        if msg.get("role") == "assistant" and msg.get("tool_calls")
    ][0]
    assert assistant_message["tool_calls"][0]["function"]["name"] == "readFile"
    tool_message = [
        msg for msg in result.messages
        if msg.get("role") == "tool" and msg.get("tool_call_id") == "call_1"
    ][0]
    assert tool_message["name"] == "readFile"
    assert "Tool 'readFile' not found" in tool_message["content"]
    assert "Did you mean 'read_file'?" in tool_message["content"]
    replayed_assistant = [
        msg for msg in captured_second_call
        if msg.get("role") == "assistant" and msg.get("tool_calls")
    ][0]
    assert replayed_assistant["tool_calls"][0]["function"]["name"] == "readFile"


@pytest.mark.asyncio
@pytest.mark.parametrize("arguments", ['{path:"notes.txt"}', "null"])
async def test_runner_rejects_openai_compat_invalid_arguments_without_executing(arguments):
    parsed = OpenAICompatProvider._parse_chunks([{
        "choices": [{
            "finish_reason": "tool_calls",
            "delta": {
                "tool_calls": [{
                    "index": 0,
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "optional_tool",
                        "arguments": arguments,
                    },
                }],
            },
        }],
    }])

    result, shared_events = await _run_optional_tool_response(parsed)

    assert result.final_content == "done"
    assert parsed.tool_calls[0].arguments == arguments
    assert result.tools_used == []
    assert shared_events == []
    tool_message = _tool_message(result, "call_1")
    assert "parameters must be a JSON object" in tool_message["content"]


@pytest.mark.asyncio
async def test_runner_preserves_structured_success_that_starts_with_error():
    provider = MagicMock()
    provider.chat_stream_with_retry = AsyncMock(side_effect=[
        LLMResponse(
            content="working",
            tool_calls=[
                ToolCallRequest(id="call_1", name="structured_success", arguments={})
            ],
            usage=None,
        ),
        LLMResponse(content="done", tool_calls=[], usage=None),
    ])

    tools = ToolRegistry()
    tools.register(_StructuredSuccessTool())

    result = await AgentRunner().run(make_run_spec(provider,
        initial_messages=[{"role": "user", "content": "run tool"}],
        tools=tools,
        model="test-model",
        max_iterations=2,
        max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
    ))

    assert result.stop_reason == "completed"
    assert result.tool_events == [
        {
            "name": "structured_success",
            "status": "ok",
            "detail": "Error: generated report successfully",
        }
    ]
