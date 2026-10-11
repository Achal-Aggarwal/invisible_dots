"""File system tools: read, write, edit, list, on the Dot's own computer."""

from __future__ import annotations

import codecs
import difflib
import hashlib
import posixpath
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from nanobot.agent.tools.base import Tool, ToolResult, tool_parameters
from nanobot.agent.tools.file_state import FileStates, current_file_states
from nanobot.agent.tools.schema import (
    BooleanSchema,
    IntegerSchema,
    StringSchema,
    tool_parameters_schema,
)
from nanobot.dots.computer import WRONG_KIND, Computer, ComputerError, Entry, FileTooLargeError
from nanobot.utils.file_diff import FileDiff

_TEXT_EXTENSIONS = frozenset({
    ".txt", ".md", ".csv", ".json", ".xml", ".html", ".htm", ".log",
    ".yaml", ".yml", ".toml", ".ini", ".cfg",
})


def _decode_bom_text(raw: bytes) -> str | None:
    """Decode text whose byte-order mark declares a Unicode encoding."""
    if raw.startswith(codecs.BOM_UTF8):
        return raw.decode("utf-8-sig")
    # UTF-32 LE starts with the UTF-16 LE BOM, so check UTF-32 first.
    if raw.startswith((codecs.BOM_UTF32_LE, codecs.BOM_UTF32_BE)):
        return raw.decode("utf-32")
    if raw.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        return raw.decode("utf-16")
    return None


def _not_a_regular_file(path: str) -> str:
    """The error for a path dot-agentd refuses to read as a file."""
    return f"Error: Not a regular file: {path} (a directory, device or pipe cannot be read)"


class _FsTool(Tool):
    """Shared base of the tools that read or write the Dot's files."""

    def __init__(self, computer: Computer, file_states: FileStates | None = None) -> None:
        self.computer = computer
        # Explicit state is used by isolated runners. Shared tool instances leave this
        # unset and resolve state from the current async task, which keeps them
        # session-safe.
        self._explicit_file_states = file_states
        self._fallback_file_states = FileStates()

    @property
    def _file_states(self) -> FileStates:
        if self._explicit_file_states is not None:
            return self._explicit_file_states
        return current_file_states(self._fallback_file_states)

    def _resolve(self, path: str) -> str:
        return self.computer.resolve(path)

    def _display_path(self, path: str) -> str:
        """The path relative to the workspace when it is inside it, else as it is."""
        prefix = self.computer.workspace.rstrip("/") + "/"
        return path[len(prefix):] if path.startswith(prefix) else path


# ---------------------------------------------------------------------------
# read_file
# ---------------------------------------------------------------------------


_BLOCKED_DEVICE_PATHS = frozenset({
    "/dev/zero", "/dev/random", "/dev/urandom", "/dev/full",
    "/dev/stdin", "/dev/stdout", "/dev/stderr",
    "/dev/tty", "/dev/console",
    "/dev/fd/0", "/dev/fd/1", "/dev/fd/2",
})


def _is_blocked_device(path: str) -> bool:
    """Check if path is a blocked device that could hang or produce infinite output."""
    if path in _BLOCKED_DEVICE_PATHS or path.startswith("/dev/"):
        return True
    return re.match(r"/proc/(\d+|self)/fd/[012]$", path) is not None


