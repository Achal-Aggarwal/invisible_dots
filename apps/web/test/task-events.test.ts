import { MAX_EVENT_PAGE, type StoredEvent } from "@invisible-dots/shared/browser";
import { describe, expect, it } from "vitest";
import { isTaskEvent, readTaskProgress, readTaskStory, TASK_EVENT_TYPES, mergeTaskEvents, storyOf, taskIdOf } from "../src/lib/task-events";

let n = 0;
function event(type: string, data: Record<string, unknown> = {}, at = `2026-03-10T12:00:${String(n).padStart(2, "0")}Z`): StoredEvent {
  n += 1;
  return { id: n, dot_id: "d1", type, data, source: "guest", guest_seq: n, created_at: at } as StoredEvent;
}

describe("which events belong to a task", () => {
  it("are the ones that name it, an approval's answer among them", () => {
    expect(isTaskEvent(event("task.progress", { task_id: "t1", text: "x" }))).toBe(true);
    expect(isTaskEvent(event("tool.called", { task_id: "t1", tool: "exec" }))).toBe(true);
    expect(isTaskEvent(event("approval.resolved", { approval_id: "a1", decision: "approve", task_id: "t1" }))).toBe(true);
    expect(isTaskEvent(event("approval.resolved", { approval_id: "a2", decision: "approve" }))).toBe(false);
    expect(isTaskEvent(event("tool.called", { tool: "exec" }))).toBe(false);
    expect(isTaskEvent(event("message.assistant", { text: "hi" }))).toBe(false);
    expect(taskIdOf(event("task.started", { task_id: "t9" }))).toBe("t9");
    expect(taskIdOf(event("agent.state", { state: "IDLE" }))).toBe("");
  });

  it("merge in id order without repeating one", () => {
    const a = event("task.started", { task_id: "t1" });
    const b = event("task.progress", { task_id: "t1", text: "one" });
    const chat = event("message.assistant", { text: "not a task" });
    const merged = mergeTaskEvents([b], [a, b, chat]);
    expect(merged.map((e) => e.id)).toEqual([a.id, b.id]);
  });
});

describe("readTaskStory", () => {
  /** The control plane's `types` and `task_id` filters: the limit counts what is kept. */
  function serving(log: StoredEvent[]) {
    const asked: Array<{ after?: number; before?: number; limit?: number; types?: readonly string[]; taskId?: string; order?: string }> = [];
    return {
      asked,
      async events(_dot: string, options: { after?: number; before?: number; limit?: number; types?: readonly string[]; taskId?: string; order?: "asc" | "desc" } = {}) {
        asked.push(options);
        const kept = log.filter(
          (e) => e.id > (options.after ?? 0) && (options.before === undefined || e.id < options.before) && (!options.types || options.types.includes(e.type)) && (options.taskId === undefined || e.data.task_id === options.taskId),
        );
        return (options.order === "desc" ? [...kept].reverse() : kept).slice(0, options.limit);
      },
    };
  }

  it("asks for the events of that task and of the types of a story, page by page to the end, and nothing else crosses the wire", async () => {
    const log: StoredEvent[] = [];
    for (let i = 0; i < 3 * MAX_EVENT_PAGE + 300; i++) {
      log.push(i % 3 === 0 ? event("task.progress", { task_id: "t1", text: `p${i}` }) : i % 3 === 1 ? event("task.progress", { task_id: "t2", text: `q${i}` }) : event("agent.state", { state: "IDLE" }));
    }
    const client = serving(log);
    const read = await readTaskStory(client, "d1", "t1");
    expect(read).toHaveLength(MAX_EVENT_PAGE + 100);
    expect(read.every((e) => e.type === "task.progress" && e.data.task_id === "t1")).toBe(true);
    expect(client.asked.map((a) => a.types)).toEqual([TASK_EVENT_TYPES, TASK_EVENT_TYPES]);
    expect(client.asked.map((a) => a.taskId)).toEqual(["t1", "t1"]);
    expect(client.asked.map((a) => a.limit)).toEqual([MAX_EVENT_PAGE, MAX_EVENT_PAGE]);
    expect(client.asked[1]!.after).toBe(read[MAX_EVENT_PAGE - 1]!.id);
  });

  it("holds the approval and its answer, and no tool call or approval of the chat", async () => {
    const log = [
      event("tool.called", { tool: "exec", task_id: "t1" }),
      event("tool.called", { tool: "exec" }),
      event("approval.requested", { approval_id: "a1", tool: "exec" }),
      event("approval.requested", { approval_id: "a2", tool: "exec", task_id: "t1" }),
      event("approval.resolved", { approval_id: "a1", decision: "approve" }),
      event("approval.resolved", { approval_id: "a2", decision: "approve", task_id: "t1" }),
      event("message.assistant", { text: "hi" }),
    ];
    const read = await readTaskStory(serving(log), "d1", "t1");
    expect(read.map((e) => e.id)).toEqual([log[0]!.id, log[3]!.id, log[5]!.id]);
  });

  it("ends on a page that is exactly full only after asking once more", async () => {
    const log = Array.from({ length: MAX_EVENT_PAGE }, (_, i) => event("task.progress", { task_id: "t1", text: String(i) }));
    const client = serving(log);
    expect(await readTaskStory(client, "d1", "t1")).toHaveLength(MAX_EVENT_PAGE);
    expect(client.asked).toHaveLength(2);
  });

  it("lets a failure through", async () => {
    await expect(
      readTaskStory(
        {
          async events() {
            throw new Error("the log is down");
          },
        },
        "d1",
        "t1",
      ),
    ).rejects.toThrow("the log is down");
  });
});

