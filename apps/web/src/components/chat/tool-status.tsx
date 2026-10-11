// Derived from AI Elements (Vercel) packages/elements/src/tool.tsx at 6a9d5b1, Apache-2.0; changed: the states are this app's own (a call is reported when it has ended, so there is no running state; a call that waits for the person belongs to the approval step), and the map gives each a word, an icon and a tone from this app's tokens, not a badge in fixed colors.

import { BanIcon, CheckCircle2Icon, CircleAlertIcon, XCircleIcon, type LucideIcon } from "lucide-react";
import { TOOL_OUTCOME, type ToolState } from "../../lib/steps";
import { cn } from "../../lib/utils";

export interface ToolStatus {
  /** One word for how the call ended. */
  word: string;
  icon: LucideIcon;
  /** Text color from the tokens. */
  tone: string;
  /** Whether the person should notice it: anything but an ordinary success. */
  attention: boolean;
}

export const TOOL_STATUS: Readonly<Record<ToolState, ToolStatus>> = {
  ok: { word: TOOL_OUTCOME.ok.word, icon: CheckCircle2Icon, tone: "text-ok", attention: false },
  error: { word: TOOL_OUTCOME.error.word, icon: XCircleIcon, tone: "text-danger", attention: true },
  denied: { word: TOOL_OUTCOME.denied.word, icon: BanIcon, tone: "text-warn", attention: true },
  interrupted: { word: TOOL_OUTCOME.interrupted.word, icon: CircleAlertIcon, tone: "text-warn", attention: true },
};

/** The word of a call's ending, shown beside it only when it is not an ordinary success. */
export function ToolStatusWord({ state, className }: { state: ToolState; className?: string }) {
  const status = TOOL_STATUS[state];
  if (!status.attention) return null;
  return <span className={cn("shrink-0 text-xs font-medium", status.tone, className)}>{status.word}</span>;
}
