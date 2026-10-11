"""Search tools: file discovery and grep, on the Dot's own computer."""

from __future__ import annotations

import fnmatch
import posixpath
import re
import time
from collections.abc import Generator
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache
from pathlib import PurePosixPath
from typing import Any, TypeVar

from nanobot.agent.tools._search_content import ContentPage, MatchTooLargeError, SourceLine
from nanobot.agent.tools.base import ToolResult
from nanobot.agent.tools.filesystem import ListDirTool, _FsTool

_DEFAULT_HEAD_LIMIT = 250
_DEFAULT_FILE_HEAD_LIMIT = 200
T = TypeVar("T")
_TYPE_GLOB_MAP = {
    "py": ("*.py", "*.pyi"),
    "python": ("*.py", "*.pyi"),
    "js": ("*.js", "*.jsx", "*.mjs", "*.cjs"),
    "ts": ("*.ts", "*.tsx", "*.mts", "*.cts"),
    "tsx": ("*.tsx",),
    "jsx": ("*.jsx",),
    "json": ("*.json",),
    "md": ("*.md", "*.mdx"),
    "markdown": ("*.md", "*.mdx"),
    "go": ("*.go",),
    "rs": ("*.rs",),
    "rust": ("*.rs",),
    "java": ("*.java",),
    "sh": ("*.sh", "*.bash"),
    "yaml": ("*.yaml", "*.yml"),
    "yml": ("*.yaml", "*.yml"),
    "toml": ("*.toml",),
    "sql": ("*.sql",),
    "html": ("*.html", "*.htm"),
    "css": ("*.css", "*.scss", "*.sass"),
}


def _normalize_pattern(pattern: str) -> str:
    return pattern.strip().replace("\\", "/")


@lru_cache(maxsize=128)
def _glob_patterns(pattern: str) -> tuple[str, ...]:
    """Expand bounded brace alternatives before matching path segments."""
    pending = [_normalize_pattern(pattern)]
    expanded: list[str] = []
    while pending:
        current = pending.pop()
        braces = re.search(r"\{([^{}]*)\}", current)
        if braces is None:
            if "{" in current or "}" in current:
                raise ValueError("Invalid glob: unbalanced braces")
            expanded.append(current)
            continue
        options = braces[1].split(",")
        if len(options) < 2:
            raise ValueError("Invalid glob: braces require comma-separated alternatives")
        if len(expanded) + len(pending) + len(options) > 64:
            raise ValueError("Invalid glob: at most 64 brace alternatives are supported")
        pending.extend(current[:braces.start()] + part + current[braces.end():] for part in options)
    return tuple(expanded)


def _match_glob(rel_path: str, name: str, pattern: str) -> bool:
    return any(_match_path_glob(rel_path, name, item) for item in _glob_patterns(pattern))


def _match_path_glob(rel_path: str, name: str, normalized: str) -> bool:
    if not normalized:
        return False
    if "/" in normalized:
        pattern_parts = PurePosixPath(normalized).parts
        path_parts = PurePosixPath(rel_path).parts
        matched = [True] + [False] * len(path_parts)
        for part in pattern_parts:
            if part == "**":
                # A globstar consumes zero or more complete path segments.
                for index in range(1, len(matched)):
                    matched[index] = matched[index] or matched[index - 1]
            else:
                matched = [False] + [
                    matched[index] and fnmatch.fnmatchcase(path_part, part)
                    for index, path_part in enumerate(path_parts)
                ]
        return matched[-1]
    return fnmatch.fnmatch(name, normalized)


def _is_binary(raw: bytes) -> bool:
    if b"\x00" in raw:
        return True
    sample = raw[:4096]
    if not sample:
        return False
    non_text = sum(byte < 9 or 13 < byte < 32 for byte in sample)
    return (non_text / len(sample)) > 0.2


def _entry_mtime(iso: str) -> float:
    """Seconds since the epoch of an ISO time dot-agentd reported, 0 if it is not one."""
    try:
        return datetime.fromisoformat(iso).timestamp()
    except ValueError:
        return 0.0


def _walk_order(rel: str) -> tuple[tuple[int, str], ...]:
    """Sort key of a directory walk: a directory's files first, then its subdirectories."""
    *directories, name = rel.split("/")
    return (*((1, part) for part in directories), (0, name))


def _paginate(items: list[T], limit: int | None, offset: int) -> tuple[list[T], bool]:
    if limit is None:
        return items[offset:], False
    sliced = items[offset : offset + limit]
    truncated = len(items) > offset + limit
    return sliced, truncated