@tool_parameters(
    tool_parameters_schema(
        path=StringSchema("The file path to read"),
        offset=IntegerSchema(
            description="1-based line to start at (default 1)",
            minimum=1,
        ),
        limit=IntegerSchema(
            description="Maximum lines to return (default 2000)",
            minimum=1,
        ),
        force=BooleanSchema(
            description="Return an unchanged range again",
            default=False,
        ),
        required=["path"],
    )
)
class ReadFileTool(_FsTool):
    """Read file contents with optional line-based pagination."""

    _MAX_CHARS = 128_000
    _MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024
    _DEFAULT_LIMIT = 2000

    @property
    def name(self) -> str:
        return "read_file"

    @property
    def description(self) -> str:
        return (
            "Read a text file by path. "
            "Text is line-numbered; use offset/limit for targeted ranges."
        )

    async def execute(
        self,
        path: str | None = None,
        offset: int = 1,
        limit: int | None = None,
        force: bool = False,
        **kwargs: Any,
    ) -> Any:
        try:
            if not path:
                return ToolResult.error("Error reading file: Unknown path")

            # Device path blacklist
            if _is_blocked_device(path):
                return ToolResult.error(f"Error: Reading {path} is blocked (device path that could hang or produce infinite output).")

            fp = self._resolve(path)
            if _is_blocked_device(fp):
                return ToolResult.error(f"Error: Reading {fp} is blocked (device path that could hang or produce infinite output).")
            try:
                raw = await self.computer.read_bytes(fp, max_bytes=self._MAX_FILE_SIZE_BYTES)
            except FileTooLargeError as exc:
                size_mib = exc.size / (1024 * 1024)
                max_mib = self._MAX_FILE_SIZE_BYTES // (1024 * 1024)
                return ToolResult.error(
                    f"Error: File too large to read ({size_mib:.1f} MiB). "
                    f"Maximum is {max_mib} MiB."
                )
            except ComputerError as exc:
                if exc.status_code == WRONG_KIND:
                    return ToolResult.error(_not_a_regular_file(path))
                raise
            if raw is None:
                return ToolResult.error(f"Error: File not found: {path}")

            file_size = len(raw)

            if not raw:
                return f"(Empty file: {path})"

            content_hash = hashlib.sha256(raw).hexdigest()
            if not force and self._file_states.is_unchanged(
                fp, offset=offset, limit=limit, content_hash=content_hash,
            ):
                return f"[File unchanged since last read: {path}]"
            text_content = _decode_bom_text(raw)
            if text_content is None:
                try:
                    text_content = raw.decode("utf-8")
                except UnicodeDecodeError:
                    # Known text formats may be Latin-1; any other undecodable file is binary.
                    if posixpath.splitext(fp)[1].lower() not in _TEXT_EXTENSIONS:
                        return ToolResult.error(
                            f"Error: Cannot read binary file {path} ({file_size} bytes). "
                            "Only text files can be read."
                        )
                    text_content = raw.decode("latin-1")

            if not text_content:
                return f"(Empty file: {path})"

            # Normalize CRLF -> LF before line-splitting. Primarily a Windows
            # concern (git checkouts with autocrlf, editors saving CRLF) but
            # applied on all platforms so downstream StrReplace/Grep behavior
            # is consistent regardless of where the file was written.
            text_content = text_content.replace("\r\n", "\n")

            all_lines = text_content.splitlines()
            total = len(all_lines)

            if offset < 1:
                offset = 1
            if offset > total:
                return ToolResult.error(f"Error: offset {offset} is beyond end of file ({total} lines)")

            start = offset - 1
            end = min(start + (limit or self._DEFAULT_LIMIT), total)
            numbered = [f"{start + i + 1}| {line}" for i, line in enumerate(all_lines[start:end])]
            result = "\n".join(numbered)
            line_truncated = False

            if len(result) > self._MAX_CHARS:
                trimmed: list[str] = []
                chars = 0
                for line in numbered:
                    extra = len(line) + (1 if trimmed else 0)
                    if chars + extra > self._MAX_CHARS:
                        if not trimmed:
                            trimmed.append(line[: self._MAX_CHARS])
                            line_truncated = True
                        break
                    trimmed.append(line)
                    chars += extra
                end = start + len(trimmed)
                result = "\n".join(trimmed)

            if line_truncated:
                result += (
                    f"\n\n(Line {offset} truncated; its remaining characters are not shown. "
                    "Use exec with a targeted command to inspect the omitted content.)"
                )
            if end < total:
                result += f"\n\n(Showing lines {offset}-{end} of {total}. Use offset={end + 1} to continue.)"
            else:
                result += f"\n\n(End of file - {total} lines total)"
            self._file_states.record_read(
                fp, offset=offset, limit=limit, content_hash=content_hash, result=result,
            )
            return result
        except PermissionError as e:
            return ToolResult.error(f"Error: {e}")
        except Exception as e:
            return ToolResult.error(f"Error reading file: {e}")


