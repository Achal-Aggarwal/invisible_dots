"use client";

import { mergeEvents, readRecentEvents } from "@invisible-dots/sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ACTIVITY_PAGE, typesFor } from "../../lib/activity";
import { api } from "../../lib/api";
import type { EventFamily } from "../../lib/events/view";
import type { StoredEvent } from "../../lib/types";
import { useLiveEvents } from "../events";

export interface ActivityLog {
  /** What has been read and what has arrived since, oldest first. */
  events: StoredEvent[];
  error: unknown;
  loading: boolean;
  /** Whether the last page read was full, so the log may hold older events than these. */
  hasOlder: boolean;
  /** Read the page that comes next: the one before the oldest event held, or the newest when none is held (after a failed first read). */
  loadMore: () => void;
}

/**
 * The Dot's event log as the Activity page reads it: the newest page of the families chosen (none chosen is every
 * type), then older pages on request, and what the live stream brings. The control plane cuts by type, so a family
 * that is not chosen does not cross the wire; a live event is kept only if its type is one of those asked for. A
 * change of Dot or of families starts over, and an answer that arrives for the choice before is dropped.
 */
export function useActivityLog(dotId: string, families: readonly EventFamily[]): ActivityLog {
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [hasOlder, setHasOlder] = useState(false);
  // The id of the oldest event read from the log: where "older" goes on from. Live events are newer, so they never move it.
  const oldest = useRef<number | undefined>(undefined);
  const generation = useRef(0);
  const familiesKey = families.join(",");
  const types = useMemo(() => typesFor(familiesKey === "" ? [] : (familiesKey.split(",") as EventFamily[])), [familiesKey]);

  const read = useCallback(
    async (before: number | undefined) => {
      const mine = generation.current;
      setLoading(true);
      try {
        const page = await readRecentEvents(api, dotId, { types: types ?? [], count: ACTIVITY_PAGE, before });
        if (mine !== generation.current) return;
        oldest.current = page[0]?.id ?? oldest.current;
        setEvents((current) => mergeEvents(current, page));
        setHasOlder(page.length >= ACTIVITY_PAGE);
        setError(null);
      } catch (failure) {
        if (mine === generation.current) setError(failure);
      } finally {
        if (mine === generation.current) setLoading(false);
      }
    },
    [dotId, types],
  );

  useEffect(() => {
    generation.current++;
    oldest.current = undefined;
    setEvents([]);
    setHasOlder(false);
    setError(null);
    void read(undefined);
  }, [read]);

  useLiveEvents((event) => setEvents((current) => mergeEvents(current, [event])), types);

  const loadMore = useCallback(() => void read(oldest.current), [read]);
  return { events, error, loading, hasOlder, loadMore };
}
