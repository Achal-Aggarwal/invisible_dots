"""Tests for find_files and grep on the Dot's computer."""

from __future__ import annotations

import asyncio
import os
import re
from pathlib import Path

import pytest
from fakes.local_computer import LocalComputer

from nanobot.agent.tools.registry import is_tool_error_result
from nanobot.agent.tools.search import FindFilesTool, GrepTool
from nanobot.dots.computer import RunResult


@pytest.mark.asyncio
async def test_find_files_filters_by_query_glob_and_type(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "settings_view.tsx").write_text("export {}\n", encoding="utf-8")
    (tmp_path / "src" / "settings_api.py").write_text("pass\n", encoding="utf-8")
    (tmp_path / "README.md").write_text("settings\n", encoding="utf-8")

    tool = FindFilesTool(computer=LocalComputer(tmp_path))
    result = await tool.execute(
        path=".",
        query="settings",
        glob="src/**",
        type="ts",
    )

    assert result.splitlines() == ["src/settings_view.tsx"]


@pytest.mark.parametrize("tool_name", ["find_files", "grep"])
@pytest.mark.parametrize(
    ("glob", "expected"),
    [
        ("**/*.py", ["main.py", "src/api.py", "src/nested/deep/worker.py"]),
        ("**.py", ["main.py", "src/api.py", "src/nested/deep/worker.py"]),
        ("src/**/*.py", ["src/api.py", "src/nested/deep/worker.py"]),
        ("src/**", ["src/api.py", "src/nested/deep/worker.py"]),
        ("src/*.py", ["src/api.py"]),
        ("src/**/deep/*.py", ["src/nested/deep/worker.py"]),
        (r"src\**\*.py", ["src/api.py", "src/nested/deep/worker.py"]),
    ],
)
async def test_search_recursive_glob_matches_zero_or_more_directories(
    tmp_path: Path, tool_name: str, glob: str, expected: list[str]
) -> None:
    for name in ["main.py", "src/api.py", "src/nested/deep/worker.py", "notes.md"]:
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("needle\n", encoding="utf-8")

    if tool_name == "find_files":
        result = await FindFilesTool(computer=LocalComputer(tmp_path)).execute(
            path=".", glob=glob,
        )
    else:
        result = await GrepTool(computer=LocalComputer(tmp_path)).execute(
            pattern="needle", path=".", glob=glob, output_mode="files_with_matches",
        )

    assert sorted(result.splitlines()) == expected


@pytest.mark.asyncio
async def test_find_files_can_include_directories(tmp_path: Path) -> None:
    (tmp_path / "src" / "settings").mkdir(parents=True)
    (tmp_path / "src" / "settings" / "index.ts").write_text("export {}\n", encoding="utf-8")

    tool = FindFilesTool(computer=LocalComputer(tmp_path))
    result = await tool.execute(path="src", query="settings", include_dirs=True)

    assert "src/settings/" in result.splitlines()
    assert "src/settings/index.ts" in result.splitlines()


