"""Utility functions for nanobot."""

from __future__ import annotations

import json
import re
from contextlib import suppress
from datetime import datetime
from typing import TYPE_CHECKING, Any, TypeVar, cast, overload

from nanobot.utils.token_encoding import get_token_encoding as _get_token_encoding

if TYPE_CHECKING:
    from tiktoken import Encoding


_TOOLS_TOKEN_CACHE_MAX_ENTRIES = 64
_TOOLS_TOKEN_CACHE: dict[int, tuple[tuple[int, ...], dict[bool, int]]] = {}
_T = TypeVar("_T")


@overload
def sanitize_surrogates(text: str) -> str: ...


@overload
def sanitize_surrogates(text: _T) -> _T: ...


def sanitize_surrogates(text: Any) -> Any:
    """Reconstruct surrogate pairs and replace unpaired surrogates.

    Lone UTF-16 surrogate code points (``U+D800``..``U+DFFF``) cannot be
    encoded as UTF-8 and cause ``UnicodeEncodeError`` when the message is
    serialized for an HTTP request body. This helper round-trips through
    UTF-16 to reconstruct genuine surrogate pairs (produced e.g. by Windows
    console input for emoji) and substitutes lone surrogates with
    ``U+FFFD``.

    Non-string inputs are returned unchanged so this helper is safe to call
    on arbitrary message payload leaves.
    """
    if not isinstance(text, str):
        return text
    # Fast path: no surrogate code points → return the original object so
    # callers can rely on identity to detect an actual mutation.
    for ch in text:
        cp = ord(ch)
        if 0xD800 <= cp <= 0xDFFF:
            break
    else:
        return text
    return text.encode("utf-16-le", errors="surrogatepass").decode(
        "utf-16-le", errors="replace"
    )


def sanitize_surrogates_deep(value: Any) -> Any:
    """Recursively apply :func:`sanitize_surrogates` to every string leaf.

    Lists and dicts are rebuilt only when a nested string actually changes,
    so the common case (no surrogates present) returns the original object
    without allocations.
    """
    if isinstance(value, str):
        cleaned = sanitize_surrogates(value)
        return cleaned
    if isinstance(value, list):
        result_list: list[Any] = []
        mutated = False
        for item in cast(list[Any], value):
            new_item = sanitize_surrogates_deep(item)
            if new_item is not item:
                mutated = True
            result_list.append(new_item)
        return result_list if mutated else cast(Any, value)
    if isinstance(value, dict):
        result_dict: dict[Any, Any] = {}
        mutated = False
        for key, item in cast(dict[Any, Any], value).items():
            new_item = sanitize_surrogates_deep(item)
            if new_item is not item:
                mutated = True
            result_dict[key] = new_item
        return result_dict if mutated else cast(Any, value)
    if isinstance(value, tuple):
        tuple_value = cast(tuple[Any, ...], value)
        result_tuple = tuple(sanitize_surrogates_deep(item) for item in tuple_value)
        return (
            result_tuple
            if any(a is not b for a, b in zip(result_tuple, tuple_value))
            else cast(Any, value)
        )
    return value


def _cache_tools_token_count(
    tools_id: int,
    fingerprint: tuple[int, ...],
    counts: dict[bool, int],
) -> None:
    if (
        tools_id not in _TOOLS_TOKEN_CACHE
        and len(_TOOLS_TOKEN_CACHE) >= _TOOLS_TOKEN_CACHE_MAX_ENTRIES
    ):
        _TOOLS_TOKEN_CACHE.pop(next(iter(_TOOLS_TOKEN_CACHE)))
    _TOOLS_TOKEN_CACHE[tools_id] = (fingerprint, counts)


def _estimate_tools_tokens(
    enc: Encoding,
    tools: list[dict[str, Any]],
    *,
    leading_separator: bool,
) -> int:
    """Estimate stable tool definition tokens without re-encoding every loop."""
    # ToolRegistry keeps the returned definitions list alive until the registry changes.
    tools_id = id(tools)
    fingerprint = tuple(id(tool) for tool in tools)
    cached = _TOOLS_TOKEN_CACHE.get(tools_id)
    if cached and cached[0] == fingerprint:
        token_count = cached[1].get(leading_separator)
        if token_count is not None:
            return token_count
        counts = cached[1]
    else:
        counts = {}

    rendered = json.dumps(tools, ensure_ascii=False)
    if leading_separator:
        rendered = "\n" + rendered
    token_count = len(enc.encode_ordinary(rendered))
    counts[leading_separator] = token_count
    _cache_tools_token_count(tools_id, fingerprint, counts)
    return token_count


