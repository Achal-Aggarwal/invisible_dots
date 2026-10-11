"use client";

import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { HealthResponse } from "@invisible-dots/sdk";
import { api } from "../../lib/api";
import { attentionByDot, needsYouCount, NO_ATTENTION, withTitlePrefix, type DotAttention } from "../../lib/attention";
import { readDismissed, writeDismissed } from "../../lib/dismissed";
import { loadRelinks, type ChannelRelink } from "../../lib/channels";
import { loadFailedTasks, recentFailures } from "../../lib/failed-tasks";
import { applyLiveEvent, dismissRestart, dotIdFromPath, liveOf, markRead, type LiveDot, type LiveDots } from "../../lib/dot-live";
import { faviconHref } from "../../lib/favicon";
import type { Approval, Dot, Task } from "../../lib/types";
import { useNow } from "../../lib/use-now";
import { useLiveEvents, useLiveRefresh } from "../events";
import { useResource, type Resource } from "../ui";

const DOT_EVENTS = ["dot.created", "dot.updated", "dot.deleted", "computer.state", "computer.started", "computer.stopped"];
// dot.deleted too: a Dot's delete takes its approvals with it, and no approval.resolved says so.
const APPROVAL_EVENTS = ["approval.requested", "approval.resolved", "task.cancelled", "task.completed", "task.failed", "dot.deleted"];
const FAILED_TASK_EVENTS = ["task.failed"];
const AGENT_EVENTS = ["agent.state", "agent.started"];
const CHANNEL_EVENTS = ["channel.status", "channel.changed"];
const HEALTH_INTERVAL_MS = 30_000;

interface ShellData {
  dots: Resource<Dot[]>;
  approvals: Resource<Approval[]>;
  attention: ReadonlyMap<string, DotAttention>;
  /** What needs the person, across every Dot: waiting approvals, Dots in ERROR, failed tasks and channels to link again. The number on the rail's Inbox entry. */
  needsYou: number;
  /** Tasks that failed in the last 24 hours and are not dismissed, newest first; and whether they could not be read. */
  failedTasks: { tasks: readonly Task[]; unreadable: boolean; loading: boolean };
  /** Channels that need linking again; and whether they could not be read. */
  relinks: { items: readonly ChannelRelink[]; unreadable: boolean; loading: boolean };
  /** Take a failed task out of the Inbox (remembered in this browser). */
  dismissFailedTask: (taskId: string) => void;
  live: LiveDots;
  dismissRestart: (dotId: string) => void;
}

const Context = createContext<ShellData | null>(null);
const HealthContext = createContext<Resource<HealthResponse> | null>(null);

/**
 * What every page of the app shares: the Dots, the approvals that wait, the tasks that failed lately, the channels that
 * need linking again, what the live stream says about each Dot, and whether the control plane answers. The rail, the
 * Dot header, the document title, the favicon and the setup pages
 * all read it, so they agree and the control plane is asked once, not once per component.
 */
