/**
 * What a guest event changes on the host besides the event log: task rows (state, summary, error, spend),
 * approval rows, the Dot's status, the time of its next automation, and the MCP servers of its config.
 */
import type { Repositories } from "@invisible-dots/database";
import {
  isMcpServerName,
  parseDotConfig,
  parseMcpServerEntry,
  resolvePermission,
  TERMINAL_TASK_STATES,
  type AgentState,
  type DotRecord,
  type DotState,
  type HostEventDataMap,
  type OutboundEvent,
  type PermissionName,
} from "@invisible-dots/shared";

/**
 * The Dot status for an agent state. READY means the computer is up and the
 * agent is IDLE; DONE is the short step before IDLE (section 8.1) and still
 * counts as working.
 */
export function dotStatusForAgent(state: AgentState): DotState {
  switch (state) {
    case "IDLE":
      return "READY";
    case "WAITING_APPROVAL":
      return "WAITING_APPROVAL";
    default:
      return "RUNNING";
  }
}

/** Dot states the agent's own reports never override: they are set by the control plane. */
const STICKY_DOT_STATES: readonly DotState[] = ["CREATING", "ERROR", "IDLE"];

export interface AppliedGuestEvent {
  /** A task reached a terminal state, so the Dot may take the next one. */
  taskSettled: boolean;
  /** The Dot's config changed (an MCP server it added): it is pushed to the guest once the transaction commits. */
  reconfigured?: DotRecord;
  /** What the host logs of it, in the same transaction: `dot.updated`, or why it refused (`mcp.server.refused`). */
  hostEvents?: HostEventOf[];
}

type HostEventOf = { [K in keyof HostEventDataMap]: { type: K; data: HostEventDataMap[K] } }[keyof HostEventDataMap];

/** The tool of the engine that asks to add an MCP server; its approvals are the person's consent to one. */
export const ADD_MCP_SERVER_TOOL = "add_mcp_server";
const ADD_PERMISSION: PermissionName = "mcp.servers.add";

/**
 * A Dot added an MCP server to its own config. The config is the host's, so the host decides again what the engine
 * decided: the permission allows it, or the person approved a call of exactly these arguments, and that approval is
 * used up here, so it adds one server once. The entry is checked by the config's own schema first (a call refused for
 * it keeps its approval), and a name already declared is not replaced. The server's own permission is left to its
 * default, ask, so each of its tools still asks until the person allows it.
 */
async function addMcpServer(tx: Repositories, dotId: string, args: Record<string, unknown>): Promise<AppliedGuestEvent> {
  const name = typeof args.name === "string" ? args.name : "";
  const refuse = (reason: string): AppliedGuestEvent => ({ taskSettled: false, hostEvents: [{ type: "mcp.server.refused", data: { name, reason } }] });
  const dot = await tx.dots.get(dotId);
  if (!dot) return refuse("the Dot no longer exists");
  const decision = resolvePermission(dot.config, ADD_PERMISSION);
  if (decision === "deny") return refuse(`the Dot's config denies ${ADD_PERMISSION}`);
  if (!isMcpServerName(name)) return refuse(`"${name}" is not an MCP server's name`);
  if (name in dot.config.mcp_servers) return refuse(`the Dot's config already declares an MCP server "${name}"`);
  const { name: _name, reason: _reason, ...entry } = args;
  const parsed = parseMcpServerEntry(entry);
  if (!parsed.ok) return refuse(parsed.problem);
  const config = parseDotConfig({ ...dot.config, mcp_servers: { ...dot.config.mcp_servers, [name]: parsed.server } });
  let approvalId: string | undefined;
  if (decision === "ask") {
    const approval = await tx.approvals.useApproved(dotId, ADD_MCP_SERVER_TOOL, args);
    if (!approval) return refuse(`${ADD_PERMISSION} asks, and no unused approval of exactly these arguments was given`);
    approvalId = approval.id;
  }
  const reconfigured = await tx.dots.updateConfig(dotId, config);
  if (!reconfigured) return refuse("the Dot no longer exists");
  const added = { name: dot.name, mcp_server_added: name, ...(approvalId && { approval_id: approvalId }) };
  return { taskSettled: false, reconfigured, hostEvents: [{ type: "dot.updated", data: added }] };
}

/** The spend a task event reports (architecture section 5.4), onto the task's row; events without it change nothing. */
async function recordTaskSpend(tx: Repositories, dotId: string, data: { task_id: string; spent_usd?: number }): Promise<void> {
  if (data.spent_usd !== undefined) await tx.tasks.recordSpend(data.task_id, dotId, data.spent_usd);
}

/** Apply one newly stored guest event inside the transaction that stored it. */
export async function applyGuestEvent(tx: Repositories, dotId: string, event: OutboundEvent): Promise<AppliedGuestEvent> {
  switch (event.type) {
    case "agent.state": {
      const dot = await tx.dots.get(dotId);
      if (dot && !STICKY_DOT_STATES.includes(dot.status)) {
        const next = dotStatusForAgent(event.data.state);
        if (next !== dot.status) await tx.dots.setStatus(dotId, next);
      }
      return { taskSettled: false };
    }
    case "task.started":
      await tx.tasks.transition(event.data.task_id, "RUNNING", { dotId });
      return { taskSettled: false };
    case "task.progress":
      await recordTaskSpend(tx, dotId, event.data);
      return { taskSettled: false };
    case "task.completed":
      await recordTaskSpend(tx, dotId, event.data);
      return { taskSettled: (await tx.tasks.transition(event.data.task_id, "COMPLETED", { summary: event.data.summary, dotId })) !== null };
    case "task.failed":
      await recordTaskSpend(tx, dotId, event.data);
      return { taskSettled: (await tx.tasks.transition(event.data.task_id, "FAILED", { error: event.data.error, dotId })) !== null };
    case "automation.next_run":
      // The guest's report of when its earliest automation is due, so a stopped computer is started shortly before it.
      await tx.computers.setNextAutomation(dotId, event.data.next_run_at_ms);
      return { taskSettled: false };
    case "approval.requested": {
      // A request for a task that already ended (cancelled while the guest
      // was asking) is kept for the record but never listed as pending.
      const task = event.data.task_id ? await tx.tasks.get(event.data.task_id) : null;
      const ended = task !== null && task.dot_id === dotId && TERMINAL_TASK_STATES.includes(task.status);
      await tx.approvals.insertRequested(dotId, event.data, ended ? "expired" : "pending");
      if (event.data.task_id && !ended) await tx.tasks.transition(event.data.task_id, "WAITING_APPROVAL", { dotId });
      return { taskSettled: false };
    }
    case "mcp.server.added":
      return addMcpServer(tx, dotId, event.data.arguments);
    default:
      return { taskSettled: false };
  }
}
