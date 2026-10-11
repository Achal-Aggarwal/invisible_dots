import { describe, expect, it } from "vitest";
import {
  attentionByDot,
  needsYouCount,
  ringState,
  titlePrefix,
  withTitlePrefix,
  type AttentionDot,
  type RingInput,
} from "../src/lib/attention";

const dot = (id: string, status: AttentionDot["status"] = "READY", error: string | null = null): AttentionDot => ({ id, status, error });

describe("the attention model", () => {
  it("counts the approvals that wait, per Dot, and ignores the answered ones and the unknown Dots", () => {
    const map = attentionByDot(
      [dot("a"), dot("b")],
      [
        { dot_id: "a", status: "pending" },
        { dot_id: "a", status: "pending" },
        { dot_id: "a", status: "approved" },
        { dot_id: "b", status: "expired" },
        { dot_id: "gone", status: "pending" },
      ],
    );
    expect(map.get("a")).toEqual({ pendingApprovals: 2, error: null, failedTasks: 0, relinks: [] });
    expect(map.get("b")).toEqual({ pendingApprovals: 0, error: null, failedTasks: 0, relinks: [] });
    expect(map.has("gone")).toBe(false);
    expect(needsYouCount(map)).toBe(2);
  });

  it("counts the tasks that failed lately, per Dot, and ignores those of a Dot it does not know", () => {
    const map = attentionByDot([dot("a"), dot("b")], [], [{ dot_id: "a" }, { dot_id: "a" }, { dot_id: "gone" }]);
    expect(map.get("a")?.failedTasks).toBe(2);
    expect(map.get("b")?.failedTasks).toBe(0);
    expect(needsYouCount(map)).toBe(2);
  });

  it("counts the channels that need linking again, per Dot, with what the host says, and ignores those of a Dot it does not know", () => {
    const map = attentionByDot(
      [dot("a"), dot("b")],
      [],
      [],
      [
        { dot_id: "a", kind: "telegram", detail: "Telegram refused the token" },
        { dot_id: "a", kind: "whatsapp", detail: null },
        { dot_id: "gone", kind: "telegram", detail: null },
      ],
    );
    expect(map.get("a")?.relinks).toEqual([
      { kind: "telegram", detail: "Telegram refused the token" },
      { kind: "whatsapp", detail: null },
    ]);
    expect(map.get("b")?.relinks).toEqual([]);
    expect(needsYouCount(map)).toBe(2);
  });

  it("carries the reason of a Dot in ERROR, and a stand-in reason when the record has none", () => {
    const map = attentionByDot([dot("a", "ERROR", "the disk is full"), dot("b", "ERROR")], []);
    expect(map.get("a")?.error).toBe("the disk is full");
    expect(map.get("b")?.error).toBe("The Dot is in an error state");
  });

  it("counts what needs the person: waiting approvals, Dots in ERROR, failed tasks and channels to link again, each once", () => {
    const map = attentionByDot([dot("a"), dot("b", "ERROR", "x")], [{ dot_id: "a", status: "pending" }], [{ dot_id: "b" }], [{ dot_id: "a", kind: "telegram", detail: null }]);
    expect(needsYouCount(map)).toBe(4);
    expect(needsYouCount(attentionByDot([dot("a")], []))).toBe(0);
  });

  it("writes the count in front of the page title, replacing the one that was there", () => {
    expect(titlePrefix(0)).toBe("");
    expect(titlePrefix(3)).toBe("(3) ");
    expect(titlePrefix(250)).toBe("(99+) ");
    expect(withTitlePrefix("Chat - invisible_dots", 3)).toBe("(3) Chat - invisible_dots");
    expect(withTitlePrefix("(3) Chat - invisible_dots", 5)).toBe("(5) Chat - invisible_dots");
    expect(withTitlePrefix("(99+) Chat", 0)).toBe("Chat");
    // A title that merely starts with parentheses is left alone.
    expect(withTitlePrefix("(draft) notes", 0)).toBe("(draft) notes");
  });
});

describe("the avatar ring", () => {
  const base: RingInput = { status: "READY", computerState: "RUNNING", agentState: null, pendingApprovals: 0 };
  const ring = (change: Partial<RingInput>) => ringState({ ...base, ...change });

  it("is grey for a computer that is stopped or missing, green for one that runs quietly", () => {
    expect(ring({ computerState: "STOPPED" })).toBe("stopped");
    expect(ring({ computerState: null })).toBe("stopped");
    expect(ring({})).toBe("ready");
  });

  it("breathes while the agent thinks, plans or runs a tool, and while the computer changes state", () => {
    for (const agentState of ["THINKING", "PLANNING", "EXECUTING"] as const) expect(ring({ agentState })).toBe("working");
    for (const computerState of ["PROVISIONING", "STARTING", "STOPPING"] as const) expect(ring({ computerState })).toBe("working");
    expect(ring({ status: "CREATING", computerState: null })).toBe("working");
  });

  it("turns amber for a Dot that waits for the person, from an approval, the status or the agent", () => {
    expect(ring({ pendingApprovals: 1 })).toBe("waiting");
    expect(ring({ status: "WAITING_APPROVAL" })).toBe("waiting");
    expect(ring({ agentState: "WAITING_APPROVAL" })).toBe("waiting");
    // Waiting outranks work: the person is the one holding it up.
    expect(ring({ agentState: "THINKING", pendingApprovals: 2 })).toBe("waiting");
  });

  it("turns red on an error, which outranks everything", () => {
    expect(ring({ status: "ERROR" })).toBe("error");
    expect(ring({ computerState: "ERROR" })).toBe("error");
    expect(ring({ status: "ERROR", pendingApprovals: 3, agentState: "EXECUTING" })).toBe("error");
  });
});