def _text_page(
    items: list[str], limit: int | None, offset: int, max_chars: int,
) -> tuple[list[str], bool]:
    page, truncated = _paginate(items, limit, offset)
    size = 0
    for index, item in enumerate(page):
        size += len(item) + (1 if index else 0)
        if size > max_chars:
            if index == 0:
                raise ValueError("Search entry exceeds output budget; narrow the search path")
            return page[:index], True
    return page, truncated


def _pagination_note(limit: int | None, offset: int, truncated: bool) -> str | None:
    if truncated:
        if limit is None:
            return f"(pagination: offset={offset})"
        return f"(pagination: limit={limit}, offset={offset})"
    if offset > 0:
        return f"(pagination: offset={offset})"
    return None


def _matches_type(name: str, file_type: str | None) -> bool:
    if not file_type:
        return True
    lowered = file_type.strip().lower()
    if not lowered:
        return True
    patterns = _TYPE_GLOB_MAP.get(lowered, (f"*.{lowered}",))
    return any(fnmatch.fnmatch(name.lower(), pattern.lower()) for pattern in patterns)


def _matches_query(rel_path: str, query: str | None) -> bool:
    if not query:
        return True
    haystack = rel_path.lower()
    terms = [part for part in query.lower().split() if part]
    return all(term in haystack for term in terms)


@dataclass(frozen=True, slots=True)
class _Target:
    """What a search path names: a directory to walk, or one file."""

    root: str  # the directory searched, or the directory holding the file
    file: str | None  # the file's name when the path names a file


class _SearchBudgetExceededError(Exception):
    """Stop a scan at its configured budget: "paths" or "time"."""


class _SearchTool(_FsTool):
    _IGNORE_DIRS = ListDirTool._IGNORE_DIRS | {".worktrees", ".worktree", ".nanobot"}
    _IGNORE_DIR_PREFIX = ".verify-"
    _MAX_SCAN_PATHS = 500_000
    _MAX_SCAN_SECONDS = 30.0
    _MAX_RESULT_CHARS = 12_000
    _STAT_BATCH = 200

    @classmethod
    def _ignored_dir_globs(cls) -> list[str]:
        """The directory names a walk skips, as globs for find and grep."""
        return [*sorted(cls._IGNORE_DIRS), cls._IGNORE_DIR_PREFIX + "*"]

    async def _target(self, path: str) -> _Target | str:
        """Resolve a search path, or return the tool error naming what is wrong."""
        resolved = self._resolve(path or ".")
        entry = await self.computer.stat(resolved)
        if entry is None:
            return ToolResult.error(f"Error: Path not found: {path}")
        if entry.type == "file":
            return _Target(posixpath.dirname(resolved), posixpath.basename(resolved))
        if entry.type == "dir":
            return _Target(resolved, None)
        return ToolResult.error(f"Error: Unsupported path: {path}")

    def _display(self, root: str, rel: str) -> str:
        """The path shown for root/rel: relative to the workspace inside it, else to root."""
        absolute = posixpath.normpath(posixpath.join(root, rel))
        workspace = posixpath.normpath(self.computer.workspace)
        if absolute == workspace:
            return "."
        prefix = workspace.rstrip("/") + "/"
        return absolute[len(prefix):] if absolute.startswith(prefix) else rel

    def _budget_error(self, tool: str, exceeded: _SearchBudgetExceededError) -> str:
        detail = (
            f"{self._MAX_SCAN_PATHS} paths"
            if str(exceeded) == "paths"
            else f"{self._MAX_SCAN_SECONDS:g} seconds"
        )
        return ToolResult.error(
            f"Error: {tool} scan exceeded {detail}; narrow path, glob, or type and retry."
        )

    async def _scan(self, argv: list[str], root: str) -> bytes:
        """Run a search program in root; its stdout, or a budget or tool error."""
        result = await self.computer.run(argv, cwd=root, timeout_s=self._MAX_SCAN_SECONDS)
        if result.timed_out:
            raise _SearchBudgetExceededError("time")
        # Exit 1 is "nothing found". An unreadable file makes grep exit 2 with the
        # rest of its answer, so a failure is an exit above 1 and nothing to show.
        if result.exit_code > 1 and not result.stdout:
            message = result.stderr.decode("utf-8", errors="replace").strip()
            raise RuntimeError(message or f"{argv[0]} failed with exit code {result.exit_code}")
        return result.stdout

    async def _file_stats(self, root: str, rels: list[str]) -> dict[str, tuple[int, float]]:
        """Size and modification time of files under root, in a few calls."""
        stats: dict[str, tuple[int, float]] = {}
        for start in range(0, len(rels), self._STAT_BATCH):
            batch = rels[start : start + self._STAT_BATCH]
            stdout = await self._scan(
                ["stat", "--printf=%s\t%Y\t%n\\0", "--", *batch], root
            )
            for record in stdout.decode("utf-8", errors="replace").split("\0"):
                size, _, rest = record.partition("\t")
                mtime, _, name = rest.partition("\t")
                if name:
                    stats[name] = (int(size), float(mtime))
        return stats


