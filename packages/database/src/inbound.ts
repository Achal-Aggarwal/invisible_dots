/**
 * The host's outbox of inbound events (migration 0002): what the control
 * plane has decided to tell a guest, stored before it is sent. Every send
 * goes through `beginSend`, which is the one place that decides, atomically
 * with a concurrent cancel, whether a task.created may still go out.
 */
import type { InboundEvent, InboundEventType } from "@invisible-dots/shared";
import { iso, isoRequired, type Queryable } from "./rows.js";

interface InboundRow {
  seq: number;
  id: string;
  dot_id: string;
  type: InboundEventType;
  data: Record<string, unknown>;
  ts: string;
  task_id: string | null;
  run_id: string | null;
  created_at: Date;
  sent_at: Date | null;
  delivered_at: Date | null;
  dropped_at: Date | null;
  drop_reason: string | null;
  failures: number;
  last_error: string | null;
  retry_at: Date | null;
}

export interface InboundRecord {
  seq: number;
  dot_id: string;
  event: InboundEvent;
  task_id: string | null;
  run_id: string | null;
  created_at: string;
  sent_at: string | null;
  delivered_at: string | null;
  dropped_at: string | null;
  drop_reason: string | null;
  failures: number;
  last_error: string | null;
  retry_at: string | null;
}

function toRecord(row: InboundRow): InboundRecord {
  return {
    seq: row.seq,
    dot_id: row.dot_id,
    event: { id: row.id, type: row.type, ts: row.ts, data: row.data } as InboundEvent,
    task_id: row.task_id,
    run_id: row.run_id,
    created_at: isoRequired(row.created_at),
    sent_at: iso(row.sent_at),
    delivered_at: iso(row.delivered_at),
    dropped_at: iso(row.dropped_at),
    drop_reason: row.drop_reason,
    failures: row.failures,
    last_error: row.last_error,
    retry_at: iso(row.retry_at),
  };
}

/** Rows still to deliver: neither delivered nor dropped. */
const PENDING = "delivered_at IS NULL AND dropped_at IS NULL";

/** Why a task.created is never sent once its task stopped being active. */
export const TASK_ENDED_BEFORE_DELIVERY = "the task ended before it was delivered";

export class InboundRepository {
  constructor(private readonly q: Queryable) {}

