"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIcon } from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/utils";
import type { StoredEvent } from "../lib/types";
import { StatusIcon } from "./shell/StatusIcon";

export type StreamStatus = "connecting" | "open" | "reconnecting" | "closed";

type Listener = (event: StoredEvent) => void;

interface StreamContext {
  subscribe: (listener: Listener) => () => void;
  status: StreamStatus;
  detail: string;
}

const Context = createContext<StreamContext | null>(null);

/** The Dot whose page is open, when one is: what its components hear is limited to that Dot's events. */
const ScopeContext = createContext<string | null>(null);

/** Limit `useLiveEvents` and `useLiveRefresh` below to the events of one Dot. */
export function DotEventScope({ dotId, children }: { dotId: string; children: ReactNode }) {
  return <ScopeContext.Provider value={dotId}>{children}</ScopeContext.Provider>;
}

/** One SSE connection for every Dot, kept for as long as the app's pages are open and shared by every component below it. */
export function EventStreamProvider({ children }: { children: ReactNode }) {
  const listeners = useRef(new Set<Listener>());
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [detail, setDetail] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setStatus("connecting");
    setDetail("");
    void (async () => {
      try {
        // The SDK reconnects by itself and resumes after the last event it delivered.
        for await (const event of api.stream({
          signal: controller.signal,
          onOpen: () => {
            setStatus("open");
            setDetail("");
          },
          onReconnect: ({ error }) => {
            setStatus("reconnecting");
            setDetail(error.message);
          },
        })) {
          for (const listener of listeners.current) listener(event);
        }
        setStatus("closed");
      } catch (error) {
        // Only an answer that retrying cannot fix ends the stream (a 4xx such as a refused origin).
        setStatus("closed");
        setDetail((error as Error).message);
      }
    })();
    return () => controller.abort();
  }, []);

  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);
  const value = useMemo<StreamContext>(() => ({ subscribe, status, detail }), [subscribe, status, detail]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** Whether the live stream is up, and why it is not when it is not. */
export function useStreamStatus(): { status: StreamStatus; detail: string } {
  const context = useContext(Context);
  return { status: context?.status ?? "connecting", detail: context?.detail ?? "" };
}

/**
 * Call `onEvent` for each live event whose type matches `types` (all when
 * omitted), and, below a DotEventScope, that belongs to the scope's Dot. The
 * latest callback is used without resubscribing.
 */
export function useLiveEvents(onEvent: Listener, types?: readonly string[]): void {
  const subscribe = useContext(Context)?.subscribe;
  const scope = useContext(ScopeContext);
  const callback = useRef(onEvent);
  useEffect(() => {
    callback.current = onEvent;
  });
  const key = types?.join(",") ?? "";
  useEffect(() => {
    if (!subscribe) return;
    const wanted = key ? new Set(key.split(",")) : null;
    return subscribe((event) => {
      if (scope !== null && event.dot_id !== scope) return;
      if (!wanted || wanted.has(event.type)) callback.current(event);
    });
  }, [subscribe, key, scope]);
}

/** Like useLiveEvents, but coalesces bursts into one call `delayMs` after the last event. */
export function useLiveRefresh(refresh: () => void, types: readonly string[], delayMs = 300): void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(refresh);
  useEffect(() => {
    latest.current = refresh;
  });
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  useLiveEvents(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => latest.current(), delayMs);
  }, types);
}

const STREAM_LABEL: Record<StreamStatus, string> = {
  open: "Live",
  closed: "Offline",
  connecting: "Connecting",
  reconnecting: "Reconnecting",
};

const STREAM_DOT: Record<StreamStatus, string> = {
  open: "bg-ok",
  closed: "bg-danger",
  connecting: "bg-muted-foreground",
  reconnecting: "bg-warn",
};

/** Whether live updates reach this page: an icon with a colored dot, the word (and why, when it is not live) on hover. */
export function StreamIndicator() {
  const context = useContext(Context);
  if (!context) return null;
  const label = STREAM_LABEL[context.status];
  return (
    <StatusIcon icon={ActivityIcon} dotClassName={STREAM_DOT[context.status]} tooltip={[`Live updates: ${label}`, context.detail].filter(Boolean).join(" · ")}>
      <span>Updates: </span>
      {label}
    </StatusIcon>
  );
}