# ---------------------------------------------------------------------------
# write_file
# ---------------------------------------------------------------------------


@tool_parameters(
    tool_parameters_schema(
        path=StringSchema("The file path to write to"),
        content=StringSchema("The content to write"),
        required=["path", "content"],
    )
)
class WriteFileTool(_FsTool):
    """Write content to a file."""

    @property
    def name(self) -> str:
        return "write_file"

    @property
    def description(self) -> str:
        return (
            "Create a new file or intentionally replace an entire file with "
            "the provided content. Overwrites existing files and creates parent "
            "directories as needed. For code changes or partial edits, prefer "
            "apply_patch; use edit_file only for small exact replacements."
        )

    async def execute(self, path: str | None = None, content: str | None = None, **kwargs: Any) -> str:
        try:
            if not path:
                raise ValueError("Unknown path")
            if content is None:
                raise ValueError("Unknown content")
            fp = self._resolve(path)
            await self.computer.write_bytes(fp, content.encode("utf-8"))
            self._file_states.record_write(fp)
            return f"Successfully wrote {len(content)} characters to {fp}"
        except PermissionError as e:
            return ToolResult.error(f"Error: {e}")
        except Exception as e:
            return ToolResult.error(f"Error writing file: {e}")


# ---------------------------------------------------------------------------
# edit_file
# ---------------------------------------------------------------------------

_QUOTE_TABLE = str.maketrans({
    "\u2018": "'", "\u2019": "'",  # curly single → straight
    "\u201c": '"', "\u201d": '"',  # curly double → straight
    "'": "'", '"': '"',            # identity (kept for completeness)
})


def _normalize_quotes(s: str) -> str:
    return s.translate(_QUOTE_TABLE)


def _curly_double_quotes(text: str) -> str:
    parts: list[str] = []
    opening = True
    for ch in text:
        if ch == '"':
            parts.append("\u201c" if opening else "\u201d")
            opening = not opening
        else:
            parts.append(ch)
    return "".join(parts)


def _curly_single_quotes(text: str) -> str:
    parts: list[str] = []
    opening = True
    for i, ch in enumerate(text):
        if ch != "'":
            parts.append(ch)
            continue
        prev_ch = text[i - 1] if i > 0 else ""
        next_ch = text[i + 1] if i + 1 < len(text) else ""
        if prev_ch.isalnum() and next_ch.isalnum():
            parts.append("\u2019")
            continue
        parts.append("\u2018" if opening else "\u2019")
        opening = not opening
    return "".join(parts)


def _preserve_quote_style(old_text: str, actual_text: str, new_text: str) -> str:
    """Preserve curly quote style when a quote-normalized fallback matched."""
    if _normalize_quotes(old_text.strip()) != _normalize_quotes(actual_text.strip()) or old_text == actual_text:
        return new_text

    styled = new_text
    if any(ch in actual_text for ch in ("\u201c", "\u201d")) and '"' in styled:
        styled = _curly_double_quotes(styled)
    if any(ch in actual_text for ch in ("\u2018", "\u2019")) and "'" in styled:
        styled = _curly_single_quotes(styled)
    return styled


def _leading_ws(line: str) -> str:
    return line[: len(line) - len(line.lstrip(" \t"))]


