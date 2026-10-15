"""A BrowserManager on a real store, a local computer and the fake MCP server, for the tests that need a browser."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fakes.fake_mcp_server import install_fake_mcp, server_interface

from nanobot.dots.browser import BrowserManager
from nanobot.dots.computer import Computer
from nanobot.dots.store import DotStore

# A retry that does not wait: the fake server answers at once.
FAST = {"open_retry_initial_s": 0.01, "open_retry_max_s": 0.02}


def mcp_home(tmp_path: Path, identity_id: str) -> Path:
    """Where the MCP server of an identity keeps its files: outside the browsers directory, as in a Dot."""
    return tmp_path / "mcp-homes" / identity_id


def make_browser_manager(tmp_path: Path, store: DotStore, computer: Computer, **options: Any) -> BrowserManager:
    """The browsers live under `tmp_path/browsers`, their MCP homes under `tmp_path/mcp-homes`, the MCP program is the fake one."""
    (tmp_path / "bin").mkdir(exist_ok=True)
    settings: dict[str, Any] = {
        "store": store,
        "computer": computer,
        "mcp_command": str(install_fake_mcp(tmp_path / "bin")),
        "interface": server_interface(),
        "max_open": 3,
        "max_identities": 20,
        "browsers_dir": str(tmp_path / "browsers"),
        "mcp_homes_dir": str(tmp_path / "mcp-homes"),
        **FAST,
        **options,
    }
    return BrowserManager(**settings)
