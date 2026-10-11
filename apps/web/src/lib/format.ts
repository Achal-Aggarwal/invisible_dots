import type { Tone } from "./tone";

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];

/** Binary units, matching the config's sizes (1gb = 1024^3 bytes). */
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "-";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function formatDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "-";
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/** How long a call took: milliseconds under a second, then seconds with a decimal, then the longer units. */
export function formatMillis(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  // 59.95 s and over would round to "60.0 s": it is a minute.
  if (ms < 59_950) return `${(ms / 1000).toFixed(1)} s`;
  return formatDuration(Math.round(ms / 1000));
}

const TONES: Record<string, Tone> = {
  // Dot states
  READY: "ok",
  CREATING: "info",
  WAITING_APPROVAL: "warn",
  // VM states
  PROVISIONING: "info",
  STARTING: "info",
  STOPPING: "info",
  STOPPED: "neutral",
  DELETING: "warn",
  // Task states
  PENDING: "neutral",
  COMPLETED: "ok",
  FAILED: "error",
  CANCELLED: "neutral",
  // Shared by several
  RUNNING: "ok",
  IDLE: "neutral",
  ERROR: "error",
  // Approval statuses
  pending: "warn",
  approved: "ok",
  rejected: "error",
};

export function statusTone(status: string | null | undefined): Tone {
  return (status && TONES[status]) || "neutral";
}

/** Model spend in US dollars: cents above a cent, "<$0.01" for a trace, "$0.00" for nothing. */
export function formatUsd(usd: number | null | undefined): string {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) return "-";
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** The start of the local day of `now`, as an ISO 8601 instant: what "today" means for a spend figure. */
export function startOfToday(now: Date = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}