def _reindent_like_match(old_text: str, actual_text: str, new_text: str) -> str:
    """Preserve the outer indentation from the actual matched block."""
    # A terminal newline does not add a logical line, even at an unterminated EOF.
    old_lines = old_text.removesuffix("\n").split("\n")
    actual_lines = actual_text.removesuffix("\n").split("\n")
    if len(old_lines) != len(actual_lines):
        return new_text

    comparable = [
        (old_line, actual_line)
        for old_line, actual_line in zip(old_lines, actual_lines)
        if old_line.strip() and actual_line.strip()
    ]
    if not comparable or any(
        _normalize_quotes(old_line.strip()) != _normalize_quotes(actual_line.strip())
        for old_line, actual_line in comparable
    ):
        return new_text

    old_ws = _leading_ws(comparable[0][0])
    actual_ws = _leading_ws(comparable[0][1])
    if actual_ws == old_ws:
        return new_text

    if old_ws:
        if not actual_ws.startswith(old_ws):
            return new_text
        delta = actual_ws[len(old_ws):]
    else:
        delta = actual_ws

    if not delta:
        return new_text

    return "\n".join((delta + line) if line else line for line in new_text.split("\n"))


@dataclass(slots=True)
class _MatchSpan:
    start: int
    end: int
    text: str
    line: int


def _match_end_line(match: _MatchSpan) -> int:
    comparable = match.text[:-1] if match.text.endswith("\n") else match.text
    return match.line + comparable.count("\n")


def _match_covers_line(match: _MatchSpan, line: int) -> bool:
    return match.line <= line <= _match_end_line(match)


def _find_exact_matches(content: str, old_text: str) -> list[_MatchSpan]:
    matches: list[_MatchSpan] = []
    start = 0
    while True:
        idx = content.find(old_text, start)
        if idx == -1:
            break
        matches.append(
            _MatchSpan(
                start=idx,
                end=idx + len(old_text),
                text=content[idx : idx + len(old_text)],
                line=content.count("\n", 0, idx) + 1,
            )
        )
        start = idx + max(1, len(old_text))
    return matches


def _find_trim_matches(content: str, old_text: str, *, normalize_quotes: bool = False) -> list[_MatchSpan]:
    old_lines = old_text.splitlines()
    if not old_lines:
        return []

    content_lines = content.splitlines()
    content_lines_keepends = content.splitlines(keepends=True)
    if len(content_lines) < len(old_lines):
        return []

    offsets: list[int] = []
    pos = 0
    for line in content_lines_keepends:
        offsets.append(pos)
        pos += len(line)
    offsets.append(pos)

    if normalize_quotes:
        stripped_old = [_normalize_quotes(line.strip()) for line in old_lines]
    else:
        stripped_old = [line.strip() for line in old_lines]

    matches: list[_MatchSpan] = []
    window_size = len(stripped_old)
    for i in range(len(content_lines) - window_size + 1):
        window = content_lines[i : i + window_size]
        if normalize_quotes:
            comparable = [_normalize_quotes(line.strip()) for line in window]
        else:
            comparable = [line.strip() for line in window]
        if comparable != stripped_old:
            continue

        start = offsets[i]
        end = offsets[i + window_size]
        # Include the line terminator only when the requested match includes it.
        if (
            not old_text.endswith("\n")
            and content_lines_keepends[i + window_size - 1].endswith("\n")
        ):
            end -= 1
        matches.append(
            _MatchSpan(
                start=start,
                end=end,
                text=content[start:end],
                line=i + 1,
            )
        )
    return matches


def _find_quote_matches(content: str, old_text: str) -> list[_MatchSpan]:
    norm_content = _normalize_quotes(content)
    norm_old = _normalize_quotes(old_text)
    matches: list[_MatchSpan] = []
    start = 0
    while True:
        idx = norm_content.find(norm_old, start)
        if idx == -1:
            break
        matches.append(
            _MatchSpan(
                start=idx,
                end=idx + len(old_text),
                text=content[idx : idx + len(old_text)],
                line=content.count("\n", 0, idx) + 1,
            )
        )
        start = idx + max(1, len(norm_old))
    return matches