  /** Store an event for the Dot's guest; `taskId` and `runId` tie a task.created or a cancel to its task. */
  async enqueue(dotId: string, event: InboundEvent, refs: { taskId?: string; runId?: string } = {}): Promise<InboundRecord> {
    const { rows } = await this.q.query<InboundRow>(
      `INSERT INTO inbound_events (id, dot_id, type, data, ts, task_id, run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [event.id, dotId, event.type, JSON.stringify(event.data), event.ts, refs.taskId ?? null, refs.runId ?? null],
    );
    return toRecord(rows[0]!);
  }

  async get(id: string): Promise<InboundRecord | null> {
    const { rows } = await this.q.query<InboundRow>("SELECT * FROM inbound_events WHERE id = $1", [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** The Dot's rows still to deliver, in the order they must reach the guest. */
  async pending(dotId: string): Promise<InboundRecord[]> {
    const { rows } = await this.q.query<InboundRow>(
      `SELECT * FROM inbound_events WHERE dot_id = $1 AND ${PENDING} ORDER BY seq`,
      [dotId],
    );
    return rows.map(toRecord);
  }

  /**
   * Dots with a pending row that may be tried again now: it has failed fewer
   * than `maxFailures` times and its retry time has come. A row that used up
   * its attempts waits for the Dot's next READY instead.
   */
  async dueDots(maxFailures: number): Promise<string[]> {
    const { rows } = await this.q.query<{ dot_id: string }>(
      `SELECT DISTINCT dot_id FROM inbound_events
        WHERE ${PENDING} AND failures < $1 AND (retry_at IS NULL OR retry_at <= now())
        ORDER BY dot_id`,
      [maxFailures],
    );
    return rows.map((r) => r.dot_id);
  }

  /**
   * Decide, in one statement, that the row goes out now: "send" when it
   * is still pending and, for a task.created, its task is still active;
   * "skip" otherwise. A task.created whose task ended (a cancel that won the
   * race) is dropped here, so it is never sent. `sent_at` records that the
   * guest may hold the event from now on, which is what a cancel reads.
   */
  async beginSend(id: string): Promise<"send" | "skip"> {
    const { rows } = await this.q.query(
      `UPDATE inbound_events i SET sent_at = COALESCE(i.sent_at, now())
        WHERE i.id = $1 AND i.delivered_at IS NULL AND i.dropped_at IS NULL
          AND (i.type <> 'task.created'
               OR EXISTS (SELECT 1 FROM tasks t WHERE t.id = i.task_id AND t.status IN ('RUNNING', 'WAITING_APPROVAL')))
        RETURNING i.seq`,
      [id],
    );
    if (rows.length > 0) return "send";
    await this.q.query(
      `UPDATE inbound_events SET dropped_at = now(), drop_reason = $2
        WHERE id = $1 AND type = 'task.created' AND ${PENDING}`,
      [id, TASK_ENDED_BEFORE_DELIVERY],
    );
    return "skip";
  }

  /** The guest accepted the event (202); a task.created also marks its run delivered, in the same statement. */
  async markDelivered(id: string): Promise<void> {
    await this.q.query(
      `WITH delivered AS (
         UPDATE inbound_events SET delivered_at = now(), last_error = NULL, retry_at = NULL WHERE id = $1 RETURNING run_id
       )
       UPDATE task_runs r SET delivered_at = COALESCE(r.delivered_at, now()) FROM delivered d WHERE r.id = d.run_id`,
      [id],
    );
  }

  /** A failed send whose outcome is known; returns how many such failures the row has now. */
  async recordFailure(id: string, error: string, retryAt: Date | null): Promise<number> {
    const { rows } = await this.q.query<{ failures: number }>(
      "UPDATE inbound_events SET failures = failures + 1, last_error = $2, retry_at = $3 WHERE id = $1 RETURNING failures",
      [id, error.slice(0, 2000), retryAt],
    );
    return rows[0]?.failures ?? 0;
  }

  /** A send whose outcome is unknown: retried later, never counted as a failure. */
  async postpone(id: string, error: string, retryAt: Date | null): Promise<void> {
    await this.q.query("UPDATE inbound_events SET last_error = $2, retry_at = $3 WHERE id = $1", [id, error.slice(0, 2000), retryAt]);
  }

  /** Give a row up for good. */
  async drop(id: string, reason: string): Promise<void> {
    await this.q.query(`UPDATE inbound_events SET dropped_at = now(), drop_reason = $2 WHERE id = $1 AND ${PENDING}`, [id, reason]);
  }

  /**
   * Drop the task.created of a cancelled task if no send of it ever began;
   * true when that happened, which means the guest never heard of the task.
   * False means the guest may hold it, so the cancel has to reach the guest.
   */
  async dropUnsent(taskId: string, reason: string): Promise<boolean> {
    const { rows } = await this.q.query(
      `UPDATE inbound_events SET dropped_at = now(), drop_reason = $2
        WHERE task_id = $1 AND type = 'task.created' AND sent_at IS NULL AND ${PENDING}
        RETURNING seq`,
      [taskId, reason],
    );
    return rows.length > 0;
  }

  /** Every row of a Dot, oldest first (tests and diagnostics). */
  async list(dotId: string): Promise<InboundRecord[]> {
    const { rows } = await this.q.query<InboundRow>("SELECT * FROM inbound_events WHERE dot_id = $1 ORDER BY seq", [dotId]);
    return rows.map(toRecord);
  }
}
