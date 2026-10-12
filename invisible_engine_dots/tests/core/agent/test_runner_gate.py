"""The policy gate at the execution boundary, and what the runner hands the checkpoint callback."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from fakes.allow_all_gate import AllowAllGate

from agent.runner_helpers import ScriptedTools, make_run_spec
from nanobot.agent.hook import AgentHook, AgentHookContext
from nanobot.agent.runner import AgentRunner, AgentRunSpec
from nanobot.agent.tools.base import Tool, ToolResult
from nanobot.agent.tools.execution import STATUS_PARKED, STATUS_SKIPPED, execute_tool_calls
from nanobot.agent.tools.gate_types import SKIPPED_MESSAGE, Allow, Deny, GateCall, Park, ToolGate
from nanobot.agent.tools.registry import ToolRegistry
from nanobot.agent.transcript_metadata import IS_ERROR, METADATA_KEY
from nanobot.dots.gate import park_message
from nanobot.providers.base import LLMProvider, LLMResponse, ToolCallRequest

ALLOW = Allow("files.read", "allow")


def park(approval_id: str = "appr_1") -> Park:
    return Park("files.write", approval_id, park_message(approval_id))


class RecordingGate:
    """A gate that answers from a table (Allow when a call is not in it) and remembers what it was asked."""

    def __init__(self, decisions: dict[str, Allow | Deny | Park] | None = None, log: list[str] | None = None) -> None:
        self.decisions = decisions or {}
        self.calls: list[GateCall] = []
        self.skipped: list[str] = []
        self.log = log if log is not None else []

    def decide(self, call: GateCall) -> Allow | Deny | Park:
        self.calls.append(call)
        self.log.append(f"decide:{call.tool_call_id}")
        return self.decisions.get(call.tool_call_id or "", ALLOW)

    def skip(self, tool_call_id: str, session_key: str | None) -> None:
        self.skipped.append(tool_call_id)


class CountTool(Tool):
    """A tool whose count parameter is cast from text, so the gate can be seen to get the cast value."""

    def __init__(self, log: list[str], *, name: str = "count") -> None:
        self._name = name
        self.log = log
        self.executed: list[dict[str, Any]] = []

    @property
    def name(self) -> str:
        return self._name

    @property
    def description(self) -> str:
        return "counts"

    @property
    def parameters(self) -> dict[str, Any]:
        return {"type": "object", "properties": {"count": {"type": "integer"}}, "required": ["count"]}

    async def execute(self, **kwargs: Any) -> str:
        self.executed.append(kwargs)
        self.log.append(f"run:{kwargs['count']}")
        return f"counted {kwargs['count']}"


class RecordingHook(AgentHook):
    def __init__(self, log: list[str]) -> None:
        super().__init__()
        self.log = log

    async def before_execute_tool(self, context: Any, tool_call: ToolCallRequest, tool: Any, params: Any) -> None:
        self.log.append(f"before:{tool_call.id}")

    async def after_execute_tool(
        self, context: Any, tool_call: ToolCallRequest, tool: Any, params: Any, result: Any
    ) -> None:
        self.log.append(f"after:{tool_call.id}")


def registry_of(*tools: Tool) -> ToolRegistry:
    registry = ToolRegistry()
    for tool in tools:
        registry.register(tool)
    return registry


def request(call_id: str, name: str = "count", **arguments: Any) -> ToolCallRequest:
    return ToolCallRequest(id=call_id, name=name, arguments=arguments or {"count": 1})


async def execute(
    tools: ToolRegistry,
    calls: list[ToolCallRequest],
    gate: ToolGate,
    *,
    hook: AgentHook | None = None,
    on_result: Any = None,
) -> tuple[list[Any], list[dict[str, str]]]:
    return await execute_tool_calls(
        tools,
        calls,
        hook=hook or AgentHook(),
        context=AgentHookContext(iteration=0, messages=[], session_key="s1"),
        gate=gate,
        on_result=on_result,
    )


class TestTheGateAtTheBoundary:
    async def test_it_decides_on_the_final_arguments_before_the_hook_and_the_tool(self) -> None:
        log: list[str] = []
        tool = CountTool(log)
        gate = RecordingGate(log=log)

        results, events = await execute(
            registry_of(tool), [request("c1", count="3")], gate, hook=RecordingHook(log)
        )

        (seen,) = gate.calls
        assert seen == GateCall("count", {"count": 3}, "c1", "s1")
        assert log == ["decide:c1", "before:c1", "run:3", "after:c1"]
        assert results == ["counted 3"] and events[0]["status"] == "ok"

    async def test_a_denied_call_does_not_run_and_the_reason_is_final(self) -> None:
        log: list[str] = []
        tool = CountTool(log)
        gate = RecordingGate({"c1": Deny("files.write", "The Dot's policy denies files.write.")}, log)

        results, events = await execute(registry_of(tool), [request("c1")], gate, hook=RecordingHook(log))

        assert tool.executed == []
        assert log == ["decide:c1"]
        assert results == ["The Dot's policy denies files.write."]
        assert isinstance(results[0], ToolResult) and results[0].is_error
        assert "try a different approach" not in results[0]
        assert events[0]["status"] == "error"

    async def test_a_call_that_does_not_prepare_never_reaches_the_gate(self) -> None:
        log: list[str] = []
        gate = RecordingGate(log=log)

        results, events = await execute(
            registry_of(CountTool(log)),
            [request("c1", "nonexistent"), request("c2", count="not a number")],
            gate,
        )

        assert gate.calls == []
        assert "not found" in results[0] and "Invalid parameters" in results[1]
        assert [event["status"] for event in events] == ["error", "error"]

    async def test_a_parked_call_ends_the_round_and_the_calls_after_it_say_so(self) -> None:
        log: list[str] = []
        tool = CountTool(log)
        gate = RecordingGate({"c2": park("appr_2")}, log)
        seen: list[tuple[str, Any, str]] = []

        async def on_result(tool_call: ToolCallRequest, result: Any, event: dict[str, str]) -> None:
            seen.append((tool_call.id, result, event["status"]))

        results, events = await execute(
            registry_of(tool),
            [request("c1", count=1), request("c2", count=2), request("c3", count=3), request("c4", count=4)],
            gate,
            hook=RecordingHook(log),
            on_result=on_result,
        )

        assert [e["status"] for e in events] == ["ok", STATUS_PARKED, STATUS_SKIPPED, STATUS_SKIPPED]
        assert results == ["counted 1", park_message("appr_2"), SKIPPED_MESSAGE, SKIPPED_MESSAGE]
        assert tool.executed == [{"count": 1}]
        assert gate.skipped == ["c3", "c4"]
        # The skipped calls were not decided and nothing about them ran.
        assert [c.tool_call_id for c in gate.calls] == ["c1", "c2"]
        assert log == ["decide:c1", "before:c1", "run:1", "after:c1", "decide:c2"]
        assert [(call_id, status) for call_id, _result, status in seen] == [
            ("c1", "ok"),
            ("c2", STATUS_PARKED),
            ("c3", STATUS_SKIPPED),
            ("c4", STATUS_SKIPPED),
        ]

    async def test_a_result_is_reported_before_the_next_call_runs(self) -> None:
        log: list[str] = []
        tool = CountTool(log)

        async def on_result(tool_call: ToolCallRequest, result: Any, event: dict[str, str]) -> None:
            log.append(f"result:{tool_call.id}")

        await execute(
            registry_of(tool), [request("a", count=1), request("b", count=2)], AllowAllGate(), on_result=on_result
        )

        assert log == ["run:1", "result:a", "run:2", "result:b"]

    async def test_a_denied_call_does_not_stop_the_calls_after_it(self) -> None:
        log: list[str] = []
        first = CountTool(log, name="first")
        second = CountTool(log, name="second")
        gate = RecordingGate({"c1": Deny("files.write", "denied")}, log)

        results, events = await execute(
            registry_of(first, second),
            [request("c1", "first", count=1), request("c2", "second", count=2)],
            gate,
        )

        assert [e["status"] for e in events] == ["error", "ok"]
        assert first.executed == [] and second.executed == [{"count": 2}]
        assert gate.skipped == []
        assert results[1] == "counted 2"

    async def test_there_is_no_way_to_run_calls_or_a_turn_without_a_gate(self) -> None:
        with pytest.raises(TypeError, match="gate"):
            await execute_tool_calls(  # type: ignore[call-arg]
                registry_of(CountTool([])),
                [request("c1")],
                hook=AgentHook(),
                context=AgentHookContext(iteration=0, messages=[], session_key="s1"),
            )
        with pytest.raises(TypeError, match="gate"):
            AgentRunSpec(  # type: ignore[call-arg]
                tools=registry_of(),
                runtime=MagicMock(),
                max_iterations=1,
                transcript_input=MagicMock(),
                transcript_builder=MagicMock(),
                consolidate_history=MagicMock(),
            )

    def test_the_registry_has_no_way_to_run_a_tool_on_its_own(self) -> None:
        assert not hasattr(ToolRegistry, "execute")


def scripted_provider(*responses: LLMResponse) -> MagicMock:
    provider = MagicMock(spec=LLMProvider)
    provider.chat_stream_with_retry = AsyncMock(side_effect=list(responses))
    return provider


def tool_call_response(*calls: ToolCallRequest) -> LLMResponse:
    return LLMResponse(content=None, tool_calls=list(calls), finish_reason="tool_calls")


async def run_with_checkpoints(
    provider: MagicMock,
    tools: ToolRegistry,
    *,
    gate: ToolGate = AllowAllGate(),
    max_iterations: int = 5,
    **kwargs: Any,
) -> tuple[Any, list[dict[str, Any]]]:
    checkpoints: list[dict[str, Any]] = []

    async def checkpoint(payload: dict[str, Any]) -> None:
        checkpoints.append(payload)

    result = await AgentRunner().run(make_run_spec(
        provider,
        initial_messages=[{"role": "system", "content": "system"}, {"role": "user", "content": "start"}],
        tools=tools,
        model="test-model",
        max_iterations=max_iterations,
        checkpoint_callback=checkpoint,
        gate=gate,
        session_key="s1",
        **kwargs,
    ))
    return result, checkpoints


def phases(checkpoints: list[dict[str, Any]]) -> list[str]:
    return [checkpoint["phase"] for checkpoint in checkpoints]


def without_metadata(message: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in message.items() if key != METADATA_KEY}


class TestAParkedCallEndsTheTurn:
    async def test_there_is_no_further_model_request_and_no_final_answer(self) -> None:
        log: list[str] = []
        tool = CountTool(log)
        provider = scripted_provider(
            tool_call_response(request("c1", count=1), request("c2", count=2)),
            LLMResponse(content="must not be asked"),
        )
        gate = RecordingGate({"c1": park("appr_1")}, log)

        result, checkpoints = await run_with_checkpoints(provider, registry_of(tool), gate=gate)

        assert result.stop_reason == "parked"
        assert result.final_content is None and result.error is None
        assert provider.chat_stream_with_retry.await_count == 1
        assert tool.executed == []
        assert [m["content"] for m in result.messages[-2:]] == [park_message("appr_1"), SKIPPED_MESSAGE]
        assert phases(checkpoints) == ["assistant_tool_calls", "tool_result", "tool_result"]


class TestTheCheckpointContract:
    async def test_a_checkpoint_precedes_the_tool_and_each_result_precedes_the_next_call(self) -> None:
        seen: list[tuple[str, list[str]]] = []
        checkpoints: list[dict[str, Any]] = []

        async def execute_tool(name: str, params: dict[str, Any]) -> str:
            seen.append((name, phases(checkpoints)))
            return f"{name} done"

        async def record(payload: dict[str, Any]) -> None:
            checkpoints.append(payload)

        provider = scripted_provider(
            tool_call_response(
                ToolCallRequest(id="a", name="first", arguments={}),
                ToolCallRequest(id="b", name="second", arguments={}),
            ),
            LLMResponse(content="finished"),
        )
        tools = ScriptedTools(AsyncMock(side_effect=execute_tool))
        result = await AgentRunner().run(make_run_spec(
            provider,
            initial_messages=[{"role": "user", "content": "start"}],
            tools=tools,
            model="test-model",
            max_iterations=3,
            checkpoint_callback=record,
        ))

        assert result.final_content == "finished"
        assert seen == [
            ("first", ["assistant_tool_calls"]),
            ("second", ["assistant_tool_calls", "tool_result"]),
        ]
        assert phases(checkpoints) == ["assistant_tool_calls", "tool_result", "tool_result", "final_response"]

    async def test_every_message_the_runner_adds_reaches_the_callback_once_in_order(self) -> None:
        tool = CountTool([])
        provider = scripted_provider(
            tool_call_response(request("c1", count=1)),
            LLMResponse(content="finished"),
        )

        result, checkpoints = await run_with_checkpoints(provider, registry_of(tool))

        added = result.messages[2:]
        assert [without_metadata(c["message"]) for c in checkpoints] == added
        assert phases(checkpoints) == ["assistant_tool_calls", "tool_result", "final_response"]
        assert [m["role"] for m in added] == ["assistant", "tool", "assistant"]

    async def test_a_failed_tool_result_carries_the_error_flag_in_the_payload_only(self) -> None:
        provider = scripted_provider(
            tool_call_response(request("c1", count=1)),
            LLMResponse(content="finished"),
        )
        tools = ScriptedTools(AsyncMock(side_effect=RuntimeError("boom")))

        result, checkpoints = await run_with_checkpoints(provider, tools)

        tool_payload = checkpoints[1]["message"]
        assert tool_payload[METADATA_KEY] == {IS_ERROR: True}
        assert METADATA_KEY not in result.messages[3]
        assert "Error: RuntimeError: boom" in result.messages[3]["content"]

    async def test_a_model_error_commits_the_placeholder(self) -> None:
        provider = scripted_provider(LLMResponse(content="429 rate limit", finish_reason="error"))

        result, checkpoints = await run_with_checkpoints(provider, registry_of(CountTool([])))

        assert result.stop_reason == "error"
        assert phases(checkpoints) == ["error_placeholder"]
        assert [without_metadata(c["message"]) for c in checkpoints] == result.messages[2:]

    async def test_an_empty_answer_commits_its_notice_and_is_not_a_final_response(self) -> None:
        provider = scripted_provider(*[LLMResponse(content="") for _ in range(3)])

        result, checkpoints = await run_with_checkpoints(provider, registry_of(CountTool([])))

        assert result.stop_reason == "empty_final_response"
        assert phases(checkpoints) == ["empty_final_response"]

    async def test_the_step_limit_commits_the_fallback_after_the_last_tool_result(self) -> None:
        provider = scripted_provider(tool_call_response(request("c1")), tool_call_response(request("c2")))

        result, checkpoints = await run_with_checkpoints(
            provider, registry_of(CountTool([])), max_iterations=2
        )

        assert result.stop_reason == "max_iterations"
        assert phases(checkpoints) == [
            "assistant_tool_calls",
            "tool_result",
            "assistant_tool_calls",
            "tool_result",
            "max_iterations_fallback",
        ]
        assert [without_metadata(c["message"]) for c in checkpoints] == result.messages[2:]

    async def test_a_truncated_answer_commits_its_segments_and_the_notice_between_them(self) -> None:
        provider = scripted_provider(
            LLMResponse(content="the first half ", finish_reason="length"),
            LLMResponse(content="and the rest"),
        )

        result, checkpoints = await run_with_checkpoints(provider, registry_of(CountTool([])))

        assert phases(checkpoints) == ["length_segment", "length_notice", "final_response"]
        assert [c["message"]["role"] for c in checkpoints] == ["assistant", "user", "assistant"]
        assert [without_metadata(c["message"]) for c in checkpoints] == result.messages[2:]

    async def test_injected_messages_are_committed_with_their_metadata_and_kept_out_of_the_transcript(self) -> None:
        provider = scripted_provider(LLMResponse(content="answered"))
        pending = [[{"role": "user", "content": "and this", METADATA_KEY: {"dots_inbound_id": "in2"}}], []]

        async def inject() -> list[dict[str, Any]]:
            return pending.pop(0)

        result, checkpoints = await run_with_checkpoints(
            provider, registry_of(CountTool([])), injection_callback=inject
        )

        assert phases(checkpoints) == ["injected_user", "final_response"]
        assert checkpoints[0]["message"][METADATA_KEY] == {"dots_inbound_id": "in2"}
        assert result.messages[2] == {"role": "user", "content": "and this"}

    async def test_the_payload_is_a_snapshot_the_runner_does_not_change_afterwards(self) -> None:
        provider = scripted_provider(LLMResponse(content="answered"))

        result, checkpoints = await run_with_checkpoints(provider, registry_of(CountTool([])))

        checkpoints[0]["message"]["content"] = "changed by the callback"
        assert result.messages[-1]["content"] == "answered"