def _find_matches(content: str, old_text: str) -> list[_MatchSpan]:
    """Locate all matches using progressively looser strategies."""
    for matcher in (
        lambda: _find_exact_matches(content, old_text),
        lambda: _find_trim_matches(content, old_text),
        lambda: _find_trim_matches(content, old_text, normalize_quotes=True),
        lambda: _find_quote_matches(content, old_text),
    ):
        matches = matcher()
        if matches:
            return matches
    return []


def _collapse_internal_whitespace(text: str) -> str:
    return "\n".join(" ".join(line.split()) for line in text.splitlines())


def _diagnose_near_match(old_text: str, actual_text: str) -> list[str]:
    """Return actionable hints describing why text was close but not exact."""
    hints: list[str] = []

    if old_text.lower() == actual_text.lower() and old_text != actual_text:
        hints.append("letter case differs")
    if _collapse_internal_whitespace(old_text) == _collapse_internal_whitespace(actual_text) and old_text != actual_text:
        hints.append("whitespace differs")
    if old_text.rstrip("\n") == actual_text.rstrip("\n") and old_text != actual_text:
        hints.append("trailing newline differs")
    if _normalize_quotes(old_text) == _normalize_quotes(actual_text) and old_text != actual_text:
        hints.append("quote style differs")

    return hints


def _best_window(old_text: str, content: str) -> tuple[float, int, list[str], list[str]]:
    """Find the closest line-window match and return ratio/start/snippet/hints."""
    lines = content.splitlines(keepends=True)
    old_lines = old_text.splitlines(keepends=True)
    window = max(1, len(old_lines))

    best_ratio, best_start = -1.0, 0
    best_window_lines: list[str] = []

    for i in range(max(1, len(lines) - window + 1)):
        current = lines[i : i + window]
        ratio = difflib.SequenceMatcher(None, old_lines, current).ratio()
        if ratio > best_ratio:
            best_ratio, best_start = ratio, i
            best_window_lines = current

    actual_text = "".join(best_window_lines).replace("\r\n", "\n").rstrip("\n")
    hints = _diagnose_near_match(old_text.replace("\r\n", "\n").rstrip("\n"), actual_text)
    return best_ratio, best_start, best_window_lines, hints