@pytest.mark.asyncio
async def test_find_files_supports_modified_sort_and_pagination(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    for idx, name in enumerate(("a.py", "b.py", "c.py"), start=1):
        file_path = tmp_path / "src" / name
        file_path.write_text("pass\n", encoding="utf-8")
        os.utime(file_path, (idx, idx))

    tool = FindFilesTool(computer=LocalComputer(tmp_path))
    result = await tool.execute(
        path="src",
        type="py",
        sort="modified",
        head_limit=1,
        offset=1,
    )

    assert result.splitlines()[0] == "src/b.py"
    assert "pagination: limit=1, offset=1" in result


@pytest.mark.asyncio
async def test_find_files_searches_outside_the_workspace_by_absolute_path(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "elsewhere.txt").write_text("ok\n", encoding="utf-8")
    tool = FindFilesTool(computer=LocalComputer(tmp_path, workspace))

    result = await tool.execute(path=str(outside))

    assert result == "elsewhere.txt"


@pytest.mark.asyncio
async def test_find_files_reports_a_missing_path(tmp_path: Path) -> None:
    tool = FindFilesTool(computer=LocalComputer(tmp_path))

    result = await tool.execute(path="nowhere")

    assert result == "Error: Path not found: nowhere"


class _GatedComputer(LocalComputer):
    """A computer whose runs wait for the test, and that notes a run being cancelled."""

    def __init__(self, root: Path) -> None:
        super().__init__(root)
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.cancelled = False

    async def run(self, argv, *, cwd=None, stdin=b"", timeout_s=None) -> RunResult:
        self.started.set()
        try:
            await self.release.wait()
        except asyncio.CancelledError:
            self.cancelled = True
            raise
        return await super().run(argv, cwd=cwd, stdin=stdin, timeout_s=timeout_s)


@pytest.mark.asyncio
async def test_find_files_scan_keeps_event_loop_responsive(tmp_path: Path) -> None:
    (tmp_path / "match.txt").write_text("ok\n", encoding="utf-8")
    computer = _GatedComputer(tmp_path)
    task = asyncio.create_task(FindFilesTool(computer=computer).execute(path="."))
    try:
        await asyncio.wait_for(computer.started.wait(), timeout=0.5)
        for _ in range(3):
            await asyncio.sleep(0.01)
        assert not task.done()
    finally:
        computer.release.set()

    assert await asyncio.wait_for(task, timeout=2) == "match.txt"


@pytest.mark.asyncio
@pytest.mark.parametrize("make_tool", [
    lambda computer: FindFilesTool(computer=computer),
    lambda computer: GrepTool(computer=computer),
], ids=["find_files", "grep"])
async def test_search_cancellation_reaches_the_scan_on_the_computer(tmp_path: Path, make_tool) -> None:
    (tmp_path / "match.txt").write_text("needle\n", encoding="utf-8")
    computer = _GatedComputer(tmp_path)
    tool = make_tool(computer)
    args = {"pattern": "needle"} if isinstance(tool, GrepTool) else {}
    task = asyncio.create_task(tool.execute(path=".", **args))
    await asyncio.wait_for(computer.started.wait(), timeout=0.5)

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, timeout=0.5)

    assert computer.cancelled


@pytest.mark.asyncio
async def test_find_files_path_budget_counts_directories(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / "one").mkdir()
    (tmp_path / "two").mkdir()
    monkeypatch.setattr(FindFilesTool, "_MAX_SCAN_PATHS", 1)
    tool = FindFilesTool(computer=LocalComputer(tmp_path))

    result = await tool.execute(path=".")

    assert result.startswith("Error: find_files scan exceeded 1 paths")


@pytest.mark.asyncio
async def test_find_files_enforces_time_budget(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / "match.txt").write_text("ok\n", encoding="utf-8")
    monkeypatch.setattr(FindFilesTool, "_MAX_SCAN_SECONDS", 0.0)
    tool = FindFilesTool(computer=LocalComputer(tmp_path))

    result = await tool.execute(path=".")

    assert result.startswith("Error: find_files scan exceeded 0 seconds")


@pytest.mark.asyncio
async def test_find_files_path_sort_matches_existing_lexicographic_contract(
    tmp_path: Path,
) -> None:
    (tmp_path / "a").mkdir()
    (tmp_path / "a" / "inside.txt").write_text("ok\n", encoding="utf-8")
    (tmp_path / "a+").write_text("ok\n", encoding="utf-8")
    (tmp_path / "a.py").write_text("ok\n", encoding="utf-8")
    tool = FindFilesTool(computer=LocalComputer(tmp_path))

    result = await tool.execute(path=".", head_limit=0)

    assert result.splitlines() == ["a+", "a.py", "a/inside.txt"]