class FindFilesTool(_SearchTool):
    """Find files by path fragment, glob, or type."""

    @property
    def name(self) -> str:
        return "find_files"

    @property
    def description(self) -> str:
        return (
            "Find workspace paths by name, glob, or file type. "
            "Returns relative paths; skips dependencies, builds, worktrees and tool artifacts."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Search root (default '.'); set path explicitly to search skipped worktrees, builds or tool artifacts",
                },
                "query": {
                    "type": "string",
                    "description": "Case-insensitive path terms; all must match",
                },
                "glob": {
                    "type": "string",
                    "description": "Root-relative path glob, e.g. 'src/**/*.{ts,tsx}'; bare '*.py' matches any depth",
                },
                "type": {
                    "type": "string",
                    "description": "File type, e.g. 'py', 'ts', 'md', or 'json'",
                },
                "include_dirs": {
                    "type": "boolean",
                    "description": "Include directories (default false)",
                },
                "sort": {
                    "type": "string",
                    "enum": ["path", "modified"],
                    "description": "Sort order (default path)",
                },
                "head_limit": {
                    "type": "integer",
                    "description": "Maximum paths (default 200; 0 for all)",
                    "minimum": 0,
                    "maximum": 1000,
                },
                "offset": {
                    "type": "integer",
                    "description": "Paths to skip before head_limit",
                    "minimum": 0,
                    "maximum": 100000,
                },
            },
        }

    async def execute(
        self,
        path: str = ".",
        query: str | None = None,
        glob: str | None = None,
        type: str | None = None,
        include_dirs: bool = False,
        sort: str = "path",
        head_limit: int | None = None,
        offset: int = 0,
        **kwargs: Any,
    ) -> str:
        try:
            target = await self._target(path)
            if isinstance(target, str):
                return target

            if glob:
                _glob_patterns(glob)

            if sort not in {"path", "modified"}:
                return ToolResult.error("Error: sort must be 'path' or 'modified'")

            limit = (
                _DEFAULT_FILE_HEAD_LIMIT
                if head_limit is None
                else None if head_limit == 0 else head_limit
            )
            # (path as shown, modification time) of every entry that matches.
            matches: list[tuple[str, float]] = []
            try:
                for rel, is_dir, mtime in await self._walk(target, include_dirs):
                    name = posixpath.basename(rel) if rel != "." else posixpath.basename(target.root)
                    display = self._display(target.root, rel)
                    if glob and not _match_glob(rel, name, glob):
                        continue
                    if is_dir:
                        if type:
                            continue
                    elif not _matches_type(name, type):
                        continue
                    if not _matches_query(display, query):
                        continue
                    matches.append((display + ("/" if is_dir else ""), mtime))
            except _SearchBudgetExceededError as exc:
                return self._budget_error("find_files", exc)

            if sort == "modified":
                matches.sort(key=lambda item: (-item[1], item[0]))
            else:
                matches.sort(key=lambda item: item[0])

            paths = [item[0] for item in matches]
            paged, truncated = _text_page(paths, limit, offset, self._MAX_RESULT_CHARS)
            if not paged:
                return "No files found"

            result = "\n".join(paged)
            note = _pagination_note(limit, offset, truncated)
            if note:
                result += "\n\n" + note
            if truncated:
                result += f"\n(use offset={offset + len(paged)} to continue)"
            return result
        except PermissionError as e:
            return ToolResult.error(f"Error: {e}")
        except Exception as e:
            return ToolResult.error(f"Error finding files: {e}")

    async def _walk(
        self, target: _Target, include_dirs: bool
    ) -> list[tuple[str, bool, float]]:
        """(path relative to the root, is a directory, mtime) of what the path holds."""
        if target.file is not None:
            stats = await self._file_stats(target.root, [target.file])
            return [(target.file, False, stats.get(target.file, (0, 0.0))[1])]

        entries: list[tuple[str, bool, float]] = []
        if include_dirs:
            root_stats = await self.computer.stat(target.root)
            entries.append((".", True, _entry_mtime(root_stats.mtime) if root_stats else 0.0))

        # A directory symlink is not entered, and not listed: %y is l and %Y is d.
        skipped = ["("]
        for index, name in enumerate(self._ignored_dir_globs()):
            skipped += ["-o"] if index else []
            skipped += ["-name", name]
        skipped += [")"]
        argv = [
            "find", ".", "-mindepth", "1",
            "(", "-type", "d", *skipped, "-prune", ")", "-o",
            "-printf", "%y\t%Y\t%T@\t%P\\0",
        ]
        stdout = await self._scan(argv, target.root)
        records = [record for record in stdout.decode("utf-8", errors="replace").split("\0") if record]
        if len(records) > self._MAX_SCAN_PATHS:
            raise _SearchBudgetExceededError("paths")
        for record in records:
            kind, _, rest = record.partition("\t")
            target_kind, _, rest = rest.partition("\t")
            mtime, _, rel = rest.partition("\t")
            if not rel or (kind == "l" and target_kind == "d"):
                continue
            if kind != "d" or include_dirs:
                entries.append((rel, kind == "d", float(mtime)))
        return entries