def _tag_regex(tags: tuple[str, ...]) -> str:
    return rf"(?:{'|'.join(re.escape(tag) for tag in tags)})"


_THINKING_TAGS = ("think", "thinking", "thought")
_THINKING_TAG = _tag_regex(_THINKING_TAGS)
_INLINE_SELF_CLOSING_THINKING_TAG = r"(?:thinking)"
_THINKING_TAG_PREFIX = "|".join(
    sorted(
        {re.escape(tag[:i]) for tag in _THINKING_TAGS for i in range(1, len(tag) + 1)},
        key=len,
        reverse=True,
    )
)
_PARTIAL_THINKING_TAG = rf"</?(?:{_THINKING_TAG_PREFIX})>?"


def strip_think(text: str) -> str:
    """Remove thinking blocks, unclosed trailing tags, and tokenizer-level
    template leaks occasionally emitted by some models (notably Gemma 4's
    Ollama renderer).

    Covers:
      1. Well-formed `<think>...</think>`, `<thinking>...</thinking>`,
         and `<thought>...</thought>` blocks.
      2. Streaming prefixes where the block is never closed.
      3. *Malformed* opening tags missing the `>` - e.g. `<think广场…`. The
         model sometimes emits the tag name directly followed by user-facing
         content with no delimiter; without this step the literal `<think`
         leaks into the rendered message.
      4. Harmony-style channel markers like `<channel|>` / `<|channel|>`
         **at the start of the text** - conservative to avoid eating
         explanatory prose that mentions these tokens.
      5. Orphan closing tags `</think>` / `</thinking>` / `</thought>`
         **at the very start or end of the text** only, for the same reason.
      6. Trailing partial control tags split across stream chunks, such as
         `<thi`, `<thin`, or `<tho`.

    Since this is also applied before persisting to history (memory.py),
    the edge-only stripping of (4) and (5) is deliberate: stripping those
    tokens mid-text would silently rewrite any message where a user or the
    assistant discusses the tokens themselves.
    """
    # Every supported control tag contains '<'; ordinary text only needs trimming.
    if "<" not in text:
        return text.strip()
    # Well-formed blocks first.
    text = re.sub(rf"<(?P<tag>{_THINKING_TAG})>[\s\S]*?</(?P=tag)>", "", text)
    text = re.sub(rf"^\s*<{_THINKING_TAG}>[\s\S]*$", "", text)
    # Self-closing `<thinking/>` is an empty marker, not user-visible text.
    text = re.sub(rf"^\s*<{_INLINE_SELF_CLOSING_THINKING_TAG}/>\s*", "", text)
    text = re.sub(rf"\s*<{_INLINE_SELF_CLOSING_THINKING_TAG}/>\s*$", "", text)
    # Malformed opening tags: `<think` / `<thinking` / `<thought` where the next char is
    # NOT one that could continue a valid tag / identifier name. Explicitly
    # listing ASCII tag-name chars (letters, digits, `_`, `-`, `:`) plus
    # `>` / `/` - we can't use `\w` here because in Python's default
    # Unicode regex mode it matches CJK characters too, which would defeat
    # the primary fix for `<think广场…` leaks.
    text = re.sub(rf"<{_THINKING_TAG}(?![A-Za-z0-9_\-:>/])", "", text)
    # Edge-only orphan closing tags (start or end of text).
    text = re.sub(rf"^\s*</{_THINKING_TAG}>\s*", "", text)
    text = re.sub(rf"\s*</{_THINKING_TAG}>\s*$", "", text)
    # Edge-only channel markers (harmony / Gemma 4 variant leaks).
    text = re.sub(r"^\s*<\|?channel\|?>\s*", "", text)
    # Stream chunks may end in the middle of a control tag. Strip only known
    # control-token prefixes at the very end.
    partial_control_tag = (
        rf"{_PARTIAL_THINKING_TAG}|"
        r"<\|?(?:c|ch|cha|chan|chann|channe|channel)(?:\|?>?)?"
    )
    text = re.sub(rf"(?:{partial_control_tag})$", "", text)
    text = re.sub(r"^\s*<\|?$", "", text)
    return text.strip()


