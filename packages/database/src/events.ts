import { MAX_EVENT_PAGE, USAGE_EVENT_TYPES, type EventSource, type ListOrder, type OutboundEvent, type StoredEvent } from "@invisible-dots/shared";
import { isoRequired, type Queryable } from "./rows.js";

interface EventRow {
  id: number;
  dot_id: string;
  type: string;
  data: Record<string, unknown>;
  source: EventSource;
  guest_seq: number | null;
  created_at: Date;
}

function toStored(row: EventRow): StoredEvent {
  return {
    id: row.id,
    dot_id: row.dot_id,
    type: row.type as StoredEvent["type"],
    data: row.data,
    source: row.source,
    guest_seq: row.guest_seq,
    created_at: isoRequired(row.created_at),
  };
}

export interface EventQuery {
  /** Only events of this Dot; every Dot when omitted. */
  dotId?: string;
  /** Only events with an id greater than this. */
  after?: number;
  /** Only events with an id less than this: the page that goes on, older, from the oldest row of the last one. Needs `order: "desc"`. */
  before?: number;
  /** Only these types. */
  types?: readonly string[];
  /** Only the events of this task (`data.task_id`). */
  taskId?: string;
  /** Narrows the `tool.called` events to those of these tools (`data.tool`); events of other types are not affected. */
  tools?: readonly string[];
  /** At most this many (default 500). */
  limit?: number;
  /** `asc` (the default) is the oldest first; `desc` the newest first, so a limit keeps the newest. */
  order?: ListOrder;
}

/**
 * Key of the transaction-scoped advisory lock every event insert takes
 * before its id is drawn ("idots-ev" in ASCII). A bigserial id is assigned
 * at insert but becomes visible at commit, so without it a transaction that
 * drew id 10 could commit after another that drew 11, and a stream resumed
 * with `after=11` would never replay 10. Holding the lock from the draw to
 * the commit makes ids visible in id order on PostgreSQL; PGlite runs one
 * transaction at a time anyway and takes the same lock uncontended.
 *
 * The lock is held until the surrounding transaction ends, so a transaction
 * that inserts an event and changes other rows inserts the event FIRST:
 * taking this lock while holding a row lock another event writer waits for
 * would deadlock.
 */
export const EVENT_ORDER_LOCK_KEY = 0x69646f74732d6576n;

/** The lock, taken inside the INSERT itself so it holds in autocommit and in a transaction alike. */
const LOCKED = `FROM (SELECT pg_advisory_xact_lock(${EVENT_ORDER_LOCK_KEY.toString()})) AS event_order_lock`;

export class EventsRepository {
  constructor(private readonly q: Queryable) {}

  async insertHost(dotId: string, type: string, data: Record<string, unknown>): Promise<StoredEvent> {
    const { rows } = await this.q.query<EventRow>(
      `INSERT INTO events (dot_id, type, data, source) SELECT $1::text, $2::text, $3::jsonb, 'host' ${LOCKED} RETURNING *`,
      [dotId, type, JSON.stringify(data)],
    );
    return toStored(rows[0]!);
  }

  /**
   * Store a `user.message`. One that came through a channel is identified by its Dot, its binding and
   * the channel's own message id (`events_user_message_origin_key`): a redelivery of the same message is
   * not stored again and null comes back, in the same statement and so in the same transaction as the
   * row it would have been, which is what makes a redelivery after any failure harmless.
   */
  async insertUserMessage(dotId: string, data: Record<string, unknown>): Promise<StoredEvent | null> {
    const { rows } = await this.q.query<EventRow>(
      `INSERT INTO events (dot_id, type, data, source) SELECT $1::text, 'user.message', $2::jsonb, 'host' ${LOCKED}
       ON CONFLICT (dot_id, (data->'origin'->>'binding_id'), (data->'origin'->>'external_id'))
         WHERE type = 'user.message' AND data->'origin' IS NOT NULL DO NOTHING RETURNING *`,
      [dotId, JSON.stringify(data)],
    );
    return rows[0] ? toStored(rows[0]) : null;
  }

  /**
   * Store a guest event. The guest replays from the cursor after every
   * reconnect, so the same `seq` can arrive twice: the second copy is
   * dropped and null comes back.
   */
  async insertGuest(dotId: string, event: OutboundEvent): Promise<StoredEvent | null> {
    // The guest's own event id and timestamp are kept inside data, so nothing it sent is lost.
    const data = { ...event.data, guest_event_id: event.id, guest_ts: event.ts };
    const { rows } = await this.q.query<EventRow>(
      `INSERT INTO events (dot_id, type, data, source, guest_seq) SELECT $1::text, $2::text, $3::jsonb, 'guest', $4::bigint ${LOCKED}
       ON CONFLICT (dot_id, guest_seq) DO NOTHING RETURNING *`,
      [dotId, event.type, JSON.stringify(data), event.seq],
    );
    return rows[0] ? toStored(rows[0]) : null;
  }

