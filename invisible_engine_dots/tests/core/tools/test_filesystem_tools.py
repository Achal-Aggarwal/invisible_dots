"""Tests for enhanced filesystem tools: ReadFileTool, EditFileTool, ListDirTool."""

import pytest
from fakes.local_computer import LocalComputer

from nanobot.agent.tools.file_state import file_read_context
from nanobot.agent.tools.filesystem import (
    EditFileTool,
    ListDirTool,
    ReadFileTool,
    WriteFileTool,
)


@pytest.mark.asyncio
@pytest.mark.parametrize("newline", ["\n", "\r\n", "\r"])
@pytest.mark.parametrize("operation", ["write", "edit_new", "edit_empty"])
async def test_file_creation_preserves_provided_newlines(tmp_path, newline, operation):
    target = tmp_path / "nested" / "script.py"
    content = f"first = 1{newline}second = 2{newline}"
    if operation == "write":
        result = await WriteFileTool(computer=LocalComputer(tmp_path)).execute(
            path=str(target), content=content,
        )
    else:
        if operation == "edit_empty":
            target.parent.mkdir()
            target.touch()
        result = await EditFileTool(computer=LocalComputer(tmp_path)).execute(
            path=str(target), old_text="", new_text=content,
        )

    assert "Error" not in result
    assert target.read_bytes() == content.encode("utf-8")

# ---------------------------------------------------------------------------
# ReadFileTool
# ---------------------------------------------------------------------------

class TestReadFileTool:

    @pytest.fixture()
    def tool(self, tmp_path):
        return ReadFileTool(computer=LocalComputer(tmp_path))

    @pytest.fixture()
    def sample_file(self, tmp_path):
        f = tmp_path / "sample.txt"
        f.write_text("\n".join(f"line {i}" for i in range(1, 21)), encoding="utf-8")
        return f

    @pytest.mark.asyncio
    async def test_basic_read_has_line_numbers(self, tool, sample_file):
        result = await tool.execute(path=str(sample_file))
        assert "1| line 1" in result
        assert "20| line 20" in result

    @pytest.mark.asyncio
    async def test_offset_and_limit(self, tool, sample_file):
        result = await tool.execute(path=str(sample_file), offset=5, limit=3)
        assert "5| line 5" in result
        assert "7| line 7" in result
        assert "8| line 8" not in result
        assert "Use offset=8 to continue" in result

    @pytest.mark.asyncio
    async def test_offset_beyond_end(self, tool, sample_file):
        result = await tool.execute(path=str(sample_file), offset=999)
        assert "Error" in result
        assert "beyond end" in result

    @pytest.mark.asyncio
    async def test_end_of_file_marker(self, tool, sample_file):
        result = await tool.execute(path=str(sample_file), offset=1, limit=9999)
        assert "End of file" in result

    @pytest.mark.asyncio
    async def test_empty_file(self, tool, tmp_path):
        f = tmp_path / "empty.txt"
        f.write_text("", encoding="utf-8")
        result = await tool.execute(path=str(f))
        assert "Empty file" in result

    @pytest.mark.asyncio
    async def test_image_file_is_reported_as_binary(self, tool, tmp_path):
        f = tmp_path / "pixel.png"
        f.write_bytes(b"\x89PNG\r\n\x1a\nfake-png-data")

        result = await tool.execute(path=str(f))

        assert isinstance(result, str)
        assert "Cannot read binary file" in result

    @pytest.mark.asyncio
    async def test_file_not_found(self, tool, tmp_path):
        result = await tool.execute(path=str(tmp_path / "nope.txt"))
        assert "Error" in result
        assert "not found" in result


    @pytest.mark.asyncio
    async def test_missing_path_returns_clear_error(self, tool):
        result = await tool.execute()
        assert result == "Error reading file: Unknown path"

    @pytest.mark.asyncio
    async def test_large_file_comes_back_whole(self, tool, tmp_path):
        f = tmp_path / "big.txt"
        lines = [f"{n:05d}" + "x" * 294 for n in range(1, 1001)]
        f.write_text("\n".join(lines) + "\n", encoding="utf-8")
        assert len(f.read_text(encoding="utf-8")) == 300_000

        result = await tool.execute(path=str(f))

        assert result == "\n".join(f"{n}| {line}" for n, line in enumerate(lines, 1)) + (
            "\n\n(End of file - 1000 lines total)"
        )

    @pytest.mark.asyncio
    @pytest.mark.parametrize("following", ["", "\nsecond line"])
    async def test_long_first_line_comes_back_whole(self, tool, tmp_path, following):
        f = tmp_path / "minified.txt"
        line = "界" * 300_000 + "TAIL"
        original = line + following
        f.write_text(original, encoding="utf-8")

        with file_read_context("read-1", lambda: {}):
            first = await tool.execute(path=str(f), limit=1)

        assert first.split("\n\n")[0] == "1| " + line
        assert "truncated" not in first
        assert "column" not in tool.parameters["properties"]
        assert f.read_text(encoding="utf-8") == original

        with file_read_context("read-2", lambda: {"read-1": first}):
            repeated = await tool.execute(path=str(f), limit=1)
        assert "File unchanged" in repeated

        if following:
            assert "Use offset=2 to continue" in first
            with file_read_context("read-3", lambda: {"read-1": first}):
                second = await tool.execute(path=str(f), offset=2, limit=1)
            assert "2| second line" in second
            assert "End of file" in second
        else:
            assert "End of file" in first
            assert "Use offset=" not in first

    @pytest.mark.asyncio
    async def test_long_middle_line_does_not_stop_the_read(self, tool, tmp_path):
        f = tmp_path / "bundle.txt"
        middle = "z" * 300_000
        f.write_text("first\n" + middle + "\nlast\n")

        whole = await tool.execute(path=str(f))
        assert whole == f"1| first\n2| {middle}\n3| last\n\n(End of file - 3 lines total)"

        second = await tool.execute(path=str(f), offset=2, limit=1)
        assert second == f"2| {middle}\n\n(Showing lines 2-2 of 3. Use offset=3 to continue.)"

    @pytest.mark.asyncio
    async def test_oversized_file_is_rejected_before_read(self, tool, tmp_path, monkeypatch):
        f = tmp_path / "huge.txt"
        with f.open("wb") as stream:
            stream.truncate(ReadFileTool._MAX_FILE_SIZE_BYTES + 1)

        def fail_read_bytes(self):
            raise AssertionError("oversized file content should not be loaded")

        monkeypatch.setattr(type(f), "read_bytes", fail_read_bytes)

        result = await tool.execute(path=str(f))

        assert "File too large to read" in result
        assert "Maximum is 100 MiB" in result


