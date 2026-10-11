/**
 * Reading a Dot's event log through the one route that serves it, `GET /api/dots/:id/events`, which keeps the types
 * (and the task) a caller names in the database so only those cross the wire. No client reads the whole log of a Dot:
 * that costs more with every day it lives. The web client's views and `invisible-dots logs` read what they show,
 * bounded on one side: the events of one task (`taskId`), the events from a point on (`readEventLog` with `after`),
 * the range between two points (`readEventRange`), or the newest window (`readRecentEvents`, which the Activity page
 * goes on from, older, a page at a time, with a `before`). Each says which types it reads and, where a type alone is
 * not enough, what else an event must be.
 */
import { MAX_EVENT_PAGE, type StoredEvent } from "@invisible-dots/shared/browser";
import type { InvisibleDotsClient } from "./client.js";

export interface EventLogQuery {
  /** The event type names to read (every type when omitted or empty); the control plane refuses a name it does not know. */
  types?: readonly string[];
  /** Narrows the `tool.called` events to those of these tools (`data.tool`), in the database; other types are not affected. */
  tools?: readonly string[];
  /** Only the events of this task (`data.task_id`), in the database. */
  taskId?: string;
  /** For what a type alone cannot say (a `tool.called` of the chat is one that names no task). */
  keep?: (event: StoredEvent) => boolean;
}

/** Every event of the Dot's log of those types that `keep` accepts, oldest first, with an id above `after` (the whole log when omitted). It is read page by page, from `after` on. */
export async function readEventLog(client: Pick<InvisibleDotsClient, "events">, dotId: string, query: EventLogQuery & { after?: number }): Promise<StoredEvent[]> {
  const found: StoredEvent[] = [];
  let after = query.after ?? 0;
  for (;;) {
    const page = await client.events(dotId, { after, limit: MAX_EVENT_PAGE, types: query.types, tools: query.tools, taskId: query.taskId });
    for (const event of page) if (query.keep?.(event) ?? true) found.push(event);
    if (page.length < MAX_EVENT_PAGE) return found;
    after = page[page.length - 1]!.id;
  }
}

/**
 * The events of the log that the types and tools keep, and `keep` accepts, with an id above `after` and below `before`,
 * oldest first: a range of the log read from its end, newest page first, so what is older than `after` is never read.
 */
export async function readEventRange(
  client: Pick<InvisibleDotsClient, "events">,
  dotId: string,
  query: EventLogQuery & { after: number; before: number },
): Promise<StoredEvent[]> {
  const found: StoredEvent[] = [];
  let before = query.before;
  for (;;) {
    const page = await client.events(dotId, { after: query.after, before, limit: MAX_EVENT_PAGE, types: query.types, tools: query.tools, taskId: query.taskId, order: "desc" });
    for (const event of page) if (query.keep?.(event) ?? true) found.push(event);
    if (page.length < MAX_EVENT_PAGE) return found.reverse();
    before = page[page.length - 1]!.id;
  }
}

/**
 * The newest `count` events of the log that the types and tools keep, oldest first, in one request: what a view that
 * follows the recent past reads, so the cost does not grow with the age of the Dot. `keep` then drops, from those, what
 * the filters cannot say. With `before` (the id of the oldest event already read) it is the `count` events that came
 * before that one.
 */
export async function readRecentEvents(
  client: Pick<InvisibleDotsClient, "events">,
  dotId: string,
  query: EventLogQuery & { count: number; before?: number },
): Promise<StoredEvent[]> {
  const page = await client.events(dotId, { limit: Math.min(query.count, MAX_EVENT_PAGE), types: query.types, tools: query.tools, taskId: query.taskId, before: query.before, order: "desc" });
  return page.filter((event) => query.keep?.(event) ?? true).reverse();
}

/** Merge new events into a list ordered by id, dropping duplicates (a reconnect can replay some, and a page can overlap the live stream). */
export function mergeEvents(current: readonly StoredEvent[], incoming: readonly StoredEvent[]): StoredEvent[] {
  const byId = new Map<number, StoredEvent>();
  for (const event of current) byId.set(event.id, event);
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}
