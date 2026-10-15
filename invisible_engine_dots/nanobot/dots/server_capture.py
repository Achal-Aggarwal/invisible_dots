"""What invisible-playwright-mcp tells a model, read from the server installed on this computer; printed as JSON.

The engine does not run this file: it has it run through the relay, as `dot`, by the interpreter of the installed
server (`server_interface.read_server_interface`), because only that interpreter can import the server's package.
It starts the server the way the engine starts it (`INVISIBLE_MCP_HOST_MANAGED=1`), asks `initialize` for the
version and the instructions and `tools/list` for the tools, and reads the sentences the engine recognizes in the
server's answers from the package's own constants (OPENED, NOT_OPEN, GONE, for the browser DEFAULT_BROWSER_ID).
Listing starts no browser.

The imports are inside `main`: the engine's own environment imports this module along with the rest of its
package, and it has neither the server nor the version of the MCP SDK the server was installed with.
"""

from __future__ import annotations


def main() -> None:
    import asyncio
    import json
    import os
    import sys

    from invisible_playwright_mcp.mcp import DEFAULT_BROWSER_ID, GONE, NOT_OPEN, OPENED
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    async def capture() -> dict:
        environment = {**os.environ, "INVISIBLE_MCP_HOST_MANAGED": "1"}
        server = StdioServerParameters(command=sys.executable, args=["-m", "invisible_playwright_mcp"], env=environment)
        async with stdio_client(server) as (read, write), ClientSession(read, write) as session:
            started = await session.initialize()
            listed = await session.list_tools()
        return {
            "package": "invisible-playwright-mcp",
            "version": started.serverInfo.version,
            "instructions": started.instructions or "",
            "browser": DEFAULT_BROWSER_ID,
            "answers": {"opened": OPENED, "not_open": NOT_OPEN, "gone": GONE},
            "tools": [
                {"name": tool.name, "description": tool.description, "inputSchema": tool.inputSchema}
                for tool in listed.tools
            ],
        }

    print(json.dumps(asyncio.run(capture()), ensure_ascii=False))


if __name__ == "__main__":
    main()
