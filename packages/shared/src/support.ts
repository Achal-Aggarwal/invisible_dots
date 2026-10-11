/**
 * Small pieces every part of the host is built from: the clock, the logger's shape, an error's message, a sleep that
 * an abort ends, and the error the API answers with. They live here, below every app and package, so that a package
 * (channels, the database layer) never depends on an app for them. All of it runs in a browser too.
 */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** The logger of every part of the control plane process, so one logger serves it all. */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A sleep that ends early, without an error, when `signal` aborts, also one that has already aborted. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** An error with the HTTP status and `error` code the API answers with (section 9.6). */
export class ControlPlaneError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ControlPlaneError";
  }
}

export const notFound = (what: string, id: string) => new ControlPlaneError(404, "not_found", `${what} "${id}" not found`);