describe("readTaskProgress", () => {
  it("asks once for the newest progress line of that task, and is null for a task that has said nothing", async () => {
    const log = [
      event("task.progress", { task_id: "t1", text: "first" }),
      event("task.progress", { task_id: "t2", text: "other task" }),
      event("task.progress", { task_id: "t1", text: "second" }),
      event("tool.called", { task_id: "t1", tool: "exec" }),
    ];
    const asked: unknown[] = [];
    const client = {
      async events(_dot: string, options: { limit?: number; types?: readonly string[]; taskId?: string; order?: "asc" | "desc" } = {}) {
        asked.push(options);
        const kept = log.filter((e) => options.types?.includes(e.type) && e.data.task_id === options.taskId);
        return (options.order === "desc" ? [...kept].reverse() : kept).slice(0, options.limit);
      },
    };
    expect(await readTaskProgress(client, "d1", "t1")).toMatchObject({ id: log[2]!.id, text: "second" });
    expect(asked).toEqual([{ limit: 1, types: ["task.progress"], taskId: "t1", order: "desc" }]);
    expect((await readTaskProgress(client, "d1", "t2"))?.text).toBe("other task");
    expect(await readTaskProgress(client, "d1", "t3")).toBeNull();
  });
});

describe("storyOf", () => {
  const events = [
    event("task.created", { task_id: "t1", description: "Write it", priority: 10 }),
    event("task.started", { task_id: "t1" }),
    event("task.progress", { task_id: "t1", text: "Reading the sources" }),
    event("tool.called", { task_id: "t1", tool: "exec", permission: "computer.exec", decision: "allow", ok: true, duration_ms: 1200, target: "ls -la" }),
    event("tool.called", { task_id: "t2", tool: "exec", decision: "allow", ok: true, duration_ms: 5 }),
    event("approval.requested", { task_id: "t1", approval_id: "a1", tool: "write_file", permission: "files.write", reason: "needs to save the report", arguments: {} }),
    event("approval.resolved", { task_id: "t1", approval_id: "a1", decision: "approve", note: "go on" }),
    event("approval.resolved", { task_id: "t2", approval_id: "other", decision: "reject" }),
    event("tool.called", { task_id: "t1", tool: "browser_navigate", decision: "deny", ok: false, duration_ms: 0 }),
    event("tool.called", { task_id: "t1", tool: "exec", decision: "allow", ok: false, duration_ms: 0, interrupted: true }),
    event("task.completed", { task_id: "t1", summary: "Done: **report.md**" }),
  ];

  it("lists one task's steps in order, each typed, and none of another task's", () => {
    const story = storyOf(events, "t1");
    expect(story.map((s) => s.kind)).toEqual(["created", "started", "progress", "tool", "approval", "tool", "tool", "completed"]);
    expect(story[0]).toMatchObject({ kind: "created", description: "Write it", priority: 10 });
    expect(story[2]).toMatchObject({ kind: "progress", text: "Reading the sources" });
    expect(story[3]).toMatchObject({ kind: "tool", tool: "exec", label: "Ran a command", target: "ls -la", state: "ok", durationMs: 1200 });
    expect(story[7]).toMatchObject({ kind: "completed", summary: "Done: **report.md**" });
  });

  it("says a call that started a terminal session as that", () => {
    const [step] = storyOf([event("tool.called", { task_id: "t9", tool: "exec", decision: "allow", ok: true, duration_ms: 5, target: "python3", tty: true })], "t9");
    expect(step).toMatchObject({ kind: "tool", label: "Started a terminal session" });
    expect(storyOf(events, "t1")[3]).toMatchObject({ kind: "tool", label: "Ran a command" });
  });

  it("folds an approval and its answer into one step, found by the approval's id", () => {
    const approval = storyOf(events, "t1").find((s) => s.kind === "approval");
    expect(approval).toMatchObject({ approvalId: "a1", tool: "write_file", reason: "needs to save the report", outcome: "approved", note: "go on" });
    const waiting = storyOf(events.slice(0, 6), "t1").find((s) => s.kind === "approval");
    expect(waiting).toMatchObject({ outcome: "waiting", note: "" });
  });

  it("keeps a refused call and an interrupted one for what they are", () => {
    const tools = storyOf(events, "t1").filter((s) => s.kind === "tool");
    expect(tools[1]).toMatchObject({ tool: "browser_navigate", state: "denied" });
    expect(tools[2]).toMatchObject({ tool: "exec", state: "interrupted" });
  });

  it("ends a failed task with its error and a cancelled one with that", () => {
    const failed = storyOf([event("task.failed", { task_id: "t5", error: "cost cap reached" })], "t5");
    expect(failed).toEqual([expect.objectContaining({ kind: "failed", error: "cost cap reached" })]);
    const cancelled = storyOf([event("task.cancelled", { task_id: "t6" })], "t6");
    expect(cancelled.map((s) => s.kind)).toEqual(["cancelled"]);
    expect(storyOf(events, "nope")).toEqual([]);
  });
});
