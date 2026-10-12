"""Model-message governance and compaction for agent runner requests.

This module owns model-facing message shaping, request pressure, H/delta
compaction state, and tool-result content normalization. It may return copied
messages, but it must not mutate an existing session history list in place.
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from copy import deepcopy
from dataclasses import dataclass, replace
from datetime import datetime
from typing import TYPE_CHECKING, Any, cast

from loguru import logger

from nanobot.agent.context import TranscriptInput
from nanobot.providers.base import CONTEXT_SAFETY_BUFFER, LLMUsage
from nanobot.session.history_visibility import is_hidden_history_message
from nanobot.session.summary import (
    SUMMARY_CONTINUATION_TEXT,
    SessionSummaryCheckpoint,
)
from nanobot.utils.helpers import (
    estimate_message_tokens,
    estimate_prompt_tokens_chain,
)
from nanobot.utils.runtime import ensure_nonempty_tool_result

if TYPE_CHECKING:
    from nanobot.agent.tools.registry import ToolRegistry
    from nanobot.providers.base import LLMProvider

TranscriptBuilder = Callable[[TranscriptInput], list[dict[str, Any]]]
SummaryTranscriptBuilder = Callable[[str], list[dict[str, Any]]]
HistoryConsolidator = Callable[
    [list[dict[str, Any]], str | None],
    Awaitable[str | None],
]

BACKFILL_CONTENT = "[Tool result unavailable - call was interrupted or lost]"
# A request is compacted only when it reaches its model's own window, less the room kept for the answer: 20000
# tokens, or the model's longest answer when that is shorter (opencode's rule, MIT:
# github.com/anomalyco/opencode, packages/opencode/src/session/overflow.ts).
ANSWER_ROOM_TOKENS = 20_000
# Compacting starts by clearing old tool results, which needs no model call and, measured on SWE-bench, costs
# half as much as summarizing for the same solve rate (JetBrains, "The Complexity Trap", arXiv 2508.21433). The
# newest 40000 tokens of results stay, and the older ones are cleared only when that frees 20000 tokens or more
# (opencode's PRUNE_PROTECT and PRUNE_MINIMUM). Unlike opencode, the results of the last user turns are not
# kept whole: a task is one user turn, so that rule would never clear anything in the long work it is for.
CLEAR_PROTECT_TOKENS = 40_000
CLEAR_MINIMUM_TOKENS = 20_000
CLEARED_TOOL_RESULT = "[Old tool result cleared to save context; call the tool again if you need it.]"
# The note at the end of a result cut to fit the window (ContextGovernor._cut_note): what was kept, of how much.
_CUT_NOTE = re.compile(r"\n\n\[Cut here: the first (\d+) of (\d+) characters\. [^\n]*\]\Z")
PLACEHOLDER_TEXTS = frozenset({
    "[Previous assistant message omitted.]",
})


def prompt_budget(context_window_tokens: int | None, max_tokens: int | None) -> int:
    """The tokens a prompt may take: the model's window less the room kept for the answer (ANSWER_ROOM_TOKENS, or
    the model's longest answer when that is shorter) and the estimate's safety margin; 0 when the window is not
    known, which leaves the request as it is."""
    if not context_window_tokens:
        return 0
    answer_room = ANSWER_ROOM_TOKENS if max_tokens is None else min(ANSWER_ROOM_TOKENS, max_tokens)
    return max(0, context_window_tokens - answer_room - CONTEXT_SAFETY_BUFFER)


def answer_limit(context_window_tokens: int | None, max_tokens: int | None, prompt_tokens: int) -> int | None:
    """The answer limit a request sends: the model's longest answer, or what its window leaves after the prompt
    when that is less (a provider refuses more); None when the model publishes no longest answer."""
    if max_tokens is None:
        return None
    if not context_window_tokens:
        return max_tokens
    return max(1, min(max_tokens, context_window_tokens - prompt_tokens - CONTEXT_SAFETY_BUFFER))


class ContextWindowExceededError(RuntimeError):
    """Raised before a request that exceeds its local context budget."""

    def __init__(
        self,
        *,
        session_key: str | None,
        estimated_tokens: int,
        input_budget: int,
        source: str,
    ) -> None:
        self.session_key = session_key
        self.estimated_tokens = estimated_tokens
        self.input_budget = input_budget
        self.source = source
        super().__init__(
            "Model input exceeds the local context budget "
            f"for {session_key or 'default'}: {estimated_tokens}/{input_budget} via {source}"
        )


def _tool_call_name_is_valid(tool_call: Any) -> bool:
    """Whether a persisted OpenAI-style tool_call carries a usable name.

    Mirrors ``ToolCallRequest.has_valid_name`` for the dict shape stored in
    message history: a degenerate call with ``name=None`` / ``""`` cannot be
    executed and is rejected by upstream APIs if replayed.
    """
    if not isinstance(tool_call, dict):
        return False
    tool_call_data = cast(dict[str, Any], tool_call)
    fn = tool_call_data.get("function")
    name = cast(dict[str, Any], fn).get("name") if isinstance(fn, dict) else tool_call_data.get("name")
    return isinstance(name, str) and bool(name)


@dataclass(slots=True)
class ContextGovernanceConfig:
    provider: LLMProvider
    model: str
    tools: ToolRegistry
    session_key: str | None
    context_window_tokens: int | None = None
    max_tokens: int | None = None


@dataclass(slots=True)
class ContextCompactionState:
    """Track accepted provider input H separately from the unsent delta."""

    raw_messages: list[dict[str, Any]]
    accepted_messages: list[dict[str, Any]]
    raw_accepted_boundary: int
    active_summary: str | None
    summary_transcript_builder: SummaryTranscriptBuilder
    consolidate_history: HistoryConsolidator
    summary_checkpoint: SessionSummaryCheckpoint | None = None

    @classmethod
    def from_transcript(
        cls,
        transcript_input: TranscriptInput,
        transcript_builder: TranscriptBuilder,
        consolidate_history: HistoryConsolidator,
    ) -> tuple[list[dict[str, Any]], ContextCompactionState]:
        """Build the raw transcript and its initial H/delta boundary."""
        messages = list(transcript_builder(transcript_input))
        accepted_history_boundary = 1 + len(transcript_input.history)

        def build_summary_transcript(summary: str) -> list[dict[str, Any]]:
            return transcript_builder(
                replace(
                    transcript_input,
                    history=[],
                    current_message=None,
                    session_summary={
                        "text": summary,
                        "last_active": datetime.now().astimezone().isoformat(),
                    },
                )
            )

        return messages, cls(
            raw_messages=messages,
            accepted_messages=deepcopy(messages[:accepted_history_boundary]),
            raw_accepted_boundary=accepted_history_boundary,
            active_summary=(
                transcript_input.session_summary["text"]
                if transcript_input.session_summary is not None
                else None
            ),
            summary_transcript_builder=build_summary_transcript,
            consolidate_history=consolidate_history,
        )

    def request_messages(
        self,
        raw_messages: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        return [
            *deepcopy(self.accepted_messages),
            *deepcopy(raw_messages[self.raw_accepted_boundary:]),
        ]

    def delta_after_accepted(
        self,
        request_messages: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        return deepcopy(request_messages[len(self.accepted_messages):])

    def accept_request(
        self,
        model_messages: list[dict[str, Any]],
        *,
        raw_boundary: int,
    ) -> None:
        """Advance H after the provider has received one request."""
        self.accepted_messages = deepcopy(model_messages)
        self.raw_accepted_boundary = raw_boundary


@dataclass(slots=True)
class ModelRequestState:
    """Context state shared by every provider request in one runner turn."""

    config: ContextGovernanceConfig
    compaction: ContextCompactionState
    usage: LLMUsage | None = None
    messages: list[dict[str, Any]] | None = None
    tool_definitions: list[dict[str, Any]] | None = None
    # The answer limit of the request prepare_request prepared last (None: no limit is known, none is sent).
    answer_tokens: int | None = None


class ContextGovernor:
    """Own model-request context while preserving persisted history."""

    @staticmethod
    def _merge_message_content(left: Any, right: Any) -> str | list[dict[str, Any]]:
        if isinstance(left, str) and isinstance(right, str):
            return f"{left}\n\n{right}" if left else right

        def _to_blocks(value: Any) -> list[dict[str, Any]]:
            if isinstance(value, list):
                return [
                    cast(dict[str, Any], item)
                    if isinstance(item, dict)
                    else {"type": "text", "text": str(item)}
                    for item in cast(list[Any], value)
                ]
            if value is None:
                return []
            return [{"type": "text", "text": str(value)}]

        return _to_blocks(left) + _to_blocks(right)

    @classmethod
    def _merge_adjacent_user_messages_for_model(
        cls,
        messages: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Merge adjacent visible user messages only in the model-facing copy."""
        prepared: list[dict[str, Any]] = []
        for source in messages:
            injection = deepcopy(source)
            if (
                prepared
                and injection.get("role") == "user"
                and prepared[-1].get("role") == "user"
                and injection.get("content") != SUMMARY_CONTINUATION_TEXT
                and prepared[-1].get("content") != SUMMARY_CONTINUATION_TEXT
                and not is_hidden_history_message(injection)
                and not is_hidden_history_message(prepared[-1])
            ):
                merged = dict(prepared[-1])
                merged["content"] = cls._merge_message_content(
                    merged.get("content"),
                    injection.get("content"),
                )
                prepared[-1] = merged
                continue
            prepared.append(injection)
        return prepared

    def prepare_messages_for_model(
        self,
        config: ContextGovernanceConfig,
        messages: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Build the normalized model-facing copy of a raw transcript."""
        governed = self.prepare_for_model(config, messages)
        return self._merge_adjacent_user_messages_for_model(governed)

    def prepare_for_model(
        self,
        config: ContextGovernanceConfig,
        messages: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        updated = self.strip_placeholder_assistant_messages(messages)
        updated = self.strip_malformed_tool_calls(updated)
        updated = self.drop_orphan_tool_results(updated)
        updated = self.backfill_missing_tool_results(updated)
        # No result is cut here: a request that does not fit is compacted first, and only then are the results of
        # its latest round cut to what the window leaves (`fit_latest_round`).
        return self.ensure_nonempty_results(updated)

    def ensure_request_fits(
        self,
        config: ContextGovernanceConfig,
        messages: list[dict[str, Any]],
        *,
        tool_definitions: list[dict[str, Any]] | None,
    ) -> list[dict[str, Any]]:
        """Validate an exact model request without dropping any messages."""
        if not config.context_window_tokens:
            return messages
        budget = self.input_budget(config)
        estimated, source = estimate_prompt_tokens_chain(
            config.provider,
            config.model,
            messages,
            tool_definitions,
        )
        if budget > 0 and estimated <= budget:
            return messages
        raise ContextWindowExceededError(
            session_key=config.session_key,
            estimated_tokens=estimated,
            input_budget=budget,
            source=source,
        )

    def _pressured(self, config: ContextGovernanceConfig, measurement: tuple[int, str] | None) -> bool:
        budget = self.input_budget(config)
        return measurement is not None and not (budget > 0 and measurement[0] < budget)

    def measure_request(
        self,
        config: ContextGovernanceConfig,
        messages: list[dict[str, Any]],
        usage: LLMUsage | None,
        *,
        usage_matches_messages: bool,
        tool_definitions: list[dict[str, Any]] | None,
    ) -> tuple[int, str] | None:
        """The prompt tokens of a request, from its authoritative source; None when the window is not known."""
        if not config.context_window_tokens:
            return None
        if (
            usage_matches_messages
            and usage is not None
            and usage.context_tokens is not None
        ):
            measured = usage.context_tokens
            source = "matching provider usage"
        else:
            measured, source = estimate_prompt_tokens_chain(
                config.provider,
                config.model,
                messages,
                tool_definitions,
            )
        return measured, source

    @staticmethod
    def _summary_transcript(
        compaction: ContextCompactionState,
        summary: str,
    ) -> list[dict[str, Any]]:
        """Rebuild only the stable system prefix around a replacement summary."""
        return compaction.summary_transcript_builder(summary)

    async def _compact_request_history(
        self,
        state: ModelRequestState,
        compaction: ContextCompactionState,
        messages: list[dict[str, Any]],
        pressure: tuple[int, str],
        *,
        tool_definitions: list[dict[str, Any]] | None,
    ) -> list[dict[str, Any]]:
        """Replace accepted history H with a checkpoint while preserving delta."""
        measured, source = pressure
        delta_messages = compaction.delta_after_accepted(messages)
        consolidation_prefix = self.prepare_messages_for_model(
            state.config,
            compaction.accepted_messages,
        )
        summary = await compaction.consolidate_history(
            deepcopy(consolidation_prefix),
            compaction.active_summary,
        )
        if not summary:
            # Nothing older to summarize: what is left to give way is the latest round's results, if it has any.
            current = self.prepare_messages_for_model(state.config, messages)
            fitted = self.fit_latest_round(state.config, current, tool_definitions)
            if fitted is current:
                raise ContextWindowExceededError(
                    session_key=state.config.session_key,
                    estimated_tokens=measured,
                    input_budget=self.input_budget(state.config),
                    source=source,
                )
            return self.ensure_request_fits(state.config, fitted, tool_definitions=tool_definitions)

        compaction.active_summary = summary
        # Fresh user input defines the next task. Only ongoing work without
        # new user input needs a temporary instruction to resume after H is replaced.
        continuation = (
            []
            if any(message.get("role") == "user" for message in delta_messages)
            else [{"role": "user", "content": SUMMARY_CONTINUATION_TEXT}]
        )
        prepared = self.prepare_messages_for_model(
            state.config,
            [
                *self._summary_transcript(compaction, summary),
                *continuation,
                *delta_messages,
            ],
        )
        state.usage = None
        prepared = self.ensure_request_fits(
            state.config,
            self.fit_latest_round(state.config, prepared, tool_definitions),
            tool_definitions=tool_definitions,
        )
        compaction.summary_checkpoint = SessionSummaryCheckpoint(
            summary=summary,
            transcript_boundary=compaction.raw_accepted_boundary,
        )
        return prepared

    async def prepare_request(
        self,
        state: ModelRequestState,
        messages: list[dict[str, Any]],
        *,
        tool_definitions: list[dict[str, Any]] | None,
    ) -> list[dict[str, Any]]:
        """Prepare or compact and record the exact provider payload."""
        prepared = self.prepare_messages_for_model(state.config, messages)
        usage_matches_messages = (
            state.messages is not None
            and prepared == state.messages
            and tool_definitions == state.tool_definitions
        )
        measurement = self.measure_request(
            state.config,
            prepared,
            state.usage,
            usage_matches_messages=usage_matches_messages,
            tool_definitions=tool_definitions,
        )
        pressure = measurement if self._pressured(state.config, measurement) else None
        # The prompt the answer limit is figured from: this measurement, measured again if the request changes.
        prompt_tokens = measurement[0] if measurement is not None else 0
        if pressure is not None:
            # First the cheap step: clear old tool results. When the request then fits, no summary is written.
            cleared = self.clear_old_tool_results(prepared)
            if cleared is not None:
                measured = estimate_prompt_tokens_chain(
                    state.config.provider, state.config.model, cleared, tool_definitions,
                )
                if measured[0] < self.input_budget(state.config):
                    logger.info(
                        "Cleared old tool results for {}: {} tokens before, {} after (budget {})",
                        state.config.session_key or "default", pressure[0], measured[0],
                        self.input_budget(state.config),
                    )
                    prepared = cleared
                    pressure = None
                    prompt_tokens = measured[0]
                    state.usage = None
        if pressure is not None:
            prepared = await self._compact_request_history(
                state,
                state.compaction,
                messages,
                pressure,
                tool_definitions=tool_definitions,
            )
            prompt_tokens = estimate_prompt_tokens_chain(
                state.config.provider, state.config.model, prepared, tool_definitions,
            )[0]
        state.messages = deepcopy(prepared)
        state.tool_definitions = deepcopy(tool_definitions)
        state.answer_tokens = self.answer_tokens(state.config, prompt_tokens)
        logger.info(
            "request for {}: prompt {} tokens ({}), answer limit {}",
            state.config.session_key or "default",
            prompt_tokens,
            measurement[1] if measurement is not None else "no window",
            state.answer_tokens,
        )
        return prepared

    @staticmethod
    def input_budget(config: ContextGovernanceConfig) -> int:
        """The tokens a request's prompt may take before it is compacted (`prompt_budget`)."""
        return prompt_budget(config.context_window_tokens, config.max_tokens)

    @staticmethod
    def answer_tokens(config: ContextGovernanceConfig, prompt_tokens: int) -> int | None:
        """The answer limit a request sends (`answer_limit`)."""
        return answer_limit(config.context_window_tokens, config.max_tokens, prompt_tokens)

    @staticmethod
    def clear_old_tool_results(messages: list[dict[str, Any]]) -> list[dict[str, Any]] | None:
        """The request with its older tool results cleared, or None when that would free too little.

        Walking back from the newest message, the first CLEAR_PROTECT_TOKENS tokens of tool results stay; every
        older result is replaced by CLEARED_TOOL_RESULT when together they free CLEAR_MINIMUM_TOKENS or more. The
        calls, the reasoning and every other message stay as they are, and a cleared result keeps its call id.
        """
        protected = 0
        freed = 0
        cleared: list[int] = []
        for index in range(len(messages) - 1, -1, -1):
            message = messages[index]
            if message.get("role") != "tool" or message.get("content") == CLEARED_TOOL_RESULT:
                continue
            tokens = estimate_message_tokens(message)
            if protected < CLEAR_PROTECT_TOKENS:
                protected += tokens
                continue
            cleared.append(index)
            freed += tokens
        if freed < CLEAR_MINIMUM_TOKENS:
            return None
        updated = list(messages)
        for index in cleared:
            updated[index] = {**messages[index], "content": CLEARED_TOOL_RESULT}
        return updated

    def result_room(self, config: ContextGovernanceConfig, messages: list[dict[str, Any]]) -> int | None:
        """The most the content of the last of `messages`, a tool result with none yet, could ever take: the
        model's prompt budget less what no compaction removes (the system prompt, the tool definitions) and the
        result's own framing. A result is stored cut there because beyond it nothing of it could reach the model;
        whether it fits a given request is `fit_latest_round`'s to say, after compaction. None when the window is
        not known; then nothing is cut.
        """
        if not config.context_window_tokens:
            return None
        kept = [message for message in messages[:-1] if message.get("role") == "system"]
        used, _ = estimate_prompt_tokens_chain(
            config.provider, config.model, [*kept, messages[-1]], config.tools.get_definitions(),
        )
        return max(0, self.input_budget(config) - used - 1)

    def fit_latest_round(
        self,
        config: ContextGovernanceConfig,
        messages: list[dict[str, Any]],
        tool_definitions: list[dict[str, Any]] | None,
    ) -> list[dict[str, Any]]:
        """The request with the results of its latest round of tool calls cut so that it fits the budget, when
        it does not fit as it is: what is left once compaction did what it could (clearing old results, then
        the summary) is the window's to give, and only these results can still give way.

        The results share what the window leaves in their order, each keeping the room of the notes of the
        results after it; the request is one token short of the budget, because one that reaches it is
        compacted. When even empty results would not fit, the request is returned as it is, and does not fit.
        """
        budget = self.input_budget(config)
        last_call = max((i for i, m in enumerate(messages) if m.get("role") == "assistant"), default=-1)
        results = [i for i in range(last_call + 1, len(messages)) if messages[i].get("role") == "tool"]
        if not config.context_window_tokens or budget <= 0 or not results:
            return messages
        estimate = estimate_prompt_tokens_chain(config.provider, config.model, messages, tool_definitions)[0]
        if estimate < budget:
            return messages
        updated = list(messages)
        for n, index in enumerate(results):
            trial = [
                {**message, "content": ""} if i in results and i >= index else message
                for i, message in enumerate(updated)
            ]
            used, _ = estimate_prompt_tokens_chain(config.provider, config.model, trial, tool_definitions)
            later = len(results) - n - 1
            room = max(0, budget - used - later * self._note_tokens(config) - 1)
            message = updated[index]
            updated[index] = {
                **message,
                "content": self.normalize_tool_result(
                    config, str(message.get("name") or "tool"), message.get("content"), room,
                ),
            }
        return updated

    @staticmethod
    def normalize_tool_result(
        config: ContextGovernanceConfig,
        tool_name: str,
        result: Any,
        room: int | None,
    ) -> Any:
        """A tool result as the model gets it: never empty, and whole unless its text takes more than `room` tokens
        (`result_room`); then it is cut there, and the cut says how much came through and how to get the rest."""
        result = ensure_nonempty_tool_result(tool_name, result)
        if room is None:
            return result
        if isinstance(result, str):
            return ContextGovernor._fit(config, result, room)
        if isinstance(result, list):
            blocks = cast(list[object], result)
            for raw_block in blocks:
                if not isinstance(raw_block, dict):
                    return result
                block = cast(dict[str, Any], raw_block)
                if not isinstance(block.get("type"), str):
                    return result
                if block["type"] == "text" and not isinstance(block.get("text"), str):
                    return result
            # The text blocks share the room in their order, each keeping the room of the notes of the text blocks
            # after it; an image block is left as it is.
            fitted: list[dict[str, Any]] = []
            to_come = sum(1 for block in cast(list[dict[str, Any]], blocks) if block["type"] == "text")
            for block in cast(list[dict[str, Any]], blocks):
                if block["type"] == "text":
                    to_come -= 1
                    reserved = to_come * ContextGovernor._note_tokens(config)
                    text = ContextGovernor._fit(config, block["text"], max(0, room - reserved))
                    room = max(0, room - ContextGovernor._tokens(config, text))
                    block = {**block, "text": text}
                fitted.append(block)
            return fitted
        return result

    @staticmethod
    def _cut_note(config: ContextGovernanceConfig, kept: int, total: int) -> str:
        return (
            f"\n\n[Cut here: the first {kept} of {total} characters. The whole result does not fit in the context "
            f"window of {config.model} ({config.context_window_tokens} tokens) beside the rest of the request; ask "
            "for less to see the rest: a narrower selector, a pattern, an offset and a limit.]"
        )

    @staticmethod
    def _tokens(config: ContextGovernanceConfig, text: str) -> int:
        """What `text` adds to a request as a tool result, by the estimate that decides whether the request fits
        (`estimate_prompt_tokens_chain`), so a cut and the check that follows it count alike."""
        def measured(content: str) -> int:
            message = {"role": "tool", "tool_call_id": "call", "name": "tool", "content": content}
            return estimate_prompt_tokens_chain(config.provider, config.model, [message], None)[0]

        return max(0, measured(text) - measured(""))

    @staticmethod
    def _note_tokens(config: ContextGovernanceConfig) -> int:
        """The most a cut's note can take: its numbers at their longest."""
        return ContextGovernor._tokens(config, ContextGovernor._cut_note(config, 10**12, 10**12))

    @staticmethod
    def _fit(config: ContextGovernanceConfig, text: str, room: int) -> str:
        """`text` whole when it takes at most `room` tokens; else its longest start that fits beside the note."""
        whole = ContextGovernor._tokens(config, text)
        if whole <= room:
            return text
        # A result stored cut is cut again from what was kept, and its note keeps the length of the whole result.
        total = len(text)
        earlier = _CUT_NOTE.search(text)
        if earlier is not None:
            text, total = text[: earlier.start()], int(earlier.group(2))

        def cut(kept: int) -> str:
            return text[:kept] + ContextGovernor._cut_note(config, kept, total)

        # The longest start that fits, found by halving: the estimate is not additive, so each try is measured
        # whole. Tokens grow with characters, so the start is searched within twice its proportional share.
        low, high = 0, min(len(text), 2 * len(text) * room // whole + 1)
        while low < high:
            middle = (low + high + 1) // 2
            if ContextGovernor._tokens(config, cut(middle)) <= room:
                low = middle
            else:
                high = middle - 1
        return cut(low)

    @staticmethod
    def ensure_nonempty_results(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Every tool result of a request has content: a provider rejects an empty one."""
        updated = messages
        for idx, message in enumerate(messages):
            if message.get("role") != "tool":
                continue
            content = ensure_nonempty_tool_result(str(message.get("name") or "tool"), message.get("content"))
            if content != message.get("content"):
                if updated is messages:
                    updated = [dict(m) for m in messages]
                updated[idx]["content"] = content
        return updated

    @staticmethod
    def strip_placeholder_assistant_messages(
        messages: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Remove assistant messages that are compaction placeholders.

        Messages like ``[Previous assistant message omitted.]`` carry no useful
        context for the model and can cause it to repeatedly attempt tool calls
        that previously failed, producing malformed responses in a loop.
        Consecutive same-role messages that result from removal are handled
        downstream by the provider's merge-consecutive logic. Only the
        model-facing copy is repaired; the persisted transcript is untouched
        (a copy is returned, or the same list object when nothing changes).
        """
        updated: list[dict[str, Any]] | None = None
        for idx, msg in enumerate(messages):
            if msg.get("role") != "assistant":
                if updated is not None:
                    updated.append(msg)
                continue
            content = msg.get("content", "")
            text = content if isinstance(content, str) else ""
            is_placeholder = text.strip() in PLACEHOLDER_TEXTS
            has_tool_calls = bool(msg.get("tool_calls"))
            if is_placeholder and not has_tool_calls:
                if updated is None:
                    updated = list(messages[:idx])
                logger.debug(
                    "Stripping placeholder assistant message from history: {!r}",
                    text[:60],
                )
                continue
            if updated is not None:
                updated.append(msg)
        if updated is None:
            return messages
        return updated

    @staticmethod
    def strip_malformed_tool_calls(
        messages: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Drop persisted assistant tool_calls whose name is missing/non-string.

        A degenerate tool call (``name=None`` or ``""``) that slipped into the
        saved history before this guard existed gets replayed on every turn and
        makes upstream APIs reject the whole request
        (``messages.content.N.tool_use.name: Input should be a valid string``),
        permanently wedging the session. Removing the bad call here lets the
        existing orphan-result cleanup drop its now-dangling tool result, so a
        polluted session self-heals on its next turn. The persisted transcript
        is left untouched; only the model-facing copy is repaired (a copy is
        returned, or the same list object when nothing changes).
        """
        updated: list[dict[str, Any]] | None = None
        for idx, msg in enumerate(messages):
            if msg.get("role") != "assistant":
                if updated is not None:
                    updated.append(msg)
                continue
            calls = msg.get("tool_calls")
            if not calls:
                if updated is not None:
                    updated.append(msg)
                continue
            kept = [tc for tc in cast(list[Any], calls) if _tool_call_name_is_valid(tc)]
            if len(kept) == len(calls):
                if updated is not None:
                    updated.append(msg)
                continue
            if updated is None:
                updated = [dict(m) for m in messages[:idx]]
            logger.warning(
                "Stripping {} malformed tool_call(s) with missing/non-string "
                "name from assistant history before request",
                len(calls) - len(kept),
            )
            repaired = dict(msg)
            if kept:
                repaired["tool_calls"] = kept
            else:
                repaired.pop("tool_calls", None)
            # An assistant turn with neither content nor any valid tool call is
            # itself invalid upstream; drop it entirely in that case.
            has_content = bool(repaired.get("content"))
            if not kept and not has_content:
                continue
            updated.append(repaired)

        if updated is None:
            return messages
        return updated

    @staticmethod
    def drop_orphan_tool_results(
        messages: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Drop invalid tool results before history is sent back to providers.

        A result answers the latest call that has its id: an assistant message that makes a call
        opens the id again, so a later response that reuses "call_0" (models behind OpenRouter number
        their calls from zero every time) gets its own result kept, and only a second result for one
        call is a duplicate.
        """
        declared: set[str] = set()
        fulfilled: set[str] = set()
        updated: list[dict[str, Any]] | None = None
        for idx, msg in enumerate(messages):
            role = msg.get("role")
            if role == "assistant":
                for tc in cast(list[Any], msg.get("tool_calls") or []):
                    if isinstance(tc, dict):
                        tool_call = cast(dict[str, Any], tc)
                        if tool_call.get("id"):
                            declared.add(str(tool_call["id"]))
                            fulfilled.discard(str(tool_call["id"]))
            if role == "tool":
                tid = msg.get("tool_call_id")
                tid_str = str(tid) if tid else ""
                if not tid_str or tid_str not in declared or tid_str in fulfilled:
                    if updated is None:
                        updated = [dict(m) for m in messages[:idx]]
                    continue
                fulfilled.add(tid_str)
            if updated is not None:
                updated.append(dict(msg))

        if updated is None:
            return messages
        return updated

    @staticmethod
    def backfill_missing_tool_results(
        messages: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Insert synthetic error results for assistant tool_calls with missing tool outputs.

        A result answers the latest call that has its id (see drop_orphan_tool_results): a call whose
        id a later response reuses before it got a result is missing its own.
        """
        open_calls: dict[str, tuple[int, str]] = {}
        missing: list[tuple[int, str, str]] = []
        for idx, msg in enumerate(messages):
            role = msg.get("role")
            if role == "assistant":
                for tc in cast(list[Any], msg.get("tool_calls") or []):
                    if isinstance(tc, dict):
                        name = ""
                        tool_call = cast(dict[str, Any], tc)
                        if tool_call.get("id"):
                            func = tool_call.get("function")
                            if isinstance(func, dict):
                                func_data = cast(dict[str, Any], func)
                                raw_name = func_data.get("name", "")
                                name = raw_name if isinstance(raw_name, str) else str(raw_name)
                            call_id = str(tool_call["id"])
                            if call_id in open_calls:
                                earlier_idx, earlier_name = open_calls[call_id]
                                missing.append((earlier_idx, call_id, earlier_name))
                            open_calls[call_id] = (idx, name)
            elif role == "tool":
                tid = msg.get("tool_call_id")
                if tid:
                    open_calls.pop(str(tid), None)

        missing.extend((ai, cid, name) for cid, (ai, name) in open_calls.items())
        missing.sort(key=lambda entry: entry[0])
        if not missing:
            return messages

        updated = list(messages)
        offset = 0
        for assistant_idx, call_id, name in missing:
            insert_at = assistant_idx + 1 + offset
            while insert_at < len(updated) and updated[insert_at].get("role") == "tool":
                insert_at += 1
            updated.insert(insert_at, {
                "role": "tool",
                "tool_call_id": call_id,
                "name": name,
                "content": BACKFILL_CONTENT,
            })
            offset += 1
        return updated
