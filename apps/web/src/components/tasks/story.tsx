"use client";

import { BanIcon, CheckCircle2Icon, CircleDotIcon, FlagIcon, HandIcon, MessageSquareIcon, PlayIcon, TerminalIcon, XCircleIcon, type LucideIcon } from "lucide-react";
import { formatDate, formatMillis } from "../../lib/format";
import { APPROVAL_WORD, TOOL_OUTCOME } from "../../lib/steps";
import type { StoryStep } from "../../lib/task-events";
import { priorityLabel } from "../../lib/task-view";
import { relativeTime } from "../../lib/time";
import { cn } from "../../lib/utils";
import { Markdown } from "../markdown";

const ICON: Record<StoryStep["kind"], LucideIcon> = {
  created: FlagIcon,
  started: PlayIcon,
  progress: MessageSquareIcon,
  tool: TerminalIcon,
  approval: HandIcon,
  completed: CheckCircle2Icon,
  failed: XCircleIcon,
  cancelled: BanIcon,
};

const ICON_TONE: Partial<Record<StoryStep["kind"], string>> = { completed: "text-ok", failed: "text-danger", approval: "text-warn" };

/** The color of how a call ended: only what is not an ordinary success has one. */
const OUTCOME_CLASS = { neutral: "text-muted-foreground", info: "text-muted-foreground", ok: "text-muted-foreground", warn: "text-warn", error: "text-danger" } as const;

function Body({ step }: { step: StoryStep }) {
  switch (step.kind) {
    case "created":
      return (
        <>
          Task created{step.priority !== null && step.priority !== 0 ? <span className="text-muted-foreground"> ({priorityLabel(step.priority)} priority)</span> : null}
        </>
      );
    case "started":
      return <>The Dot started on it</>;
    case "progress":
      return <span className="whitespace-pre-wrap">{step.text}</span>;
    case "tool": {
      const outcome = TOOL_OUTCOME[step.state];
      return (
        <>
          <span title={step.tool} className="font-medium">
            {step.label}
          </span>
          {step.target ? <span className="break-all text-muted-foreground"> {step.target}</span> : null}{" "}
          <span className={cn("text-xs", OUTCOME_CLASS[outcome.tone])}>
            {outcome.word}
            {step.durationMs > 0 ? `, ${formatMillis(step.durationMs)}` : ""}
          </span>
        </>
      );
    }
    case "approval":
      return (
        <>
          <span className="font-medium">
            {APPROVAL_WORD[step.outcome]}
            {step.outcome === "approved" && step.always ? " for good" : ""}:
          </span>{" "}
          <span title={step.tool}>{step.label.toLowerCase()}</span>
          {step.reason ? <span className="text-muted-foreground"> {step.reason}</span> : null}
          {step.note ? <span className="block text-xs text-muted-foreground">Note: {step.note}</span> : null}
        </>
      );
    case "completed":
      return (
        <>
          <span className="font-medium">Completed</span>
          {step.summary ? <Markdown className="mt-1">{step.summary}</Markdown> : null}
        </>
      );
    case "failed":
      return (
        <>
          <span className="font-medium text-danger">Failed</span>
          <span className="block whitespace-pre-wrap text-danger">{step.error}</span>
        </>
      );
    case "cancelled":
      return <>The task was cancelled</>;
  }
}

/** A task's story as a list, oldest first: each step with its icon and when it happened. */
export function Story({ steps }: { steps: readonly StoryStep[] }) {
  if (steps.length === 0) return <p className="text-sm text-muted-foreground">Nothing has been recorded for this task yet.</p>;
  return (
    <ol className="space-y-3">
      {steps.map((step) => {
        const Icon = ICON[step.kind] ?? CircleDotIcon;
        return (
          <li key={step.id} className="flex gap-3 text-sm">
            <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0 text-muted-foreground", ICON_TONE[step.kind])} />
            <div className="min-w-0 flex-1">
              <Body step={step} />
            </div>
            <time dateTime={step.at} title={formatDate(step.at)} className="shrink-0 text-xs text-muted-foreground">
              {relativeTime(step.at)}
            </time>
          </li>
        );
      })}
    </ol>
  );
}