class GrepTool(_SearchTool):
    """Search text file contents using a regex-like pattern."""

    _MAX_RENDERED_LINE_CHARS = 2_000
    _MAX_FILE_BYTES = 2_000_000
    _MAX_EXPLICIT_FILE_BYTES = 100_000_000

    @property
    def name(self) -> str:
        return "grep"

    @property
    def description(self) -> str:
        return (
            "Search text file content. "
            "Returns matches with five context lines by default."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Regex, or literal text when fixed_strings=true",
                    "minLength": 1,
                },
                "path": {
                    "type": "string",
                    "description": "Search root (default '.'); set path explicitly to search skipped worktrees, builds or tool artifacts",
                },
                "glob": {
                    "type": "string",
                    "description": "Root-relative path glob, e.g. 'src/**/*.{ts,tsx}'; bare '*.py' matches any depth",
                },
                "type": {
                    "type": "string",
                    "description": "File type, e.g. 'py', 'ts', 'md', or 'json'",
                },
                "case_insensitive": {
                    "type": "boolean",
                    "description": "Ignore case (default false)",
                },
                "fixed_strings": {
                    "type": "boolean",
                    "description": "Treat pattern literally (default false)",
                },
                "output_mode": {
                    "type": "string",
                    "enum": ["content", "files_with_matches", "count"],
                    "description": (
                        "content: matches with context (default); "
                        "files_with_matches: paths; count: matches per file"
                    ),
                },
                "context_before": {
                    "type": "integer",
                    "description": "Context lines before a match (default 5)",
                    "minimum": 0,
                    "maximum": 20,
                },
                "context_after": {
                    "type": "integer",
                    "description": "Context lines after a match (default 5)",
                    "minimum": 0,
                    "maximum": 20,
                },
                "head_limit": {
                    "type": "integer",
                    "description": "Maximum matches or file entries (default 250; 0 for all)",
                    "minimum": 0,
                    "maximum": 1000,
                },
                "offset": {
                    "type": "integer",
                    "description": "Matches or file entries to skip before head_limit",
                    "minimum": 0,
                    "maximum": 100000,
                },
            },
            "required": ["pattern"],
        }

    @staticmethod
    def _source_lines(raw: bytes) -> Generator[SourceLine, None, None] | None:
        """The text lines of a file's bytes, or None for a binary or non-UTF-8 file."""
        if _is_binary(raw):
            return None
        try:
            content = raw.decode("utf-8")
        except UnicodeDecodeError:
            return None
        return (SourceLine(text, line_no) for line_no, text in enumerate(content.splitlines(), 1))

    async def _candidates(
        self, target: _Target, pattern: str, case_insensitive: bool, fixed_strings: bool
    ) -> list[str]:
        """Paths (relative to the root) of the files that may match.

        grep on the Dot's computer is only the prefilter, so that files that cannot
        match are never read over the socket. The tool's own regex decides what
        matches. PCRE is the dialect closest to Python's.
        """
        if target.file is not None:
            return [target.file]
        argv = ["grep", "-rlZ", "-F" if fixed_strings else "-P"]
        if case_insensitive:
            argv.append("-i")
        argv += [f"--exclude-dir={name}" for name in self._ignored_dir_globs()]
        argv += ["-e", pattern, "--", "."]
        stdout = await self._scan(argv, target.root)
        return [
            rel.removeprefix("./")
            for rel in stdout.decode("utf-8", errors="replace").split("\0")
            if rel
        ]

    async def execute(
        self,
        pattern: str,
        path: str = ".",
        glob: str | None = None,
        type: str | None = None,
        case_insensitive: bool = False,
        fixed_strings: bool = False,
        output_mode: str = "content",
        context_before: int = 5,
        context_after: int = 5,
        max_matches: int | None = None,
        max_results: int | None = None,
        head_limit: int | None = None,
        offset: int = 0,
        **kwargs: Any,
    ) -> str:
        deadline = time.monotonic() + self._MAX_SCAN_SECONDS
        try:
            if glob:
                _glob_patterns(glob)
            target = await self._target(path)
            if isinstance(target, str):
                return target

            flags = re.IGNORECASE if case_insensitive else 0
            try:
                needle = re.escape(pattern) if fixed_strings else pattern
                regex = re.compile(needle, flags)
            except re.error as e:
                return ToolResult.error(f"Error: invalid regex pattern: {e}")

            if head_limit is not None:
                limit = None if head_limit == 0 else head_limit
            elif output_mode == "content" and max_matches is not None:
                limit = max_matches
            elif output_mode != "content" and max_results is not None:
                limit = max_results
            else:
                limit = _DEFAULT_HEAD_LIMIT
            content_page = ContentPage(limit, offset, self._MAX_RESULT_CHARS, self._MAX_RENDERED_LINE_CHARS)
            skipped_binary = 0
            skipped_large = 0
            counts: dict[str, int] = {}
            file_mtimes: dict[str, float] = {}
            max_file_bytes = (
                self._MAX_EXPLICIT_FILE_BYTES if target.file is not None else self._MAX_FILE_BYTES
            )

            candidates = await self._candidates(target, pattern, case_insensitive, fixed_strings)
            if len(candidates) > self._MAX_SCAN_PATHS:
                raise _SearchBudgetExceededError("paths")
            rels = sorted(
                (
                    rel for rel in candidates
                    if (not glob or _match_glob(rel, posixpath.basename(rel), glob))
                    and _matches_type(posixpath.basename(rel), type)
                ),
                key=_walk_order,
            )
            stats = await self._file_stats(target.root, rels)

            for rel in rels:
                if time.monotonic() >= deadline:
                    raise _SearchBudgetExceededError("time")
                display_path = self._display(target.root, rel)
                if rel not in stats:
                    skipped_binary += 1
                    continue
                file_size, mtime = stats[rel]
                if file_size > max_file_bytes:
                    skipped_large += 1
                    continue
                raw = await self.computer.read_bytes(posixpath.join(target.root, rel))
                source_lines = None if raw is None else self._source_lines(raw)
                if source_lines is None:
                    skipped_binary += 1
                    continue

                file_had_match = False
                with closing(source_lines):
                    if output_mode == "content":
                        content_page.scan(
                            display_path, source_lines, regex, context_before, context_after
                        )
                    else:
                        for line in source_lines:
                            if regex.search(line.text) is None:
                                continue
                            file_had_match = True
                            if output_mode == "count":
                                counts[display_path] = counts.get(display_path, 0) + 1
                                continue
                            break
                if file_had_match:
                    file_mtimes[display_path] = mtime
                if content_page.stopped:
                    break

            no_matches = f"No matches found for pattern '{pattern}' in {path}"
            notes: list[str] = []
            if output_mode == "content":
                result, note = content_page.render(no_matches)
                if note:
                    notes.append(note)
            else:
                ordered_files = sorted(
                    file_mtimes, key=lambda name: (-file_mtimes.get(name, 0.0), name),
                )
                entries = (
                    [f"{name}: {counts[name]}" for name in ordered_files]
                    if output_mode == "count" else ordered_files
                )
                paged, truncated = _text_page(entries, limit, offset, self._MAX_RESULT_CHARS)
                result = "\n".join(paged) if file_mtimes or counts else no_matches
                if truncated:
                    notes.append(
                        f"(pagination: limit={limit}, offset={offset}; "
                        f"use offset={offset + len(paged)} to continue)"
                    )
                elif offset > 0:
                    notes.append(f"(pagination: offset={offset})")
            if skipped_binary:
                notes.append(f"(skipped {skipped_binary} binary/unreadable files)")
            if skipped_large:
                notes.append(f"(skipped {skipped_large} large files)")
            if output_mode == "count" and counts:
                notes.append(
                    f"(total matches: {sum(counts.values())} in {len(counts)} files)"
                )
            if notes:
                result += "\n\n" + "\n".join(notes)
            return result
        except MatchTooLargeError as exc:
            return ToolResult.error(f"Error: {exc}")
        except _SearchBudgetExceededError as exc:
            return self._budget_error("grep", exc)
        except PermissionError as e:
            return ToolResult.error(f"Error: {e}")
        except Exception as e:
            return ToolResult.error(f"Error searching files: {e}")
