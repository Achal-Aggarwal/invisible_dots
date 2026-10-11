"""Session support for long-running exec workflows."""

from __future__ import annotations

import asyncio
import codecs
import shlex
import time
import uuid
from collections import deque
from contextlib import suppress
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from loguru import logger

from nanobot.agent.tools.base import Tool, ToolResult, tool_parameters
from nanobot.agent.tools.context import (
    current_request_session_key,
    tool_log_content_allowed,
)
from nanobot.agent.tools.schema import (
    BooleanSchema,
    IntegerSchema,
    StringSchema,
    tool_parameters_schema,
)

if TYPE_CHECKING:
    from nanobot.dots.computer import Computer

DEFAULT_YIELD_MS = 1000
MAX_YIELD_MS = 30_000
DEFAULT_WAIT_FOR_MS = 10_000
DEFAULT_UNTIL_EXIT_MS = 600_000
MAX_WAIT_FOR_MS = 600_000
DEFAULT_MAX_OUTPUT_CHARS = 10_000
MAX_OUTPUT_CHARS = 50_000
OUTPUT_DRAIN_GRACE_S = 0.1


_ESC = "\x1b"
# What a terminal session may hold back between two polls: the start of an escape sequence the
# program has not finished writing. A string (OSC, DCS...) that never ends is dropped past this.
MAX_PENDING_ESCAPE_CHARS = 4096
_STRING_INTRODUCERS = "]PX^_"
_CHARSET_INTRODUCERS = "()*+#%"


def _escape_end(text: str, start: int) -> int | None:
    """Where the escape sequence that starts at `text[start]` (an ESC) ends.

    None when `text` stops inside it. A sequence that turns out not to be one (a control
    character or another ESC right after the ESC) ends after the ESC alone, so what follows
    is read as text again.
    """
    length = len(text)
    if start + 1 >= length:
        return None
    introducer = text[start + 1]
    if introducer == "[":
        index = start + 2
        while index < length and "0" <= text[index] <= "?":  # parameter bytes
            index += 1
        while index < length and " " <= text[index] <= "/":  # intermediate bytes
            index += 1
        if index >= length:
            return None
        return index + 1 if "@" <= text[index] <= "~" else index
    if introducer in _STRING_INTRODUCERS:
        index = start + 2
        while index < length:
            char = text[index]
            if char == "\x07":
                return index + 1
            if char == _ESC:
                if index + 1 >= length:
                    return None
                return index + 2 if text[index + 1] == "\\" else index
            if char == "\n":
                return index
            index += 1
        return None
    if introducer in _CHARSET_INTRODUCERS:
        return start + 3 if start + 2 < length else None
    if introducer < " ":
        return start + 1
    return start + 2


def terminal_text(raw: str, *, final: bool = False) -> tuple[str, str]:
    """The text a terminal would show for what a program wrote, and what is still waiting.

    Escape sequences (colors, cursor moves, window titles) are dropped, `\\r\\n` is a line
    ending, a lone `\\r` and `\\b` move the cursor back so what is written next overwrites,
    and erase-in-line (`ESC [ K`) is honored: a progress bar reads as its last state. Other
    control characters are dropped. The screen is not modelled: a cursor move up or down,
    or a program that paints the whole screen (vim, htop), is not rendered.

    An escape sequence cut off by the end of `raw` is returned as the second value, to be put
    in front of the next chunk; `final` says there is no next chunk, so it is dropped. A line
    that continues in the next chunk is not overwritten by it: the text of each chunk stands
    alone.
    """
    out: list[str] = []
    line: list[str] = []
    column = 0
    pending = ""
    index = 0
    length = len(raw)
    while index < length:
        char = raw[index]
        if char == _ESC:
            end = _escape_end(raw, index)
            if end is None:
                if not final and length - index <= MAX_PENDING_ESCAPE_CHARS:
                    pending = raw[index:]
                break
            if raw.startswith("\x1b[", index) and raw[end - 1] == "K":
                mode = raw[index + 2 : end - 1]
                if mode in ("", "0"):
                    del line[column:]
                elif mode == "1":
                    line[: column + 1] = [" "] * min(column + 1, len(line))
                elif mode == "2":
                    line.clear()
            index = end
            continue
        index += 1
        if char == "\n":
            out.append("".join(line) + "\n")
            line = []
            column = 0
        elif char == "\r":
            column = 0
        elif char == "\b":
            column = max(0, column - 1)
        elif char == "\t" or (char >= " " and char != "\x7f" and not "\x80" <= char <= "\x9f"):
            if column > len(line):
                line.extend(" " * (column - len(line)))
            if column < len(line):
                line[column] = char
            else:
                line.append(char)
            column += 1
    out.append("".join(line))
    return "".join(out), pending


