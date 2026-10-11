/**
 * A tool call and an approval as a step of what the Dot did: the one reading of `tool.called`, `approval.requested`
 * and `approval.resolved` that the chat (`chat-thread.ts`), a task's story (`task-events.ts`) and the Activity page
 * (`events/view.ts`) draw, with one set of words for how a call ended and how an approval was answered. How long a
 * call took is `formatMillis` (format.ts) in all three.
 */
import { toolLabel, type ToolFamily } from "@invisible-dots/shared/browser";
import type { Tone } from "./tone";
import type { StoredEvent } from "./types";

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * How a tool call ended. The engine reports a call when it has ended, so a call that is still running has no event
 * yet; a call that waits for the person is the approval's step.
 */
export type ToolState = "ok" | "error" | "denied" | "interrupted";

export function toolStateOf(data: Record<string, unknown>): ToolState {
  if (data.interrupted === true) return "interrupted";
  if (data.decision === "deny") return "denied";
  return data.ok === true ? "ok" : "error";
}

/**
 * How a call ended, in a word and a tone. A denied call never ran: the Dot's config refused it, which is worth noticing
 * but is not a failure; an interrupted one has no known outcome.
 */
export const TOOL_OUTCOME: Readonly<Record<ToolState, { word: string; tone: Tone }>> = {
  ok: { word: "done", tone: "neutral" },
  error: { word: "failed", tone: "error" },
  denied: { word: "denied", tone: "warn" },
  interrupted: { word: "interrupted", tone: "warn" },
};

export interface ToolStep {
  kind: "tool";
  id: number;
  at: string;
  tool: string;
  label: string;
  family: ToolFamily;
  /** What the call acted on, as the engine reported it (one line); "" when it named nothing. */
  target: string;
  state: ToolState;
  durationMs: number;
}

export type ApprovalOutcome = "waiting" | "approved" | "rejected";

/** How an approval stands, in the words of a step. */
export const APPROVAL_WORD: Readonly<Record<ApprovalOutcome, string>> = { waiting: "Waiting for an answer", approved: "Allowed", rejected: "Denied" };

export interface ApprovalStep {
  kind: "approval";
  id: number;
  at: string;
  approvalId: string;
  tool: string;
  label: string;
  family: ToolFamily;
  reason: string;
  /** What the call needs the person's permission for, and with which arguments: what the approval card shows. */
  permission: string;
  arguments: Record<string, unknown>;
  outcome: ApprovalOutcome;
  /** What the person wrote to the Dot with the answer; "" for none. */
  note: string;
  /** The answer also allowed the permission for good. */
  always: boolean;
}

/** A `tool.called` event as a step. */
export function toolStep(event: Pick<StoredEvent, "id" | "created_at" | "data">): ToolStep {
  const d = event.data ?? {};
  const tool = text(d.tool);
  const { label, family } = toolLabel(tool, d.tty === true);
  return {
    kind: "tool",
    id: event.id,
    at: event.created_at,
    tool,
    label,
    family,
    target: text(d.target),
    state: toolStateOf(d),
    durationMs: typeof d.duration_ms === "number" ? d.duration_ms : 0,
  };
}

/** An `approval.requested` event as a step that waits; `answerApproval` records its answer. */
export function approvalStep(event: Pick<StoredEvent, "id" | "created_at" | "data">): ApprovalStep {
  const d = event.data ?? {};
  const tool = text(d.tool);
  const { label, family } = toolLabel(tool);
  return {
    kind: "approval",
    id: event.id,
    at: event.created_at,
    approvalId: text(d.approval_id),
    tool,
    label,
    family,
    reason: text(d.reason),
    permission: text(d.permission),
    arguments: typeof d.arguments === "object" && d.arguments !== null && !Array.isArray(d.arguments) ? (d.arguments as Record<string, unknown>) : {},
    outcome: "waiting",
    note: "",
    always: false,
  };
}

/** An `approval.resolved` event, written into the step of the approval it answers. */
export function answerApproval(step: ApprovalStep, resolved: Pick<StoredEvent, "data">): void {
  const d = resolved.data ?? {};
  step.outcome = d.decision === "approve" ? "approved" : "rejected";
  step.note = text(d.note);
  step.always = d.always === true;
}

/**
 * The steps of the tool calls and approvals among `events`, in the order of the events, and how each approval was
 * answered. `keep` says which `tool.called` and `approval.requested` events are the caller's (the chat's turns, one
 * task); an answer is found by its approval's id, so one to an approval that was not kept changes nothing.
 */
export function stepsOf(events: readonly StoredEvent[], keep: (event: StoredEvent) => boolean): Array<ToolStep | ApprovalStep> {
  const steps: Array<ToolStep | ApprovalStep> = [];
  const approvals = new Map<string, ApprovalStep>();
  for (const event of events) {
    if (event.type === "tool.called" && keep(event)) steps.push(toolStep(event));
    else if (event.type === "approval.requested" && keep(event)) {
      const step = approvalStep(event);
      approvals.set(step.approvalId, step);
      steps.push(step);
    } else if (event.type === "approval.resolved") {
      const step = approvals.get(text(event.data?.approval_id));
      if (step) answerApproval(step, event);
    }
  }
  return steps;
}