def strip_reasoning_tags(text: object) -> str:
    """Remove wrapper tags from text that is already known to be reasoning."""
    if not isinstance(text, str):
        return ""
    if "<" not in text:
        return text.strip()
    text = re.sub(rf"^\s*<{_THINKING_TAG}/>\s*", "", text)
    text = re.sub(rf"\s*<{_THINKING_TAG}/>\s*$", "", text)
    text = re.sub(rf"^\s*<{_THINKING_TAG}>\s*", "", text)
    text = re.sub(rf"\s*</{_THINKING_TAG}>\s*$", "", text)
    text = re.sub(rf"\s*(?:{_PARTIAL_THINKING_TAG})$", "", text)
    return text.strip()


def extract_think(text: str) -> tuple[str | None, str]:
    """Extract thinking content from inline thinking tags.

    Returns ``(thinking_text, cleaned_text)``. Only closed blocks are
    extracted; unclosed streaming prefixes are stripped from the cleaned
    text but not surfaced - :func:`strip_think` handles that case.
    """
    if "<" not in text:
        return None, text.strip()
    parts: list[str] = []
    for m in re.finditer(rf"<(?P<tag>{_THINKING_TAG})>([\s\S]*?)</(?P=tag)>", text):
        parts.append(m.group(2).strip())
    thinking = "\n\n".join(parts) if parts else None
    return thinking, strip_think(text)


def extract_reasoning(
    reasoning_content: str | None,
    thinking_blocks: list[dict[str, Any]] | None,
    content: str | None,
) -> tuple[str | None, str | None]:
    """Return ``(reasoning_text, cleaned_content)`` from one model response.

    Single source of truth for "what reasoning did this response carry, and
    what answer text remains after we peel it out". Fallback order:

    1. Dedicated ``reasoning_content`` (DeepSeek-R1, Kimi, MiMo, OpenAI
       reasoning models).
    2. Extended ``thinking_blocks``.
    3. Inline ``<think>`` / ``<thought>`` blocks in ``content``.

    Only one source contributes per response; lower-priority sources are
    ignored if a higher-priority one is present, but inline ``<think>``
    tags are still stripped from ``content`` so they never leak into the
    final answer.
    """
    if reasoning_content:
        return strip_reasoning_tags(reasoning_content), strip_think(content) if content else content
    if thinking_blocks:
        parts = [
            strip_reasoning_tags(tb.get("thinking", ""))
            for tb in thinking_blocks
            if tb.get("type") == "thinking"
        ]
        joined = "\n\n".join(p for p in parts if p)
        return (joined or None), strip_think(content) if content else content
    if content:
        return extract_think(content)
    return None, content


def timestamp() -> str:
    """Current ISO timestamp."""
    return datetime.now().isoformat()


_TRUNCATED_SUFFIX = "\n... (truncated)"


def image_placeholder_text(path: str | None, *, empty: str = "[image]") -> str:
    """Build an image placeholder string."""
    return f"[image: {path}]" if path else empty


def content_with_media_breadcrumbs(
    role: str | None,
    content: Any,
    media: Any,
) -> Any:
    """Append persisted user-media breadcrumbs to plain-text content."""
    if role != "user" or not isinstance(content, str) or not isinstance(media, list):
        return content
    breadcrumbs = "\n".join(
        image_placeholder_text(path)
        for path in cast(list[object], media)
        if isinstance(path, str) and path
    )
    if not breadcrumbs:
        return content
    return f"{content}\n{breadcrumbs}" if content else breadcrumbs


def truncate_text(text: str, max_chars: int) -> str:
    """Truncate text with a stable suffix."""
    if max_chars <= 0 or len(text) <= max_chars:
        return text
    return text[:max_chars] + _TRUNCATED_SUFFIX