@dataclass(slots=True)
class _SessionPoll:
    output: str
    done: bool
    exit_code: int | None
    elapsed_s: float = 0.0
    timed_out: bool = False
    terminated: bool = False
    stdin_closed: bool = False
    truncated_chars: int = 0


@dataclass(slots=True)
class ExecSessionInfo:
    session_id: str
    command: str
    cwd: str
    elapsed_s: float
    idle_s: float
    remaining_s: float
    returncode: int | None
    owner_session_key: str | None = None
    tty: bool = False


class _BoundedOutputBuffer:
    """Keep the first and most recent characters within a fixed budget."""

    def __init__(self, max_chars: int) -> None:
        self.max_chars = max_chars
        self._content = ""
        self._tail: deque[str] = deque()
        self._tail_chars = 0
        self._total_chars = 0
        self._truncated = False

    @property
    def has_output(self) -> bool:
        return self._total_chars > 0

    @property
    def retained_chars(self) -> int:
        """How much the buffer holds now: never more than its bound, whatever was appended."""
        return len(self._content) + self._tail_chars

    def append(self, text: str) -> None:
        if not text:
            return
        self._total_chars += len(text)
        if not self._truncated:
            combined = self._content + text
            if len(combined) <= self.max_chars:
                self._content = combined
                return
            head_chars = self.max_chars // 2
            tail_chars = self.max_chars - head_chars
            self._content = combined[:head_chars]
            self._tail.append(combined[-tail_chars:])
            self._tail_chars = tail_chars
            self._truncated = True
            return

        tail_chars = self.max_chars - len(self._content)
        self._tail.append(text)
        self._tail_chars += len(text)
        while self._tail_chars > tail_chars:
            excess = self._tail_chars - tail_chars
            first = self._tail[0]
            if len(first) <= excess:
                self._tail.popleft()
                self._tail_chars -= len(first)
            else:
                self._tail[0] = first[excess:]
                self._tail_chars -= excess

    def drain(self) -> tuple[str, int]:
        output = self._content + "".join(self._tail)
        truncated_chars = self._total_chars - len(output)
        self._content = ""
        self._tail.clear()
        self._tail_chars = 0
        self._total_chars = 0
        self._truncated = False
        return output, truncated_chars


