import type { StoredEvent } from "@invisible-dots/shared/browser";
import { describe, expect, it } from "vitest";
import { activityOf, buildThread, CLUSTER_AFTER, clusterSummary, groupActivity, lastStepSinceUser, mergeChatEvents, unsettled } from "../src/lib/chat-thread";
import { toolStateOf, type ToolStep } from "../src/lib/steps";
import type { ChatMessage } from "../src/lib/types";

let n = 0;
function event(type: string, data: Record<string, unknown> = {}): StoredEvent {
  n += 1;
  return { id: n, dot_id: "d1", type, data, source: "guest", guest_seq: n, created_at: `2026-03-10T12:00:${String(n % 60).padStart(2, "0")}Z` } as StoredEvent;
}
function message(role: "user" | "assistant", text: string, id: number): ChatMessage {
  return { event_id: id, role, text, in_reply_to: null, created_at: "2026-03-10T12:00:00Z" };
}
const call = (tool: string, data: Record<string, unknown> = {}) => event("tool.called", { tool, permission: "computer.exec", decision: "allow", ok: true, duration_ms: 40, ...data });

describe("how a tool call ended", () => {
  it("is interrupted first, then denied, then ok or failed", () => {
    expect(toolStateOf({ ok: true, decision: "allow" })).toBe("ok");
    expect(toolStateOf({ ok: false, decision: "allow" })).toBe("error");
    expect(toolStateOf({ ok: false, decision: "deny" })).toBe("denied");
    expect(toolStateOf({ ok: false, decision: "allow", interrupted: true })).toBe("interrupted");
    expect(toolStateOf({ ok: true, decision: "ask" })).toBe("ok");
    expect(toolStateOf({})).toBe("error");
  });
});

describe("the activity of the chat", () => {
  it("reads a call as its words, its target and how it ended", () => {
    const [step] = activityOf([call("exec", { target: "ls -la", duration_ms: 2500 })]);
    expect(step).toMatchObject({ kind: "tool", tool: "exec", label: "Ran a command", family: "command", target: "ls -la", state: "ok", durationMs: 2500 });
  });

  it("says a command that opened a terminal session as that", () => {
    const [terminal, plain] = activityOf([call("exec", { target: "python3", tty: true }), call("exec", { target: "ls" })]);
    expect(terminal).toMatchObject({ label: "Started a terminal session", target: "python3", family: "command" });
    expect(plain).toMatchObject({ label: "Ran a command" });
  });

  it("leaves out what belongs to a task: its calls and its approvals", () => {
    const events = [
      call("exec", { task_id: "t1" }),
      event("approval.requested", { task_id: "t1", approval_id: "a1", tool: "write_file", reason: "x" }),
      event("approval.resolved", { approval_id: "a1", decision: "approve" }),
      call("read_file", { target: "notes.md" }),
    ];
    expect(activityOf(events).map((i) => i.kind)).toEqual(["tool"]);
  });

  it("shows a note the Dot saved as the call that wrote it: a note is a file of its memory folder, nothing more", () => {
    const items = activityOf([call("write_file", { target: "/home/dot/memory/trips/rome.md" }), event("memory.written", { key: "trips/rome.md" })]);
    expect(items.map((i) => i.kind)).toEqual(["tool"]);
    expect(items[0]).toMatchObject({ tool: "write_file", target: "/home/dot/memory/trips/rome.md" });
  });

  it("follows an approval from its request to its answer, wherever the answer sits", () => {
    const asked = event("approval.requested", { approval_id: "a1", tool: "exec", reason: "to list files", permission: "computer.exec", arguments: {} });
    const [waiting] = activityOf([asked]);
    expect(waiting).toMatchObject({ kind: "approval", outcome: "waiting", label: "Ran a command", reason: "to list files" });
    expect(activityOf([asked, event("approval.resolved", { approval_id: "a1", decision: "approve" })])[0]).toMatchObject({ outcome: "approved" });
    expect(activityOf([asked, event("approval.resolved", { approval_id: "a1", decision: "reject" })])[0]).toMatchObject({ outcome: "rejected" });
    // The note the person wrote with the answer is kept, as a task's story keeps it.
    expect(activityOf([asked, event("approval.resolved", { approval_id: "a1", decision: "reject", note: "not now" })])[0]).toMatchObject({ note: "not now" });
    // An answer to somebody else's approval changes nothing.
    expect(activityOf([asked, event("approval.resolved", { approval_id: "other", decision: "reject" })])[0]).toMatchObject({ outcome: "waiting" });
  });

  it("is in the order of the log whatever order it was given", () => {
    const a = call("exec");
    const b = call("read_file");
    expect(activityOf([b, a]).map((i) => i.id)).toEqual([a.id, b.id]);
  });

  it("names a tool the engine refuses as the model called it", () => {
    expect(activityOf([call("rm_rf", { permission: "", decision: "deny", ok: false })])[0]).toMatchObject({ label: "Called rm_rf", family: "other", state: "denied" });
  });

  it("merges only the events the chat reads, in id order, without repeats", () => {
    const a = call("exec");
    const b = call("grep");
    const other = event("agent.state", { state: "IDLE" });
    expect(mergeChatEvents([b], [a, b, other]).map((e) => e.id)).toEqual([a.id, b.id]);
  });
});

