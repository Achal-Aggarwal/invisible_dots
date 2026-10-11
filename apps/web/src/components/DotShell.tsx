"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { api, ApiError } from "../lib/api";
import type { Dot } from "../lib/types";
import { DotHeader } from "./dot/DotHeader";
import { DotTabs } from "./dot/DotTabs";
import { useLiveRefresh } from "./events";
import { buttonVariants } from "./ui/button";
import { useResource, type Resource } from "./ui";

interface DotContextValue {
  dotId: string;
  dot: Resource<Dot>;
}

const DotContext = createContext<DotContextValue | null>(null);

export function useDot(): DotContextValue {
  const value = useContext(DotContext);
  if (!value) throw new Error("useDot must be used inside DotShell");
  return value;
}

// dot.deleted too: a delete finishes after the request (its computer stops first), and the page open on the Dot then
// says it does not exist instead of staying on "Deleting".
const HEADER_EVENTS = ["dot.updated", "dot.deleted", "computer.state", "computer.started", "computer.stopped", "agent.state"];

/**
 * The page of one Dot: its header (S4), the tab bar, and the tab's body, which fills the rest of the window and
 * scrolls by itself while the header and the tabs stay.
 *
 * The control plane accepts a Dot's name where it takes an id, but the live stream, the rail and the attention state
 * all name a Dot by its id. So an address that holds a name is replaced by the one that holds the id as soon as the
 * Dot is known, and the tab's body is not drawn under the name: everything below hears this Dot's events.
 */
export function DotShell({ dotId, children }: { dotId: string; children: ReactNode }) {
  const dot = useResource(() => api.getDot(dotId), dotId);
  useLiveRefresh(dot.reload, HEADER_EVENTS);
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const canonical = dot.data !== undefined && dot.data.id !== dotId ? dot.data.id : null;
  useEffect(() => {
    if (canonical === null) return;
    // Only the segment that names the Dot changes; the tab, a task's address and the query stay.
    const address = /^\/dots\/[^/]+/.exec(pathname);
    if (address) router.replace(`/dots/${encodeURIComponent(canonical)}${pathname.slice(address[0].length)}${window.location.search}${window.location.hash}`);
  }, [canonical, pathname, router]);

  const value = useMemo(() => ({ dotId, dot }), [dotId, dot]);

  // A Dot the control plane does not have (deleted, or never this host's): no header, tabs or composer for it.
  if (dot.error instanceof ApiError && dot.error.status === 404) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="max-w-sm space-y-3 text-center">
          <h1 className="text-xl font-semibold tracking-tight">This Dot does not exist</h1>
          <p className="text-sm text-muted-foreground">It may have been deleted, or the link names a Dot this host never had.</p>
          <Link href="/" className={buttonVariants()}>
            Go to Home
          </Link>
        </div>
      </div>
    );
  }

  return (
    <DotContext.Provider value={value}>
      <div className="flex min-h-0 flex-1 flex-col">
        <DotHeader dotId={dotId} dot={dot} />
        <DotTabs dotId={dotId} />
        <section className="relative mt-4 flex min-h-0 flex-1 flex-col overflow-y-auto">{canonical === null ? children : null}</section>
      </div>
    </DotContext.Provider>
  );
}