class _ExecSession:
    def __init__(
        self,
        *,
        session_id: str,
        process: asyncio.subprocess.Process,
        command: str,
        cwd: str,
        timeout: int | None,
        owner_session_key: str | None = None,
        tty: bool = False,
    ) -> None:
        self.session_id = session_id
        self.process = process
        self.command = command
        self.cwd = cwd
        self.owner_session_key = owner_session_key
        self.tty = tty
        # The end of an escape sequence the terminal program has not finished writing, kept for
        # the next poll (terminal_text).
        self._pending_escape = ""
        self.started_at = time.monotonic()
        # timeout None/0 means no limit; an infinite deadline is never reached.
        self.deadline = time.monotonic() + timeout if timeout else float("inf")
        self.last_access = time.monotonic()
        self._stdout = _BoundedOutputBuffer(MAX_OUTPUT_CHARS)
        self._stderr = _BoundedOutputBuffer(MAX_OUTPUT_CHARS)
        self._lock = asyncio.Lock()
        self._timed_out = False
        self._kill_task: asyncio.Task[None] | None = None
        self._stdout_task = asyncio.create_task(self._read_stream(process.stdout, self._stdout))
        self._stderr_task = asyncio.create_task(self._read_stream(process.stderr, self._stderr))
        self._timeout_task = asyncio.create_task(self._watch_timeout()) if timeout else None

    async def _watch_timeout(self) -> None:
        """Enforce the hard deadline even when nobody polls this session."""
        try:
            await asyncio.wait_for(
                self.process.wait(), timeout=max(0.0, self.deadline - time.monotonic()),
            )
        except asyncio.TimeoutError:
            if self.process.returncode is None:
                if self._kill_task is None:
                    self._timed_out = True
                # The kill callback logs failures; leave the session available for retry.
                with suppress(Exception):
                    await self.kill()

    async def _read_stream(
        self,
        stream: asyncio.StreamReader | None,
        buffer: _BoundedOutputBuffer,
    ) -> None:
        if stream is None:
            return
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        while True:
            chunk = await stream.read(4096)
            text = decoder.decode(chunk, final=not chunk)
            async with self._lock:
                buffer.append(text)
            if not chunk:
                break

    async def write(self, chars: str) -> str | None:
        if self.process.returncode is not None:
            return "session has already exited"
        if self.process.stdin is None:
            return "session stdin is not available"
        try:
            self.process.stdin.write(chars.encode("utf-8"))
            await self.process.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            return "session stdin is closed"
        return None

    async def close_stdin(self) -> str | None:
        if self.process.returncode is not None:
            return "session has already exited"
        if self.process.stdin is None:
            return "session stdin is not available"
        self.process.stdin.close()
        with suppress(BrokenPipeError, ConnectionResetError):
            await self.process.stdin.wait_closed()
        return None

    async def poll(
        self,
        yield_time_ms: int,
        max_output_chars: int,
        *,
        terminated: bool = False,
        stdin_closed: bool = False,
    ) -> _SessionPoll:
        self.last_access = time.monotonic()
        if yield_time_ms > 0 and self.process.returncode is None:
            wait_s = min(yield_time_ms, MAX_YIELD_MS) / 1000
            remaining_s = self.deadline - time.monotonic()
            if remaining_s <= 0:
                wait_s = 0
            else:
                wait_s = min(wait_s, remaining_s)
            if wait_s > 0:
                with suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(self.process.wait(), timeout=wait_s)

        if self.process.returncode is None and time.monotonic() >= self.deadline:
            if self._kill_task is None:
                self._timed_out = True
            await self.kill()

        if self._kill_task is not None:
            # Finish termination before returning output.
            await asyncio.shield(self._kill_task)

        if self.process.returncode is not None:
            with suppress(asyncio.TimeoutError):
                await asyncio.wait_for(
                    asyncio.gather(self._stdout_task, self._stderr_task),
                    timeout=2.0,
                )
            # Safety-net reap after normal exit.
            from nanobot.agent.tools.shell import _reap_pid  # pyright: ignore[reportPrivateUsage]

            _reap_pid(self.process.pid)
        elif yield_time_ms > 0:
            await self._wait_for_buffered_output()

        async with self._lock:
            stdout, stdout_truncated = self._stdout.drain()
            stderr, stderr_truncated = self._stderr.drain()
            if self.tty:
                # One stream: the relay reads the terminal's master, so stderr only carries the
                # relay's own messages, plain text. The stream's end flushes a cut sequence.
                ended = self.process.returncode is not None and self._stdout_task.done()
                stdout, self._pending_escape = terminal_text(
                    self._pending_escape + stdout, final=ended
                )

        output_parts = [stdout] if stdout else []
        if stderr:
            output_parts.append(f"STDERR:\n{stderr}")
        output = "\n".join(output_parts)
        output, response_truncated = _truncate_output(output, max_output_chars)
        return _SessionPoll(
            output=output,
            done=self.process.returncode is not None,
            exit_code=self.process.returncode,
            elapsed_s=max(0.0, time.monotonic() - self.started_at),
            timed_out=self._timed_out,
            terminated=terminated,
            stdin_closed=stdin_closed,
            truncated_chars=stdout_truncated + stderr_truncated + response_truncated,
        )

    async def kill(self) -> None:
        # A cancelled poll must not cancel the session's process-tree cleanup.
        if self._kill_task is None or (
            self._kill_task.done() and self.process.returncode is None
        ):
            self._kill_task = asyncio.create_task(self._kill())
            self._kill_task.add_done_callback(self._on_kill_done)
        await asyncio.shield(self._kill_task)

    def _on_kill_done(self, task: asyncio.Task[None]) -> None:
        error = None if task.cancelled() else task.exception()
        if error is not None:
            logger.opt(exception=error if tool_log_content_allowed() else False).error(
                "Failed to terminate exec session {}", self.session_id,
            )
        if (task.cancelled() or error is not None) and self._kill_task is task:
            self._kill_task = None

    async def _kill(self) -> None:
        from nanobot.agent.tools.shell import ExecTool

        try:
            await ExecTool._kill_process_tree(self.process)  # pyright: ignore[reportPrivateUsage]
        finally:
            with suppress(asyncio.TimeoutError):
                await asyncio.wait_for(
                    asyncio.gather(
                        self._stdout_task,
                        self._stderr_task,
                        return_exceptions=True,
                    ),
                    timeout=2.0,
                )

    async def _wait_for_buffered_output(self) -> None:
        deadline = time.monotonic() + OUTPUT_DRAIN_GRACE_S
        while time.monotonic() < deadline:
            async with self._lock:
                if self._stdout.has_output or self._stderr.has_output:
                    return
            await asyncio.sleep(0.01)