# ---------------------------------------------------------------------------
# EditFileTool
# ---------------------------------------------------------------------------

class TestEditFileTool:

    @pytest.fixture()
    def tool(self, tmp_path):
        return EditFileTool(computer=LocalComputer(tmp_path))

    @pytest.mark.asyncio
    async def test_exact_match(self, tool, tmp_path):
        f = tmp_path / "a.py"
        f.write_text("hello world", encoding="utf-8")
        result = await tool.execute(path=str(f), old_text="world", new_text="earth")
        assert "Patch applied:" in result
        assert f.read_text() == "hello earth"

    @pytest.mark.asyncio
    async def test_identical_replacement_returns_clear_error(self, tool, tmp_path):
        f = tmp_path / "a.py"
        f.write_text("hello world", encoding="utf-8")

        result = await tool.execute(path=str(f), old_text="world", new_text="world")

        assert result == "Error: new_text must be different from old_text."
        assert f.read_text(encoding="utf-8") == "hello world"

    @pytest.mark.asyncio
    async def test_crlf_normalisation(self, tool, tmp_path):
        f = tmp_path / "crlf.py"
        f.write_bytes(b"line1\r\nline2\r\nline3")
        result = await tool.execute(
            path=str(f), old_text="line1\nline2", new_text="LINE1\nLINE2",
        )
        assert "Patch applied:" in result
        raw = f.read_bytes()
        assert b"LINE1" in raw
        # CRLF line endings should be preserved throughout the file
        assert b"\r\n" in raw

    @pytest.mark.asyncio
    async def test_trim_fallback(self, tool, tmp_path):
        f = tmp_path / "indent.py"
        f.write_text("    def foo():\n        pass\n", encoding="utf-8")
        result = await tool.execute(
            path=str(f), old_text="def foo():\n    pass", new_text="def bar():\n    return 1",
        )
        assert "Patch applied:" in result
        assert "bar" in f.read_text()

    @pytest.mark.asyncio
    async def test_ambiguous_match(self, tool, tmp_path):
        f = tmp_path / "dup.py"
        f.write_text("aaa\nbbb\naaa\nbbb\n", encoding="utf-8")
        result = await tool.execute(path=str(f), old_text="aaa\nbbb", new_text="xxx")
        assert "appears" in result.lower() or "Warning" in result

    @pytest.mark.asyncio
    async def test_replace_all(self, tool, tmp_path):
        f = tmp_path / "multi.py"
        f.write_text("foo bar foo bar foo", encoding="utf-8")
        result = await tool.execute(
            path=str(f), old_text="foo", new_text="baz", replace_all=True,
        )
        assert "Patch applied:" in result
        assert f.read_text() == "baz bar baz bar baz"

    @pytest.mark.asyncio
    async def test_not_found(self, tool, tmp_path):
        f = tmp_path / "nf.py"
        f.write_text("hello", encoding="utf-8")
        result = await tool.execute(path=str(f), old_text="xyz", new_text="abc")
        assert "Error" in result
        assert "not found" in result

    @pytest.mark.asyncio
    async def test_missing_new_text_returns_clear_error(self, tool, tmp_path):
        f = tmp_path / "a.py"
        f.write_text("hello", encoding="utf-8")
        result = await tool.execute(path=str(f), old_text="hello")
        assert result == "Error editing file: Unknown new_text"


