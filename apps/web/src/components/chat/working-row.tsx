"use client";

import { agentStateLabel, type AgentStateValue } from "../../lib/agent";
import type { ApprovalStep, ToolStep } from "../../lib/steps";
import type { RingState } from "../../lib/attention";
import { DotAvatar } from "../shell/DotAvatar";

/** The Dot is in the middle of a turn: its face, a shimmering word for what it is doing, and the last thing it did. */
export function WorkingRow({ dot, ring, state, last }: { dot: { id: string; name: string }; ring: RingState; state: AgentStateValue; last: ToolStep | ApprovalStep | null }) {
  return (
    <div role="status" className="grid grid-cols-[2rem_minmax(0,1fr)] items-center gap-3">
      <DotAvatar id={dot.id} name={dot.name} ring={ring} size="sm" />
      <p className="flex min-w-0 items-baseline gap-2 text-sm">
        <span className="shimmer font-medium">{agentStateLabel(state)}</span>
        {last ? (
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            Last step: {last.label.toLowerCase()}
            {last.kind === "tool" && last.target ? ` ${last.target}` : ""}
          </span>
        ) : null}
      </p>
    </div>
  );
}