@tool_parameters(
    tool_parameters_schema(
        path=StringSchema("The file path to edit"),
        old_text=StringSchema("The text to find and replace; copy it from read_file."),
        new_text=StringSchema(
            "The replacement text; must differ from old_text for an existing file."
        ),
        replace_all=BooleanSchema(description="Replace all occurrences (default false)"),
        occurrence=IntegerSchema(
            description="Optional 1-based occurrence to replace when old_text appears multiple times.",
            minimum=1,
            nullable=True,
        ),
        line_hint=IntegerSchema(
            description=(
                "Optional exact 1-based target line copied from read_file. "
                "The selected old_text match must cover this line."
            ),
            minimum=1,
            nullable=True,
        ),
        expected_replacements=IntegerSchema(
            description="Optional guard for the number of replacements that must be made.",
            minimum=1,
            nullable=True,
        ),
        required=["path", "old_text", "new_text"],
    )
)
class EditFileTool(_FsTool):
    """Edit a file by replacing text with fallback matching."""

    _MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024  # 1 GiB
    _MARKDOWN_EXTS = frozenset({".md", ".mdx", ".markdown"})

    @property
    def name(self) -> str:
        return "edit_file"

    @property
    def description(self) -> str:
        return (
            "Perform a small, exact replacement in one file. "
            "Prefer apply_patch for multi-file, structural, or generated edits. "
            "occurrence, line_hint, and replace_all=true are mutually exclusive."
        )

    @staticmethod
    def _strip_trailing_ws(text: str, *, preserve_last_line: bool = False) -> str:
        """Strip line-ending whitespace, except a final fragment that continues inline."""
        lines = text.split("\n")
        return "\n".join(
            line if preserve_last_line and i == len(lines) - 1 else line.rstrip()
            for i, line in enumerate(lines)
        )

    def _format_summary(
        self, resolved_path: str, before: str, after: str, *,
        created: bool = False,
    ) -> str:
        diff = FileDiff.from_text(before, after)
        added, deleted = diff.added, diff.deleted
        action = "add" if created else "update"
        stats = f" (+{added}/-{deleted})" if added or deleted else ""
        return f"Patch applied:\n- {action} {self._display_path(resolved_path)}{stats}"

    async def execute(
        self, path: str | None = None, old_text: str | None = None,
        new_text: str | None = None,
        replace_all: bool = False, occurrence: int | None = None,
        line_hint: int | None = None, expected_replacements: int | None = None, **kwargs: Any,
    ) -> str:
        try:
            if not path:
                raise ValueError("Unknown path")
            if old_text is None:
                raise ValueError("Unknown old_text")
            if new_text is None:
                raise ValueError("Unknown new_text")
            if occurrence is not None and occurrence < 1:
                return ToolResult.error("Error: occurrence must be >= 1.")
            if line_hint is not None and line_hint < 1:
                return ToolResult.error("Error: line_hint must be >= 1.")
            if expected_replacements is not None and expected_replacements < 1:
                return ToolResult.error("Error: expected_replacements must be >= 1.")

            fp = self._resolve(path)
            try:
                raw = await self.computer.read_bytes(fp, max_bytes=self._MAX_EDIT_FILE_SIZE)
            except FileTooLargeError as exc:
                return ToolResult.error(
                    f"Error: File too large to edit ({exc.size / (1024**3):.1f} GiB). Maximum is 1 GiB."
                )
            except ComputerError as exc:
                if exc.status_code == WRONG_KIND:
                    return ToolResult.error(_not_a_regular_file(path))
                raise
            file_exists = raw is not None
            if file_exists and old_text == new_text:
                return ToolResult.error("Error: new_text must be different from old_text.")

            # Create-file semantics: old_text='' + file doesn't exist -> create
            if raw is None:
                if old_text == "":
                    await self.computer.write_bytes(fp, new_text.encode("utf-8"))
                    self._file_states.record_write(fp)
                    return self._format_summary(fp, "", new_text, created=True)
                return await self._file_not_found_msg(path, fp)

            # Create-file: old_text='' but file exists and not empty -> reject
            if old_text == "":
                content = raw.decode("utf-8")
                if content.strip():
                    return ToolResult.error(f"Error: Cannot create file - {path} already exists and is not empty.")
                await self.computer.write_bytes(fp, new_text.encode("utf-8"))
                self._file_states.record_write(fp)
                return self._format_summary(fp, content, new_text)

            uses_crlf = b"\r\n" in raw
            content = raw.decode("utf-8").replace("\r\n", "\n")
            norm_old = old_text.replace("\r\n", "\n")
            matches = _find_matches(content, norm_old)

            if not matches:
                return self._not_found_msg(old_text, content, path)
            count = len(matches)
            if replace_all and occurrence is not None:
                return ToolResult.error("Error: occurrence cannot be used with replace_all=true.")
            if replace_all and line_hint is not None:
                return ToolResult.error("Error: line_hint cannot be used with replace_all=true.")
            if occurrence is not None and line_hint is not None:
                return ToolResult.error("Error: line_hint cannot be used with occurrence.")
            if occurrence is not None and occurrence > count:
                return ToolResult.error(
                    f"Error: occurrence {occurrence} is out of range; "
                    f"old_text appears {count} time(s)."
                )
            if count > 1 and not replace_all and occurrence is None and line_hint is None:
                line_numbers = [match.line for match in matches]
                preview = ", ".join(f"line {n}" for n in line_numbers[:3])
                if len(line_numbers) > 3:
                    preview += ", ..."
                location_hint = f" at {preview}" if preview else ""
                return (
                    f"Warning: old_text appears {count} times{location_hint}. "
                    "Provide more context, set occurrence to choose one match, "
                    "or set replace_all=true."
                )

            norm_new = new_text.replace("\r\n", "\n")

            if replace_all:
                selected = matches
            elif occurrence is not None:
                selected = [matches[occurrence - 1]]
            elif line_hint is not None:
                candidates = [match for match in matches if _match_covers_line(match, line_hint)]
                if not candidates:
                    locations = ", ".join(f"line {match.line}" for match in matches[:3])
                    if len(matches) > 3:
                        locations += ", ..."
                    return ToolResult.error(
                        f"Error: line_hint {line_hint} does not match the old_text location. "
                        f"old_text appears at {locations}. Re-read the intended region and "
                        "copy old_text that covers the target line."
                    )
                if len(candidates) > 1:
                    return ToolResult.error(
                        f"Error: line_hint {line_hint} is ambiguous; "
                        f"old_text appears {len(candidates)} times on that line."
                    )
                selected = candidates
            else:
                selected = [matches[0]]
            if expected_replacements is not None and len(selected) != expected_replacements:
                return ToolResult.error(
                    f"Error: expected {expected_replacements} replacements but "
                    f"would make {len(selected)}."
                )
            new_content = content
            for match in reversed(selected):
                replacement = norm_new
                # Preserve separator whitespace when the remaining line has content.
                # Markdown keeps all trailing whitespace for hard line breaks.
                if posixpath.splitext(fp)[1].lower() not in self._MARKDOWN_EXTS:
                    line_end = content.find("\n", match.end)
                    if line_end == -1:
                        line_end = len(content)
                    replacement = self._strip_trailing_ws(
                        replacement,
                        preserve_last_line=bool(content[match.end:line_end].strip()),
                    )
                replacement = _preserve_quote_style(norm_old, match.text, replacement)
                replacement = _reindent_like_match(norm_old, match.text, replacement)

                # Only consume the trailing newline when deleting complete lines;
                # inline suffix deletions must preserve the remaining line boundary.
                end = match.end
                if (
                    replacement == ""
                    and (match.start == 0 or content[match.start - 1] == "\n")
                    and not match.text.endswith("\n")
                    and content[end:end + 1] == "\n"
                ):
                    end += 1

                new_content = new_content[: match.start] + replacement + new_content[end:]
            if uses_crlf:
                new_content = new_content.replace("\n", "\r\n")

            await self.computer.write_bytes(fp, new_content.encode("utf-8"))
            self._file_states.record_write(fp)
            return self._format_summary(fp, content, new_content)
        except PermissionError as e:
            return ToolResult.error(f"Error: {e}")
        except Exception as e:
            return ToolResult.error(f"Error editing file: {e}")

    async def _file_not_found_msg(self, path: str, fp: str) -> str:
        """Build an error message with 'Did you mean ...?' suggestions."""
        parent = posixpath.dirname(fp)
        suggestions: list[str] = []
        entries = await self.computer.list_dir(parent)
        if entries is not None:
            siblings = [e.name for e in entries if e.type == "file"]
            close = difflib.get_close_matches(posixpath.basename(fp), siblings, n=3, cutoff=0.6)
            suggestions = [posixpath.join(parent, c) for c in close]
        parts = [f"Error: File not found: {path}"]
        if suggestions:
            parts.append("Did you mean: " + ", ".join(suggestions) + "?")
        return ToolResult.error("\n".join(parts))

    @staticmethod
    def _not_found_msg(old_text: str, content: str, path: str) -> str:
        best_ratio, best_start, best_window_lines, hints = _best_window(old_text, content)
        if best_ratio > 0.5:
            diff = "\n".join(difflib.unified_diff(
                old_text.splitlines(keepends=True),
                best_window_lines,
                fromfile="old_text (provided)",
                tofile=f"{path} (actual, line {best_start + 1})",
                lineterm="",
            ))
            hint_text = ""
            if hints:
                hint_text = "\nPossible cause: " + ", ".join(hints) + "."
            return ToolResult.error(
                f"Error: old_text not found in {path}."
                f"{hint_text}\nBest match ({best_ratio:.0%} similar) at line {best_start + 1}:\n{diff}"
            )

        if hints:
            return ToolResult.error(
                f"Error: old_text not found in {path}. "
                f"Possible cause: {', '.join(hints)}. "
                "Copy the exact text from read_file and try again."
            )
        return ToolResult.error(f"Error: old_text not found in {path}. No similar text found. Verify the file content.")


