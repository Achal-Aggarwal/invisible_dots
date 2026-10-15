"""The constants a host reads, as the real package exports them from `invisible_playwright_mcp.mcp`: here, the ones
the fixture interface records, so the fake answers with the sentences the engine is told to recognize."""

from fake_mcp_server import interface

_ANSWERS = interface()["answers"]

DEFAULT_BROWSER_ID = interface()["browser"]
OPENED = _ANSWERS["opened"]
NOT_OPEN = _ANSWERS["not_open"]
GONE = _ANSWERS["gone"]
