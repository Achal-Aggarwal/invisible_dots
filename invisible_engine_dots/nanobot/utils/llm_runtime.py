"""Immutable execution settings for one LLM turn."""

from __future__ import annotations

from dataclasses import dataclass, replace

from nanobot.providers.base import GenerationSettings, LLMProvider, ModelLimits


@dataclass(frozen=True, slots=True)
class LLMRuntime:
    """One captured provider/model configuration used for an entire execution.

    The provider itself is stateful, but all mutable selection and generation
    values are copied into this frozen value.  Consumers must use these fields
    instead of consulting ``provider.generation`` after admission.
    """

    provider: LLMProvider
    model: str
    generation: GenerationSettings
    # The model's context window, prompt and answer together; None when it is not known.
    context_window_tokens: int | None

    @classmethod
    def capture(
        cls,
        provider: LLMProvider,
        model: str,
        *,
        context_window_tokens: int | None,
    ) -> LLMRuntime:
        """Capture provider defaults without retaining mutable generation state."""
        defaults = GenerationSettings()
        generation = getattr(provider, "generation", defaults)
        return cls(
            provider=provider,
            model=model,
            generation=GenerationSettings(
                temperature=getattr(generation, "temperature", defaults.temperature),
                max_tokens=getattr(generation, "max_tokens", defaults.max_tokens),
            ),
            context_window_tokens=context_window_tokens,
        )

    @classmethod
    def at_model_limits(cls, provider: LLMProvider, model: str, limits: ModelLimits) -> LLMRuntime:
        """A runtime that uses the whole of what the model can do: its context window, and its longest answer
        as the answer's limit on every request (sent, so no provider default cuts it shorter)."""
        runtime = cls.capture(provider, model, context_window_tokens=limits.context_tokens)
        return replace(runtime, generation=replace(runtime.generation, max_tokens=limits.answer_tokens))
