/**
 * Delivery of host to guest events (sections 5.4 and 9.5) from the durable
 * outbox in `inbound_events`. Whatever the control plane decides to tell a
 * guest (a claimed task, a message, an approval, a cancel) is stored first,
 * in the transaction that decided it; this class only sends what is stored.
 *
 * Per Dot, one flush runs at a time and sends the pending rows in order,
 * stopping at the first failure so a later event never overtakes an earlier
 * one. A Dot that is not READY is woken first. A row is marked delivered
 * only on the guest's 202; the guest keeps every event id it accepted, so a
 * row whose send had an unknown outcome (a timeout, a reset connection) is
 * simply sent again. Every READY transition flushes the Dot again, so
 * nothing waits for a timer once the guest is back.
 */
import { TASK_ENDED_BEFORE_DELIVERY, type Database, type InboundRecord } from "@invisible-dots/database";
import type { EventLog } from "@invisible-dots/events";
import { guestErrorCode, guestErrorStatus } from "./driver.js";
import type { Lifecycle } from "./lifecycle.js";
import { errorMessage, type Clock, type Logger } from "@invisible-dots/shared";

export interface InboundDeliveryOptions {
  /** Failed sends with a known outcome before a task.created gives its task up as FAILED. */
  maxDeliveryAttempts: number;
  /** Delay before a failed row is retried, multiplied by its number of failures. */
  retryDelayMs: number;
}

export const DEFAULT_INBOUND_OPTIONS: InboundDeliveryOptions = {
  maxDeliveryAttempts: 3,
  retryDelayMs: 30_000,
};

export interface InboundDeliveryDeps {
  db: Database;
  events: EventLog;
  lifecycle: Lifecycle;
  clock: Clock;
  logger: Logger;
  /** Resolves once a Dot that is still being provisioned is (successfully or not). */
  provisioned: (dotId: string) => Promise<void>;
  /** A task reached a terminal state here: the dispatcher may have work to hand out. */
  onTaskSettled: () => void;
  options?: Partial<InboundDeliveryOptions>;
}

/**
 * Whether a failed send certainly did NOT hand the event to the guest: the
 * guest answered with an error, or nothing listened on the guest port. A
 * timeout or a dropped connection may have delivered it, so it is not
 * counted against the row.
 */
function knownUndelivered(error: unknown): boolean {
  return guestErrorStatus(error) >= 400 || (error as { code?: unknown })?.code === "ECONNREFUSED";
}

/** Rolls back a give-up whose task ended before it: the task keeps that end and logs no failure. */
class TaskAlreadyEnded extends Error {}

export class InboundDelivery {
  readonly #db: Database;
  readonly #events: EventLog;
  readonly #lifecycle: Lifecycle;
  readonly #clock: Clock;
  readonly #log: Logger;
  readonly #provisioned: (dotId: string) => Promise<void>;
  readonly #onTaskSettled: () => void;
  readonly #opts: InboundDeliveryOptions;
  readonly #flushing = new Map<string, Promise<void>>();
  readonly #again = new Set<string>();
  readonly #timers = new Set<NodeJS.Timeout>();
  /** Dots whose deliveries wait for something that has to reach the guest first (`hold`). */
  readonly #holds = new Map<string, { holders: number; open: Promise<void>; release: () => void }>();
  #closed = false;

  constructor(deps: InboundDeliveryDeps) {
    this.#db = deps.db;
    this.#events = deps.events;
    this.#lifecycle = deps.lifecycle;
    this.#clock = deps.clock;
    this.#log = deps.logger;
    this.#provisioned = deps.provisioned;
    this.#onTaskSettled = deps.onTaskSettled;
    this.#opts = { ...DEFAULT_INBOUND_OPTIONS, ...deps.options };
  }

  get maxDeliveryAttempts(): number {
    return this.#opts.maxDeliveryAttempts;
  }

