/**
 * The host event log (architecture sections 5.4 and 9.1): every host and
 * guest event is a row of `events`, and every row that is written is also
 * handed to the live subscribers behind `GET /api/stream`.
 *
 * The fan-out is in-process. The control plane is one process (section 2),
 * so every writer and every SSE connection share this object, and PostgreSQL
 * LISTEN/NOTIFY would add a second delivery path that could only disagree
 * with this one. If the control plane is ever split into several processes,
 * `publish` is the one place that has to become a NOTIFY.
 */
import type { EventQuery, EventsRepository, Queryable } from "@invisible-dots/database";
import type { HostEventDataMap, HostEventType, MessageOrigin, OutboundEvent, StoredEvent } from "@invisible-dots/shared";

/**
 * Type of the event a user message is logged as. The conversation of
 * `GET /api/dots/:id/messages` is rebuilt from the log, so the user's side has
 * to be in it; the name matches the inbound event the guest receives.
 */
export const USER_MESSAGE_EVENT = "user.message";

export interface UserMessageData {
  message_id: string;
  text: string;
  /** Set when the message came through a channel; absent for the control plane's own API (the web, the CLI, the SDK). */
  origin?: MessageOrigin;
}

export interface EventFilter {
  /** Only events of this Dot. */
  dotId?: string;
}

export type EventListener = (event: StoredEvent) => void;

/** How many events a slow stream may fall behind before it is ended (the client resumes with its last id). */
export const DEFAULT_STREAM_BUFFER = 10_000;

export class StreamOverflowError extends Error {
  constructor(readonly lastId: number) {
    super(`the event stream fell more than ${DEFAULT_STREAM_BUFFER} events behind; resume after id ${lastId}`);
    this.name = "StreamOverflowError";
  }
}

interface Subscriber {
  filter: EventFilter;
  listener: EventListener;
}

function matches(filter: EventFilter, event: StoredEvent): boolean {
  return filter.dotId === undefined || filter.dotId === event.dot_id;
}

/** The part of the events repository the log needs; tests can hand in an in-memory one. */
export type EventStore = Pick<EventsRepository, "insertHost" | "insertUserMessage" | "list" | "tail" | "userMessage" | "userMessageOfOrigin">;

export class EventLog {
  readonly #subscribers = new Set<Subscriber>();

  constructor(
    private readonly repo: EventStore,
    private readonly log: (line: string) => void = () => {},
  ) {}

  /** Write a host event and publish it. */
  async appendHost<T extends HostEventType>(dotId: string, type: T, data: HostEventDataMap[T]): Promise<StoredEvent> {
    const event = await this.repo.insertHost(dotId, type, data as Record<string, unknown>);
    this.publish(event);
    return event;
  }

  /** Write a user message (see USER_MESSAGE_EVENT) and publish it; null when it is a channel message already logged. */
  async appendUserMessage(dotId: string, data: UserMessageData): Promise<StoredEvent | null> {
    const event = await this.appendUserMessageIn({ events: this.repo }, dotId, data);
    if (event) this.publish(event);
    return event;
  }

  /**
   * Write a host event through `tx` (the caller's transaction) WITHOUT
   * publishing it, for a host event that must commit together with other
   * rows; the caller publishes the result after COMMIT, as for guest events.
   */
  async appendHostIn<T extends HostEventType>(
    tx: { events: Pick<EventsRepository, "insertHost"> },
    dotId: string,
    type: T,
    data: HostEventDataMap[T],
  ): Promise<StoredEvent> {
    return tx.events.insertHost(dotId, type, data as Record<string, unknown>);
  }

  /**
   * `appendUserMessage` through the caller's transaction, published by the caller after COMMIT. A message
   * that came through a channel is stored once per Dot, binding and channel message id: null means this one was already logged.
   */
  async appendUserMessageIn(
    tx: { events: Pick<EventsRepository, "insertUserMessage"> },
    dotId: string,
    data: UserMessageData,
  ): Promise<StoredEvent | null> {
    return tx.events.insertUserMessage(dotId, { ...data });
  }