class ExecSessionManager:
    def __init__(self, *, max_sessions: int = 8, idle_timeout: int = 1800) -> None:
        self.max_sessions = max_sessions
        self.idle_timeout = idle_timeout
        self._sessions: dict[str, _ExecSession] = {}
        self._lock = asyncio.Lock()
        self._closed = False

    async def start(
        self,
        *,
        computer: Computer,
        command: str | list[str],
        cwd: str,
        timeout: int | None,
        yield_time_ms: int,
        max_output_chars: int,
        owner_session_key: str | None = None,
        tty: bool = False,
    ) -> tuple[str, _SessionPoll]:
        from nanobot.agent.tools.shell import ExecTool

        async with self._lock:
            if self._closed:
                raise RuntimeError("exec session manager is closed")
            await self._cleanup_locked()
            if len(self._sessions) >= self.max_sessions:
                raise RuntimeError(f"maximum exec sessions reached ({self.max_sessions})")
            process = await ExecTool._spawn(  # pyright: ignore[reportPrivateUsage]
                computer, command, cwd, stdin=asyncio.subprocess.PIPE, tty=tty
            )
            session_id = uuid.uuid4().hex[:12]
            session = _ExecSession(
                session_id=session_id,
                process=process,
                command=shlex.join(command) if isinstance(command, list) else command,
                cwd=cwd,
                timeout=timeout,
                owner_session_key=owner_session_key,
                tty=tty,
            )
            self._sessions[session_id] = session

        poll = await session.poll(yield_time_ms, max_output_chars)
        if poll.done:
            async with self._lock:
                self._sessions.pop(session_id, None)
        return session_id, poll

    async def write(
        self,
        *,
        session_id: str,
        chars: str | None,
        close_stdin: bool,
        terminate: bool,
        yield_time_ms: int,
        max_output_chars: int,
        owner_session_key: str | None = None,
    ) -> _SessionPoll:
        async with self._lock:
            await self._cleanup_locked()
            session = self._sessions.get(session_id)
        if session is None:
            raise KeyError(session_id)
        if session.owner_session_key and session.owner_session_key != owner_session_key:
            raise KeyError(session_id)

        if chars:
            error = await session.write(chars)
            if error:
                raise RuntimeError(error)
        stdin_closed = False
        if close_stdin:
            error = await session.close_stdin()
            if error:
                raise RuntimeError(error)
            stdin_closed = True
        if terminate:
            await session.kill()
        poll = await session.poll(
            yield_time_ms,
            max_output_chars,
            terminated=terminate,
            stdin_closed=stdin_closed,
        )
        if poll.done:
            async with self._lock:
                self._sessions.pop(session_id, None)
        return poll

    async def list(self, *, owner_session_key: str | None = None) -> list[ExecSessionInfo]:
        async with self._lock:
            await self._cleanup_locked()
            now = time.monotonic()
            return [
                ExecSessionInfo(
                    session_id=session_id,
                    command=session.command,
                    cwd=session.cwd,
                    elapsed_s=max(0.0, now - session.started_at),
                    idle_s=max(0.0, now - session.last_access),
                    remaining_s=max(0.0, session.deadline - now),
                    returncode=session.process.returncode,
                    owner_session_key=session.owner_session_key,
                    tty=session.tty,
                )
                for session_id, session in sorted(self._sessions.items())
                if session.owner_session_key == owner_session_key
            ]

    async def close_all(self) -> int:
        """Terminate and remove all active sessions during shutdown."""
        async with self._lock:
            self._closed = True
            sessions: list[_ExecSession] = list(self._sessions.values())
            self._sessions.clear()
        results: list[None | BaseException] = list(await asyncio.gather(
            *(session.kill() for session in sessions),
            return_exceptions=True,
        ))
        failures: list[tuple[_ExecSession, BaseException]] = [
            (session, result)
            for session, result in zip(sessions, results, strict=True)
            if isinstance(result, BaseException)
        ]
        if failures:
            async with self._lock:
                for session, _ in failures:
                    self._sessions[session.session_id] = session
            if len(failures) == 1:
                raise failures[0][1]
            raise BaseExceptionGroup(
                "failed to close exec sessions",
                [result for _, result in failures],
            )
        return len(sessions)

    async def _cleanup_locked(self) -> None:
        now = time.monotonic()
        stale = [
            session_id
            for session_id, session in self._sessions.items()
            if now - session.last_access > self.idle_timeout
        ]
        for session_id in stale:
            session = self._sessions[session_id]
            await session.kill()
            self._sessions.pop(session_id, None)


