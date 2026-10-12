"""A tool result reaches the model whole, unless it does not fit in what the model's window leaves for it once
compaction did what it could; then it is cut there, and the cut says how much came through."""

from __future__ import annotations

import re
from unittest.mock import AsyncMock, MagicMock

import pytest

from agent.runner_helpers import ScriptedTools, make_run_spec
from nanobot.agent.context_governance import ContextGovernanceConfig, ContextGovernor
from nanobot.agent.runner import AgentRunner
from nanobot.agent.tools.registry import ToolRegistry
from nanobot.providers.base import LLMResponse, LLMUsage, ToolCallRequest
from nanobot.utils.helpers import estimate_prompt_tokens

# A window this small leaves about 8000 tokens for the prompt: 10000, less 1000 kept for the answer and the
# estimate's 1024 of margin.
SMALL_WINDOW = 10_000
ANSWER = 1_000
BUDGET = SMALL_WINDOW - ANSWER - 1024
LONG = "".join(f"word{n} " for n in range(40_000))


def _config(window: int | None = SMALL_WINDOW) -> ContextGovernanceConfig:
    return ContextGovernanceConfig(
        provider=MagicMock(), model="z-ai/glm-5.3-flash", tools=ToolRegistry(), session_key="s",
        context_window_tokens=window, max_tokens=ANSWER,
    )


def _call(call_id: str, name: str = "exec") -> dict:
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": "{}"}}


def _result(call_id: str, content: str, name: str = "exec") -> dict:
    return {"role": "tool", "tool_call_id": call_id, "name": name, "content": content}


