"use client";

import { AlertCircleIcon, CheckCircle2Icon, UnplugIcon, XCircleIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, type ReactNode } from "react";
import { askOfRecord, type ApprovalAsk } from "../../lib/approval-view";
import { CHANNEL_LABELS, type ChannelRelink } from "../../lib/channels";
import { formatDate } from "../../lib/format";
import { matchesFilters, waitingOrder } from "../../lib/inbox";
import { relativeTime } from "../../lib/time";
import type { Dot, Task } from "../../lib/types";
import { ApprovalCard } from "../approvals/ApprovalCard";
import { useApprovalAnswers } from "../approvals/use-answers";
import { ErrorAlert } from "../ErrorAlert";
import { useShell } from "../shell/attention";
import { DotAvatar } from "../shell/DotAvatar";
import { taskHref } from "../tasks/task-card";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { useInboxKeys } from "./use-inbox-keys";

interface Filter {
  /** A Dot's id; null for every Dot. */
  dotId: string | null;
  permission: string | null;
}

function Section({ id, title, count, children }: { id: string; title: string; count: number; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h2 id={id} className="text-sm font-semibold">
        {title}
        <span className="ml-1.5 font-normal text-muted-foreground">{count}</span>
      </h2>
      {children}
    </section>
  );
}

/** A Dot that is in an error state: why, and the two places to look. */
function DotErrorCard({ dot, reason }: { dot: Dot; reason: string }) {
  const base = `/dots/${encodeURIComponent(dot.id)}`;
  return (
    <article aria-label={`${dot.name} is in an error state`} className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3 text-card-foreground">
      <DotAvatar id={dot.id} name={dot.name} ring="error" size="sm" />
      <div className="min-w-0 flex-1 basis-56">
        <p className="text-sm font-medium">
          {dot.name} <span className="font-normal text-danger">is in an error state</span>
        </p>
        <p className="text-xs break-words text-muted-foreground">{reason}</p>
      </div>
      <div className="flex gap-2">
        <Button asChild variant="outline" size="xs">
          <Link href={`${base}/chat`}>Open</Link>
        </Button>
        <Button asChild variant="outline" size="xs">
          <Link href={`${base}/settings`}>Settings</Link>
        </Button>
      </div>
    </article>
  );
}

/** A task that failed lately: what it was, what the Dot said, and a way to open it or put it away. */
function FailedTaskCard({ task, dotName, onDismiss }: { task: Task; dotName: string; onDismiss: () => void }) {
  return (
    <article aria-label={`Failed: ${task.description}`} className="flex flex-wrap items-start gap-3 rounded-lg border bg-card p-3 text-card-foreground">
      <XCircleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
      <div className="min-w-0 flex-1 basis-56">
        <p className="line-clamp-2 text-sm font-medium break-words">
          <span className="text-muted-foreground">{dotName}: </span>
          {task.description}
        </p>
        {task.error ? <p className="line-clamp-3 text-xs break-words whitespace-pre-wrap text-danger">{task.error}</p> : null}
        {task.finished_at ? (
          <p className="text-xs text-muted-foreground">
            Failed{" "}
            <time dateTime={task.finished_at} title={formatDate(task.finished_at)}>
              {relativeTime(task.finished_at)}
            </time>
          </p>
        ) : null}
      </div>
      <div className="flex gap-2">
        <Button asChild variant="outline" size="xs">
          <Link href={taskHref(task.dot_id, task.id)}>Open task</Link>
        </Button>
        <Button type="button" variant="ghost" size="xs" onClick={onDismiss}>
          Dismiss<span className="sr-only"> failed task: {task.description}</span>
        </Button>
      </div>
    </article>
  );
}

/** A channel whose login was refused: what the host says, and the page where it is done again. */
function RelinkCard({ relink, dotName }: { relink: ChannelRelink; dotName: string }) {
  const name = CHANNEL_LABELS[relink.kind];
  return (
    <article aria-label={`${name} of ${dotName} needs linking again`} className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3 text-card-foreground">
      <UnplugIcon aria-hidden="true" className="size-4 shrink-0 text-warn" />
      <div className="min-w-0 flex-1 basis-56">
        <p className="text-sm font-medium">
          <span className="text-muted-foreground">{dotName}: </span>
          {name} needs linking again
        </p>
        {relink.detail ? <p className="line-clamp-3 text-xs break-words text-muted-foreground">{relink.detail}</p> : null}
      </div>
      <Button asChild variant="outline" size="xs">
        <Link href={`/dots/${encodeURIComponent(relink.dot_id)}/channels`}>Open channels</Link>
      </Button>
    </article>
  );
}

function Key({ children }: { children: string }) {
  return <kbd className="rounded border px-1 font-mono">{children}</kbd>;
}

/**
 * What needs the person (S6): the approvals that wait, oldest first, each answerable where it stands; Dots in an error
 * state; tasks that failed in the last day; channels that need linking again. An approval that was answered here
 * stays in its place as a receipt until the person leaves, so that nothing jumps away under the pointer. Keys, while
 * the focus is in the list of the approvals: j and k move, a allows once, d denies.
 */