export function AttentionProvider({ children }: { children: ReactNode }) {
  const dots = useResource(() => api.listDots(), "shell:dots");
  const approvals = useResource(() => api.listApprovals("pending"), "shell:approvals");
  const health = useResource(() => api.health(), "shell:health");
  const failed = useResource<Task[]>(() => loadFailedTasks(api), "shell:failed");
  const channels = useResource<ChannelRelink[]>(() => loadRelinks(api), "shell:channels");
  const reloadHealth = health.reload;
  useEffect(() => {
    const timer = setInterval(reloadHealth, HEALTH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [reloadHealth]);
  useLiveRefresh(dots.reload, DOT_EVENTS);
  useLiveRefresh(approvals.reload, APPROVAL_EVENTS);
  useLiveRefresh(failed.reload, FAILED_TASK_EVENTS);
  useLiveRefresh(channels.reload, CHANNEL_EVENTS);

  const openDotId = dotIdFromPath(usePathname() ?? "");
  const [live, setLive] = useState<LiveDots>({});
  useLiveEvents((event) => setLive((current) => applyLiveEvent(current, event, openDotId)));
  useEffect(() => {
    if (openDotId) setLive((current) => markRead(current, openDotId));
  }, [openDotId]);
  // A page opened in the middle of a turn: the stream says nothing of what began before it, so the newest agent event
  // of the log is read, for the Dot whose page is open and whose computer runs (a stopped one has no agent).
  const openRuns = openDotId !== null && (dots.data ?? []).some((dot) => (dot.id === openDotId || dot.name === openDotId) && dot.computer_state === "RUNNING");
  useEffect(() => {
    if (!openDotId || !openRuns) return;
    let current = true;
    api.events(openDotId, { types: AGENT_EVENTS, limit: 1, order: "desc" }).then(
      ([newest]) => {
        if (current && newest) setLive((now) => applyLiveEvent(now, newest, openDotId));
      },
      () => {
        // The state of the agent is a convenience: the stored status of the Dot says what it can.
      },
    );
    return () => {
      current = false;
    };
  }, [openDotId, openRuns]);

  // Dismissals are read after mount: the server render has no storage, and the first render must match it.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const dismissedNow = useRef(dismissed);
  useEffect(() => {
    dismissedNow.current = readDismissed();
    setDismissed(dismissedNow.current);
  }, []);
  const dismissFailedTask = useCallback((taskId: string) => {
    dismissedNow.current = new Set(dismissedNow.current).add(taskId);
    writeDismissed(dismissedNow.current);
    setDismissed(dismissedNow.current);
  }, []);
  // A failure leaves the Inbox a day after it happened, without anyone reloading anything.
  const now = Math.floor(useNow(60_000) / 60_000);
  const recent = useMemo(() => recentFailures(failed.data ?? [], dismissed, now * 60_000), [failed.data, dismissed, now]);
  const failedTasks = useMemo(() => ({ tasks: recent, unreadable: failed.error !== null, loading: failed.data === undefined && failed.error === null }), [recent, failed.data, failed.error]);

  const relinks = useMemo(
    () => ({ items: channels.data ?? [], unreadable: channels.error !== null, loading: channels.data === undefined && channels.error === null }),
    [channels.data, channels.error],
  );

  const attention = useMemo(() => attentionByDot(dots.data ?? [], approvals.data ?? [], recent, relinks.items), [dots.data, approvals.data, recent, relinks.items]);
  const needsYou = needsYouCount(attention);
  useTitleAndFavicon(needsYou);

  const dismiss = useCallback((dotId: string) => setLive((current) => dismissRestart(current, dotId)), []);
  const value = useMemo<ShellData>(
    () => ({ dots, approvals, attention, needsYou, failedTasks, relinks, dismissFailedTask, live, dismissRestart: dismiss }),
    [dots, approvals, attention, needsYou, failedTasks, relinks, dismissFailedTask, live, dismiss],
  );
  // The health is a context of its own: its poll every 30 seconds re-renders what reads it, not every user of the shell.
  return (
    <HealthContext.Provider value={health}>
      <Context.Provider value={value}>{children}</Context.Provider>
    </HealthContext.Provider>
  );
}

/** The control plane's answer, asked every 30 seconds and again on `reload()` (after a key is saved). */
export function useHealth(): Resource<HealthResponse> {
  const value = useContext(HealthContext);
  if (!value) throw new Error("useHealth must be used inside AttentionProvider");
  return value;
}

export function useShell(): ShellData {
  const value = useContext(Context);
  if (!value) throw new Error("useShell must be used inside AttentionProvider");
  return value;
}

export function useDotAttention(dotId: string): DotAttention {
  return useShell().attention.get(dotId) ?? NO_ATTENTION;
}

export function useDotLive(dotId: string): LiveDot {
  return liveOf(useShell().live, dotId);
}

/** "(3) " in the tab title and a second dot on the favicon while something needs the person. */
function useTitleAndFavicon(needsYou: number): void {
  useEffect(() => {
    const apply = () => {
      const next = withTitlePrefix(document.title, needsYou);
      if (next !== document.title) document.title = next;
    };
    apply();
    // Next writes a new title on every navigation: put the prefix back each time.
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      document.title = withTitlePrefix(document.title, 0);
    };
  }, [needsYou]);

  const attentive = needsYou > 0;
  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "icon";
    link.type = "image/svg+xml";
    link.href = faviconHref(attentive);
    document.head.append(link);
    return () => link.remove();
  }, [attentive]);
}
