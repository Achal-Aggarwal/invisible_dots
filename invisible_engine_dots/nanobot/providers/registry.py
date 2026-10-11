"""Provider registry: the one provider the Dot's engine speaks to, OpenRouter.

``ProviderSpec`` describes how ``OpenAICompatProvider`` talks to a gateway. No
credential is ever read from the environment: the key reaches the provider as a
constructor argument, from the engine's memory.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ProviderSpec:
    """One LLM provider's metadata."""

    name: str  # e.g. "openrouter"
    display_name: str = ""
    default_api_base: str = ""  # OpenAI-compatible base URL for this provider
    is_gateway: bool = False  # routes any model (OpenRouter)

    # Provider supports cache_control on content blocks (Claude models behind a gateway).
    supports_prompt_caching: bool = False


OPENROUTER = ProviderSpec(
    name="openrouter",
    display_name="OpenRouter",
    default_api_base="https://openrouter.ai/api/v1",
    is_gateway=True,
    supports_prompt_caching=True,
)
