"use client";

import Link from "next/link";
import { useState } from "react";
import { approvalBody, askTitle, boundedJson, isDestructive, permissionInfo, RECEIPT_WORD, type ApprovalAsk } from "../../lib/approval-view";
import { formatDate } from "../../lib/format";
import { relativeTime } from "../../lib/time";
import { cn } from "../../lib/utils";
import { ErrorAlert } from "../ErrorAlert";
import { ApprovalCard as ApprovalCardElement } from "../elements/approval-card";
import { DotAvatar } from "../shell/DotAvatar";
import { FAMILY_ICON } from "../tool-family-icon";
import { APPROVAL_NOTE_MAX, permissionPhrase, toolLabel } from "@invisible-dots/shared/browser";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { AlwaysAllowDialog } from "./always-allow-dialog";
import { Body } from "./approval-body";
import type { Answers } from "./use-answers";

/** The raw arguments of the call, behind a disclosure: the card's body is how they read best, this is exactly what they are. */
function Details({ ask }: { ask: ApprovalAsk }) {
  const { text, cut } = boundedJson(ask.arguments);
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground">Details</summary>
      <pre className="mt-1.5 max-h-64 overflow-auto rounded-md bg-muted p-3 font-mono whitespace-pre-wrap break-all">{text}</pre>
      {cut ? <p className="mt-1 text-muted-foreground">The arguments are longer than this: the first part is shown.</p> : null}
    </details>
  );
}

/** A note for the Dot, sent with whichever answer the person gives. */
function NoteField({ ask, answers, disabled }: { ask: ApprovalAsk; answers: Answers; disabled: boolean }) {
  const [open, setOpen] = useState(() => answers.noteOf(ask.id) !== "");
  const id = `note-${ask.id}`;
  if (!open) {
    return (
      <div>
        <Button type="button" variant="ghost" size="xs" onClick={() => setOpen(true)}>
          Add a note for the Dot
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        Note for the Dot (optional)
      </Label>
      <Input id={id} value={answers.noteOf(ask.id)} disabled={disabled} maxLength={APPROVAL_NOTE_MAX} onChange={(event) => answers.setNote(ask.id, event.target.value)} />
    </div>
  );
}

/**
 * One approval (S7): what the Dot wants to do and how it reads best (a command, a diff, an address, a schedule), the
 * Dot's reason, the raw arguments under Details, and the three answers. After an answer it is a receipt, and the receipt is
 * what is left. `dotName` is given where cards of several Dots are listed together.
 */
export function ApprovalCard({ ask, answers, dotName, selected = false, className }: { ask: ApprovalAsk; answers: Answers; dotName?: string; selected?: boolean; className?: string }) {
  const [alwaysOpen, setAlwaysOpen] = useState(false);
  const settled = answers.settled.get(ask.id);
  const pending = answers.sending.has(ask.id);
  const info = permissionInfo(ask.permission);
  const destructive = isDestructive(ask);
  const Icon = FAMILY_ICON[toolLabel(ask.tool).family];
  const where = ask.taskId !== null ? { href: `/dots/${encodeURIComponent(ask.dotId)}/tasks/${encodeURIComponent(ask.taskId)}`, words: "From a task" } : { href: `/dots/${encodeURIComponent(ask.dotId)}/chat`, words: "In the chat" };

  const subtitle = (
    <>
      {dotName ? (
        <>
          {/* The Dot's face, so cards of several Dots are told apart at a glance; its name is said beside it. */}
          <span aria-hidden="true" className="mr-1.5 inline-flex align-middle">
            <DotAvatar id={ask.dotId} name={dotName} ring="waiting" size="xs" />
          </span>
          <span className="font-medium text-foreground">{dotName}</span>
          {" · "}
        </>
      ) : null}
      <span>{permissionPhrase(ask.permission)}</span>
      {" · "}
      <Link href={where.href} className="underline underline-offset-2 hover:text-foreground">
        {where.words}
      </Link>
      {" · "}
      <time dateTime={ask.createdAt} title={formatDate(ask.createdAt)}>
        {relativeTime(ask.createdAt)}
      </time>
    </>
  );

  const statusLabel =
    settled === undefined ? undefined : (
      <span>
        {settled.receipt === "approved" && settled.always && info ? `Allowed. The Dot will not ask for "${info.label}" again.` : RECEIPT_WORD[settled.receipt]}
        {settled.note !== "" ? <span className="block text-xs">Your note: {settled.note}</span> : null}
      </span>
    );

  return (
    <article aria-label={askTitle(ask)} data-approval-id={ask.id} aria-current={selected ? "true" : undefined} className={cn("rounded-lg", selected && "outline-2 outline-offset-2 outline-ring", className)}>
      <ApprovalCardElement
        state={settled?.receipt ?? "request"}
        title={askTitle(ask)}
        subtitle={subtitle}
        description={ask.reason !== "" ? ask.reason : undefined}
        icon={<Icon className="size-4" />}
        variant={destructive ? "destructive" : "default"}
        pending={pending}
        statusLabel={statusLabel}
        onAllowOnce={() => void answers.answer(ask, "approve")}
        onAlwaysAllow={info ? () => setAlwaysOpen(true) : undefined}
        onDeny={() => void answers.answer(ask, "reject")}
        form={
          <div className="space-y-2">
            <NoteField ask={ask} answers={answers} disabled={pending} />
            <ErrorAlert error={answers.errors.get(ask.id)} title="The answer was not recorded" />
          </div>
        }
        footnote="The Dot is waiting. It keeps waiting across restarts."
      >
        <Body body={approvalBody(ask)} />
        <Details ask={ask} />
      </ApprovalCardElement>
      <AlwaysAllowDialog ask={ask} open={alwaysOpen} onOpenChange={setAlwaysOpen} onConfirm={() => void answers.answer(ask, "approve", { always: true })} />
    </article>
  );
}