# ---------------------------------------------------------------------------
# ListDirTool
# ---------------------------------------------------------------------------

class TestListDirTool:

    @pytest.fixture()
    def tool(self, tmp_path):
        return ListDirTool(computer=LocalComputer(tmp_path))

    @pytest.fixture()
    def populated_dir(self, tmp_path):
        (tmp_path / "src").mkdir()
        (tmp_path / "src" / "main.py").write_text("pass")
        (tmp_path / "src" / "utils.py").write_text("pass")
        (tmp_path / "README.md").write_text("hi")
        (tmp_path / ".git").mkdir()
        (tmp_path / ".git" / "config").write_text("x")
        (tmp_path / "node_modules").mkdir()
        (tmp_path / "node_modules" / "pkg").mkdir()
        return tmp_path

    @pytest.mark.asyncio
    async def test_basic_list(self, tool, populated_dir):
        result = await tool.execute(path=str(populated_dir))
        assert "README.md" in result
        assert "src" in result
        # .git and node_modules should be ignored
        assert ".git" not in result
        assert "node_modules" not in result

    @pytest.mark.asyncio
    async def test_recursive(self, tool, populated_dir):
        result = await tool.execute(path=str(populated_dir), recursive=True)
        # Normalize path separators for cross-platform compatibility
        normalized = result.replace("\\", "/")
        assert "src/main.py" in normalized
        assert "src/utils.py" in normalized
        assert "README.md" in result
        # Ignored dirs should not appear
        assert ".git" not in result
        assert "node_modules" not in result

    @pytest.mark.asyncio
    @pytest.mark.parametrize("relative_root", ["build", "build/project"])
    async def test_recursive_ignores_only_descendants(self, tool, tmp_path, relative_root):
        root = tmp_path / relative_root
        (root / "src").mkdir(parents=True)
        (root / "src" / "main.py").write_text("pass")
        (root / "README.md").write_text("hi")
        (root / ".git").mkdir()
        (root / ".git" / "config").write_text("ignored")
        (root / "src" / "node_modules").mkdir()
        (root / "src" / "node_modules" / "package.json").write_text("{}")

        result = await tool.execute(path=str(root), recursive=True)

        assert set(result.replace("\\", "/").splitlines()) == {
            "README.md", "src/", "src/main.py",
        }

    @pytest.mark.asyncio
    async def test_max_entries_truncation(self, tool, tmp_path):
        for i in range(10):
            (tmp_path / f"file_{i}.txt").write_text("x")
        result = await tool.execute(path=str(tmp_path), max_entries=3)
        assert "truncated" in result
        assert "3 of 10" in result

    @pytest.mark.asyncio
    async def test_empty_dir(self, tool, tmp_path):
        d = tmp_path / "empty"
        d.mkdir()
        result = await tool.execute(path=str(d))
        assert "empty" in result.lower()

    @pytest.mark.asyncio
    async def test_not_found(self, tool, tmp_path):
        result = await tool.execute(path=str(tmp_path / "nope"))
        assert "Error" in result
        assert "not found" in result

    @pytest.mark.asyncio
    async def test_missing_path_returns_clear_error(self, tool):
        result = await tool.execute()
        assert result == "Error listing directory: Unknown path"


# ---------------------------------------------------------------------------
# Paths: the workspace is a starting point, what dot may touch is the OS's call
# ---------------------------------------------------------------------------

class TestPathResolution:

    @pytest.mark.asyncio
    async def test_relative_paths_resolve_against_the_workspace(self, tmp_path):
        workspace = tmp_path / "ws"
        workspace.mkdir()
        (workspace / "notes.txt").write_text("in the workspace", encoding="utf-8")

        result = await ReadFileTool(computer=LocalComputer(tmp_path, workspace)).execute(path="notes.txt")

        assert "in the workspace" in result

    @pytest.mark.asyncio
    async def test_files_outside_the_workspace_are_reachable(self, tmp_path):
        workspace = tmp_path / "ws"
        workspace.mkdir()
        outside = tmp_path / "outside"
        outside.mkdir()
        (outside / "other.txt").write_text("elsewhere", encoding="utf-8")
        computer = LocalComputer(tmp_path, workspace)

        assert "elsewhere" in await ReadFileTool(computer=computer).execute(path=str(outside / "other.txt"))
        await WriteFileTool(computer=computer).execute(path=str(outside / "new.txt"), content="written")
        assert (outside / "new.txt").read_text(encoding="utf-8") == "written"
        edit = await EditFileTool(computer=computer).execute(
            path=str(outside / "new.txt"), old_text="written", new_text="edited",
        )
        assert "Error" not in edit
        assert (outside / "new.txt").read_text(encoding="utf-8") == "edited"

    @pytest.mark.asyncio
    async def test_a_directory_is_not_read_as_a_file(self, tmp_path):
        (tmp_path / "sub").mkdir()

        result = await ReadFileTool(computer=LocalComputer(tmp_path)).execute(path="sub")

        assert result.startswith("Error: Not a regular file")