def truncate_text_to_tokens(text: str, max_tokens: int) -> str:
    """Truncate text to a token budget with a stable suffix.

    Uses cl100k_base when ready, which may differ from the model's tokenizer.
    Falls back to a UTF-8 byte budget while loading or if initialization failed.
    """
    if max_tokens <= 0:
        return text
    try:
        enc = _get_token_encoding()
        if enc is not None:
            tokens = enc.encode_ordinary(text)
            if len(tokens) <= max_tokens:
                return text
            suffix_tokens = enc.encode_ordinary(_TRUNCATED_SUFFIX)
            body_budget = max_tokens - len(suffix_tokens)
            if body_budget <= 0:
                return enc.decode(tokens[:max_tokens])
            for candidate_budget in range(body_budget, -1, -1):
                result = enc.decode(tokens[:candidate_budget]) + _TRUNCATED_SUFFIX
                if len(enc.encode_ordinary(result)) <= max_tokens:
                    return result
            return enc.decode(tokens[:max_tokens])
    except Exception:
        pass
    if len(text.encode("utf-8")) <= max_tokens:
        return text
    suffix_bytes = len(_TRUNCATED_SUFFIX.encode("utf-8"))
    if max_tokens <= suffix_bytes:
        return _truncate_text_to_utf8_bytes(text, max_tokens)
    body = _truncate_text_to_utf8_bytes(text, max_tokens - suffix_bytes)
    return body + _TRUNCATED_SUFFIX


def _truncate_text_to_utf8_bytes(text: str, max_bytes: int) -> str:
    """Return the longest code-point prefix within a UTF-8 byte budget."""
    if max_bytes <= 0:
        return ""
    encoded = text.encode("utf-8")
    if len(encoded) <= max_bytes:
        return text
    return encoded[:max_bytes].decode("utf-8", errors="ignore")


def recent_message_start_index(
    messages: list[dict[str, Any]],
    max_messages: int,
    *,
    extend_to_user: bool = False,
) -> int:
    """Return the start index for a recent replay window."""
    if max_messages <= 0:
        return len(messages)
    start_idx = max(0, len(messages) - max_messages)
    if not extend_to_user or len(messages) <= max_messages:
        return start_idx
    if any(messages[i].get("role") == "user" for i in range(start_idx, len(messages))):
        return start_idx

    recovered_user = next(
        (i for i in range(start_idx - 1, -1, -1) if messages[i].get("role") == "user"),
        None,
    )
    if recovered_user is None:
        return start_idx
    if recovered_user > 0 and messages[recovered_user - 1].get("_channel_delivery"):
        return recovered_user - 1
    return recovered_user


def find_legal_message_start(messages: list[dict[str, Any]]) -> int:
    """Find the first index whose tool results have matching assistant calls."""
    declared: set[str] = set()
    start = 0
    for i, msg in enumerate(messages):
        role = msg.get("role")
        if role == "assistant":
            for raw_call in cast(list[object], msg.get("tool_calls") or []):
                tool_call = cast(dict[str, Any], raw_call) if isinstance(raw_call, dict) else None
                if tool_call is not None and tool_call.get("id"):
                    declared.add(str(tool_call["id"]))
        elif role == "tool":
            tid = msg.get("tool_call_id")
            if tid and str(tid) not in declared:
                start = i + 1
                declared.clear()
    return start


def stringify_text_blocks(content: list[object]) -> str | None:
    parts: list[str] = []
    for raw_block in content:
        if not isinstance(raw_block, dict):
            return None
        block = cast(dict[str, Any], raw_block)
        if block.get("type") != "text":
            return None
        text = block.get("text")
        if not isinstance(text, str):
            return None
        parts.append(text)
    return "\n".join(parts)


