/**
 * What a task did, read from the Dot's event log: the newest line it reported, and its story step by step for the
 * drawer. The log is the one record of both (the task row keeps only its state, result and spend). Both are read by
 * the task (`task_id`, indexed in the database), so what it costs does not grow with the age of the Dot.
 */
import { mergeEvents, readEventLog, readRecentEvents, type InvisibleDotsClient } from "@invisible-dots/sdk";
import { stepsOf, type ApprovalStep, type ToolStep } from "./steps";
import type { StoredEvent } from "./types";

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function taskIdOf(event: Pick<StoredEvent, "data">): string {
  return text(event.data?.task_id);
}

/** The event types that can belong to a task's story; the control plane keeps only these when the log is read. */
export const TASK_EVENT_TYPES: readonly string[] = [
  "task.created",
  "task.started",
  "task.progress",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "tool.called",
  "approval.requested",
  "approval.resolved",
];

/** Whether an event belongs to a task's story: it names the task (an approval's answer does too, see `approval.resolved`). */
export function isTaskEvent(event: Pick<StoredEvent, "data">): boolean {
  return taskIdOf(event) !== "";
}

/** Every event of one task's story, oldest first; a tool call or an approval of the chat names no task and is not among them. */
export function readTaskStory(client: Pick<InvisibleDotsClient, "events">, dotId: string, taskId: string): Promise<StoredEvent[]> {
  return readEventLog(client, dotId, { types: TASK_EVENT_TYPES, taskId });
}

export function mergeTaskEvents(current: readonly StoredEvent[], incoming: readonly StoredEvent[]): StoredEvent[] {
  return mergeEvents(current, incoming.filter(isTaskEvent));
}

export interface TaskProgress {
  /** The id of the event it was reported in: a later one is newer, however it came. */
  id: number;
  text: string;
  at: string;
}

export function progressOfEvent(event: Pick<StoredEvent, "id" | "data" | "created_at">): TaskProgress {
  return { id: event.id, text: text(event.data.text), at: event.created_at };
}

/** The newest thing the task said while it worked, or null when it has said nothing (yet): one request for the newest report. */
export async function readTaskProgress(client: Pick<InvisibleDotsClient, "events">, dotId: string, taskId: string): Promise<TaskProgress | null> {
  const [newest] = await readRecentEvents(client, dotId, { types: ["task.progress"], taskId, count: 1 });
  return newest === undefined ? null : progressOfEvent(newest);
}

export type StoryStep =
  | { kind: "created"; id: number; at: string; description: string; priority: number | null }
  | { kind: "started"; id: number; at: string }
  | { kind: "progress"; id: number; at: string; text: string }
  | ToolStep
  | ApprovalStep
  | { kind: "completed"; id: number; at: string; summary: string }
  | { kind: "failed"; id: number; at: string; error: string }
  | { kind: "cancelled"; id: number; at: string };

/** A step of the task's own life (created, started, said something, ended); null for an event that is none. */
function lifeStep(event: StoredEvent): StoryStep | null {
  const base = { id: event.id, at: event.created_at };
  const d = event.data ?? {};
  switch (event.type) {
    case "task.created":
      return { ...base, kind: "created", description: text(d.description), priority: typeof d.priority === "number" ? d.priority : null };
    case "task.started":
      return { ...base, kind: "started" };
    case "task.progress":
      return { ...base, kind: "progress", text: text(d.text) };
    case "task.completed":
      return { ...base, kind: "completed", summary: text(d.summary) };
    case "task.failed":
      return { ...base, kind: "failed", error: text(d.error) };
    case "task.cancelled":
      return { ...base, kind: "cancelled" };
    default:
      return null;
  }
}

/** The steps of one task, in the order they happened. An approval is one step: asked, and then how it was answered. */
export function storyOf(events: readonly StoredEvent[], taskId: string): StoryStep[] {
  const own = events.filter((event) => taskIdOf(event) === taskId);
  const life = own.flatMap((event) => lifeStep(event) ?? []);
  return [...life, ...stepsOf(own, () => true)].sort((a, b) => a.id - b.id);
}
