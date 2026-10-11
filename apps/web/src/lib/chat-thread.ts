/**
 * The conversation as the chat draws it: the messages, and between them what the Dot did to answer, read from the
 * event log. The messages route and the log are two views of the same log (a message carries the id of its event), so
 * ordering by that id puts each step between the right two messages.
 *
 * Only the chat's own turns are drawn here: a tool call or an approval that names a task belongs to that task's
 * story (the Tasks page), not to the conversation.
 */
import { mergeEvents } from "@invisible-dots/sdk";
import { stepsOf, type ApprovalStep, type ToolStep } from "./steps";
import type { ChatMessage, StoredEvent } from "./types";

export type ActivityItem = ToolStep | ApprovalStep;

export type ThreadItem =
  | { kind: "user"; id: number; message: ChatMessage }
  | { kind: "assistant"; id: number; message: ChatMessage; firstOfGroup: boolean }
  | { kind: "activity"; id: number; items: ActivityItem[] };

/** The event types the chat reads besides the messages. */
export const CHAT_ACTIVITY_EVENT_TYPES: readonly string[] = ["tool.called", "approval.requested", "approval.resolved"];

export function isChatActivityEvent(event: Pick<StoredEvent, "type">): boolean {
  return CHAT_ACTIVITY_EVENT_TYPES.includes(event.type);
}

/** Runs of tool steps longer than this fold into one line the person can open. */
export const CLUSTER_AFTER = 3;

/** Whether a call or an approval is the chat's: one that names a task is that task's. */
function isTheChats(event: Pick<StoredEvent, "data">): boolean {
  const taskId = event.data?.task_id;
  return typeof taskId !== "string" || taskId === "";
}

/** The steps of the chat's turns in the order they happened, from the events `isChatActivityEvent` accepts. */
export function activityOf(events: readonly StoredEvent[]): ActivityItem[] {
  return stepsOf([...events].sort((a, b) => a.id - b.id), isTheChats);
}

/** The thread: messages and activity merged by event id; an assistant message starts a group after anything but another assistant message. */
export function buildThread(messages: readonly ChatMessage[], events: readonly StoredEvent[]): ThreadItem[] {
  const activity = activityOf(events);
  const sortedMessages = [...messages].sort((a, b) => a.event_id - b.event_id);
  const thread: ThreadItem[] = [];
  let a = 0;
  let m = 0;
  let run: ActivityItem[] = [];
  const flush = () => {
    if (run.length > 0) thread.push({ kind: "activity", id: run[0]!.id, items: run });
    run = [];
  };
  let previousWasAssistant = false;
  while (a < activity.length || m < sortedMessages.length) {
    const nextActivity = activity[a];
    const nextMessage = sortedMessages[m];
    if (nextActivity !== undefined && (nextMessage === undefined || nextActivity.id < nextMessage.event_id)) {
      run.push(nextActivity);
      a++;
      continue;
    }
    flush();
    const message = nextMessage!;
    m++;
    if (message.role === "user") {
      thread.push({ kind: "user", id: message.event_id, message });
      previousWasAssistant = false;
    } else {
      thread.push({ kind: "assistant", id: message.event_id, message, firstOfGroup: !previousWasAssistant });
      previousWasAssistant = true;
    }
  }
  flush();
  return thread;
}

/** Fold events read from the log and live ones into the chat's list, oldest first, keeping only what the chat reads. */
export function mergeChatEvents(current: readonly StoredEvent[], incoming: readonly StoredEvent[]): StoredEvent[] {
  return mergeEvents(current, incoming.filter(isChatActivityEvent));
}

/**
 * The newest tool call or approval of the turn the Dot is in now, for the working row; null when there is none. A turn
 * starts at the person's message and ends at the Dot's answer: a step before either belongs to a turn that is over
 * (the Dot may be working again for a task, a schedule or an approval that resumed).
 */
export function lastStepSinceUser(thread: readonly ThreadItem[]): ToolStep | ApprovalStep | null {
  for (let i = thread.length - 1; i >= 0; i--) {
    const item = thread[i]!;
    if (item.kind !== "activity") return null;
    const step = item.items.at(-1);
    if (step) return step;
  }
  return null;
}

export type ActivityGroup = { kind: "single"; item: ActivityItem } | { kind: "cluster"; steps: ToolStep[] };

/** Consecutive tool steps beyond `CLUSTER_AFTER` fold into one cluster; approvals always stand alone. */
export function groupActivity(items: readonly ActivityItem[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  let run: ToolStep[] = [];
  const flush = () => {
    if (run.length > CLUSTER_AFTER) groups.push({ kind: "cluster", steps: run });
    else for (const step of run) groups.push({ kind: "single", item: step });
    run = [];
  };
  for (const item of items) {
    if (item.kind === "tool") {
      run.push(item);
      continue;
    }
    flush();
    groups.push({ kind: "single", item });
  }
  flush();
  return groups;
}

/** What a folded run says of itself: how many steps, and how many did not end well. */
export function clusterSummary(steps: readonly ToolStep[]): string {
  const problems = steps.filter((step) => step.state !== "ok").length;
  const base = `${steps.length} steps`;
  return problems === 0 ? base : `${base}, ${problems} did not go through`;
}

/** A message the person sent from this page that the log may not show yet. */
export interface PendingMessage {
  key: string;
  text: string;
  /** The id of the logged `user.message` event, once the API answered; null while it is on its way. */
  eventId: number | null;
}

/** The pending messages the log does not hold yet: one that was answered is settled by the event it was logged as. */
export function unsettled(pending: readonly PendingMessage[], messages: readonly ChatMessage[]): PendingMessage[] {
  const logged = new Set(messages.map((message) => message.event_id));
  return pending.filter((p) => p.eventId === null || !logged.has(p.eventId));
}
