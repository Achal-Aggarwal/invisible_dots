/**
 * What an approval prompt says in a chat, and what it says once the approval is settled. One owner of the
 * wording, so every channel shows the same thing, and the question in the words of the web client's approval card
 * (`toolLabel`, `permissionPhrase`). Plain text: a channel adds its own means of answering.
 *
 * The prompt goes through a third party that can read it (a chat is not end-to-end encrypted), so the arguments of the
 * tool, which can hold private data, are cut to `APPROVAL_PROMPT_TEXT_MAX` characters. A secret that has no place in an approval
 * (a proxy password, the user and the password of a URL) is replaced by the engine in the event itself (architecture
 * section 6): this module shows the arguments as the event has them and redacts nothing. The query of a URL stays: it
 * is how a model that was talked into it sends data out, so it is what the approver has to see (a person who does not want
 * it in a chat turns `show_arguments` off).
 */
import { APPROVAL_PROMPT_TEXT_MAX, permissionPhrase, toolLabel, type ApprovalRecord } from "@invisible-dots/shared";

const MORE = "...";

function cut(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - MORE.length).trimEnd()}${MORE}`;
}

export function approvalPromptText(approval: ApprovalRecord, showArguments: boolean): string {
  const lines = [`The Dot wants to ${toolLabel(approval.tool).ask}.`, `Permission: ${permissionPhrase(approval.permission)}`];
  const reason = cut(approval.reason, APPROVAL_PROMPT_TEXT_MAX);
  if (reason !== "") lines.push(`Reason: ${reason}`);
  const args = cut(JSON.stringify(approval.arguments), APPROVAL_PROMPT_TEXT_MAX);
  if (showArguments && args !== "{}") lines.push(`Arguments: ${args}`);
  return lines.join("\n");
}

const OUTCOMES: Record<ApprovalRecord["status"], string> = {
  pending: "Waiting for an answer.",
  approved: "Approved.",
  rejected: "Rejected.",
  expired: "No longer needed: the task ended before anyone answered.",
};

/** The prompt as it reads once the approval is settled: the question stays, the answer is added. */
export function approvalOutcomeText(approval: ApprovalRecord, showArguments: boolean): string {
  return `${approvalPromptText(approval, showArguments)}\n\n${OUTCOMES[approval.status]}`;
}

/** How many trailing characters of an approval id the words of a text answer carry: the tail of a UUIDv4 in hex, 24 bits. */
const SHORT_ID_LENGTH = 6;

/** What a person types after `yes` or `no` on a channel without buttons: short, and shaped so that an ordinary message is not taken for it. */
export function approvalReplyToken(approvalId: string): string {
  return `ap-${approvalId.slice(-SHORT_ID_LENGTH)}`;
}

/** The last line of a prompt on a channel without buttons: how to answer it. */
export function approvalReplyHint(approvalId: string): string {
  const token = approvalReplyToken(approvalId);
  return `Reply "yes ${token}" to approve or "no ${token}" to reject.`;
}

export interface ApprovalReply {
  decision: "approve" | "reject";
  /** The end of the approval's id, lowercase. */
  shortId: string;
}

const REPLY_SHAPE = new RegExp(`^(yes|no)\\s+ap-([a-z0-9]{${SHORT_ID_LENGTH}})$`, "i");

/** What a message says when it is exactly an answer in the words of `approvalReplyHint`; null for everything else, which is an ordinary message. */
export function parseApprovalReply(text: string): ApprovalReply | null {
  const match = REPLY_SHAPE.exec(text.trim());
  if (!match) return null;
  return { decision: match[1]!.toLowerCase() === "yes" ? "approve" : "reject", shortId: match[2]!.toLowerCase() };
}
