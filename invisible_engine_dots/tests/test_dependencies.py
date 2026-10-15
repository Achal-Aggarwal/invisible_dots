"""The declared dependencies are exactly what the engine imports.

A dependency nobody imports is attack surface in the Dot's golden image, and an
import nobody declares is a crash on a clean install. This test collects the
top-level third-party imports of every module under ``nanobot/`` and compares
them, in both directions, with ``[project].dependencies`` of ``pyproject.toml``.
"""

from __future__ import annotations

import ast
import re
import sys
import tomllib
from pathlib import Path

import pytest

ENGINE_ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ENGINE_ROOT / "nanobot"

# Import name -> distribution name, for the imports whose two names differ.
# Every other import name is its own distribution name.
IMPORT_TO_DISTRIBUTION = {
    "json_repair": "json-repair",
    "yaml": "pyyaml",
    "dateutil": "python-dateutil",
}

# Distributions the engine needs at runtime without any module importing them.
RUNTIME_ONLY = {
    # zoneinfo falls back to this package when the host has no IANA timezone
    # database; the cron tool and croniter resolve timezones through zoneinfo.
    "tzdata": "zoneinfo's fallback timezone database",
}


# Modules of the package another interpreter runs, with the distributions that interpreter has and the engine does
# not: server_capture.py is run by the python of the installed invisible-playwright-mcp (server_interface.py).
OTHER_INTERPRETER = {
    "nanobot/dots/server_capture.py": {"invisible-playwright-mcp"},
}


def _normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def _declared() -> set[str]:
    pyproject = tomllib.loads((ENGINE_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    names: set[str] = set()
    for requirement in pyproject["project"]["dependencies"]:
        match = re.match(r"[A-Za-z0-9][A-Za-z0-9._-]*", requirement)
        assert match is not None, f"unparsable requirement: {requirement!r}"
        names.add(_normalize(match.group(0)))
    return names


def _imported() -> dict[str, set[str]]:
    """Distribution name -> the modules that import it."""
    found: dict[str, set[str]] = {}
    for path in sorted(PACKAGE.rglob("*.py")):
        tree = ast.parse(path.read_bytes(), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                tops = [alias.name.split(".")[0] for alias in node.names]
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                tops = [node.module.split(".")[0]]
            else:
                continue
            module = path.relative_to(ENGINE_ROOT).as_posix()
            for top in tops:
                if top in sys.stdlib_module_names or top == "nanobot":
                    continue
                distribution = _normalize(IMPORT_TO_DISTRIBUTION.get(top, top))
                if distribution in OTHER_INTERPRETER.get(module, set()):
                    continue
                found.setdefault(distribution, set()).add(module)
    return found


def test_every_import_is_declared() -> None:
    undeclared = {
        name: sorted(modules)
        for name, modules in _imported().items()
        if name not in _declared()
    }
    assert not undeclared, f"imported but not in [project].dependencies: {undeclared}"


def test_every_declared_dependency_is_imported() -> None:
    unused = _declared() - set(_imported()) - {_normalize(name) for name in RUNTIME_ONLY}
    assert not unused, f"declared in [project].dependencies but imported by no module: {sorted(unused)}"


def test_runtime_only_entries_are_declared() -> None:
    declared = _declared()
    missing = {_normalize(name) for name in RUNTIME_ONLY} - declared
    assert not missing, f"RUNTIME_ONLY names a distribution pyproject.toml does not declare: {sorted(missing)}"


@pytest.mark.parametrize(
    "gone",
    [
        "typer", "anthropic", "pydantic-settings", "websockets", "cryptography", "ddgs",
        "oauth-cli-kit", "readability-lxml", "lxml-html-clean", "rich", "qrcode",
        "prompt-toolkit", "setproctitle", "questionary", "dulwich", "watchfiles",
        "packaging", "defusedxml", "pypdf", "python-docx", "openpyxl", "python-pptx",
        "chardet", "pyyaml", "tzlocal",
    ],
)
def test_deleted_features_leave_no_dependency(gone: str) -> None:
    assert _normalize(gone) not in _declared()


# The only browser of a Dot is invisible-playwright-mcp, which the BrowserManager runs as a separate process
# in the Dot's own computer. Nothing in the engine, or in what it installs, browses or fetches the web another
# way: no browser, no browser-automation or scraping library, no web search or page-reading package.
OTHER_BROWSERS = {
    "playwright", "patchright", "selenium", "seleniumbase", "undetected-chromedriver", "chromedriver-py",
    "pyppeteer", "puppeteer", "splinter", "mechanize", "mechanicalsoup", "requests-html", "helium",
    "camoufox", "zendriver", "nodriver", "drissionpage", "browser-use", "scrapy", "trafilatura", "newspaper3k",
    "ddgs", "duckduckgo-search", "googlesearch-python", "readability-lxml", "html2text", "beautifulsoup4", "lxml",
}


def test_no_other_browser_or_web_library_is_declared_or_imported() -> None:
    refused = {_normalize(name) for name in OTHER_BROWSERS}
    assert not refused & _declared(), sorted(refused & _declared())
    assert not refused & set(_imported()), {name: modules for name, modules in _imported().items() if name in refused}