async def _second_request(tool_results: list[tuple[str, str]], window: int) -> list[dict]:
    """The messages of the request that follows one round of tool calls answering `tool_results`."""
    provider = MagicMock()
    captured: list[dict] = []
    calls = {"n": 0}

    async def chat_stream_with_retry(*, messages, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            return LLMResponse(
                content="working",
                tool_calls=[
                    ToolCallRequest(id=f"call_{n}", name=name, arguments={"path": "big.txt"})
                    for n, (name, _) in enumerate(tool_results)
                ],
                usage=LLMUsage.reported(input_tokens=5, output_tokens=3),
            )
        captured[:] = messages
        return LLMResponse(content="done", tool_calls=[], usage=None)

    provider.chat_stream_with_retry = chat_stream_with_retry
    run = await AgentRunner().run(make_run_spec(
        provider,
        initial_messages=[{"role": "user", "content": "do task"}],
        tools=ScriptedTools(AsyncMock(side_effect=[result for _, result in tool_results]), definitions=[]),
        model="z-ai/glm-5.3-flash",
        max_iterations=2,
        context_window_tokens=window,
        max_tokens=ANSWER,
    ))
    assert run.final_content == "done"
    return captured


def _tool_messages(messages: list[dict]) -> list[dict]:
    return [message for message in messages if message.get("role") == "tool"]


async def test_a_long_result_that_fits_the_window_reaches_the_model_whole() -> None:
    # 200000 characters: sixteen times what the old fixed cut let through.
    result = "".join(f"line {n}\n" for n in range(25_000))

    [message] = _tool_messages(await _second_request([("exec", result)], window=1_000_000))

    assert message["content"] == result


@pytest.mark.parametrize("tool", ["exec", "read_file", "browser_read_text"])
async def test_a_result_too_big_for_the_window_is_cut_where_it_ends_and_says_how_much(tool: str) -> None:
    messages = await _second_request([(tool, LONG)], window=SMALL_WINDOW)
    [message] = _tool_messages(messages)

    content = message["content"]
    kept = int(re.search(r"\[Cut here: the first (\d+) of \d+ characters", content).group(1))
    assert content.startswith(LONG[:kept])
    assert f"of {len(LONG)} characters" in content
    assert "context window of z-ai/glm-5.3-flash (10000 tokens)" in content
    assert "ask for less to see the rest" in content
    # Cut where the window ends: the request it is in fits the budget, and not by much.
    assert BUDGET - 300 < estimate_prompt_tokens(messages) < BUDGET


async def test_results_of_the_same_round_share_the_room_so_together_they_still_fit() -> None:
    messages = await _second_request([("exec", LONG), ("read_file", LONG)], window=SMALL_WINDOW)
    first, second = _tool_messages(messages)

    assert "[Cut here" in first["content"] and "[Cut here" in second["content"]
    assert estimate_prompt_tokens(messages) < BUDGET


def test_with_no_window_known_nothing_is_cut() -> None:
    governor = ContextGovernor()
    config = _config(window=None)
    messages = [{"role": "user", "content": "x"}, {"role": "assistant", "content": "", "tool_calls": [_call("a")]},
                _result("a", LONG)]

    assert governor.result_room(config, messages) is None
    assert governor.fit_latest_round(config, messages, None) is messages
    assert ContextGovernor.normalize_tool_result(config, "exec", LONG, None) == LONG


def test_a_result_is_stored_cut_only_beyond_what_no_compaction_could_make_room_for() -> None:
    governor = ContextGovernor()
    config = _config()
    system = {"role": "system", "content": "the Dot's prompt"}
    history = [{"role": "user", "content": "q " * 3_000}, {"role": "assistant", "content": "a " * 3_000}]
    round_ = [{"role": "assistant", "content": "", "tool_calls": [_call("b")]}, _result("b", "")]

    # The history and the results of earlier rounds can be summarized and cleared: they take none of it. The
    # system prompt and the result's own framing stay.
    room = governor.result_room(config, [system, *history, *round_])
    assert room == governor.result_room(config, [system, *round_])
    assert room < governor.result_room(config, round_)


def test_a_request_that_fits_is_left_as_it_is() -> None:
    governor = ContextGovernor()
    messages = [{"role": "user", "content": "x"}, {"role": "assistant", "content": "", "tool_calls": [_call("a")]},
                _result("a", "short")]

    assert governor.fit_latest_round(_config(), messages, None) is messages


def test_only_the_latest_rounds_results_give_way_and_in_their_order() -> None:
    governor = ContextGovernor()
    config = _config()
    earlier = [{"role": "assistant", "content": "", "tool_calls": [_call("a")]}, _result("a", "kept as it is")]
    latest = [{"role": "assistant", "content": "", "tool_calls": [_call("b"), _call("c")]},
              _result("b", LONG), _result("c", LONG)]
    messages = [{"role": "user", "content": "x"}, *earlier, *latest]

    fitted = governor.fit_latest_round(config, messages, None)

    assert fitted[2] == earlier[1]
    assert "[Cut here" in fitted[4]["content"] and "[Cut here" in fitted[5]["content"]
    # The first result took what was left but for the second's note.
    assert len(fitted[4]["content"]) > 10 * len(fitted[5]["content"])
    assert estimate_prompt_tokens(fitted) < BUDGET


def test_a_result_cut_again_keeps_the_length_of_the_whole_result() -> None:
    config = _config()
    once = ContextGovernor.normalize_tool_result(config, "exec", LONG, 5_000)
    twice = ContextGovernor.normalize_tool_result(config, "exec", once, 1_000)

    assert f"of {len(LONG)} characters" in once and f"of {len(LONG)} characters" in twice
    assert twice.count("[Cut here") == 1
    kept = int(re.search(r"the first (\d+) of", twice).group(1))
    assert twice.startswith(LONG[:kept])


def test_text_blocks_share_the_room_and_an_image_is_kept() -> None:
    image = {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}
    text = "".join(f"word{n} " for n in range(2_000))
    result = [{"type": "text", "text": text}, image, {"type": "text", "text": text}]

    config = _config()
    first, kept_image, second = ContextGovernor.normalize_tool_result(config, "browser_snapshot", result, 1_000)

    assert kept_image == image
    assert "[Cut here" in first["text"] and "[Cut here" in second["text"]
    assert ContextGovernor._tokens(config, first["text"]) + ContextGovernor._tokens(config, second["text"]) <= 1_000


@pytest.mark.parametrize("invalid_block", [42, ["nested"], {}, {"type": "text", "text": 42}])
def test_a_result_list_it_does_not_recognize_is_left_whole(invalid_block: object) -> None:
    result = [{"type": "text", "text": "x" * 20_000}, invalid_block]

    assert ContextGovernor.normalize_tool_result(_config(), "custom", result, 10) is result
