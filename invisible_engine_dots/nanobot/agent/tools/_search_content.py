"""Build one page of grep matches from streams of source lines."""

from __future__ import annotations

import re
from collections import deque
from dataclasses import dataclass, field
from itertools import chain, islice
from typing import Iterable


@dataclass(frozen=True, slots=True)
class SourceLine:
    """One text line of a searched file and its 1-based line number."""

    text: str
    line_no: int


def _format_line(line: SourceLine, is_match: bool) -> str:
    marker = ">" if is_match else " "
    return f"{marker} {line.line_no}| {line.text}"


def _format_header(path: str, line: SourceLine) -> str:
    return f"{path}:{line.line_no}"


@dataclass
class ContentPage:
    """Select matches and append only context not already present in the page."""

    limit: int | None
    offset: int
    blocks: list[list[str]] = field(default_factory=list, init=False)
    seen: int = field(default=0, init=False)
    returned: int = field(default=0, init=False)
    stopped: bool = field(default=False, init=False)

    def scan(
        self, path: str, lines: Iterable[SourceLine], regex: re.Pattern[str],
        before: int, after: int,
    ) -> None:
        source = iter(lines)
        history: deque[SourceLine] = deque(maxlen=before)
        following = deque(islice(source, after + 1))
        positions: dict[int, int] = {}
        while following:
            match = regex.search(following[0].text)
            if match is not None:
                self.seen += 1
                if self.seen > self.offset:
                    if self.limit is not None and self.returned >= self.limit:
                        self.stopped = True
                        return
                    self._append_match(path, history, following, positions)
            history.append(following.popleft())
            if (line := next(source, None)) is not None:
                following.append(line)

    def _append_match(
        self, path: str, history: deque[SourceLine],
        following: deque[SourceLine], positions: dict[int, int],
    ) -> None:
        match = following[0]
        last_line = next(reversed(positions), 0)
        first_line = history[0] if history else match
        merge = bool(positions and first_line.line_no <= last_line)
        if not merge:
            self.blocks.append([_format_header(path, match)])
            positions.clear()
        block = self.blocks[-1]
        # A match already on the page as the previous match's context is marked in place.
        if merge and match.line_no in positions:
            block[positions[match.line_no]] = _format_line(match, True)
        for line in chain(history, following):
            if not merge or line.line_no > last_line:
                positions[line.line_no] = len(block)
                block.append(_format_line(line, line is match))
        self.returned += 1

    def render(self, no_matches: str) -> tuple[str, str | None]:
        result = "\n\n".join("\n".join(block) for block in self.blocks) or no_matches
        if self.stopped:
            return result, (
                f"(pagination: limit={self.limit}, offset={self.offset}; "
                f"use offset={self.offset + self.returned} to continue)"
            )
        return result, f"(pagination: offset={self.offset})" if self.offset and self.blocks else None
