"""The projection of the pushed Dot config into what the engine runs with."""

from __future__ import annotations

import dataclasses
from collections.abc import Callable
from typing import Any

import pytest

from nanobot.dots.permissions import TOOL_PERMISSIONS
from nanobot.dots.projection import (
    EngineSettings,
    dot_prompt_section,
    project,
)
from nanobot.dots.protocol import DotRuntimeConfig, parse_runtime_config

WORKSPACE = "/home/dot/workspace"


def settings(config: DotRuntimeConfig, base_url: str | None = None) -> EngineSettings:
    return project(config, workspace=WORKSPACE, openrouter_base_url=base_url)


def test_names_the_model_the_workspace_and_maps_the_limits(make_config: Callable[..., DotRuntimeConfig]) -> None:
    result = settings(make_config({}))
    assert result.model_id == "z-ai/glm-5.3-flash"
    assert result.workspace == WORKSPACE
    assert result.max_iterations == 60
    assert result.max_cost_usd == 1
    # The context window is the model's own (OpenRouter's), read by the turn: the settings name none.
    assert not hasattr(result, "context_window_tokens")
    # Nor a fixed cut of a tool's result: what the window leaves decides it (ContextGovernor.result_room).
    assert not hasattr(result, "max_tool_result_chars")


def test_the_summary_role_names_a_model_and_defaults_to_the_dots_own(
    config_body: Callable[..., dict[str, Any]],
) -> None:
    plain = settings(parse_runtime_config(config_body()))
    assert plain.models == ()
    assert plain.model_for("summary") == plain.model_id == "z-ai/glm-5.3-flash"

    named = settings(parse_runtime_config(config_body(models={"summary": "openai/gpt-5-mini"})))
    assert named.models == (("summary", "openai/gpt-5-mini"),)
    assert named.model_for("summary") == "openai/gpt-5-mini"
    assert named.model_id == "z-ai/glm-5.3-flash"


def test_asking_for_a_role_there_is_not_is_an_error_not_the_dots_model(
    config_body: Callable[..., dict[str, Any]],
) -> None:
    result = settings(parse_runtime_config(config_body(models={"summary": "a/b"})))
    with pytest.raises(ValueError, match="unknown model role"):
        result.model_for("fast")


def test_the_limits_follow_the_config(config_body: Callable[..., dict[str, Any]]) -> None:
    body = config_body()
    body["limits"].update(max_steps_per_task=7, max_cost_per_task_usd=0.25)
    result = settings(parse_runtime_config(body))
    assert (result.max_iterations, result.max_cost_usd) == (7, 0.25)


def test_offers_the_model_only_the_tools_whose_permission_is_not_denied(make_config: Callable[..., DotRuntimeConfig]) -> None:
    result = settings(
        make_config({"computer.exec": "ask", "files.read": "allow", "files.write": "deny", "automations": "ask"})
    )
    assert result.offered_tools == (
        "cron",
        "exec",
        "exec_session",
        "find_files",
        "grep",
        "list_dir",
        "list_exec_sessions",
        "read_file",
    )
    assert settings(make_config({"files.write": "deny"})).offered_tools == ()
    assert settings(make_config({})).offered_tools == ()


def test_offers_nothing_outside_the_permission_table(make_config: Callable[..., DotRuntimeConfig]) -> None:
    everything = {permission: "allow" for permission in {e.permission for e in TOOL_PERMISSIONS.values()}}
    assert set(settings(make_config(everything)).offered_tools) == set(TOOL_PERMISSIONS)
    assert settings(make_config({"web.fetch": "allow", "subagents": "allow"})).offered_tools == ()


def test_points_openrouter_at_a_stand_in_only_when_told_to(make_config: Callable[..., DotRuntimeConfig]) -> None:
    config = make_config({})
    assert settings(config).openrouter_base_url is None
    assert settings(config, "").openrouter_base_url is None
    assert settings(config, "   ").openrouter_base_url is None
    assert settings(config, " http://127.0.0.1:9/api/v1 ").openrouter_base_url == "http://127.0.0.1:9/api/v1"


def test_the_projection_is_pure_and_the_settings_are_frozen(make_config: Callable[..., DotRuntimeConfig]) -> None:
    config = make_config({"files.read": "allow"})
    first, second = settings(config), settings(config)
    assert first == second
    assert hash(first) == hash(second)
    with pytest.raises(dataclasses.FrozenInstanceError):
        first.model_id = "other"  # type: ignore[misc]
    assert config.permissions == {"files.read": "allow"}


def test_the_prompt_section_names_the_dot(make_config: Callable[..., DotRuntimeConfig]) -> None:
    assert dot_prompt_section(make_config({})) == 'You are the Dot "fare-watch".'


def test_the_prompt_section_carries_the_instructions_when_there_are_some(
    config_body: Callable[..., dict[str, Any]],
) -> None:
    config = parse_runtime_config(config_body(instructions="  Be brief.\nNo emoji.  "))
    assert dot_prompt_section(config) == (
        'You are the Dot "fare-watch".\n'
        "\n"
        "Instructions from the person who owns you:\n"
        "Be brief.\nNo emoji."
    )


@pytest.mark.parametrize("instructions", [None, "", "  \n "])
def test_blank_instructions_add_nothing(config_body: Callable[..., dict[str, Any]], instructions: str | None) -> None:
    config = parse_runtime_config(config_body(instructions=instructions) if instructions is not None else config_body())
    assert "Instructions" not in dot_prompt_section(config)


def test_the_settings_carry_the_prompt_section_of_the_config(make_config: Callable[..., DotRuntimeConfig]) -> None:
    config = make_config({})
    assert settings(config).dot_prompt == dot_prompt_section(config)
