"""Tests for the mid-turn injection system: drain, checkpoints, pending queues, error paths."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from agent.runner_helpers import ScriptedTools, make_run_spec
from nanobot.agent.context import TranscriptInput
from nanobot.providers.base import LLMResponse, ToolCallRequest



def _make_injection_callback(queue: asyncio.Queue):
    """Return an async callback that drains *queue* into a list of dicts."""
    async def inject_cb():
        items = []
        while not queue.empty():
            items.append(await queue.get())
        return items
    return inject_cb


@pytest.mark.asyncio
async def test_drain_injections_returns_empty_when_no_callback():
    """No injection_callback → empty list."""
    from nanobot.agent.runner import AgentRunner

    provider = MagicMock()
    runner = AgentRunner()
    tools = MagicMock()
    tools.get_definitions.return_value = []
    spec = make_run_spec(provider,
        initial_messages=[{"role": "user", "content": "start"}], tools=tools, model="m",
        max_iterations=1, 
        injection_callback=None,
    )
    result = await runner._drain_injections(spec)
    assert result == []


@pytest.mark.asyncio
async def test_drain_injections_extracts_content_from_inbound_messages():
    """Should extract .content from injected messages."""
    from nanobot.agent.runner import AgentRunner
    from agent.runner_helpers import InjectedMessage

    provider = MagicMock()
    runner = AgentRunner()
    tools = MagicMock()
    tools.get_definitions.return_value = []

    msgs = [
        InjectedMessage(channel="cli", sender_id="u", chat_id="c", content="hello"),
        InjectedMessage(channel="cli", sender_id="u", chat_id="c", content="world"),
    ]

    async def cb():
        return msgs

    spec = make_run_spec(provider,
        initial_messages=[{"role": "user", "content": "start"}], tools=tools, model="m",
        max_iterations=1, 
        injection_callback=cb,
    )
    result = await runner._drain_injections(spec)
    assert result == [
        {"role": "user", "content": "hello"},
        {"role": "user", "content": "world"},
    ]


@pytest.mark.asyncio
async def test_drain_injections_keeps_entire_callback_snapshot():
    """A callback snapshot is never split by an arbitrary message count."""
    from nanobot.agent.runner import AgentRunner
    from agent.runner_helpers import InjectedMessage

    provider = MagicMock()
    runner = AgentRunner()
    tools = MagicMock()
    tools.get_definitions.return_value = []
    msgs = [
        InjectedMessage(channel="cli", sender_id="u", chat_id="c", content=f"msg{i}")
        for i in range(8)
    ]

    async def cb():
        return msgs

    spec = make_run_spec(provider,
        initial_messages=[{"role": "user", "content": "start"}], tools=tools, model="m",
        max_iterations=1, 
        injection_callback=cb,
    )
    result = await runner._drain_injections(spec)
    assert result == [
        {"role": "user", "content": f"msg{i}"}
        for i in range(8)
    ]


@pytest.mark.asyncio
async def test_drain_injections_skips_empty_content():
    """Messages with blank content should be filtered out."""
    from nanobot.agent.runner import AgentRunner
    from agent.runner_helpers import InjectedMessage

    provider = MagicMock()
    runner = AgentRunner()
    tools = MagicMock()
    tools.get_definitions.return_value = []

    msgs = [
        InjectedMessage(channel="cli", sender_id="u", chat_id="c", content=""),
        InjectedMessage(channel="cli", sender_id="u", chat_id="c", content="   "),
        InjectedMessage(channel="cli", sender_id="u", chat_id="c", content="valid"),
    ]

    async def cb():
        return msgs

    spec = make_run_spec(provider,
        initial_messages=[{"role": "user", "content": "start"}], tools=tools, model="m",
        max_iterations=1, 
        injection_callback=cb,
    )
    result = await runner._drain_injections(spec)
    assert result == [{"role": "user", "content": "valid"}]


@pytest.mark.asyncio
async def test_drain_injections_filters_empty_dict_payloads():
    """Pre-normalized dict injections should obey the same empty-content guard."""
    from nanobot.agent.runner import AgentRunner

    provider = MagicMock()
    runner = AgentRunner()
    tools = MagicMock()
    tools.get_definitions.return_value = []

    multimodal = [{"type": "image_url", "image_url": {"url": "data:image/png;base64,abc"}}]
    msgs = [
        {"role": "user", "content": ""},
        {"role": "user", "content": "   "},
        {"role": "user", "content": None},
        {"role": "assistant", "content": "should not be re-injected as user"},
        None,
        {"role": "user", "content": "valid"},
        {"role": "user", "content": multimodal},
    ]

    async def cb():
        return msgs

    spec = make_run_spec(provider,
        initial_messages=[{"role": "user", "content": "start"}], tools=tools, model="m",
        max_iterations=1, 
        injection_callback=cb,
    )
    result = await runner._drain_injections(spec)
    assert result == [
        {"role": "user", "content": "valid"},
        {"role": "user", "content": multimodal},
    ]


@pytest.mark.asyncio
async def test_drain_injections_skips_objects_with_none_content():
    """Objects exposing content=None should be skipped rather than stringified."""
    from types import SimpleNamespace

    from nanobot.agent.runner import AgentRunner

    provider = MagicMock()
    runner = AgentRunner()
    tools = MagicMock()
    tools.get_definitions.return_value = []

    async def cb():
        return [
            SimpleNamespace(content=None),
            SimpleNamespace(content=""),
            SimpleNamespace(content="valid"),
        ]

    spec = make_run_spec(provider,
        initial_messages=[{"role": "user", "content": "start"}], tools=tools, model="m",
        max_iterations=1, 
        injection_callback=cb,
    )
    result = await runner._drain_injections(spec)
    assert result == [{"role": "user", "content": "valid"}]


@pytest.mark.asyncio
async def test_drain_injections_handles_callback_exception():
    """If the callback raises, return empty list (error is logged)."""
    from nanobot.agent.runner import AgentRunner

    provider = MagicMock()
    runner = AgentRunner()
    tools = MagicMock()
    tools.get_definitions.return_value = []

    async def cb():
        raise RuntimeError("boom")

    spec = make_run_spec(provider,
        initial_messages=[{"role": "user", "content": "start"}], tools=tools, model="m",
        max_iterations=1, 
        injection_callback=cb,
    )
    result = await runner._drain_injections(spec)
    assert result == []


@pytest.mark.asyncio
async def test_checkpoint1_injects_after_tool_execution():
    """Follow-up messages are injected after tool execution, before next LLM call."""
    from nanobot.agent.runner import AgentRunner
    from agent.runner_helpers import InjectedMessage

    provider = MagicMock()
    call_count = {"n": 0}
    captured_messages = []

    async def chat_stream_with_retry(*, messages, **kwargs):
        call_count["n"] += 1
        captured_messages.append(list(messages))
        if call_count["n"] == 1:
            return LLMResponse(
                content="using tool",
                tool_calls=[ToolCallRequest(id="c1", name="read_file", arguments={"path": "x"})],
                usage=None,
            )
        return LLMResponse(content="final answer", tool_calls=[], usage=None)

    provider.chat_stream_with_retry = chat_stream_with_retry
    injection_queue = asyncio.Queue()
    inject_cb = _make_injection_callback(injection_queue)

    async def execute_tool(*_args, **_kwargs):
        await injection_queue.put(
            InjectedMessage(
                channel="cli", sender_id="u", chat_id="c", content="follow-up question"
            )
        )
        return "file content"

    tools = ScriptedTools(AsyncMock(side_effect=execute_tool))

    runner = AgentRunner()
    result = await runner.run(make_run_spec(provider,
        initial_messages=[{"role": "user", "content": "hello"}],
        tools=tools,
        model="test-model",
        max_iterations=5,
        injection_callback=inject_cb,
    ))

    assert result.had_injections is True
    assert result.final_content == "final answer"
    # The second call should have the injected user message
    assert call_count["n"] == 2
    last_messages = captured_messages[-1]
    injected = [m for m in last_messages if m.get("role") == "user" and m.get("content") == "follow-up question"]
    assert len(injected) == 1


@pytest.mark.asyncio
async def test_checkpoint2_injects_after_final_response():
    """After a final response, an input that arrived meanwhile is taken in and the run goes on."""
    from nanobot.agent.runner import AgentRunner
    from agent.runner_helpers import InjectedMessage

    provider = MagicMock()
    call_count = {"n": 0}

    async def chat_stream_with_retry(*, messages, **kwargs):
        call_count["n"] += 1
        if call_count["n"] == 1:
            await injection_queue.put(
                InjectedMessage(
                    channel="cli", sender_id="u", chat_id="c", content="quick follow-up"
                )
            )
            return LLMResponse(content="first answer", tool_calls=[], usage=None)
        return LLMResponse(content="second answer", tool_calls=[], usage=None)

    provider.chat_stream_with_retry = chat_stream_with_retry
    tools = MagicMock()
    tools.get_definitions.return_value = []

    injection_queue = asyncio.Queue()
    inject_cb = _make_injection_callback(injection_queue)

    runner = AgentRunner()
    result = await runner.run(make_run_spec(provider,
        initial_messages=[{"role": "user", "content": "hello"}],
        tools=tools,
        model="test-model",
        max_iterations=5,
        injection_callback=inject_cb,
    ))

    assert result.had_injections is True
    assert result.final_content == "second answer"
    assert call_count["n"] == 2


@pytest.mark.asyncio
async def test_injected_followup_starts_new_length_recovery_chain():
    """A follow-up gets a fresh recovery budget and no content from the prior answer."""
    from nanobot.agent.runner import AgentRunner
    from agent.runner_helpers import InjectedMessage

    provider = MagicMock()
    responses = [
        LLMResponse(content="first-1 ", finish_reason="length"),
        LLMResponse(content="first-2 ", finish_reason="length"),
        LLMResponse(content="first-3 ", finish_reason="length"),
        LLMResponse(content="first-final", finish_reason="stop"),
        LLMResponse(content="follow-up ", finish_reason="length"),
        LLMResponse(content="answer", finish_reason="stop"),
    ]
    tools = MagicMock()
    tools.get_definitions.return_value = []

    injection_queue = asyncio.Queue()
    inject_cb = _make_injection_callback(injection_queue)
    call_count = 0

    async def chat_stream_with_retry(**_kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 4:
            await injection_queue.put(InjectedMessage(
                channel="cli", sender_id="u", chat_id="c", content="follow-up question"
            ))
        return responses[call_count - 1]

    provider.chat_stream_with_retry = chat_stream_with_retry

    runner = AgentRunner()
    result = await runner.run(make_run_spec(provider,
        initial_messages=[{"role": "user", "content": "give a long answer"}],
        tools=tools,
        model="test-model",
        max_iterations=8,
        injection_callback=inject_cb,
    ))

    assert result.had_injections is True
    assert result.final_content == "follow-up answer"
    assert call_count == 6


@pytest.mark.asyncio
@pytest.mark.parametrize("max_iterations", [1, 3])
async def test_truncated_answer_followup_requires_remaining_iteration(max_iterations):
    from nanobot.agent.runner import AgentRunner

    provider = MagicMock()
    tools = MagicMock()
    tools.get_definitions.return_value = []
    queue = asyncio.Queue()
    requests = []

    async def chat_stream_with_retry(*, messages, **kwargs):
        requests.append([dict(message) for message in messages])
        if len(requests) == 1:
            queue.put_nowait({"role": "user", "content": "Never mind. What is 2+2?"})
            return LLMResponse(content="Unfinished old answer: ", finish_reason="length")
        return LLMResponse(content="4", finish_reason="stop")

    provider.chat_stream_with_retry = chat_stream_with_retry
    result = await AgentRunner().run(make_run_spec(
        provider,
        initial_messages=[{"role": "user", "content": "old question"}],
        tools=tools,
        model="test-model",
        max_iterations=max_iterations,
        injection_callback=_make_injection_callback(queue),
    ))

    if max_iterations == 1:
        # No request is left for it: the input stays queued, and the run ends on its limit message.
        assert len(requests) == 1
        assert queue.get_nowait()["content"] == "Never mind. What is 2+2?"
        assert result.had_injections is False
        assert result.stop_reason == "max_iterations"
        assert result.final_content.startswith("Unfinished old answer:\n\n")
    else:
        assert len(requests) == 2
        second_request = "\n".join(str(message.get("content", "")) for message in requests[1])
        assert result.final_content == "4"
        assert "Never mind. What is 2+2?" in second_request
        assert queue.empty()
        assert "Continue the same response from its exact endpoint" not in second_request


@pytest.mark.asyncio
async def test_checkpoint2_preserves_final_response_in_history_before_followup():
    """A follow-up injected after a final answer must still see that answer in history."""
    from nanobot.agent.runner import AgentRunner
    from agent.runner_helpers import InjectedMessage

    provider = MagicMock()
    call_count = {"n": 0}
    captured_messages = []

    async def chat_stream_with_retry(*, messages, **kwargs):
        call_count["n"] += 1
        captured_messages.append([dict(message) for message in messages])
        if call_count["n"] == 1:
            await injection_queue.put(
                InjectedMessage(
                    channel="cli", sender_id="u", chat_id="c", content="follow-up question"
                )
            )
            return LLMResponse(content="first answer", tool_calls=[], usage=None)
        return LLMResponse(content="second answer", tool_calls=[], usage=None)

    provider.chat_stream_with_retry = chat_stream_with_retry
    tools = MagicMock()
    tools.get_definitions.return_value = []

    injection_queue = asyncio.Queue()
    inject_cb = _make_injection_callback(injection_queue)

    runner = AgentRunner()
    result = await runner.run(make_run_spec(provider,
        initial_messages=[{"role": "user", "content": "hello"}],
        tools=tools,
        model="test-model",
        max_iterations=5,
        injection_callback=inject_cb,
    ))

    assert result.final_content == "second answer"
    assert call_count["n"] == 2
    assert captured_messages[-1] == [
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "first answer"},
        {"role": "user", "content": "follow-up question"},
    ]
    assert [
        {"role": message["role"], "content": message["content"]}
        for message in result.messages
        if message.get("role") == "assistant"
    ] == [
        {"role": "assistant", "content": "first answer"},
        {"role": "assistant", "content": "second answer"},
    ]


@pytest.mark.asyncio
async def test_model_request_merges_injected_user_messages_without_losing_media():
    """The model copy may merge follow-ups while the raw transcript keeps each event."""
    from nanobot.agent.runner import AgentRunner

    provider = MagicMock()
    call_count = {"n": 0}
    captured_messages = []

    async def chat_stream_with_retry(*, messages, **kwargs):
        call_count["n"] += 1
        captured_messages.append([dict(message) for message in messages])
        if call_count["n"] == 1:
            return LLMResponse(content="first answer", tool_calls=[], usage=None)
        return LLMResponse(content="second answer", tool_calls=[], usage=None)

    provider.chat_stream_with_retry = chat_stream_with_retry
    tools = MagicMock()
    tools.get_definitions.return_value = []

    async def inject_cb():
        if call_count["n"] == 1:
            return [
                {
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": "data:image/png;base64,abc"}},
                        {"type": "text", "text": "look at this"},
                    ],
                },
                {"role": "user", "content": "and answer briefly"},
            ]
        return []

    runner = AgentRunner()
    result = await runner.run(make_run_spec(provider,
        initial_messages=[{"role": "user", "content": "hello"}],
        tools=tools,
        model="test-model",
        max_iterations=5,
        injection_callback=inject_cb,
    ))

    assert result.final_content == "second answer"
    assert call_count["n"] == 2
    second_call = captured_messages[-1]
    user_messages = [message for message in second_call if message.get("role") == "user"]
    assert len(user_messages) == 2
    injected = user_messages[-1]
    assert isinstance(injected["content"], list)
    assert any(
        block.get("type") == "image_url"
        for block in injected["content"]
        if isinstance(block, dict)
    )
    assert any(
        block.get("type") == "text" and block.get("text") == "and answer briefly"
        for block in injected["content"]
        if isinstance(block, dict)
    )
    assert [message["content"] for message in result.messages[-3:-1]] == [
        [
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,abc"}},
            {"type": "text", "text": "look at this"},
        ],
        "and answer briefly",
    ]


@pytest.mark.asyncio
async def test_injection_cycles_are_not_stopped_by_an_arbitrary_cap():
    """Every pending snapshot runs until the normal iteration budget is reached."""
    from nanobot.agent.runner import AgentRunner
    from agent.runner_helpers import InjectedMessage

    provider = MagicMock()
    call_count = {"n": 0}
    injection_queue = asyncio.Queue()

    async def chat_stream_with_retry(*, messages, **kwargs):
        call_count["n"] += 1
        if call_count["n"] <= 7:
            await injection_queue.put(InjectedMessage(
                channel="cli",
                sender_id="u",
                chat_id="c",
                content=f"msg-{call_count['n']}",
            ))
        return LLMResponse(content=f"answer-{call_count['n']}", tool_calls=[], usage=None)

    provider.chat_stream_with_retry = chat_stream_with_retry
    tools = MagicMock()
    tools.get_definitions.return_value = []

    inject_cb = _make_injection_callback(injection_queue)

    runner = AgentRunner()
    result = await runner.run(make_run_spec(provider,
        initial_messages=[{"role": "user", "content": "start"}],
        tools=tools,
        model="test-model",
        max_iterations=20,
        injection_callback=inject_cb,
    ))

    assert result.had_injections is True
    assert call_count["n"] == 8


@pytest.mark.asyncio
async def test_no_injections_flag_is_false_by_default():
    """had_injections should be False when no injection callback or no messages."""
    from nanobot.agent.runner import AgentRunner

    provider = MagicMock()

    async def chat_stream_with_retry(**kwargs):
        return LLMResponse(content="done", tool_calls=[], usage=None)

    provider.chat_stream_with_retry = chat_stream_with_retry
    tools = MagicMock()
    tools.get_definitions.return_value = []

    runner = AgentRunner()
    result = await runner.run(make_run_spec(provider,
        initial_messages=[{"role": "user", "content": "hi"}],
        tools=tools,
        model="test-model",
        max_iterations=1,
    ))

    assert result.had_injections is False


@pytest.mark.asyncio
async def test_drain_injections_after_recoverable_tool_error():
    """A tool error and injected follow-up continue in the same runner conversation."""
    from nanobot.agent.runner import AgentRunner
    from agent.runner_helpers import InjectedMessage

    provider = MagicMock()
    call_count = {"n": 0}

    async def chat_stream_with_retry(*, messages, **kwargs):
        call_count["n"] += 1
        if call_count["n"] == 1:
            return LLMResponse(
                content="stale prefix ",
                finish_reason="length",
                usage=None,
            )
        if call_count["n"] == 2:
            return LLMResponse(
                content="",
                tool_calls=[ToolCallRequest(id="c1", name="exec", arguments={"cmd": "bad"})],
                usage=None,
            )
        # Third call: respond normally to the injected follow-up.
        return LLMResponse(content="reply to follow-up", tool_calls=[], usage=None)

    provider.chat_stream_with_retry = chat_stream_with_retry
    tools = ScriptedTools(AsyncMock(side_effect=RuntimeError("tool exploded")), definitions=[])

    injection_queue = asyncio.Queue()
    inject_cb = _make_injection_callback(injection_queue)

    await injection_queue.put(
        InjectedMessage(channel="cli", sender_id="u", chat_id="c", content="follow-up after error")
    )

    runner = AgentRunner()
    result = await runner.run(make_run_spec(provider,
        initial_messages=[{"role": "user", "content": "hello"}],
        tools=tools,
        model="test-model",
        max_iterations=5,
        injection_callback=inject_cb,
    ))

    assert result.had_injections is True
    assert result.final_content == "reply to follow-up"
    assert call_count["n"] == 3
    # The injection should be in the messages history
    injected = [
        m for m in result.messages
        if m.get("role") == "user" and m.get("content") == "follow-up after error"
    ]
    assert len(injected) == 1


@pytest.mark.asyncio
async def test_drain_injections_on_llm_error():
    """A follow-up after an error stays raw and reaches the next model request."""
    from nanobot.agent.runner import AgentRunner
    from agent.runner_helpers import InjectedMessage

    provider = MagicMock()
    call_count = {"n": 0}
    requests: list[list[dict]] = []

    async def chat_stream_with_retry(*, messages, **kwargs):
        call_count["n"] += 1
        requests.append(messages)
        if call_count["n"] == 1:
            await injection_queue.put(
                InjectedMessage(
                    channel="cli",
                    sender_id="u",
                    chat_id="c",
                    content="follow-up after LLM error",
                )
            )
            return LLMResponse(
                content=None,
                tool_calls=[],
                finish_reason="error",
                usage=None,
            )
        # Second call: respond normally to the injected follow-up
        return LLMResponse(content="recovered answer", tool_calls=[], usage=None)

    provider.chat_stream_with_retry = chat_stream_with_retry
    tools = MagicMock()
    tools.get_definitions.return_value = []

    injection_queue = asyncio.Queue()
    inject_cb = _make_injection_callback(injection_queue)

    runner = AgentRunner()
    result = await runner.run(make_run_spec(provider,
        initial_messages=None,
        transcript_input=TranscriptInput(
            history=[
                {"role": "user", "content": "hello"},
                {"role": "assistant", "content": "previous response"},
                {"role": "user", "content": "trigger error"},
            ],
            current_message=None,
        ),
        transcript_builder=lambda transcript: [
            {"role": "system", "content": "system"},
            *transcript.history,
        ],
        consolidate_history=AsyncMock(return_value=None),
        tools=tools,
        model="test-model",
        max_iterations=5,
        injection_callback=inject_cb,
    ))

    assert result.had_injections is True
    assert result.final_content == "recovered answer"
    assert "follow-up after LLM error" in str(requests[1])
    assert [
        message["content"]
        for message in result.messages
        if message.get("role") == "user"
    ][-2:] == [
        "trigger error",
        "follow-up after LLM error",
    ]


@pytest.mark.asyncio
async def test_drain_injections_on_empty_final_response():
    """Pending injections should be drained when the runner exits due to empty response."""
    from nanobot.agent.runner import _MAX_EMPTY_RETRIES, AgentRunner
    from agent.runner_helpers import InjectedMessage

    provider = MagicMock()
    call_count = {"n": 0}

    async def chat_stream_with_retry(*, messages, **kwargs):
        call_count["n"] += 1
        if call_count["n"] <= _MAX_EMPTY_RETRIES + 1:
            if call_count["n"] == _MAX_EMPTY_RETRIES + 1:
                await injection_queue.put(InjectedMessage(
                    channel="cli",
                    sender_id="u",
                    chat_id="c",
                    content="follow-up after empty",
                ))
            return LLMResponse(content="", tool_calls=[], usage=None)
        # After retries exhausted + injection drain, respond normally
        return LLMResponse(content="answer after empty", tool_calls=[], usage=None)

    provider.chat_stream_with_retry = chat_stream_with_retry
    tools = MagicMock()
    tools.get_definitions.return_value = []

    injection_queue = asyncio.Queue()
    inject_cb = _make_injection_callback(injection_queue)

    runner = AgentRunner()
    result = await runner.run(make_run_spec(provider,
        initial_messages=[
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "previous response"},
            {"role": "user", "content": "trigger empty"},
        ],
        tools=tools,
        model="test-model",
        max_iterations=10,
        injection_callback=inject_cb,
    ))

    assert result.had_injections is True
    assert result.final_content == "answer after empty"
    injected = [
        m for m in result.messages
        if m.get("role") == "user" and "follow-up after empty" in str(m.get("content", ""))
    ]
    assert len(injected) == 1


@pytest.mark.asyncio
async def test_max_iterations_keeps_late_injection_queued():
    """Never consume a user message when no later model request can observe it."""
    from nanobot.agent.hook import AgentHook
    from nanobot.agent.runner import AgentRunner
    from agent.runner_helpers import InjectedMessage

    provider = MagicMock()
    call_count = {"n": 0}

    async def chat_stream_with_retry(*, messages, **kwargs):
        call_count["n"] += 1
        return LLMResponse(
            content="",
            tool_calls=[ToolCallRequest(id=f"c{call_count['n']}", name="read_file", arguments={"path": "x"})],
            usage=None,
        )

    provider.chat_stream_with_retry = chat_stream_with_retry
    tools = ScriptedTools(AsyncMock(return_value="file content"), definitions=[])

    injection_queue = asyncio.Queue()
    inject_cb = _make_injection_callback(injection_queue)

    class InjectAfterLastIterationHook(AgentHook):
        async def after_iteration(self, context) -> None:
            if context.iteration == 1:
                await injection_queue.put(InjectedMessage(
                    channel="cli",
                    sender_id="u",
                    chat_id="c",
                    content="follow-up after max iters",
                ))

    runner = AgentRunner()
    result = await runner.run(make_run_spec(provider,
        initial_messages=[{"role": "user", "content": "hello"}],
        tools=tools,
        model="test-model",
        max_iterations=2,
        injection_callback=inject_cb,
        hook=InjectAfterLastIterationHook(),
    ))

    assert result.stop_reason == "max_iterations"
    assert result.had_injections is False
    assert injection_queue.qsize() == 1
    assert (await injection_queue.get()).content == "follow-up after max iters"


@pytest.mark.asyncio
async def test_error_path_is_not_stopped_by_an_arbitrary_injection_cap():
    """Error recovery consumes every arrived snapshot until no follow-up remains."""
    from nanobot.agent.runner import AgentRunner
    from agent.runner_helpers import InjectedMessage

    provider = MagicMock()
    call_count = {"n": 0}
    injection_queue = asyncio.Queue()

    async def chat_stream_with_retry(*, messages, **kwargs):
        call_count["n"] += 1
        if call_count["n"] <= 7:
            await injection_queue.put(InjectedMessage(
                channel="cli",
                sender_id="u",
                chat_id="c",
                content=f"msg-{call_count['n']}",
            ))
        return LLMResponse(
            content=None,
            tool_calls=[],
            finish_reason="error",
            usage=None,
        )

    provider.chat_stream_with_retry = chat_stream_with_retry
    tools = MagicMock()
    tools.get_definitions.return_value = []

    inject_cb = _make_injection_callback(injection_queue)

    runner = AgentRunner()
    result = await runner.run(make_run_spec(provider,
        initial_messages=[
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "previous"},
            {"role": "user", "content": "trigger error"},
        ],
        tools=tools,
        model="test-model",
        max_iterations=20,
        injection_callback=inject_cb,
    ))

    assert result.had_injections is True
    assert call_count["n"] == 8