@pytest.mark.asyncio
async def test_grep_respects_glob_filter_and_context(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.py").write_text(
        "alpha\nbeta\nmatch_here\ngamma\n",
        encoding="utf-8",
    )
    (tmp_path / "README.md").write_text("match_here\n", encoding="utf-8")

    tool = GrepTool(computer=LocalComputer(tmp_path))
    result = await tool.execute(
        pattern="match_here",
        path=".",
        glob="*.py",
        output_mode="content",
        context_before=1,
        context_after=1,
    )

    assert "src/main.py:3" in result
    assert "  2| beta" in result
    assert "> 3| match_here" in result
    assert "  4| gamma" in result
    assert "README.md" not in result


@pytest.mark.asyncio
async def test_grep_defaults_to_match_context(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.py").write_text(
        "\n".join(f"line {line}" for line in range(1, 6))
        + "\nmatch_here\n"
        + "\n".join(f"line {line}" for line in range(7, 13)),
        encoding="utf-8",
    )

    tool = GrepTool(computer=LocalComputer(tmp_path))
    result = await tool.execute(
        pattern="match_here",
        path="src",
    )

    assert "src/main.py:6" in result
    assert "  1| line 1" in result
    assert "> 6| match_here" in result
    assert "  11| line 11" in result
    assert "line 12" not in result


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["people.xlsx", "notes.docx", "deck.pptx", "paper.pdf"])
async def test_grep_skips_documents_as_binary(tmp_path: Path, name: str) -> None:
    (tmp_path / name).write_bytes(b"PK\x03\x04\x80\x81 needle \x82")
    (tmp_path / "plain.txt").write_text("a needle in text\n", encoding="utf-8")

    tool = GrepTool(computer=LocalComputer(tmp_path))
    result = await tool.execute(pattern="needle", path=".", fixed_strings=True)

    assert "plain.txt:1" in result
    assert name not in result
    assert "(skipped 1 binary/unreadable files)" in result


@pytest.mark.asyncio
async def test_grep_returns_an_oversized_matching_line_whole(tmp_path: Path) -> None:
    long_line = "x" * 130_000 + "needle" + "y" * 10_000
    (tmp_path / "huge-line.txt").write_text(long_line, encoding="utf-8")
    tool = GrepTool(computer=LocalComputer(tmp_path))

    result = await tool.execute(
        pattern="needle",
        path="huge-line.txt",
        fixed_strings=True,
        context_before=0,
        context_after=0,
    )

    assert result == f"huge-line.txt:1\n> 1| {long_line}"


@pytest.mark.asyncio
async def test_grep_returns_every_match_however_long_the_result(tmp_path: Path) -> None:
    lines = [f"needle-{line}-" + "x" * 200 for line in range(1, 301)]
    (tmp_path / "many.txt").write_text("\n".join(lines), encoding="utf-8")
    tool = GrepTool(computer=LocalComputer(tmp_path))

    result = await tool.execute(
        pattern="needle",
        path="many.txt",
        fixed_strings=True,
        context_before=0,
        context_after=0,
        head_limit=0,
    )

    assert len(result) > 60_000
    assert result == "\n\n".join(f"many.txt:{n}\n> {n}| {text}" for n, text in enumerate(lines, 1))


@pytest.mark.asyncio
async def test_grep_supports_case_insensitive_search(tmp_path: Path) -> None:
    (tmp_path / "memory").mkdir()
    (tmp_path / "memory" / "HISTORY.md").write_text(
        "[2026-04-02 10:00] OAuth token rotated\n",
        encoding="utf-8",
    )

    tool = GrepTool(computer=LocalComputer(tmp_path))
    result = await tool.execute(
        pattern="oauth",
        path="memory/HISTORY.md",
        case_insensitive=True,
        output_mode="content",
    )

    assert "memory/HISTORY.md:1" in result
    assert "OAuth token rotated" in result


@pytest.mark.asyncio
async def test_grep_type_filter_limits_files(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "a.py").write_text("needle\n", encoding="utf-8")
    (tmp_path / "src" / "b.md").write_text("needle\n", encoding="utf-8")

    tool = GrepTool(computer=LocalComputer(tmp_path))
    result = await tool.execute(
        pattern="needle",
        path="src",
        type="py",
        output_mode="files_with_matches",
    )

    assert result.splitlines() == ["src/a.py"]


