"""Compatibility helpers while runner tests migrate to immutable runtimes."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from fakes.allow_all_gate import AllowAllGate

from nanobot.agent.context import TranscriptInput
from nanobot.agent.runner import AgentRunSpec
from nanobot.agent.tools.base import Tool
from nanobot.agent.tools.registry import ToolRegistry
from nanobot.providers.base import GenerationSettings, LLMProvider
from nanobot.utils.llm_runtime import LLMRuntime


@dataclass
class InjectedMessage:
    """A pending input handed to the runner by an injection callback.

    The runner reads only ``content``; the other fields carry what an inbound
    event would have carried so the tests keep the shape they were written for.
    """

    channel: str
    sender_id: str
    chat_id: str
    content: str
    media: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


async def failed_test_consolidator(
    _messages: list[dict[str, Any]],
    _previous_summary: str | None,
) -> None:
    """Model a failed summary and raw fallback in tests not exercising compaction."""


def transcript_of(
    messages: list[dict[str, Any]],
) -> tuple[TranscriptInput, Callable[[TranscriptInput], list[dict[str, Any]]]]:
    """The transcript input and builder that make a run start from exactly `messages`.

    The first message holds the system slot (an archived summary is added to its text, as the
    Dot's builder adds it to the system prompt); the others are the history.
    """
    first, *history = messages

    def build(transcript: TranscriptInput) -> list[dict[str, Any]]:
        head = dict(first)
        summary = transcript.session_summary
        if summary is not None and isinstance(head.get("content"), str):
            head["content"] = (
                f"{head['content']}\n\n---\n\n[Archived Context Summary]\n\n"
                f"Previous conversation summary:\n{summary['text']}"
            )
        return [head, *transcript.history]

    return TranscriptInput(history=history, current_message=None), build


def make_run_spec(provider: LLMProvider, **kwargs: Any) -> AgentRunSpec:
    """Build a run spec from the pre-runtime test arguments.

    `initial_messages` is the transcript the run starts from (see `transcript_of`).

    Keeping this translation in test support makes production's execution
    contract strict while avoiding irrelevant setup noise in runner behavior
    tests.  New tests should pass ``runtime`` to ``AgentRunSpec`` directly when
    runtime identity is itself under test.
    """
    model = kwargs.pop("model")
    context_window_tokens = kwargs.pop(
        "context_window_tokens",
        200_000,
    )
    provider_generation = getattr(provider, "generation", None)
    defaults = GenerationSettings()

    temperature = kwargs.pop("temperature", None)
    if temperature is None:
        candidate = getattr(provider_generation, "temperature", None)
        temperature = candidate if isinstance(candidate, (int, float)) else defaults.temperature

    max_tokens = kwargs.pop("max_tokens", None)
    if max_tokens is None:
        candidate = getattr(provider_generation, "max_tokens", None)
        max_tokens = candidate if isinstance(candidate, int) else defaults.max_tokens

    runtime = LLMRuntime(
        provider=provider,
        model=model,
        generation=GenerationSettings(
            temperature=temperature,
            max_tokens=max_tokens,
        ),
        context_window_tokens=context_window_tokens,
    )
    initial_messages = kwargs.pop("initial_messages", None)
    if initial_messages is not None:
        transcript_input, transcript_builder = transcript_of(initial_messages)
        kwargs.setdefault("transcript_input", transcript_input)
        kwargs.setdefault("transcript_builder", transcript_builder)
    kwargs.setdefault("consolidate_history", failed_test_consolidator)
    # Runner tests that are not about the gate run under one that allows everything.
    kwargs.setdefault("gate", AllowAllGate())
    return AgentRunSpec(runtime=runtime, **kwargs)


class _ScriptedTool(Tool):
    """A tool whose execution is a test's callable: `execute(name, params)`."""

    def __init__(self, name: str, execute: Callable[[str, dict[str, Any]], Awaitable[Any]]) -> None:
        self._name = name
        self._execute = execute

    @property
    def name(self) -> str:
        return self._name

    @property
    def description(self) -> str:
        return "scripted"

    @property
    def parameters(self) -> dict[str, Any]:
        return {"type": "object", "properties": {}}

    async def execute(self, **kwargs: Any) -> Any:
        return await self._execute(self._name, kwargs)


class ScriptedTools(ToolRegistry):
    """A registry in which every tool name resolves to the test's `execute(name, params)`.

    The runner tests exercise the runner and the one path that runs tools, not each
    tool: `execute` is the mock they assert on.
    """

    def __init__(
        self,
        execute: Callable[[str, dict[str, Any]], Awaitable[Any]],
        definitions: list[dict[str, Any]] | None = None,
    ) -> None:
        super().__init__()
        self.execute = execute
        self._definitions = definitions if definitions is not None else []

    def get_definitions(self) -> list[dict[str, Any]]:
        return self._definitions

    def get(self, name: str) -> Tool:
        return _ScriptedTool(name, self.execute)

    def prepare_call(self, name: str, params: Any) -> tuple[Tool, Any, str | None]:
        return self.get(name), params, None
