"""The OpenAI-compatible provider reads a model's limits from the providers OpenRouter lists for it, on every call."""

from __future__ import annotations

import socket
from collections.abc import AsyncIterator
from typing import Any

import pytest
from aiohttp import web

from nanobot.providers.base import ModelLimits
from nanobot.providers.openai_compat_provider import OpenAICompatProvider


def endpoint(provider: str, context: int | None, answer: int | None, status: int = 0) -> dict[str, Any]:
    return {"provider_name": provider, "context_length": context, "max_completion_tokens": answer, "status": status}


# As OpenRouter answered GET /models/z-ai/glm-5.3-flash/endpoints on 2026-10-12, a few of its 32 providers.
ENDPOINTS: dict[str, list[dict[str, Any]]] = {
    "z-ai/glm-5.3-flash": [
        endpoint("Reka", 262_144, 235_929),
        endpoint("Z.AI", 1_048_576, 131_072),
        endpoint("Fireworks", 1_048_576, 943_718),
        endpoint("Together", 1_048_575, 943_717),
        # A provider that is down does not count, however wide its window.
        endpoint("SiliconFlow", 2_000_000, 262_144, status=-5),
    ],
    "apodex/apodex-1.1-mini:free": [endpoint("Novita", 262_144, 235_929)],
    # A router chooses the model per request: OpenRouter lists no provider for it.
    "openrouter/auto": [],
}


class Models:
    def __init__(self) -> None:
        self.reads = 0

    async def endpoints(self, request: web.Request) -> web.Response:
        self.reads += 1
        model = request.match_info["model"]
        if model not in ENDPOINTS:
            return web.json_response({"error": {"message": "Not Found", "code": 404}}, status=404)
        return web.json_response({"data": {"id": model, "endpoints": ENDPOINTS[model]}})


@pytest.fixture
async def served() -> AsyncIterator[tuple[OpenAICompatProvider, Models]]:
    models = Models()
    app = web.Application()
    app.router.add_get("/api/v1/models/{model:.+}/endpoints", models.endpoints)
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    await web.TCPSite(runner, "127.0.0.1", port).start()
    provider = OpenAICompatProvider(api_key="sk-or-test", api_base=f"http://127.0.0.1:{port}/api/v1", provider_name="openrouter")
    try:
        yield provider, models
    finally:
        await runner.cleanup()


async def test_a_model_has_the_widest_window_of_the_providers_serving_it_and_the_longest_answer_at_that_window(
    served,
) -> None:
    provider, _ = served

    assert await provider.model_limits("z-ai/glm-5.3-flash") == ModelLimits(context_tokens=1_048_576, answer_tokens=943_718)
    assert await provider.model_limits("apodex/apodex-1.1-mini:free") == ModelLimits(
        context_tokens=262_144, answer_tokens=235_929
    )


async def test_the_limits_are_read_again_on_every_call_so_a_change_at_openrouter_is_seen(served) -> None:
    provider, models = served

    assert (await provider.model_limits("apodex/apodex-1.1-mini:free")).context_tokens == 262_144
    ENDPOINTS["apodex/apodex-1.1-mini:free"].append(endpoint("Fireworks", 524_288, 131_072))
    try:
        assert (await provider.model_limits("apodex/apodex-1.1-mini:free")).context_tokens == 524_288
    finally:
        ENDPOINTS["apodex/apodex-1.1-mini:free"].pop()
    assert models.reads == 2


async def test_a_router_has_unknown_limits(served) -> None:
    provider, _ = served

    assert await provider.model_limits("openrouter/auto") == ModelLimits()


async def test_a_model_openrouter_does_not_know_is_an_error(served) -> None:
    provider, _ = served

    with pytest.raises(LookupError, match="does not list the model no/such-model"):
        await provider.model_limits("no/such-model")