@pytest.mark.asyncio
async def test_grep_fixed_strings_treats_regex_chars_literally(tmp_path: Path) -> None:
    (tmp_path / "memory").mkdir()
    (tmp_path / "memory" / "HISTORY.md").write_text(
        "[2026-04-02 10:00] OAuth token rotated\n",
        encoding="utf-8",
    )

    tool = GrepTool(computer=LocalComputer(tmp_path))
    result = await tool.execute(
        pattern="[2026-04-02 10:00]",
        path="memory/HISTORY.md",
        fixed_strings=True,
        output_mode="content",
    )

    assert "memory/HISTORY.md:1" in result
    assert "[2026-04-02 10:00] OAuth token rotated" in result


@pytest.mark.asyncio
async def test_grep_files_with_matches_mode_returns_unique_paths(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    a = tmp_path / "src" / "a.py"
    b = tmp_path / "src" / "b.py"
    a.write_text("needle\nneedle\n", encoding="utf-8")
    b.write_text("needle\n", encoding="utf-8")
    os.utime(a, (1, 1))
    os.utime(b, (2, 2))

    tool = GrepTool(computer=LocalComputer(tmp_path))
    result = await tool.execute(
        pattern="needle",
        path="src",
        output_mode="files_with_matches",
    )

    assert result.splitlines() == ["src/b.py", "src/a.py"]


@pytest.mark.asyncio
async def test_grep_files_with_matches_supports_head_limit_and_offset(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    for name in ("a.py", "b.py", "c.py"):
        (tmp_path / "src" / name).write_text("needle\n", encoding="utf-8")

    tool = GrepTool(computer=LocalComputer(tmp_path))
    result = await tool.execute(
        pattern="needle",
        path="src",
        output_mode="files_with_matches",
        head_limit=1,
        offset=1,
    )

    # Filesystem order is not deterministic across platforms, so just verify:
    # 1. Only one file path is returned (head_limit=1 after offset=1)
    # 2. The pagination info is correct
    assert "pagination: limit=1, offset=1" in result
    # Count non-empty lines that start with src/ (file paths)
    file_lines = [line for line in result.splitlines() if line.startswith("src/")]
    assert len(file_lines) == 1


@pytest.mark.asyncio
async def test_grep_count_mode_reports_counts_per_file(tmp_path: Path) -> None:
    (tmp_path / "logs").mkdir()
    (tmp_path / "logs" / "one.log").write_text("warn\nok\nwarn\n", encoding="utf-8")
    (tmp_path / "logs" / "two.log").write_text("warn\n", encoding="utf-8")

    tool = GrepTool(computer=LocalComputer(tmp_path))
    result = await tool.execute(
        pattern="warn",
        path="logs",
        output_mode="count",
    )

    assert "logs/one.log: 2" in result
    assert "logs/two.log: 1" in result
    assert "total matches: 3 in 2 files" in result


@pytest.mark.asyncio
async def test_grep_files_with_matches_mode_respects_max_results(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    files = []
    for idx, name in enumerate(("a.py", "b.py", "c.py"), start=1):
        file_path = tmp_path / "src" / name
        file_path.write_text("needle\n", encoding="utf-8")
        os.utime(file_path, (idx, idx))
        files.append(file_path)

    tool = GrepTool(computer=LocalComputer(tmp_path))
    result = await tool.execute(
        pattern="needle",
        path="src",
        output_mode="files_with_matches",
        max_results=2,
    )

    assert result.splitlines()[:2] == ["src/c.py", "src/b.py"]
    assert "pagination: limit=2, offset=0" in result


@pytest.mark.asyncio
async def test_grep_reports_skipped_binary_and_large_files(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Both hold the pattern, so the search on the computer lists them and the tool
    # must say it could not search them.
    (tmp_path / "binary.bin").write_bytes(b"\x00\x01needle\x02")
    (tmp_path / "large.txt").write_text("needle" + "x" * 20, encoding="utf-8")

    monkeypatch.setattr(GrepTool, "_MAX_FILE_BYTES", 10)
    tool = GrepTool(computer=LocalComputer(tmp_path))
    result = await tool.execute(pattern="needle", path=".")

    assert "No matches found" in result
    assert "skipped 1 binary/unreadable files" in result
    assert "skipped 1 large files" in result


@pytest.mark.asyncio
async def test_grep_uses_a_larger_bounded_limit_for_an_explicit_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    large_file = tmp_path / "history.jsonl"
    large_file.write_text("needle\n" + "x" * 20, encoding="utf-8")
    monkeypatch.setattr(GrepTool, "_MAX_FILE_BYTES", 10)
    monkeypatch.setattr(GrepTool, "_MAX_EXPLICIT_FILE_BYTES", 100)
    tool = GrepTool(computer=LocalComputer(tmp_path))

    explicit_result = await tool.execute(
        pattern="needle",
        path=str(large_file),
        output_mode="content",
    )
    directory_result = await tool.execute(pattern="needle", path=".")
    monkeypatch.setattr(GrepTool, "_MAX_EXPLICIT_FILE_BYTES", 10)
    capped_result = await tool.execute(pattern="needle", path=str(large_file))

    assert "needle" in explicit_result
    assert "skipped 1 large files" in directory_result
    assert "skipped 1 large files" in capped_result


def test_grep_schema_is_concise_and_hides_internal_limits(tmp_path: Path) -> None:
    tool = GrepTool(computer=LocalComputer(tmp_path))
    properties = tool.parameters["properties"]

    assert len(tool.description) < 150
    assert "head_limit" in properties
    assert "max_matches" not in properties
    assert "max_results" not in properties


@pytest.mark.asyncio
async def test_grep_searches_outside_the_workspace_by_absolute_path(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    outside = tmp_path / "outside-search.txt"
    outside.write_text("secret\n", encoding="utf-8")
    grep_tool = GrepTool(computer=LocalComputer(tmp_path, workspace))

    result = await grep_tool.execute(pattern="secret", path=str(outside))

    assert "secret" in result
    assert not result.startswith("Error")


@pytest.mark.parametrize("tool_class", [FindFilesTool, GrepTool])
@pytest.mark.parametrize("glob", ["webui/**/*.{ts,tsx}", "webui/*.{ts,tsx}", r"webui\*.{ts,tsx}"])
async def test_search_braces_and_root_relative_paths(tmp_path, tool_class, glob):
    for name in ["webui/App.tsx", "webui/client.ts", "webui/style.css", "backup/webui/Old.tsx"]:
        target = tmp_path / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("needle", encoding="utf-8")
    tool = tool_class(computer=LocalComputer(tmp_path))
    args = {"pattern": "needle", "output_mode": "files_with_matches"} if tool_class is GrepTool else {}

    result = await tool.execute(path=".", glob=glob, **args)

    assert sorted(result.splitlines()) == ["webui/App.tsx", "webui/client.ts"]
    recursive = await tool.execute(path=".", glob="**/webui/*.{ts,tsx}", **args)
    assert "backup/webui/Old.tsx" in recursive


@pytest.mark.parametrize("tool_class", [FindFilesTool, GrepTool])
@pytest.mark.parametrize("glob", ["*.{ts,tsx", "*.{ts}", "{a,b}" * 7])
async def test_search_invalid_glob_is_an_error_even_in_empty_directory(tmp_path, tool_class, glob):
    tool = tool_class(computer=LocalComputer(tmp_path))
    args = {"pattern": "needle"} if tool_class is GrepTool else {}
    result = await tool.execute(glob=glob, **args)
    assert is_tool_error_result(result)
    assert "glob" in result


@pytest.mark.parametrize("tool_class", [FindFilesTool, GrepTool])
async def test_search_skips_generated_directories_but_allows_explicit_roots(tmp_path, tool_class):
    excluded = [".worktrees/other", ".worktree/other", ".nanobot/tool-results", "webui/.verify-run"]
    for name in ["src", ".agent", *excluded]:
        directory = tmp_path / name
        directory.mkdir(parents=True)
        (directory / "data.txt").write_text("needle", encoding="utf-8")
    tool = tool_class(computer=LocalComputer(tmp_path))
    args = {"pattern": "needle", "output_mode": "files_with_matches"} if tool_class is GrepTool else {}

    result = await tool.execute(**args)
    assert sorted(result.splitlines()) == [".agent/data.txt", "src/data.txt"]
    for name in excluded:
        assert await tool.execute(path=name, **args) == f"{name}/data.txt"
        assert await tool.execute(path=f"{name}/data.txt", **args) == f"{name}/data.txt"


async def test_grep_merges_context_and_pages_by_matches(tmp_path):
    (tmp_path / "source.txt").write_text(
        "before\nneedle one\nneedle two\nneedle three\nafter\n", encoding="utf-8",
    )
    tool = GrepTool(computer=LocalComputer(tmp_path))
    result = await tool.execute(pattern="needle", head_limit=2)

    assert result.count("source.txt:") == 1
    assert result.count("| before") == 1
    assert result.count("| needle one") == 1
    assert result.count("| needle two") == 1
    assert "> 2| needle one" in result and "> 3| needle two" in result
    assert "use offset=2 to continue" in result
    second = await tool.execute(pattern="needle", head_limit=2, offset=2)
    assert re.findall(r"^> (\d+)\|", second, re.M) == ["4"]
    assert "to continue" not in second


async def test_grep_pages_do_not_lose_merged_matches(tmp_path):
    (tmp_path / "source.txt").write_text(
        "\n".join(f"needle {n} " + "x" * 50 for n in range(30)), encoding="utf-8",
    )
    tool = GrepTool(computer=LocalComputer(tmp_path))
    seen = []
    offset = 0
    for _ in range(30):
        result = await tool.execute(pattern="needle", offset=offset, head_limit=7)
        seen.extend(re.findall(r"^> (\d+)\|", result, re.M))
        continuation = re.search(r"use offset=(\d+) to continue", result)
        if continuation is None:
            break
        next_offset = int(continuation[1])
        assert next_offset > offset
        offset = next_offset
    assert seen == [str(n) for n in range(1, 31)]


async def test_grep_returns_a_large_context_whole(tmp_path):
    (tmp_path / "source.txt").write_text("x" * 5000 + "\nneedle\n" + "y" * 5000, encoding="utf-8")
    result = await GrepTool(computer=LocalComputer(tmp_path)).execute(pattern="needle")
    assert result == f"source.txt:2\n  1| {'x' * 5000}\n> 2| needle\n  3| {'y' * 5000}"


@pytest.mark.parametrize("mode", ["find_files", "files_with_matches", "count"])
async def test_search_path_pages_continue(tmp_path, mode):
    for n in range(20):
        target = tmp_path / (f"file-{n:02}-" + "x" * 50 + ".txt")
        target.write_text("needle", encoding="utf-8")
        os.utime(target, (1, 1))
    tool_class = FindFilesTool if mode == "find_files" else GrepTool
    tool = tool_class(computer=LocalComputer(tmp_path))
    args = {} if mode == "find_files" else {"pattern": "needle", "output_mode": mode}
    seen = []
    offset = 0
    for _ in range(20):
        result = await tool.execute(offset=offset, head_limit=3, **args)
        seen.extend(re.findall(r"^(file-.*?\.txt)", result, re.M))
        continuation = re.search(r"use offset=(\d+) to continue", result)
        if continuation is None:
            break
        assert int(continuation[1]) > offset
        offset = int(continuation[1])
    assert seen == sorted(path.name for path in tmp_path.iterdir())


@pytest.mark.parametrize("mode", ["find_files", "files_with_matches", "count"])
async def test_search_path_lists_come_back_whole(tmp_path, mode):
    for n in range(300):
        target = tmp_path / (f"file-{n:03}-" + "x" * 100 + ".txt")
        target.write_text("needle", encoding="utf-8")
        os.utime(target, (1, 1))
    tool = (FindFilesTool if mode == "find_files" else GrepTool)(computer=LocalComputer(tmp_path))
    args = {} if mode == "find_files" else {"pattern": "needle", "output_mode": mode}

    result = await tool.execute(head_limit=0, **args)

    assert len(result) > 30_000
    assert re.findall(r"^(file-.*?\.txt)", result, re.M) == sorted(path.name for path in tmp_path.iterdir())
    assert "to continue" not in result


@pytest.mark.parametrize("budget,value", [("_MAX_SCAN_PATHS", 0), ("_MAX_SCAN_SECONDS", 0)])
async def test_grep_bounds_scans(tmp_path, monkeypatch, budget, value):
    (tmp_path / "source.txt").write_text("ordinary", encoding="utf-8")
    monkeypatch.setattr(GrepTool, budget, value)
    result = await GrepTool(computer=LocalComputer(tmp_path)).execute(pattern="ordinary")
    assert result.startswith("Error: grep scan exceeded 0")


async def test_grep_context_page_counts_matches_across_files(tmp_path):
    (tmp_path / "a.txt").write_text("needle a1\nneedle a2\n", encoding="utf-8")
    (tmp_path / "b.txt").write_text("needle b1\nneedle b2\n", encoding="utf-8")
    tool = GrepTool(computer=LocalComputer(tmp_path))

    result = await tool.execute(pattern="needle", offset=1, head_limit=2)

    assert result == (
        "a.txt:2\n  1| needle a1\n> 2| needle a2\n\n"
        "b.txt:1\n> 1| needle b1\n  2| needle b2\n\n"
        "(pagination: limit=2, offset=1; use offset=3 to continue)"
    )
    last_page = await tool.execute(pattern="needle", offset=3, head_limit=2)
    assert last_page == (
        "b.txt:2\n  1| needle b1\n> 2| needle b2\n\n(pagination: offset=3)"
    )


async def test_grep_marks_a_long_line_already_present_as_context(tmp_path):
    (tmp_path / "source.txt").write_text(
        "needle first\n" + "x" * 3000 + "needle late" + "y" * 1000, encoding="utf-8",
    )
    result = await GrepTool(computer=LocalComputer(tmp_path)).execute(pattern="needle")

    assert re.findall(r"^> (\d+)\|", result, re.M) == ["1", "2"]
    assert "needle first" in result and "needle late" in result
    assert result.count("source.txt:") == 1
    assert f"> 2| {'x' * 3000}needle late{'y' * 1000}" in result.splitlines()


@pytest.mark.parametrize("mode", ["content", "count", "files_with_matches"])
async def test_grep_closes_the_line_stream_once_it_has_enough(tmp_path, monkeypatch, mode):
    from nanobot.agent.tools._search_content import SourceLine

    (tmp_path / "source.txt").write_text("placeholder", encoding="utf-8")
    visited = []
    closed = []

    def lines():
        try:
            for n in range(1, 101):
                visited.append(n)
                yield SourceLine("needle", n)
        finally:
            closed.append(True)

    monkeypatch.setattr(GrepTool, "_source_lines", staticmethod(lambda _raw: lines()))
    result = await GrepTool(computer=LocalComputer(tmp_path)).execute(
        pattern="needle", path="source.txt", output_mode=mode,
        head_limit=1, context_before=0, context_after=1,
    )

    assert closed == [True]
    if mode == "content":
        assert result.startswith("source.txt:1\n> 1| needle")
        assert "use offset=1 to continue" in result
        assert visited == [1, 2, 3]
    elif mode == "count":
        assert result.startswith("source.txt: 100")
        assert len(visited) == 100
    else:
        assert result == "source.txt"
        assert visited == [1]
