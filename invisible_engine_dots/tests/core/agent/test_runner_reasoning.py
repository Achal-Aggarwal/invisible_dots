"""Tests for what AgentRunner does with model reasoning.

Reasoning rides along on the stored assistant message; inline ``<think>``
tags never reach the answer. The runner does not stream reasoning or answer.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from agent.runner_helpers import ScriptedTools, make_run_spec
from nanobot.providers.base import LLMResponse, LLMUsage, ToolCallRequest



@pytest.mark.asyncio
async def test_runner_preserves_reasoning_fields_in_assistant_history():
    """Reasoning fields ride along on the persisted assistant message so
    follow-up provider calls retain the model's prior thinking context."""
    from nanobot.agent.runner import AgentRunner

    provider = MagicMock()
    captured_second_call: list[dict] = []
    call_count = {"n": 0}

    async def chat_stream_with_retry(*, messages, **kwargs):
        call_count["n"] += 1
        if call_count["n"] == 1:
            return LLMResponse(
                content="thinking",
                tool_calls=[ToolCallRequest(id="call_1", name="list_dir", arguments={"path": "."})],
                reasoning_content="hidden reasoning",
                thinking_blocks=[{"type": "thinking", "thinking": "step"}],
                usage=LLMUsage.reported(input_tokens=5, output_tokens=3),
            )
        captured_second_call[:] = messages
        return LLMResponse(content="done", tool_calls=[], usage=None)

    provider.chat_stream_with_retry = chat_stream_with_retry
    tools = ScriptedTools(AsyncMock(return_value="tool result"), definitions=[])

    runner = AgentRunner()
    result = await runner.run(make_run_spec(provider,
        initial_messages=[
            {"role": "system", "content": "system"},
            {"role": "user", "content": "do task"},
        ],
        tools=tools,
        model="test-model",
        max_iterations=3,
    ))

    assert result.final_content == "done"
    assistant_messages = [
        msg for msg in captured_second_call
        if msg.get("role") == "assistant" and msg.get("tool_calls")
    ]
    assert len(assistant_messages) == 1
    assert assistant_messages[0]["reasoning_content"] == "hidden reasoning"
    assert assistant_messages[0]["thinking_blocks"] == [{"type": "thinking", "thinking": "step"}]


@pytest.mark.asyncio
async def test_runner_strips_inline_think_content_from_the_answer():
    from nanobot.agent.runner import AgentRunner

    provider = MagicMock()

    async def chat_stream_with_retry(**kwargs):
        return LLMResponse(
            content="<think>Let me think about this...\nThe answer is 42.</think>The answer is 42.",
            tool_calls=[],
            usage=LLMUsage.reported(input_tokens=5, output_tokens=3),
        )

    provider.chat_stream_with_retry = chat_stream_with_retry
    tools = MagicMock()
    tools.get_definitions.return_value = []

    result = await AgentRunner().run(make_run_spec(provider,
        initial_messages=[{"role": "user", "content": "what is the answer?"}],
        tools=tools,
        model="test-model",
        max_iterations=3,
    ))

    assert result.final_content == "The answer is 42."


@pytest.mark.asyncio
async def test_runner_strips_inline_think_even_when_a_reasoning_field_came_with_it():
    from nanobot.agent.runner import AgentRunner

    provider = MagicMock()

    async def chat_stream_with_retry(**kwargs):
        return LLMResponse(
            content="<think>inline thinking</think>The answer.",
            reasoning_content="dedicated reasoning field",
            tool_calls=[],
            usage=LLMUsage.reported(input_tokens=5, output_tokens=3),
        )

    provider.chat_stream_with_retry = chat_stream_with_retry
    tools = MagicMock()
    tools.get_definitions.return_value = []

    result = await AgentRunner().run(make_run_spec(provider,
        initial_messages=[{"role": "user", "content": "question"}],
        tools=tools,
        model="test-model",
        max_iterations=3,
    ))

    assert result.final_content == "The answer."