export function NeedsYou({ filter }: { filter: Filter }) {
  const { dots, approvals, attention, failedTasks, relinks, dismissFailedTask } = useShell();
  const answers = useApprovalAnswers();
  const names = useMemo(() => new Map((dots.data ?? []).map((dot) => [dot.id, dot.name])), [dots.data]);

  const asks = useMemo(() => {
    const waiting = (approvals.data ?? []).filter((a) => a.status === "pending").map(askOfRecord);
    const listed = new Set(waiting.map((ask) => ask.id));
    const kept = [...answers.settled.values()].map((settled) => settled.ask).filter((ask) => !listed.has(ask.id));
    return waitingOrder([...waiting, ...kept]).filter((ask: ApprovalAsk) => matchesFilters(filter.dotId, filter.permission, ask.dotId, ask.permission));
  }, [approvals.data, answers.settled, filter.dotId, filter.permission]);

  // Dots and tasks have no permission: a permission filter leaves them out.
  const otherThings = filter.permission === null;
  const broken = otherThings ? (dots.data ?? []).filter((dot) => attention.get(dot.id)?.error != null && (filter.dotId === null || dot.id === filter.dotId)) : [];
  const failed = otherThings ? failedTasks.tasks.filter((task) => filter.dotId === null || task.dot_id === filter.dotId) : [];
  const unlinked = otherThings ? relinks.items.filter((relink) => filter.dotId === null || relink.dot_id === filter.dotId) : [];
  const waitingCount = asks.filter((ask) => !answers.settled.has(ask.id)).length;

  const keys = useInboxKeys(asks, answers, (dotId) => names.get(dotId) ?? dotId);
  const loading = (approvals.data === undefined && !approvals.error) || (dots.data === undefined && !dots.error);
  // "Nothing needs you" is said only once everything has been read, failed tasks and channels included: the approvals do not wait for them.
  const empty = !loading && !failedTasks.loading && !relinks.loading && asks.length === 0 && broken.length === 0 && failed.length === 0 && unlinked.length === 0;

  return (
    <div className="space-y-6">
      <p id="inbox-keys" className="text-xs text-muted-foreground">
        Keys, once the list of approvals has the focus (click it or Tab to it): <Key>j</Key> and <Key>k</Key> move between the cards, <Key>a</Key> allows the selected one
        once, <Key>d</Key> denies it.
      </p>
      <p role="status" className="sr-only">
        {keys.announcement}
      </p>

      <ErrorAlert error={approvals.error} title="Could not load the approvals" />
      {loading ? (
        <div className="space-y-3" aria-busy="true">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : null}

      {!loading && asks.length > 0 ? (
        <Section id="inbox-approvals" title="Waiting for your answer" count={waitingCount}>
          <ul
            aria-label="Approvals waiting for your answer"
            aria-describedby="inbox-keys"
            tabIndex={0}
            className="space-y-3 rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background focus-visible:outline-hidden"
            {...keys.listProps}
          >
            {asks.map((ask) => (
              <li key={ask.id}>
                <ApprovalCard ask={ask} answers={answers} dotName={names.get(ask.dotId) ?? ask.dotId} selected={keys.selectedId === ask.id} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {broken.length > 0 ? (
        <Section id="inbox-errors" title="Dots in an error state" count={broken.length}>
          <ul className="space-y-2">
            {broken.map((dot) => (
              <li key={dot.id}>
                <DotErrorCard dot={dot} reason={attention.get(dot.id)?.error ?? ""} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {unlinked.length > 0 ? (
        <Section id="inbox-channels" title="Channels to link again" count={unlinked.length}>
          <ul className="space-y-2">
            {unlinked.map((relink) => (
              <li key={`${relink.dot_id}:${relink.kind}`}>
                <RelinkCard relink={relink} dotName={names.get(relink.dot_id) ?? relink.dot_id} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {failed.length > 0 ? (
        <Section id="inbox-failed" title="Tasks that failed in the last 24 hours" count={failed.length}>
          <ul className="space-y-2">
            {failed.map((task) => (
              <li key={task.id}>
                <FailedTaskCard task={task} dotName={names.get(task.dot_id) ?? task.dot_id} onDismiss={() => dismissFailedTask(task.id)} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {failedTasks.unreadable && otherThings ? (
        <Alert>
          <AlertCircleIcon />
          <AlertTitle>Failed tasks may be missing</AlertTitle>
          <AlertDescription>
            <p>The tasks that failed today could not be read.</p>
          </AlertDescription>
        </Alert>
      ) : null}

      {relinks.unreadable && otherThings ? (
        <Alert>
          <AlertCircleIcon />
          <AlertTitle>Channels may be missing</AlertTitle>
          <AlertDescription>
            <p>The channels could not be read.</p>
          </AlertDescription>
        </Alert>
      ) : null}

      {empty ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-10 text-center">
          <CheckCircle2Icon aria-hidden="true" className="size-6 text-ok" />
          <p className="font-medium">Nothing needs you</p>
          <p className="max-w-md text-sm text-muted-foreground">When a Dot asks permission to do something, it shows up here, and in the chat or the task that asked.</p>
        </div>
      ) : null}
    </div>
  );
}