# ---------------------------------------------------------------------------
# list_dir
# ---------------------------------------------------------------------------

@tool_parameters(
    tool_parameters_schema(
        path=StringSchema("The directory path to list"),
        recursive=BooleanSchema(description="Recursively list all files (default false)"),
        max_entries=IntegerSchema(
            description="Maximum entries to return (default 200)",
            minimum=1,
        ),
        required=["path"],
    )
)
class ListDirTool(_FsTool):
    """List directory contents with optional recursion."""

    _DEFAULT_MAX = 200
    _MAX_WALK_ENTRIES = 20_000
    _IGNORE_DIRS = {
        ".git", "node_modules", "__pycache__", ".venv", "venv",
        "dist", "build", ".tox", ".mypy_cache", ".pytest_cache",
        ".ruff_cache", ".coverage", "htmlcov",
    }

    async def _walk(
        self, abs_dir: str, rel_dir: str, listing: list[Entry]
    ) -> AsyncIterator[tuple[str, bool]]:
        """Yield (path relative to the root, is_dir) in the order of a sorted tree walk."""
        for entry in sorted(listing, key=lambda e: e.name):
            if entry.name in self._IGNORE_DIRS:
                continue
            rel = posixpath.join(rel_dir, entry.name)
            is_dir = entry.type == "dir"
            yield rel, is_dir
            if not is_dir:
                continue
            absolute = posixpath.join(abs_dir, entry.name)
            try:
                children = await self.computer.list_dir(absolute)
            except ComputerError:
                continue  # a directory that cannot be read is listed but not entered
            if children:
                async for item in self._walk(absolute, rel, children):
                    yield item

    @property
    def name(self) -> str:
        return "list_dir"

    @property
    def description(self) -> str:
        return (
            "List the contents of a directory. "
            "Set recursive=true to explore nested structure. "
            "Common noise directories (.git, node_modules, __pycache__, etc.) are auto-ignored."
        )

    async def execute(
        self, path: str | None = None, recursive: bool = False,
        max_entries: int | None = None, **kwargs: Any,
    ) -> str:
        try:
            if path is None:
                raise ValueError("Unknown path")
            dp = self._resolve(path)
            try:
                entries = await self.computer.list_dir(dp)
            except ComputerError as exc:
                if exc.status_code == WRONG_KIND:
                    return ToolResult.error(f"Error: Not a directory: {path}")
                raise
            if entries is None:
                return ToolResult.error(f"Error: Directory not found: {path}")

            cap = max_entries or self._DEFAULT_MAX
            items: list[str] = []
            total = 0
            walk_stopped = False

            if recursive:
                async for rel, is_dir in self._walk(dp, "", entries):
                    total += 1
                    if len(items) < cap:
                        items.append(f"{rel}/" if is_dir else rel)
                    if total >= self._MAX_WALK_ENTRIES:
                        walk_stopped = True
                        break
            else:
                for item in sorted(entries, key=lambda e: e.name):
                    if item.name in self._IGNORE_DIRS:
                        continue
                    total += 1
                    if len(items) < cap:
                        pfx = "\U0001F4C1 " if item.type == "dir" else "\U0001F4C4 "
                        items.append(f"{pfx}{item.name}")

            if not items and total == 0:
                return f"Directory {path} is empty"

            result = "\n".join(items)
            if walk_stopped:
                result += f"\n\n(stopped after {total} entries; list a subdirectory to see more)"
            elif total > cap:
                result += f"\n\n(truncated, showing first {cap} of {total} entries)"
            return result
        except PermissionError as e:
            return ToolResult.error(f"Error: {e}")
        except Exception as e:
            return ToolResult.error(f"Error listing directory: {e}")
