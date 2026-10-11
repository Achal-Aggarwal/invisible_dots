"use client";

import { ChevronRightIcon, HandIcon } from "lucide-react";
import { useState } from "react";
import { clusterSummary, groupActivity, type ActivityItem } from "../../lib/chat-thread";
import { formatMillis } from "../../lib/format";
import { APPROVAL_WORD, TOOL_OUTCOME, type ApprovalStep, type ToolStep } from "../../lib/steps";
import type { Tone } from "../../lib/tone";
import { cn } from "../../lib/utils";
import { InlineApproval } from "../approvals/InlineApproval";
import { FAMILY_ICON } from "../tool-family-icon";
import { ActivityStep, type ActivityStepTone } from "./activity-step";
import { TOOL_STATUS, ToolStatusWord } from "./tool-status";

/** A step's marker in the tone of how the call ended. */
const MARKER: Record<Tone, ActivityStepTone> = { neutral: "neutral", info: "active", ok: "success", warn: "warn", error: "error" };

/** One tool call as a quiet line: what it did, what it acted on, and how it ended when that was not well. */
export function ToolLine({ step }: { step: ToolStep }) {
  const status = TOOL_STATUS[step.state];
  const full = `${step.label}${step.target ? `: ${step.target}` : ""} (${status.word}${step.durationMs > 0 ? `, ${formatMillis(step.durationMs)}` : ""})`;
  return (
    <ActivityStep
      icon={FAMILY_ICON[step.family]}
      tone={MARKER[TOOL_OUTCOME[step.state].tone]}
      title={full}
      label={
        <>
          <span className="shrink-0">{step.label}</span>
          {step.target ? <code className="min-w-0 truncate font-mono text-xs font-normal text-muted-foreground/90">{step.target}</code> : null}
          <ToolStatusWord state={step.state} />
          {step.durationMs >= 1000 ? <span className="shrink-0 text-xs font-normal tabular-nums">{formatMillis(step.durationMs)}</span> : null}
        </>
      }
    />
  );
}

/**
 * An approval the Dot asked for in the conversation, in the place it was asked. While it waits it is the approval card,
 * answerable here; once answered it is a receipt, which is what the log keeps.
 */
export function ApprovalLine({ dotId, step }: { dotId: string; step: ApprovalStep }) {
  if (step.outcome === "waiting") {
    return (
      <InlineApproval
        ask={{ id: step.approvalId, dotId, taskId: null, tool: step.tool, permission: step.permission, arguments: step.arguments, reason: step.reason, createdAt: step.at }}
      />
    );
  }
  const approved = step.outcome === "approved";
  return (
    <ActivityStep
      icon={HandIcon}
      tone={approved ? "success" : "error"}
      title={step.reason || undefined}
      label={
        <span className="min-w-0 whitespace-normal">
          {APPROVAL_WORD[step.outcome]}
          {approved && step.always ? " for good" : ""}: {step.label.toLowerCase()}
          {step.reason ? <span className="font-normal"> ({step.reason})</span> : null}
          {step.note ? <span className="block text-xs font-normal">Note: {step.note}</span> : null}
        </span>
      }
    />
  );
}

/** A long run of tool calls, folded into one line that opens. */
function Cluster({ steps }: { steps: readonly ToolStep[] }) {
  const [open, setOpen] = useState(false);
  const bad = steps.some((step) => step.state !== "ok");
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 rounded py-0.5 text-ui font-medium text-muted-foreground focus-visible:outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRightIcon aria-hidden="true" className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        <span className={cn(bad && "text-warn")}>{clusterSummary(steps)}</span>
      </button>
      {open ? (
        <ul aria-label="Steps" className="mt-0.5 ml-1.5 space-y-0 border-l pl-3">
          {steps.map((step) => (
            <li key={step.id}>
              <ToolLine step={step} />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** What the Dot did between two messages: quiet lines, and approvals in the place they were asked. */
export function Activity({ dotId, items }: { dotId: string; items: readonly ActivityItem[] }) {
  const groups = groupActivity(items);
  return (
    <ul aria-label="What the Dot did" className="space-y-0.5">
      {groups.map((group) => {
        if (group.kind === "cluster") return <Cluster key={`c${group.steps[0]!.id}`} steps={group.steps} />;
        const item = group.item;
        return (
          <li key={item.id}>
            {item.kind === "tool" ? <ToolLine step={item} /> : <ApprovalLine dotId={dotId} step={item} />}
          </li>
        );
      })}
    </ul>
  );
}
