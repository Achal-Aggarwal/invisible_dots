"""What the Dot's browser server tells a model, read from the server installed on the computer.

The engine reads it when it starts (server_interface.read_server_interface): server_capture.py run through the relay
by the installed server's own interpreter. Here the installed server is the fake, laid out like the real one
(fake_mcp_server.install_fake_mcp), so the read takes the same path as in a Dot.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fakes.fake_mcp_server import install_fake_mcp, interface, server_interface
from fakes.local_computer import LocalComputer

from nanobot.dots.server_interface import ServerInterfaceError, parse_server_interface, read_server_interface


async def test_the_interface_is_read_from_the_installed_server_through_its_own_interpreter(tmp_path: Path) -> None:
    read = await read_server_interface(LocalComputer(tmp_path), str(install_fake_mcp()))

    served = interface()
    assert read.version == served["version"]
    assert read.instructions == served["instructions"]
    assert set(read.tools) == {tool["name"] for tool in served["tools"]}
    for tool in served["tools"]:
        assert read.tools[tool["name"]].description == tool["description"]
        assert read.tools[tool["name"]].input_schema == tool["inputSchema"]
    assert read.opened == served["answers"]["opened"] % served["browser"]


async def test_a_command_that_is_not_an_installed_server_is_an_error_that_says_why(tmp_path: Path) -> None:
    with pytest.raises(ServerInterfaceError, match=r"reading /nowhere/invisible-playwright-mcp exited \d+"):
        await read_server_interface(LocalComputer(tmp_path), "/nowhere/invisible-playwright-mcp")


def test_what_is_not_an_interface_is_refused_naming_what_is_missing() -> None:
    data = interface()
    del data["answers"]
    with pytest.raises(ServerInterfaceError, match="answers"):
        parse_server_interface(data)


def test_the_browser_is_lost_only_on_the_servers_whole_sentence() -> None:
    """The engine closes an identity on these whole sentences, behind FastMCP's prefix or not; a phrase inside a
    longer error is page text (a failed click echoes what covers the element) and closes nothing."""
    lost = server_interface().browser_lost
    for answer in ("not_open", "gone"):
        sentence = interface()["answers"][answer] % interface()["browser"]
        assert lost.fullmatch(sentence)
        assert lost.fullmatch(f"Error executing tool browser_click: {sentence}")
        assert not lost.fullmatch(f"the element is covered by: {sentence}")


def test_the_fixture_is_of_a_server_started_as_the_engine_starts_it() -> None:
    """A capture of the default server would offer `browser` on every tool and tell the model to call browser_open,
    which it does not have: the engine starts the server with INVISIBLE_MCP_HOST_MANAGED=1, and so does the capture."""
    fixture = server_interface()
    assert "browser_open" not in fixture.instructions and "support" not in fixture.instructions
    assert not [name for name, tool in fixture.tools.items() if "browser" in tool.input_schema.get("properties", {})]
    assert fixture.opened == "the main browser is open."