  async list(query: EventQuery = {}): Promise<StoredEvent[]> {
    const limit = Math.min(Math.max(query.limit ?? 500, 1), MAX_EVENT_PAGE);
    // The task filter is added only when asked for, so no plan has to serve a task id that may be NULL. The other
    // filters are the `$n IS NULL OR ...` form: the statement is planned with its values known (it is never a
    // prepared one that is reused), so those branches fold away and events_task_idx stays usable. The test of
    // events in repositories.test.ts EXPLAINs the statement this builds, on both adapters.
    const params: unknown[] = [query.dotId ?? null, query.after ?? 0, query.types ? [...query.types] : null];
    let taskFilter = "";
    if (query.taskId !== undefined) {
      params.push(query.taskId);
      taskFilter = `AND data->>'task_id' = $${params.length}`;
    }
    let beforeFilter = "";
    if (query.before !== undefined) {
      if (query.order !== "desc") throw new Error("events: `before` pages a list in order desc");
      params.push(query.before);
      beforeFilter = `AND id < $${params.length}`;
    }
    let toolFilter = "";
    if (query.tools !== undefined) {
      params.push([...query.tools]);
      toolFilter = `AND (type <> 'tool.called' OR data->>'tool' = ANY($${params.length}))`;
    }
    params.push(limit);
    const { rows } = await this.q.query<EventRow>(
      `SELECT * FROM events
        WHERE ($1::text IS NULL OR dot_id = $1)
          AND id > $2
          AND ($3::text[] IS NULL OR type = ANY($3))
          ${taskFilter}
          ${toolFilter}
          ${beforeFilter}
        ORDER BY id ${query.order === "desc" ? "DESC" : ""}
        LIMIT $${params.length}`,
      params,
    );
    return rows.map(toStored);
  }

  /** The `user.message` event whose data carries this message id, or null. */
  async userMessage(dotId: string, messageId: string): Promise<StoredEvent | null> {
    const { rows } = await this.q.query<EventRow>(
      "SELECT * FROM events WHERE dot_id = $1 AND type = 'user.message' AND data->>'message_id' = $2 LIMIT 1",
      [dotId, messageId],
    );
    return rows[0] ? toStored(rows[0]) : null;
  }

  /** The `user.message` of the Dot that came through this binding as the channel's own message `externalId`, or null. */
  async userMessageOfOrigin(dotId: string, bindingId: string, externalId: string): Promise<StoredEvent | null> {
    const { rows } = await this.q.query<EventRow>(
      `SELECT * FROM events WHERE dot_id = $1 AND type = 'user.message' AND data->'origin' IS NOT NULL
         AND data->'origin'->>'binding_id' = $2 AND data->'origin'->>'external_id' = $3`,
      [dotId, bindingId, externalId],
    );
    return rows[0] ? toStored(rows[0]) : null;
  }

  /** The newest events of a Dot, returned oldest first (for `logs`-style tails). */
  async tail(dotId: string, count: number): Promise<StoredEvent[]> {
    const { rows } = await this.q.query<EventRow>(
      "SELECT * FROM (SELECT * FROM events WHERE dot_id = $1 ORDER BY id DESC LIMIT $2) t ORDER BY id",
      [dotId, Math.min(Math.max(count, 1), MAX_EVENT_PAGE)],
    );
    return rows.map(toStored);
  }

  /**
   * The USD the Dot's guest reported spending, summed over the events of `USAGE_EVENT_TYPES` stored
   * at or after `since` (every one when omitted). The event log is the one record of it: nothing
   * else keeps a running total.
   */
  async spentUsd(dotId: string, since?: Date): Promise<number> {
    const { rows } = await this.q.query<{ usd: number }>(
      `SELECT COALESCE(SUM((data->>'spent_usd')::double precision), 0) AS usd FROM events
        WHERE dot_id = $1 AND source = 'guest' AND type = ANY($2) AND ($3::timestamptz IS NULL OR created_at >= $3)`,
      [dotId, [...USAGE_EVENT_TYPES], since ?? null],
    );
    // A float sum shows its noise (0.1 + 0.2): the engine reports to the hundred-millionth of a USD.
    return Math.round(Number(rows[0]!.usd) * 1e8) / 1e8;
  }
}
