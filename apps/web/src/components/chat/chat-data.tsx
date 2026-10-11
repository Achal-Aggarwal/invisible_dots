"use client";

import { readEventLog, readEventRange, readRecentEvents } from "@invisible-dots/sdk";
import { MAX_EVENT_PAGE } from "@invisible-dots/shared/browser";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api";
import { buildThread, CHAT_ACTIVITY_EVENT_TYPES, isChatActivityEvent, mergeChatEvents, unsettled, type PendingMessage, type ThreadItem } from "../../lib/chat-thread";
import { CHAT_PAGE_SIZE, withEarlierPage, withNewestPage, type ChatWindow } from "../../lib/chat-window";
import { CHAT_EVENT_TYPES } from "../../lib/messages";
import type { ChatMessage, StoredEvent } from "../../lib/types";
import { useLiveEvents, useLiveRefresh } from "../events";

export type ActivityStatus = "loading" | "loaded" | "failed";

export interface Chat {
  /** The newest messages, and the older ones asked for, oldest first; `data` is undefined until the first page is read. */
  messages: { data: ChatMessage[] | undefined; error: unknown };
  /** Messages older than those held: whether there may be some, whether they are being read, and why that failed. */
  earlier: { available: boolean; loading: boolean; error: unknown; load: () => void };
  thread: ThreadItem[];
  /** Messages sent from this page that the log does not hold yet, oldest first. */
  pending: PendingMessage[];
  /** The logged messages that were stored while the computer had to wake up, until the Dot picks up its work. */
  queued: ReadonlySet<number>;
  activity: { status: ActivityStatus; error: unknown; retry: () => void };
  /** Send a message; resolves with the error when it was not accepted, null when it was. */
  send: (text: string) => Promise<unknown>;
  sending: boolean;
}

const WAKES_THE_DOT = ["agent.state", "message.assistant"];

/**
 * Everything the chat shows, kept current by the live stream: the conversation (the newest page of the messages
 * route, and older pages on request), what the Dot did between those messages (the event log from the oldest message
 * shown on, then followed live), and what the person has just sent. What opening the chat costs is a page of messages
 * and the activity since, whatever the age of the Dot. A sent message shows at once and is replaced by the logged
 * one, which the API names by its event id.
 */
export function useChat(dotId: string): Chat {
  const [held, setHeld] = useState<ChatWindow | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const newestGeneration = useRef(0);
  const readNewest = useCallback(() => {
    const mine = ++newestGeneration.current;
    api
      .messages(dotId, { order: "desc", limit: CHAT_PAGE_SIZE })
      .then((page) => {
        if (mine !== newestGeneration.current) return;
        setHeld((current) => withNewestPage(current, page.reverse()));
        setError(null);
      })
      .catch((failure: unknown) => {
        if (mine === newestGeneration.current) setError(failure);
      });
  }, [dotId]);
  useEffect(() => {
    readNewest();
    return () => {
      newestGeneration.current++;
    };
  }, [readNewest]);
  useLiveRefresh(readNewest, CHAT_EVENT_TYPES);

  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierError, setEarlierError] = useState<unknown>(null);
  const loadEarlier = useCallback(() => {
    const oldest = held?.messages[0]?.event_id;
    if (oldest === undefined || loadingEarlier) return;
    setLoadingEarlier(true);
    setEarlierError(null);
    api
      .messages(dotId, { order: "desc", limit: CHAT_PAGE_SIZE, before: oldest })
      .then((page) => setHeld((current) => (current === undefined ? current : withEarlierPage(current, page.reverse()))))
      .catch(setEarlierError)
      .finally(() => setLoadingEarlier(false));
  }, [dotId, held, loadingEarlier]);

  // The activity is read from the oldest message shown on; going back reads only what lies between.
  const floor = held === undefined ? undefined : (held.messages[0]?.event_id ?? null);
  const [events, setEvents] = useState<readonly StoredEvent[]>([]);
  const [status, setStatus] = useState<ActivityStatus>("loading");
  const [activityError, setActivityError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  /** The lowest event id the events held reach back to; null until a read ended, 0 once the newest page of the log was read because there was no message. */
  const covered = useRef<number | null>(null);

  useLiveEvents((event) => {
    if (isChatActivityEvent(event)) setEvents((current) => mergeChatEvents(current, [event]));
  });

  useEffect(() => {
    if (floor === undefined) return;
    const have = covered.current;
    if (have !== null && (floor === null || floor >= have)) return;
    let current = true;
    setStatus("loading");
    const query = { types: CHAT_ACTIVITY_EVENT_TYPES };
    const read =
      floor === null
        ? readRecentEvents(api, dotId, { ...query, count: MAX_EVENT_PAGE })
        : have === null
          ? readEventLog(api, dotId, { ...query, after: floor })
          : readEventRange(api, dotId, { ...query, after: floor, before: have });
    read
      .then((found) => {
        if (!current) return;
        covered.current = floor ?? 0;
        setEvents((held) => mergeChatEvents(held, found));
        setActivityError(null);
        setStatus("loaded");
      })
      .catch((failure: unknown) => {
        if (!current) return;
        setActivityError(failure);
        setStatus("failed");
      });
    return () => {
      current = false;
    };
  }, [dotId, floor, attempt]);

  const [sent, setSent] = useState<PendingMessage[]>([]);
  const [queued, setQueued] = useState<ReadonlySet<number>>(new Set());
  const [sending, setSending] = useState(false);
  const counter = useRef(0);
  useLiveEvents(() => setQueued((current) => (current.size === 0 ? current : new Set())), WAKES_THE_DOT);

  const logged = held?.messages;
  const pending = useMemo(() => unsettled(sent, logged ?? []), [sent, logged]);
  // What the log holds now is no longer pending: forget it, so the list does not grow for as long as the page is open.
  useEffect(() => {
    if (pending.length !== sent.length) setSent(pending);
  }, [pending, sent.length]);

  const send = useCallback(
    async (text: string): Promise<unknown> => {
      const key = `sent-${++counter.current}`;
      setSent((current) => [...current, { key, text, eventId: null }]);
      setSending(true);
      try {
        const answer = await api.sendMessage(dotId, text);
        setSent((current) => current.map((p) => (p.key === key ? { ...p, eventId: answer.event_id } : p)));
        if (answer.delivery === "queued") setQueued((current) => new Set(current).add(answer.event_id));
        readNewest();
        return null;
      } catch (failure) {
        setSent((current) => current.filter((p) => p.key !== key));
        return failure;
      } finally {
        setSending(false);
      }
    },
    [dotId, readNewest],
  );

  // Steps from before the oldest message shown (left over when a gap in the messages was dropped, see withNewestPage) are not part of what is shown.
  const shown = useMemo(() => (floor === null || floor === undefined ? events : events.filter((event) => event.id > floor)), [events, floor]);
  const thread = useMemo(() => buildThread(logged ?? [], shown), [logged, shown]);
  return {
    messages: { data: logged, error },
    earlier: { available: held?.earlier ?? false, loading: loadingEarlier, error: earlierError, load: loadEarlier },
    thread,
    pending,
    queued,
    activity: { status, error: activityError, retry: () => setAttempt((n) => n + 1) },
    send,
    sending,
  };
}