describe("the thread", () => {
  it("puts each step between the two messages it happened between", () => {
    const u1 = message("user", "list my files", 100);
    const first = call("list_dir");
    first.id = 101;
    const a1 = message("assistant", "here they are", 102);
    const second = call("read_file");
    second.id = 103;
    const thread = buildThread([a1, u1], [second, first]);
    expect(thread.map((t) => t.kind)).toEqual(["user", "activity", "assistant", "activity"]);
    expect(thread[1]).toMatchObject({ kind: "activity", items: [{ tool: "list_dir" }] });
    expect(thread[3]).toMatchObject({ kind: "activity", items: [{ tool: "read_file" }] });
  });

  it("gives the Dot's face to the first message of a group, and a new group starts after the person speaks", () => {
    const thread = buildThread([message("user", "a", 1), message("assistant", "b", 2), message("assistant", "c", 3), message("user", "d", 4), message("assistant", "e", 5)], []);
    expect(thread.filter((t) => t.kind === "assistant").map((t) => (t as { firstOfGroup: boolean }).firstOfGroup)).toEqual([true, false, true]);
  });

  it("is empty for nothing, and keeps steps that come before any message or after the last", () => {
    expect(buildThread([], [])).toEqual([]);
    const early = call("exec");
    early.id = 1;
    const late = call("exec");
    late.id = 9;
    expect(buildThread([message("user", "x", 5)], [early, late]).map((t) => t.kind)).toEqual(["activity", "user", "activity"]);
  });

  it("finds the last step since the person spoke, for the working row", () => {
    const u = message("user", "go", 1);
    const e1 = call("list_dir");
    e1.id = 2;
    const e2 = call("grep");
    e2.id = 3;
    expect(lastStepSinceUser(buildThread([u], [e1, e2]))).toMatchObject({ tool: "grep" });
    expect(lastStepSinceUser(buildThread([u], []))).toBeNull();
    // A step before the person's last message is an old turn's.
    const later = message("user", "again", 10);
    expect(lastStepSinceUser(buildThread([u, later], [e1]))).toBeNull();
  });

  it("does not name a step of a turn the Dot already answered", () => {
    const u = message("user", "go", 1);
    const step = call("grep");
    step.id = 2;
    const answer = message("assistant", "done", 3);
    // The Dot works again after its answer (a task, a schedule, a resumed approval): the step before the answer is over.
    expect(lastStepSinceUser(buildThread([u, answer], [step]))).toBeNull();
    const next = call("list_dir");
    next.id = 4;
    expect(lastStepSinceUser(buildThread([u, answer], [step, next]))).toMatchObject({ tool: "list_dir" });
  });
});

describe("long runs of tool calls", () => {
  const steps = (count: number) => activityOf(Array.from({ length: count }, () => call("read_file"))) as ToolStep[];

  it("stay as lines up to the limit and fold into one cluster beyond it", () => {
    expect(groupActivity(steps(CLUSTER_AFTER)).map((g) => g.kind)).toEqual(Array(CLUSTER_AFTER).fill("single"));
    const folded = groupActivity(steps(CLUSTER_AFTER + 1));
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ kind: "cluster" });
  });

  it("are broken by an approval, which always stands alone", () => {
    const events = [
      ...Array.from({ length: 4 }, () => call("read_file")),
      event("approval.requested", { approval_id: "a1", tool: "exec", reason: "" }),
      ...Array.from({ length: 2 }, () => call("grep")),
    ];
    expect(groupActivity(activityOf(events)).map((g) => g.kind)).toEqual(["cluster", "single", "single", "single"]);
  });

  it("say how many steps there were and how many did not go through", () => {
    const run = activityOf([call("exec"), call("exec", { ok: false }), call("exec", { decision: "deny", ok: false }), call("exec")]) as ToolStep[];
    expect(clusterSummary(run)).toBe("4 steps, 2 did not go through");
    expect(clusterSummary(steps(5))).toBe("5 steps");
  });
});

describe("messages the person just sent", () => {
  it("stay until the log holds the event the API named, and no longer", () => {
    const pending = [
      { key: "a", text: "first", eventId: null },
      { key: "b", text: "second", eventId: 7 },
      { key: "c", text: "third", eventId: 9 },
    ];
    expect(unsettled(pending, [message("user", "second", 7)]).map((p) => p.key)).toEqual(["a", "c"]);
    expect(unsettled(pending, []).map((p) => p.key)).toEqual(["a", "b", "c"]);
  });
});
