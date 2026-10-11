/** What the Computer page shows: allocated resources from the config, live usage from the VM when it runs. */
import { COMPUTER_STOPPED } from "@invisible-dots/shared/browser";
import { ApiError } from "./api";
import { relativeTime } from "./time";
import type { Computer, DotConfig, SystemAnswer, VmState } from "./types";

const COMPUTER_STATE_LABELS: Record<VmState, string> = {
  PROVISIONING: "Provisioning",
  STARTING: "Starting",
  RUNNING: "Running",
  STOPPING: "Stopping",
  STOPPED: "Stopped",
  ERROR: "Error",
  DELETING: "Deleting",
};

/** The computer's state in words, for a person; a state this client does not know is shown as the host wrote it. */
export function computerStateLabel(state: string | null | undefined): string {
  if (!state) return "Unknown";
  return (COMPUTER_STATE_LABELS as Record<string, string>)[state] ?? state;
}

/** The routes that reach into the Dot's computer (identities, files, tools) answer 409 `computer_stopped` while it is off. */
export function isComputerStopped(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === COMPUTER_STOPPED;
}

/** What a failed read of the desktop's picture means for the person. */
export function frameProblem(error: unknown): string {
  if (error instanceof ApiError && error.code === COMPUTER_STOPPED) return "The computer is not running.";
  return error instanceof Error ? error.message : String(error);
}

export interface Usage {
  usedBytes: number;
  totalBytes: number;
  /** 0..1 */
  fraction: number;
}

export interface ComputerView {
  state: VmState | "UNKNOWN";
  allocated: { cpus: number | null; memory: string | null; disk: string | null; idleTimeout: string | null };
  live: {
    hostname: string;
    uptimeSeconds: number;
    cpus: number;
    memory: Usage;
    disk: Usage;
  } | null;
}

function usage(total: number, free: number): Usage {
  const used = Math.max(0, total - free);
  return { usedBytes: used, totalBytes: total, fraction: total > 0 ? Math.min(1, used / total) : 0 };
}

/** The live figures are the guest's `GET /v1/system`, which the API embeds as `system` while the Dot is READY. */
export function computerView(
  computer: Pick<Computer, "state"> & { system?: SystemAnswer | null } | null,
  config: DotConfig | null,
): ComputerView {
  const system = computer?.system ?? null;
  return {
    state: computer?.state ?? "UNKNOWN",
    allocated: {
      cpus: config?.computer?.cpu ?? null,
      memory: config?.computer?.memory ?? null,
      disk: config?.computer?.disk ?? null,
      idleTimeout: config?.computer?.idle_timeout ?? null,
    },
    live: system
      ? {
          hostname: system.hostname,
          uptimeSeconds: system.uptime_s,
          cpus: system.cpus,
          memory: usage(system.mem_total_bytes, system.mem_available_bytes),
          disk: usage(system.disk_total_bytes, system.disk_free_bytes),
        }
      : null,
  };
}

/**
 * What the person is asked before a power action, or null when the action goes ahead without a question. Stopping
 * always asks, because it says what it costs: a computer the person stopped runs none of its automations until the
 * person starts it again (architecture section 9.5). A reboot and a stop also ask while a task runs, which they cut off.
 */
export function confirmText(action: "stop" | "reboot", taskRunning: boolean): string | null {
  if (action === "stop") {
    const cost = "Its automations do not run while it is stopped; start it again to resume them.";
    return taskRunning ? `A task is running. Stop the computer anyway? ${cost}` : `Stop this Dot's computer? ${cost}`;
  }
  return taskRunning ? "A task is running. Reboot the computer anyway?" : null;
}

/** A moment as a person reads a calendar: "Mar 10, 2026, 9:00 AM", in the browser's zone. */
function whenLabel(ms: number, locale?: string): string {
  return new Date(ms).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

export interface AutomationsNote {
  /** The person stopped the computer, so the host does not start it for an automation until the person does. */
  paused: boolean;
  text: string;
}

/**
 * What the Dot's automations are doing, from the host's record of the computer (which holds it while the computer is
 * off, when the guest cannot be asked): paused because the person stopped it (when the engine had reported a run
 * that is due, `next_automation_at`: a Dot with none has nothing to pause), due at the time the engine last reported
 * (which the host wakes a sleeping computer for), or none due.
 */
export function automationsNote(computer: Pick<Computer, "state" | "stop_reason" | "next_automation_at">, now: number, locale?: string): AutomationsNote {
  // Paused is said of automations that exist: the engine reported a run that is due, which the person's stop now holds back.
  if (computer.stop_reason === "user" && computer.next_automation_at !== null) {
    return { paused: true, text: "Paused: you stopped this computer, so its automations do not run. Start it to resume them." };
  }
  const due = computer.next_automation_at === null ? Number.NaN : new Date(computer.next_automation_at).getTime();
  if (Number.isNaN(due)) return { paused: false, text: "No automation is due." };
  const asleep = computer.state === "STOPPED" ? " The computer is asleep and starts shortly before then." : "";
  return { paused: false, text: `Next automation: ${whenLabel(due, locale)} (${relativeTime(due, now)}).${asleep}` };
}

/** Which power buttons make sense in a state. Unknown states enable everything and let the API decide. */
export function allowedActions(state: string): { start: boolean; stop: boolean; reboot: boolean } {
  switch (state) {
    case "STOPPED":
    case "ERROR":
      return { start: true, stop: state === "ERROR", reboot: false };
    case "RUNNING":
      return { start: false, stop: true, reboot: true };
    case "PROVISIONING":
    case "STARTING":
    case "STOPPING":
    case "DELETING":
      return { start: false, stop: false, reboot: false };
    default:
      return { start: true, stop: true, reboot: true };
  }
}

/** The task is cut off if the computer goes down now: the Dot is running one, or waits on an answer inside one. */
export function taskRunning(status: string): boolean {
  return status === "RUNNING" || status === "WAITING_APPROVAL";
}