  /**
   * Send nothing to the Dot's guest until the returned function is called. For a caller that stores a row and
   * then has to do something to the guest that the row's meaning depends on: the config an approval's "always
   * allow" changed has to be there before the guest hears the approval, or the approved call's next use of the
   * permission is asked again. Take the hold before the row is stored: a flush that is already running
   * waits for it before every row it sends, so no later flush or timer can overtake the work. Several holds
   * on one Dot add up. The hold is in memory: after a restart, the guest's next READY does what the caller
   * would have done.
   */
  hold(dotId: string): () => void {
    let entry = this.#holds.get(dotId);
    if (!entry) {
      let release!: () => void;
      const open = new Promise<void>((resolve) => {
        release = resolve;
      });
      entry = { holders: 0, open, release };
      this.#holds.set(dotId, entry);
    }
    entry.holders++;
    const held = entry;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--held.holders === 0) {
        this.#holds.delete(dotId);
        held.release();
      }
    };
  }

  async #unheld(dotId: string): Promise<void> {
    for (let entry = this.#holds.get(dotId); entry; entry = this.#holds.get(dotId)) await entry.open;
  }

  /**
   * Send the Dot's pending rows. A call while a flush runs makes that flush
   * look once more when it is done, so nothing stored meanwhile is missed.
   * Resolves when no flush of the Dot is running any more.
   */
  kick(dotId: string): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const running = this.#flushing.get(dotId);
    if (running) {
      this.#again.add(dotId);
      return running;
    }
    const flush = (async () => {
      try {
        do {
          this.#again.delete(dotId);
          await this.#flush(dotId);
        } while (this.#again.has(dotId) && !this.#closed);
      } catch (error) {
        this.#log.error("inbound delivery failed", { dotId, error: errorMessage(error) });
      } finally {
        this.#flushing.delete(dotId);
      }
    })();
    this.#flushing.set(dotId, flush);
    return flush;
  }

  /** Kick every Dot whose oldest pending row is due for another try (the periodic pass and the start). */
  async kickDue(): Promise<void> {
    for (const dotId of await this.#db.inbound.dueDots(this.#opts.maxDeliveryAttempts)) void this.kick(dotId);
  }

  /** Whether any flush is running. */
  get busy(): boolean {
    return this.#flushing.size > 0;
  }

  /** Whether a flush of the Dot is running. */
  isFlushing(dotId: string): boolean {
    return this.#flushing.has(dotId);
  }

  /** Wait for every flush running now (tests and shutdown). */
  async settle(): Promise<void> {
    while (this.#flushing.size > 0) await Promise.allSettled([...this.#flushing.values()]);
  }

  close(): void {
    this.#closed = true;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }

  async #flush(dotId: string): Promise<void> {
    await this.#unheld(dotId);
    let rows = await this.#db.inbound.pending(dotId);
    if (rows.length === 0) return;
    await this.#provisioned(dotId);
    try {
      await this.#lifecycle.ensureReady(dotId);
    } catch (error) {
      await this.#notReady(dotId, rows, error);
      return;
    }
    // Rows stored while the Dot woke up are sent in the same pass.
    rows = await this.#db.inbound.pending(dotId);
    for (const row of rows) {
      await this.#unheld(dotId);
      if (this.#closed) return;
      if ((await this.#db.inbound.beginSend(row.event.id)) === "skip") {
        this.#log.info("inbound event not sent: its task ended first", { dotId, id: row.event.id, type: row.event.type });
        continue;
      }
      try {
        await (await this.#lifecycle.guest(dotId)).postEvent(row.event);
      } catch (error) {
        this.#lifecycle.markSuspect(dotId);
        await this.#sendFailed(row, error);
        return;
      }
      await this.#db.inbound.markDelivered(row.event.id);
      await this.#db.computers.touch(dotId, this.#clock.now());
      this.#log.info("inbound event delivered", { dotId, id: row.event.id, type: row.event.type });
    }
  }

  /** The Dot could not be made READY: every pending row had one more failed attempt. */
  async #notReady(dotId: string, rows: InboundRecord[], error: unknown): Promise<void> {
    const reason = errorMessage(error);
    this.#log.warn("inbound events wait: the Dot is not READY", { dotId, pending: rows.length, error: reason });
    for (const row of rows) await this.#countFailure(row, reason);
  }

  async #sendFailed(row: InboundRecord, error: unknown): Promise<void> {
    const reason = errorMessage(error);
    if (!knownUndelivered(error)) {
      // The guest may hold it: never counted, sent again with the same id.
      this.#log.warn("inbound event outcome unknown, will send it again", { dotId: row.dot_id, id: row.event.id, error: reason });
      const retryAt = this.#retryAt(1);
      await this.#db.inbound.postpone(row.event.id, reason, retryAt);
      this.#schedule(row.dot_id, this.#opts.retryDelayMs);
      return;
    }
    const status = guestErrorStatus(error);
    if (status >= 400 && status < 500) {
      // The guest refused this event as such: sending it again cannot change that.
      const code = guestErrorCode(error) ?? String(status);
      this.#log.error("the guest refused an inbound event; it is dropped", { dotId: row.dot_id, id: row.event.id, error: reason });
      await this.#giveUp(row, `refused by the guest (${code}): ${reason}`);
      return;
    }
    await this.#countFailure(row, reason);
  }

  async #countFailure(row: InboundRecord, reason: string): Promise<void> {
    const failures = await this.#db.inbound.recordFailure(row.event.id, reason, this.#retryAt(row.failures + 1));
    if (failures >= this.#opts.maxDeliveryAttempts) {
      if (row.event.type === "task.created") {
        await this.#giveUp(row, `could not be delivered to the Dot after ${failures} attempts: ${reason}`);
      } else {
        // A message or a decision is never given up: the next READY sends it.
        this.#log.warn("inbound event waits for the next READY", { dotId: row.dot_id, id: row.event.id, failures });
      }
      return;
    }
    this.#schedule(row.dot_id, this.#opts.retryDelayMs * failures);
  }

  /**
   * Drop a row for good; a task.created takes its task with it, logged as `task.failed` in the same transaction like
   * every task state change. A task that ended meanwhile (cancelled) keeps its end: only the row is dropped.
   */
  async #giveUp(row: InboundRecord, reason: string): Promise<void> {
    const taskId = row.event.type === "task.created" ? row.task_id : null;
    if (taskId) {
      const logged = await this.#db
        .transaction(async (tx) => {
          // The event first: its insert takes the event-order lock (database events.ts).
          const event = await this.#events.appendHostIn(tx, row.dot_id, "task.failed", { task_id: taskId, error: reason });
          if (!(await tx.tasks.transition(taskId, "FAILED", { error: reason }))) throw new TaskAlreadyEnded();
          await tx.inbound.drop(row.event.id, reason);
          return event;
        })
        .catch((error: unknown) => {
          if (error instanceof TaskAlreadyEnded) return null;
          throw error;
        });
      if (logged) {
        this.#events.publish(logged);
        this.#log.error("task delivery failed for good", { taskId, error: reason });
        this.#onTaskSettled();
        return;
      }
    }
    await this.#db.inbound.drop(row.event.id, reason);
  }

  /** scheduled_at style: compared with the database's now(), so a zero delay is "no date" rather than this host's now. */
  #retryAt(failures: number): Date | null {
    const delay = this.#opts.retryDelayMs * failures;
    return delay > 0 ? new Date(Date.now() + delay) : null;
  }

  #schedule(dotId: string, delayMs: number): void {
    if (this.#closed) return;
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      void this.kick(dotId);
    }, delayMs);
    timer.unref();
    this.#timers.add(timer);
  }
}

export { TASK_ENDED_BEFORE_DELIVERY };