  /**
   * Write a guest event through `tx` (the caller's transaction) WITHOUT
   * publishing it: a subscriber must never see an event whose transaction
   * may still roll back. The caller publishes the result after COMMIT. Null
   * means the event was already stored (a replay after a reconnect).
   */
  async appendGuest(
    tx: { events: Pick<EventsRepository, "insertGuest"> },
    dotId: string,
    event: OutboundEvent,
  ): Promise<StoredEvent | null> {
    return tx.events.insertGuest(dotId, event);
  }

  query(query: EventQuery): Promise<StoredEvent[]> {
    return this.repo.list(query);
  }

  tail(dotId: string, count: number): Promise<StoredEvent[]> {
    return this.repo.tail(dotId, count);
  }

  /** The logged `user.message` of the Dot that came through this binding as the channel's own message `externalId`, or null. */
  userMessageOfOrigin(dotId: string, bindingId: string, externalId: string): Promise<StoredEvent | null> {
    return this.repo.userMessageOfOrigin(dotId, bindingId, externalId);
  }

  /** The logged `user.message` of this message id (the `in_reply_to` of an answer), or null. */
  userMessage(dotId: string, messageId: string): Promise<StoredEvent | null> {
    return this.repo.userMessage(dotId, messageId);
  }

  /** Hand a stored event to every matching subscriber. A throwing listener does not stop the others. */
  publish(event: StoredEvent): void {
    for (const sub of this.#subscribers) {
      if (!matches(sub.filter, event)) continue;
      try {
        sub.listener(event);
      } catch (error) {
        this.log(`[events] subscriber failed on event ${event.id}: ${(error as Error).message}`);
      }
    }
  }

  subscribe(filter: EventFilter, listener: EventListener): () => void {
    const sub: Subscriber = { filter, listener };
    this.#subscribers.add(sub);
    return () => {
      this.#subscribers.delete(sub);
    };
  }

  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  /**
   * Every stored event after `after`, then every new one, with no gap and no
   * duplicate at the hand-over: the subscription starts before the replay
   * query, and live events the replay already returned are skipped. Ends when
   * `signal` aborts; throws StreamOverflowError when the consumer falls too
   * far behind.
   */
  async *stream(
    filter: EventFilter,
    options: { after?: number; signal?: AbortSignal; bufferLimit?: number } = {},
  ): AsyncGenerator<StoredEvent> {
    const limit = options.bufferLimit ?? DEFAULT_STREAM_BUFFER;
    const queue: StoredEvent[] = [];
    let overflowed = false;
    let wake: (() => void) | null = null;
    const notify = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    const unsubscribe = this.subscribe(filter, (event) => {
      if (queue.length >= limit) {
        overflowed = true;
      } else {
        queue.push(event);
      }
      notify();
    });
    options.signal?.addEventListener("abort", notify, { once: true });

    let lastId = options.after ?? 0;
    try {
      if (options.after !== undefined) {
        for (;;) {
          const page = await this.repo.list({ dotId: filter.dotId, after: lastId, limit: 500 });
          for (const event of page) {
            if (options.signal?.aborted) return;
            lastId = Math.max(lastId, event.id);
            yield event;
          }
          if (page.length < 500) break;
        }
      }
      // Ids become visible in id order (database events.ts), so every event up to the last one the replay read was
      // visible to it: a live event at or below it was replayed (or is before `after`), one above it is new.
      const replayedThrough = lastId;
      for (;;) {
        if (options.signal?.aborted) return;
        if (overflowed) throw new StreamOverflowError(lastId);
        const next = queue.shift();
        if (next === undefined) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          continue;
        }
        if (next.id <= replayedThrough) continue;
        lastId = Math.max(lastId, next.id);
        yield next;
      }
    } finally {
      unsubscribe();
      options.signal?.removeEventListener("abort", notify);
    }
  }
}

export type { EventQuery, Queryable };
