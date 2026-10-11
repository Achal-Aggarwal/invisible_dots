import type { AgentState } from "@invisible-dots/shared/browser";
import type { Tone } from "./tone";

export type AgentStateValue = AgentState;

const LABELS: Record<AgentState, string> = {
  IDLE: "Idle",
  THINKING: "Thinking...",
  PLANNING: "Planning...",
  EXECUTING: "Running a tool...",
  WAITING_APPROVAL: "Waiting for an approval",
  DONE: "Done",
};

export function agentStateLabel(state: string): string {
  return (LABELS as Record<string, string>)[state] ?? state;
}

export interface StatePill {
  label: string;
  tone: Tone;
  /** The label should shimmer: the Dot is working. */
  working: boolean;
}

const WORKING_STATES: readonly string[] = ["THINKING", "PLANNING", "EXECUTING"];

/** The agent is busy with a turn: thinking, planning or running a tool (not waiting for the person). */
export function isWorking(agent: AgentState | null): agent is "THINKING" | "PLANNING" | "EXECUTING" {
  return agent !== null && WORKING_STATES.includes(agent);
}

/**
 * The one state a person reads in the Dot header. The live agent state wins when this page has seen one; otherwise
 * the stored Dot status says what it can (it does not tell thinking from running a tool).
 */
export function statePill(status: string, agent: AgentState | null): StatePill {
  if (status === "ERROR") return { label: "Error", tone: "error", working: false };
  if (status === "CREATING") return { label: "Preparing the computer", tone: "info", working: true };
  if (agent === "WAITING_APPROVAL" || status === "WAITING_APPROVAL") return { label: "Waiting for you", tone: "warn", working: false };
  if (isWorking(agent)) return { label: agentStateLabel(agent), tone: "info", working: true };
  if (agent === "IDLE" || agent === "DONE") return { label: "Idle", tone: "neutral", working: false };
  if (status === "RUNNING") return { label: "Working on a task", tone: "info", working: true };
  if (status === "READY" || status === "IDLE") return { label: "Idle", tone: "neutral", working: false };
  return { label: status, tone: "neutral", working: false };
}
