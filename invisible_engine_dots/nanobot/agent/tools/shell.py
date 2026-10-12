"""Shell execution tool through dot-agentd relay."""

from __future__ import annotations

import asyncio
import os
import shlex
from typing import Any

from loguru import logger

from nanobot.agent.tools.base import Tool, ToolResult, tool_parameters
from nanobot.agent.tools.context import current_request_session_key
from nanobot.agent.tools.exec_session import (
    DEFAULT_YIELD_MS,
    MAX_YIELD_MS,
    ExecSessionManager,
    clamp_session_int,
    format_session_poll,
)
from nanobot.agent.tools.schema import (
    BooleanSchema,
    IntegerSchema,
    StringSchema,
    tool_parameters_schema,
)
from nanobot.dots.computer import Computer, kill_process_group


def _reap_pid(pid: int) -> None:
    """Best-effort waitpid to reap a child process and prevent zombies."""
    waitpid = getattr(os, "waitpid", None)
    wnohang = getattr(os, "WNOHANG", None)
    if waitpid is None or wnohang is None:
        return
    try:
        waitpid(pid, wnohang)
    except (ProcessLookupError, ChildProcessError):
        pass
    except OSError as exc:
        logger.debug("_reap_pid({}): {}", pid, exc)


@tool_parameters(
    tool_parameters_schema(
        command=StringSchema("The shell command to execute"),
        cmd=StringSchema("Compatibility alias for command"),
        working_dir=StringSchema("Optional working directory for the command"),
        workdir=StringSchema("Compatibility alias for working_dir"),
        timeout=IntegerSchema(
            description="Hard timeout in seconds (default 60, max 600).",
            minimum=1,
            maximum=600,
        ),
        yield_time_ms=IntegerSchema(
            description="Return after this many milliseconds if still running; omit to wait for exit.",
            minimum=0,
            maximum=MAX_YIELD_MS,
            nullable=True,
        ),
        tty=BooleanSchema(
            description=(
                "Run on a pseudo-terminal, for programs that ask questions or need a terminal "
                "(REPLs, ssh, sudo prompts, installers). Implies a session: yield_time_ms applies, "
                "and exec_session reads, answers and ends it. What you send is echoed back, "
                "close_stdin sends ^D, and the single character with code 3 is ^C. "
                "The terminal is 80x24 and you get its text: colors and cursor moves are dropped, "
                "so full-screen programs (vim, htop) do not work."
            ),
            default=False,
        ),
    )
)
class ExecTool(Tool):
    """Run shell commands on the Dot's own computer, as user dot, through dot-agentd.

    The engine never runs the model's command itself: it starts `dot-agentd relay`,
    which runs the command as dot and ends it when the relay goes away.
    """

    _MAX_TIMEOUT = 600

    def __init__(
        self,
        computer: Computer,
        timeout: int = 60,
        session_manager: ExecSessionManager | None = None,
    ) -> None:
        self.computer = computer
        self.timeout = timeout
        self._session_manager = session_manager or ExecSessionManager()

    @property
    def name(self) -> str:
        return "exec"

    @property
    def description(self) -> str:
        return (
            "Run a shell command on the Dot's own Linux computer, as user dot, "
            "in /home/dot/workspace unless working_dir says otherwise."
        )

    def _resolve_timeout(self, timeout: int | None) -> int | None:
        """The hard timeout in seconds, None for no limit.

        A per-call timeout from the model stays capped at _MAX_TIMEOUT. The
        configured default (self.timeout) may exceed that cap, and 0 disables the
        limit for trusted long-running work.
        """
        if timeout:
            return min(timeout, self._MAX_TIMEOUT)
        if self.timeout and self.timeout > 0:
            return self.timeout
        return None

    @staticmethod
    async def _kill_process_tree(process: asyncio.subprocess.Process) -> None:
        """Kill the relay and its process group, then reap the relay.

        Killing the relay is what ends the remote command: dot-agentd kills the
        remote process group when the relay's connection closes.
        """
        try:
            await kill_process_group(process)
        finally:
            _reap_pid(process.pid)

    @staticmethod
    async def _spawn(
        computer: Computer,
        command: str | list[str],
        cwd: str,
        *,
        stdin: int = asyncio.subprocess.DEVNULL,
        tty: bool = False,
    ) -> asyncio.subprocess.Process:
        """Start `command` on the Dot's computer through the relay.

        The one spawn of the model's commands: exec and the exec sessions use it.
        `cwd` is an absolute path on the Dot's computer. The relay itself runs with
        PATH as its only variable (and TERM with a tty): no variable of the engine
        reaches the command, whose environment is its login shell's. With `tty` the
        command runs on a pseudo-terminal that dot-agentd allocates, and what it
        writes to stdout and stderr is one stream.
        """
        script = shlex.join(command) if isinstance(command, list) else command
        argv = computer.relay_argv(["/bin/bash", "-lc", script], cwd=cwd, tty=tty)
        return await asyncio.create_subprocess_exec(
            *argv,
            env=computer.spawn_env(tty=tty),
            stdin=stdin,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )

    async def execute(
        self,
        command: str | list[str] | None = None,
        cmd: str | None = None,
        working_dir: str | None = None,
        workdir: str | None = None,
        timeout: int | None = None,
        yield_time_ms: int | None = None,
        tty: bool = False,
        **kwargs: Any,
    ) -> str:
        command = command or cmd
        working_dir = working_dir or workdir
        if not command:
            return ToolResult.error("Error: Missing command. Provide command or cmd.")

        cwd = self.computer.resolve(working_dir or ".")
        effective_timeout = self._resolve_timeout(timeout)

        if yield_time_ms is not None or tty:
            # A terminal program is interactive: it always runs as a session that exec_session drives.
            return await self._execute_session(
                command, cwd, effective_timeout, yield_time_ms, tty
            )

        process: asyncio.subprocess.Process | None = None
        try:
            process = await self._spawn(self.computer, command, cwd)

            try:
                stdout, stderr = await asyncio.wait_for(
                    process.communicate(), timeout=effective_timeout
                )
            except asyncio.TimeoutError:
                await self._kill_process_tree(process)
                return ToolResult.error(
                    f"Error: Command timed out after {effective_timeout} seconds"
                )
            except asyncio.CancelledError:
                await self._kill_process_tree(process)
                raise

            # Safety-net reap: asyncio should have reaped the relay through
            # communicate(), but in containers the child watcher sometimes
            # misses it, leaving a zombie.
            _reap_pid(process.pid)

            output_parts: list[str] = []
            if stdout:
                output_parts.append(stdout.decode("utf-8", errors="replace"))
            if stderr:
                stderr_text = stderr.decode("utf-8", errors="replace")
                if stderr_text.strip():
                    output_parts.append(f"STDERR:\n{stderr_text}")
            output_parts.append(f"\nExit code: {process.returncode}")
            return "\n".join(output_parts)

        except Exception as e:
            # Kill and reap the relay if it started but an unexpected error
            # stopped communicate() from completing.
            if process is not None:
                await self._kill_process_tree(process)
            return ToolResult.error(f"Error executing command: {e}")

    async def _execute_session(
        self,
        command: str | list[str],
        cwd: str,
        timeout: int | None,
        yield_time_ms: int | None,
        tty: bool,
    ) -> str:
        try:
            session_id, poll = await self._session_manager.start(
                computer=self.computer,
                command=command,
                cwd=cwd,
                timeout=timeout,
                yield_time_ms=clamp_session_int(yield_time_ms, DEFAULT_YIELD_MS, 0, MAX_YIELD_MS),
                owner_session_key=current_request_session_key(),
                tty=tty,
            )
            result = format_session_poll(session_id, poll)
            return ToolResult.error(result) if poll.timed_out else result
        except Exception as exc:
            return ToolResult.error(f"Error executing command: {exc}")
