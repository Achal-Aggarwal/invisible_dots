/**
 * Tasks that failed in the last 24 hours, which the Inbox puts under "Needs you" until the person has seen them and
 * says so: one read of every Dot's (`GET /api/tasks?status=FAILED`).
 */
import type { InvisibleDotsClient } from "@invisible-dots/sdk";
import type { Task } from "./types";

/** How long a failure stays in the Inbox. */
export const FAILED_WINDOW_MS = 24 * 3_600_000;

/** Whether a task failed less than a day before `now`. */
export function failedRecently(task: Pick<Task, "status" | "finished_at">, now: number): boolean {
  if (task.status !== "FAILED" || task.finished_at === null) return false;
  const finished = Date.parse(task.finished_at);
  return Number.isFinite(finished) && now - finished < FAILED_WINDOW_MS && finished <= now + 60_000;
}

/** The tasks of every Dot that failed within the window, newest first, as of when they were read; `recentFailures` applies the window and the dismissals as time goes on. */
export function loadFailedTasks(client: Pick<InvisibleDotsClient, "endedTasks">, now = Date.now()): Promise<Task[]> {
  return client.endedTasks("FAILED", new Date(now - FAILED_WINDOW_MS));
}

/** The failures the Inbox shows: within the window, and not dismissed. */
export function recentFailures(tasks: readonly Task[], dismissed: ReadonlySet<string>, now: number): Task[] {
  return tasks.filter((task) => !dismissed.has(task.id) && failedRecently(task, now));
}