def build_assistant_message(
    content: str | None,
    tool_calls: list[dict[str, Any]] | None = None,
    reasoning_content: str | None = None,
    thinking_blocks: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build a provider-safe assistant message with optional reasoning fields."""
    msg: dict[str, Any] = {"role": "assistant", "content": content or ""}
    if tool_calls:
        msg["tool_calls"] = tool_calls
    if reasoning_content is not None or thinking_blocks:
        msg["reasoning_content"] = (
            strip_reasoning_tags(reasoning_content)
            if reasoning_content is not None
            else ""
        )
    if thinking_blocks:
        msg["thinking_blocks"] = thinking_blocks
    return msg


def _estimate_prompt_tokens_with_source(
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
) -> tuple[int, str]:
    """Estimate prompt tokens and identify the counter used.

    Counts all fields that providers send to the LLM: content, tool_calls,
    reasoning_content, tool_call_id, name, plus per-message framing overhead.
    """
    parts: list[str] = []
    for msg in messages:
        content = msg.get("content")
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            for raw_part in cast(list[object], content):
                part = cast(dict[str, Any], raw_part) if isinstance(raw_part, dict) else None
                if part is not None and part.get("type") == "text":
                    text = part.get("text", "")
                    if isinstance(text, str) and text:
                        parts.append(text)

        tc = msg.get("tool_calls")
        if tc:
            parts.append(json.dumps(tc, ensure_ascii=False))

        rc = msg.get("reasoning_content")
        if isinstance(rc, str) and rc:
            parts.append(rc)

        for key in ("name", "tool_call_id"):
            value = msg.get(key)
            if isinstance(value, str) and value:
                parts.append(value)

    message_payload = "\n".join(parts)
    per_message_overhead = len(messages) * 4
    try:
        enc = _get_token_encoding()
        if enc is not None:
            tool_tokens = (
                _estimate_tools_tokens(enc, tools, leading_separator=bool(parts)) if tools else 0
            )
            message_tokens = len(enc.encode_ordinary(message_payload)) if message_payload else 0
            return message_tokens + tool_tokens + per_message_overhead, "tiktoken"
    except Exception:
        pass
    tool_payload = (
        ("\n" if message_payload else "") + json.dumps(tools, ensure_ascii=False)
        if tools
        else ""
    )
    payload = message_payload + tool_payload
    estimated = len(payload.encode("utf-8"))
    return estimated + per_message_overhead, "heuristic"


def estimate_prompt_tokens(
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
) -> int:
    """Estimate prompt tokens with tiktoken and a conservative byte fallback."""
    estimated, _ = _estimate_prompt_tokens_with_source(messages, tools)
    return estimated


def estimate_message_tokens(message: dict[str, Any]) -> int:
    """Estimate prompt tokens contributed by one persisted message."""
    content = message.get("content")
    parts: list[str] = []
    if isinstance(content, str):
        parts.append(content)
    elif isinstance(content, list):
        for raw_part in cast(list[object], content):
            part = cast(dict[str, Any], raw_part) if isinstance(raw_part, dict) else None
            if part is not None and part.get("type") == "text":
                text = part.get("text", "")
                if isinstance(text, str) and text:
                    parts.append(text)
            else:
                parts.append(json.dumps(raw_part, ensure_ascii=False))
    elif content is not None:
        parts.append(json.dumps(content, ensure_ascii=False))

    for key in ("name", "tool_call_id"):
        value = message.get(key)
        if isinstance(value, str) and value:
            parts.append(value)
    if message.get("tool_calls"):
        parts.append(json.dumps(message["tool_calls"], ensure_ascii=False))

    rc = message.get("reasoning_content")
    if isinstance(rc, str) and rc:
        parts.append(rc)

    payload = "\n".join(parts)
    if not payload:
        return 4
    try:
        enc = _get_token_encoding()
        if enc is not None:
            return max(4, len(enc.encode_ordinary(payload)) + 4)
    except Exception:
        pass
    return max(4, len(payload.encode("utf-8")) + 4)


def estimate_prompt_tokens_chain(
    provider: object,
    model: str | None,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
) -> tuple[int, str]:
    """Estimate prompt tokens via provider, tiktoken, then a byte heuristic."""
    provider_counter = getattr(provider, "estimate_prompt_tokens", None)
    if callable(provider_counter):
        with suppress(Exception):
            tokens, source = cast(tuple[object, object], provider_counter(messages, tools, model))
            if isinstance(tokens, (int, float)) and tokens > 0:
                return int(tokens), str(source or "provider_counter")
    estimated, source = _estimate_prompt_tokens_with_source(messages, tools)
    if estimated > 0:
        return int(estimated), source
    return 0, "none"
