"""What the Dot's browser server tells a model, read from the server installed on the Dot's computer.

The image installs the newest invisible-playwright-mcp when it is built, and a Dot keeps the image it was made from
while every start runs the newest engine, so the server an engine talks to is whichever its own computer has. The
engine therefore reads the server's interface from that server when it starts (`read_server_interface`), never from
a copy of its own: the page tools are offered with the names, descriptions and input schemas the installed server
serves, its instructions go into the system prompt, and the sentences the engine recognizes in its answers are the
installed package's own.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from nanobot.dots.computer import Computer, ComputerError

# Run by the installed server's interpreter, as dot, through the relay (server_capture.py says why).
CAPTURE_SCRIPT = Path(__file__).with_name("server_capture.py")

# The installed server's interpreter is the `python` of the environment its command lives in: the command is a
# console script of that environment, linked onto dot's PATH. Resolved as dot, so the engine reads nothing of dot's.
_RUN_WITH_SERVER_PYTHON = 'bin=$(dirname "$(readlink -f "$(command -v "$1")")") && exec "$bin/python" -I "$2"'

READ_TIMEOUT_S = 120.0


class ServerInterfaceError(Exception):
    """The installed server could not be read, or what it said is not an interface."""


@dataclass(frozen=True)
class ServerTool:
    """One tool of invisible-playwright-mcp as the server serves it: name, description, input schema."""

    name: str
    description: str
    input_schema: Mapping[str, Any]


@dataclass(frozen=True)
class ServerInterface:
    """The installed server's version, instructions, tools, and the answers the engine recognizes."""

    version: str
    instructions: str
    tools: Mapping[str, ServerTool]
    # What `browser_open`'s answer starts with when the browser started (the package's OPENED for its browser).
    opened: str
    # The server's whole error when its browser closed under it while the process lives on (NOT_OPEN and GONE),
    # behind the prefix FastMCP puts on what a tool raises. A phrase anywhere in a longer error is not it: a failed
    # click echoes text the page controls, and a page that says "the main browser is gone" must not close anything.
    browser_lost: re.Pattern[str]


def parse_server_interface(data: Any) -> ServerInterface:
    """The interface `server_capture.py` printed, checked; ServerInterfaceError names what is missing."""
    try:
        browser = data["browser"]
        answers = data["answers"]
        tools = {
            tool["name"]: ServerTool(
                tool["name"],
                tool.get("description") or tool["name"],
                tool.get("inputSchema") or {"type": "object", "properties": {}},
            )
            for tool in data["tools"]
        }
        return ServerInterface(
            version=str(data["version"]),
            instructions=data.get("instructions") or "",
            tools=tools,
            opened=answers["opened"] % browser,
            browser_lost=re.compile(
                r"(?:Error executing tool \w+: )?(?:"
                + "|".join(re.escape(answers[answer] % browser) for answer in ("not_open", "gone"))
                + ")"
            ),
        )
    except (KeyError, TypeError) as error:
        raise ServerInterfaceError(f"the server's interface lacks {error}") from error


async def read_server_interface(computer: Computer, mcp_command: str) -> ServerInterface:
    """Read the interface of the server `mcp_command` runs on `computer`, as dot, with the server's own interpreter."""
    argv = ["sh", "-c", _RUN_WITH_SERVER_PYTHON, "sh", mcp_command, str(CAPTURE_SCRIPT)]
    try:
        result = await computer.run(argv, timeout_s=READ_TIMEOUT_S)
    except (OSError, ComputerError) as error:
        # The relay itself did not run (no dot-agentd on this computer): the server cannot be read, for that reason.
        raise ServerInterfaceError(f"reading {mcp_command}: the relay did not run: {error}") from error
    if result.timed_out or result.exit_code != 0:
        why = "timed out" if result.timed_out else f"exited {result.exit_code}"
        detail = result.stderr.decode("utf-8", "replace").strip().splitlines()[-3:]
        raise ServerInterfaceError(f"reading {mcp_command} {why}: {' / '.join(detail) or 'no output'}")
    try:
        data = json.loads(result.stdout)
    except ValueError as error:
        raise ServerInterfaceError(f"reading {mcp_command} printed no interface: {error}") from error
    return parse_server_interface(data)
