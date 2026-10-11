/** The scheduler's own building blocks: a per-key lock, and the work it starts without waiting for it. */
import { errorMessage, type Logger } from "@invisible-dots/shared";

/**
 * Serializes work per key: lifecycle operations on one Dot (create, start,
 * stop, reboot, delete) run one after the other, operations on different
 * Dots run in parallel.
 */
export class KeyedMutex {
  readonly #tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const result = previous.then(fn, fn);
    const tail = result.catch(() => {});
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return result;
  }

  isBusy(key: string): boolean {
    return this.#tails.has(key);
  }
}

/**
 * Work a caller starts without waiting for it (a provisioning, a stop, a push to a guest): its failure is logged,
 * since nobody awaits it, and `settle` waits until all of it has finished (tests and shutdown). After `close` nothing
 * new starts.
 */
export class BackgroundWork {
  readonly #pending = new Set<Promise<unknown>>();
  #closed = false;

  constructor(private readonly log: Logger) {}

  /** Start `work`; a failure is logged as "<what> failed" with the Dot. */
  run(what: string, dotId: string, work: () => Promise<unknown>): void {
    if (this.#closed) return;
    this.track(work().catch((error) => this.log.error(`${what} failed`, { dotId, error: errorMessage(error) })));
  }

  /** Count a promise as background work until it settles; it is returned as it is, for a caller that awaits it. */
  track<T>(work: Promise<T>): Promise<T> {
    const tracked = work.finally(() => this.#pending.delete(tracked));
    tracked.catch(() => {});
    this.#pending.add(tracked);
    return work;
  }

  /** Whether any of it is still running. */
  get busy(): boolean {
    return this.#pending.size > 0;
  }

  /** Wait until all of it has finished, including work started meanwhile. */
  async settle(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }

  close(): void {
    this.#closed = true;
  }
}
