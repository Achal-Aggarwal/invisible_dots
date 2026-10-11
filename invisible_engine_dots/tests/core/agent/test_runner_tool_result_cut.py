"""A tool result reaches the model cut to max_tool_result_chars; read_file keeps its own bound."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from fakes.local_computer import LocalComputer

from agent.runner_helpers import ScriptedTools, make_run_spec
from nanobot.agent.context_governance import ContextGovernanceConfig, ContextGovernor
from nanobot.agent.runner import AgentRunner
from nanobot.agent.tools.registry import ToolRegistry
from nanobot.agent.tools.search import GrepTool
from nanobot.providers.base import LLMResponse, LLMUsage, ToolCallRequest

_MAX_TOOL_RESULT_CHARS = 16_000


def _config(max_chars: int) -> ContextGovernanceConfig:
    return ContextGovernanceConfig(
        provider=MagicMock(), model="test", tools=ToolRegistry(), session_key="s", max_tool_result_chars=max_chars,
    )


async def _second_request_tool_message(tool_name: str, result: str, max_chars: int) -> dict:
    provider = MagicMock()
    captured: list[dict] = []
    calls = {"n": 0}

    async def chat_stream_with_retry(*, messages, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            return LLMResponse(
                content="working",
                tool_calls=[ToolCallRequest(id="call_1", name=tool_name, arguments={"path": "big.txt"})],
                usage=LLMUsage.reported(input_tokens=5, output_tokens=3),
            )
        captured[:] = messages
        return LLMResponse(content="done", tool_calls=[], usage=None)

    provider.chat_stream_with_retry = chat_stream_with_retry
    result_of_run = await AgentRunner().run(make_run_spec(
        provider,
        initial_messages=[{"role": "user", "content": "do task"}],
        tools=ScriptedTools(AsyncMock(return_value=result), definitions=[]),
        model="test-model",
        max_iterations=2,
        max_tool_result_chars=max_chars,
    ))
    assert result_of_run.final_content == "done"
    return next(msg for msg in captured if msg.get("role") == "tool")


async def test_a_long_result_reaches_the_model_cut_to_the_limit() -> None:
    message = await _second_request_tool_message("exec", "x" * 5000, max_chars=2048)

    assert message["content"] == "x" * 2048 + "\n... (truncated)"


async def test_a_read_file_result_is_not_cut_it_has_its_own_bound() -> None:
    message = await _second_request_tool_message("read_file", "x" * 20_000, max_chars=2048)

    assert message["content"] == "x" * 20_000


def test_each_text_block_of_a_result_is_cut_and_an_image_is_kept() -> None:
    image = {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}
    result = [{"type": "text", "text": "y" * 100}, image]

    normalized = ContextGovernor.normalize_tool_result(_config(10), "custom", result)

    assert normalized == [{"type": "text", "text": "y" * 10 + "\n... (truncated)"}, image]


@pytest.mark.parametrize("invalid_block", [42, ["nested"], {}, {"type": "text", "text": 42}])
def test_a_result_list_it_does_not_recognize_is_left_whole(invalid_block: object) -> None:
    result = [{"type": "text", "text": "x" * 20_000}, invalid_block]

    assert ContextGovernor.normalize_tool_result(_config(2048), "custom", result) is result


async def test_a_grep_page_fits_the_default_limit_unchanged(tmp_path) -> None:
    (tmp_path / "source.txt").write_text(
        "\n".join(f"needle {n} " + "x" * 100 for n in range(200)), encoding="utf-8",
    )
    page = await GrepTool(computer=LocalComputer(tmp_path)).execute(pattern="needle", head_limit=0)

    normalized = ContextGovernor.normalize_tool_result(_config(_MAX_TOOL_RESULT_CHARS), "grep", page)

    assert "use offset=" in normalized
    assert normalized == page
