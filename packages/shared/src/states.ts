/** Agent runtime states (architecture section 8.1). */
export const AGENT_STATES = [
  "IDLE",
  "THINKING",
  "PLANNING",
  "EXECUTING",
  "WAITING_APPROVAL",
  "DONE",
] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/** States of a Dot's QEMU virtual machine, stored in `computers.state` (section 9.3). */
export const VM_STATES = [
  "PROVISIONING",
  "STARTING",
  "RUNNING",
  "STOPPING",
  "STOPPED",
  "ERROR",
  "DELETING",
] as const;
export type VmState = (typeof VM_STATES)[number];

/**
 * Why a computer is off or going off, stored in `computers.stop_reason` while it is STOPPING or STOPPED (section 9.5):
 * the idle sleep, the person's own stop, or a VM that stopped without being asked.
 */
export const STOP_REASONS = ["idle", "user", "exited"] as const;
export type StopReason = (typeof STOP_REASONS)[number];

/**
 * Whether the guest of a computer in this state answers: only a RUNNING computer does. The host's routes that reach
 * into the guest (screenshot, files, browser identities, tools, reboot) refuse every other state with 409
 * `computer_stopped`, and the UI draws pictures and lists only when this says so. `COMPUTER_STOPPED` is the code of
 * that refusal.
 */
export const COMPUTER_STOPPED = "computer_stopped";

export function computerIsUp(state: string | null | undefined): state is "RUNNING" {
  return state === "RUNNING";
}

/** Dot states, stored in `dots.status` (section 9.3). */
export const DOT_STATES = [
  "CREATING",
  "READY",
  "IDLE",
  "RUNNING",
  "WAITING_APPROVAL",
  "ERROR",
] as const;
export type DotState = (typeof DOT_STATES)[number];

/** Task states, used on the host (`tasks.status`) and in the guest queue (section 9.3). */
export const TASK_STATES = [
  "PENDING",
  "RUNNING",
  "WAITING_APPROVAL",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** A task in one of these states never runs again. */
export const TERMINAL_TASK_STATES: readonly TaskState[] = ["COMPLETED", "FAILED", "CANCELLED"];

/** How many of a Dot's tasks (the newest created first) `GET /api/dots/:id/tasks` answers with at most; `before` (the id of the last one of the page) goes on, older. */
export const TASK_LIST_LIMIT = 200;

/**
 * How many messages `GET /api/dots/:id/messages` answers with at most: by default the OLDEST ones; with `order=desc`
 * the newest, and `before` (the event id of the oldest message of the last page) pages on, older, from there.
 */
export const CONVERSATION_LIST_LIMIT = 500;

/**
 * How many approvals `GET /api/approvals` answers with at most: by default the OLDEST ones, in the order they were
 * asked; with `order=desc` the newest (by the time of their last change), and `before` pages on from there.
 */
export const APPROVAL_LIST_LIMIT = 500;

/** The most characters of a tool's arguments, and of the reason, an approval prompt shows in a chat (a chat is read by a third party). */
export const APPROVAL_PROMPT_TEXT_MAX = 300;

/** The longest note a person can add to the answer of an approval, in characters (`POST /api/approvals/:id/approve|reject`). */
export const APPROVAL_NOTE_MAX = 500;

/** The order a list route can be asked for: `asc` is the oldest first (the default of each route), `desc` the newest first. */
export const LIST_ORDERS = ["asc", "desc"] as const;
export type ListOrder = (typeof LIST_ORDERS)[number];

/**
 * `approvals.status` (section 9.1). An approval is `expired` when its task
 * ended before anybody decided: nothing waits for the decision any more.
 */
export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "expired"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** The statuses of an approval nobody is waiting on any more: someone answered it, or its task ended first. */
export const ANSWERED_APPROVAL_STATUSES: readonly ApprovalStatus[] = ["approved", "rejected", "expired"];

/** `events.source` (section 9.1). */
export const EVENT_SOURCES = ["host", "guest"] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export function isAgentState(value: unknown): value is AgentState {
  return typeof value === "string" && (AGENT_STATES as readonly string[]).includes(value);
}

export function isTaskState(value: unknown): value is TaskState {
  return typeof value === "string" && (TASK_STATES as readonly string[]).includes(value);
}
