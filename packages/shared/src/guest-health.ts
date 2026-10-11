/**
 * The one rule for "is this guest up" (sections 9.3 and 9.4) and the one
 * loop that waits for it. vm-manager's waitForGuestHealth and the
 * scheduler's test driver both run this, so a change to the rule reaches
 * every caller and every test that stands in for the VM layer.
 */
import type { HealthAnswer } from "./protocol.js";
import { abortableSleep } from "./support.js";

/** "agentd": dot-agentd answers. "agent": the agent behind it also reports status "ok". */
export type HealthUntil = "agentd" | "agent";

export function isGuestHealthy(answer: HealthAnswer, until: HealthUntil = "agent"): boolean {
  if (answer.agentd !== "ok") return false;
  return until === "agentd" || answer.agent.status === "ok";
}

/**
 * The `code` of the error a host client raises when whatever listens on a
 * guest port cannot prove it holds the Dot's token (`GET /v1/proof`,
 * section 5.2): it is not this Dot's guest.
 */
export const GUEST_UNPROVEN = "guest_unproven";

/**
 * Errors that waiting cannot fix: a refused token (the seed and the token
 * the host holds disagree) and a listener that is not the Dot's guest.
 */
export function isFatalGuestError(error: unknown): boolean {
  const { status, code } = (error ?? {}) as { status?: unknown; code?: unknown };
  return status === 401 || code === GUEST_UNPROVEN;
}

/** Whatever answers `GET /v1/health` for one guest. */
export interface HealthSource {
  /** Where the source sends requests, for errors. */
  readonly address: string;
  health(options: { timeoutMs?: number; signal?: AbortSignal }): Promise<HealthAnswer>;
}

export interface PollGuestHealthOptions {
  /** Give up after this long. Default 5 minutes: a first boot runs cloud-init and grows the disk. */
  timeoutMs?: number;
  /** Delay between attempts. Default 1 s. */
  intervalMs?: number;
  /** Timeout of each health request. Default 5 s. */
  requestTimeoutMs?: number;
  /** Default "agent", which is when the agent can take the secret and the config (section 9.4). */
  until?: HealthUntil;
  signal?: AbortSignal;
  /** Checked before every attempt; throw to stop waiting, e.g. when QEMU exited. */
  check?: () => void | Promise<void>;
}

/** Thrown when the guest did not become healthy in time; `last` is what it said last, if anything. */
export class GuestHealthTimeoutError extends Error {
  readonly last: HealthAnswer | undefined;
  constructor(address: string, timeoutMs: number, last: HealthAnswer | undefined, lastError: Error | undefined) {
    const detail = last ? `last answer: ${JSON.stringify(last)}` : `last error: ${lastError?.message ?? "none"}`;
    super(`guest ${address} was not healthy within ${timeoutMs} ms (${detail})`);
    this.name = "GuestHealthTimeoutError";
    this.last = last;
  }
}

/**
 * Poll health until the guest is up. Connection errors are expected while
 * the VM boots and are retried; a fatal error (`isFatalGuestError`) is not.
 */
export async function pollGuestHealth(source: HealthSource, options: PollGuestHealthOptions = {}): Promise<HealthAnswer> {
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const interval = options.intervalMs ?? 1000;
  const until = options.until ?? "agent";
  const deadline = Date.now() + timeoutMs;
  let last: HealthAnswer | undefined;
  let lastError: Error | undefined;
  for (;;) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
    await options.check?.();
    try {
      last = await source.health({ timeoutMs: options.requestTimeoutMs ?? 5000, signal: options.signal });
      if (isGuestHealthy(last, until)) return last;
    } catch (error) {
      if (isFatalGuestError(error)) throw error;
      lastError = error as Error;
    }
    if (Date.now() + interval > deadline) throw new GuestHealthTimeoutError(source.address, timeoutMs, last, lastError);
    await abortableSleep(interval, options.signal);
  }
}