def clamp_session_int(value: int | None, default: int, minimum: int, maximum: int) -> int:
    if value is None:
        return default
    return min(max(value, minimum), maximum)


def _truncate_output(output: str, max_output_chars: int) -> tuple[str, int]:
    if len(output) <= max_output_chars:
        return output, 0
    head_chars = max_output_chars // 2
    tail_chars = max_output_chars - head_chars
    omitted = len(output) - max_output_chars
    return output[:head_chars] + output[-tail_chars:], omitted


def format_session_poll(session_id: str, poll: _SessionPoll) -> str:
    parts = [poll.output] if poll.output else []
    if poll.truncated_chars:
        parts.append(f"({poll.truncated_chars:,} chars truncated from output)")
    if poll.timed_out:
        parts.append("Error: Command timed out; session was terminated.")
    if poll.terminated and not poll.timed_out:
        parts.append("Session terminated.")
    if poll.stdin_closed:
        parts.append("Stdin closed.")
    if poll.done:
        parts.append(f"Exit code: {poll.exit_code}")
    else:
        parts.append(f"Process running. session_id: {session_id}")
    parts.append(f"Elapsed: {poll.elapsed_s:.1f}s")
    return "\n".join(parts) if parts else "(no output yet)"


@tool_parameters(
    tool_parameters_schema(
        session_id=StringSchema("Session ID returned by exec."),
        input=StringSchema(
            "Text to send to stdin; omit to poll output.",
            nullable=True,
        ),
        close_stdin=BooleanSchema(
            description="Close stdin after sending input.",
            default=False,
        ),
        terminate=BooleanSchema(
            description="Terminate the session; use alone.",
            default=False,
        ),
        wait_for=StringSchema(
            "Return when this text appears in output.",
            min_length=1,
            nullable=True,
        ),
        until_exit=BooleanSchema(
            description="Wait for the process to exit.",
            default=False,
        ),
        timeout_ms=IntegerSchema(
            description="Maximum wait: 1s normally, 10s for wait_for, 10m for until_exit.",
            minimum=0,
            maximum=MAX_WAIT_FOR_MS,
            nullable=True,
        ),
        required=["session_id"],
    )
)
class ExecSessionTool(Tool):
    """Interact with or wait for a running exec session."""

    def __init__(
        self,
        *,
        manager: ExecSessionManager,
    ) -> None:
        self._manager = manager

    @property
    def name(self) -> str:
        return "exec_session"

    @property
    def description(self) -> str:
        return "Manage a session returned by exec."

    async def execute(  # pyright: ignore[reportIncompatibleMethodOverride]
        self,
        session_id: str,
        input: str | None = None,
        close_stdin: bool = False,
        terminate: bool = False,
        wait_for: str | None = None,
        until_exit: bool = False,
        timeout_ms: int | None = None,
        **kwargs: Any,
    ) -> str:
        try:
            if wait_for == "":
                return ToolResult.error("Error: wait_for must not be empty.")
            if wait_for is not None and until_exit:
                return ToolResult.error(
                    "Error: wait_for and until_exit are mutually exclusive."
                )
            if terminate:
                if any(
                    (
                        input is not None,
                        close_stdin,
                        wait_for is not None,
                        until_exit,
                        timeout_ms is not None,
                    )
                ):
                    return ToolResult.error("Error: terminate must be used alone.")
                poll = await self._manager.write(
                    session_id=session_id,
                    chars=None,
                    close_stdin=False,
                    terminate=True,
                    yield_time_ms=0,
                    max_output_chars=DEFAULT_MAX_OUTPUT_CHARS,
                    owner_session_key=current_request_session_key(),
                )
                result = format_session_poll(session_id, poll)
                return ToolResult.error(result) if poll.timed_out else result

            default_timeout_ms = (
                DEFAULT_UNTIL_EXIT_MS
                if until_exit
                else DEFAULT_WAIT_FOR_MS
                if wait_for is not None
                else DEFAULT_YIELD_MS
            )
            return await self._wait(
                session_id=session_id,
                input=input,
                close_stdin=close_stdin,
                wait_for=wait_for,
                until_exit=until_exit,
                timeout_ms=clamp_session_int(
                    timeout_ms,
                    default_timeout_ms,
                    0,
                    MAX_WAIT_FOR_MS,
                ),
            )
        except KeyError:
            return ToolResult.error(f"Error: exec session not found: {session_id!r}")
        except Exception as exc:
            return ToolResult.error(f"Error managing exec session: {exc}")

    async def _wait(
        self,
        *,
        session_id: str,
        input: str | None,
        close_stdin: bool,
        wait_for: str | None,
        until_exit: bool,
        timeout_ms: int,
    ) -> str:
        deadline = time.monotonic() + (timeout_ms / 1000)
        aggregate = _BoundedOutputBuffer(DEFAULT_MAX_OUTPUT_CHARS)
        upstream_truncated = 0
        search_overlap = ""
        first = True
        matched = False

        while True:
            remaining_ms = max(0, int((deadline - time.monotonic()) * 1000))
            step_ms = min(MAX_YIELD_MS if until_exit else 500, remaining_ms)
            poll = await self._manager.write(
                session_id=session_id,
                chars=input if first else None,
                close_stdin=close_stdin if first else False,
                terminate=False,
                yield_time_ms=step_ms,
                max_output_chars=MAX_OUTPUT_CHARS,
                owner_session_key=current_request_session_key(),
            )
            first = False
            upstream_truncated += poll.truncated_chars
            if poll.output:
                aggregate.append(poll.output)
                if wait_for is not None:
                    searchable = search_overlap + poll.output
                    matched = wait_for in searchable
                    overlap_chars = len(wait_for) - 1
                    search_overlap = searchable[-overlap_chars:] if overlap_chars else ""

            expired = time.monotonic() >= deadline
            has_activity = wait_for is None and not until_exit and bool(poll.output)
            if poll.done or matched or has_activity or expired:
                poll.output, aggregate_truncated = aggregate.drain()
                poll.truncated_chars = upstream_truncated + aggregate_truncated
                result = format_session_poll(session_id, poll)
                if wait_for is not None and not matched:
                    result += f"\nWait target not observed: {wait_for!r}"
                elif until_exit and not poll.done:
                    result += (
                        f"\nWait timed out after {timeout_ms / 1000:g}s; "
                        "session remains active."
                    )
                return ToolResult.error(result) if poll.timed_out else result


@tool_parameters(tool_parameters_schema())
class ListExecSessionsTool(Tool):
    """List active exec sessions."""

    def __init__(
        self,
        *,
        manager: ExecSessionManager,
    ) -> None:
        self._manager = manager

    @property
    def name(self) -> str:
        return "list_exec_sessions"

    @property
    def description(self) -> str:
        return "List active exec sessions."

    async def execute(self, **kwargs: Any) -> str:
        try:
            sessions = await self._manager.list(
                owner_session_key=current_request_session_key(),
            )
            if not sessions:
                return "No active exec sessions."
            lines: list[str] = []
            for info in sessions:
                command = " ".join(info.command.split())
                if len(command) > 120:
                    command = command[:119] + "..."
                status = "exited" if info.returncode is not None else "running"
                if info.tty:
                    status += " | tty"
                lines.append(
                    f"{info.session_id} | {status} | elapsed={info.elapsed_s:.1f}s "
                    f"| idle={info.idle_s:.1f}s | remaining={info.remaining_s:.1f}s "
                    f"| cwd={info.cwd} | {command}"
                )
            return "\n".join(lines)
        except Exception as exc:
            return ToolResult.error(f"Error listing exec sessions: {exc}")
