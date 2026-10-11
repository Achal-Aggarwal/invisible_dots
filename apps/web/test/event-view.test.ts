import { describe, expect, it } from "vitest";
import { STORED_EVENT_TYPES } from "@invisible-dots/shared/browser";
import { EVENT_FAMILIES, familyOf, truncate, typesOf, viewEvent } from "../src/lib/events/view";
import type { StoredEvent } from "../src/lib/types";

function event(id: number, type: string, data: Record<string, unknown>, source: "host" | "guest" = "guest"): StoredEvent {
  return {
    id,
    dot_id: "dot_1",
    type: type as StoredEvent["type"],
    data,
    source,
    guest_seq: source === "guest" ? id : null,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

describe("viewEvent", () => {
  it("describes a completed task as a success", () => {
    const entry = viewEvent(event(1, "task.completed", { task_id: "task_a", summary: "Cheapest day is Tuesday." }));
    expect(entry).toMatchObject({ title: "Task completed", detail: "task_a: Cheapest day is Tuesday.", tone: "ok" });
  });

  it("describes a failed task as an error", () => {
    const entry = viewEvent(event(2, "task.failed", { task_id: "task_b", error: "max steps exceeded" }));
    expect(entry).toMatchObject({ title: "Task failed", tone: "error" });
    expect(entry.detail).toContain("max steps exceeded");
  });

  it("describes an approval request with tool, permission and reason", () => {
    const entry = viewEvent(
      event(3, "approval.requested", {
        approval_id: "apr_1",
        tool: "browser_identity_delete",
        permission: "browser.identity.delete",
        arguments: { identity_id: "shop-ab12cd" },
        reason: "cleanup",
      }),
    );
    expect(entry.tone).toBe("warn");
    expect(entry.detail).toBe("browser_identity_delete [browser.identity.delete] - cleanup");
  });

  it("marks a failed tool call as an error, a denied one as a warning (it never ran) and a successful one as neutral", () => {
    const ok = viewEvent(
      event(4, "tool.called", { tool: "computer_exec", permission: "computer.exec", decision: "allow", ok: true, duration_ms: 41.6 }),
    );
    expect(ok).toMatchObject({ title: "Called computer_exec", detail: "done in 42 ms | computer_exec [computer.exec] allow", tone: "neutral" });
    const denied = viewEvent(
      event(5, "tool.called", { tool: "nope", permission: "", decision: "deny", ok: false, duration_ms: 0 }),
    );
    expect(denied).toMatchObject({ detail: "denied in 0 ms | nope deny", tone: "warn" });
    const failed = viewEvent(event(6, "tool.called", { tool: "exec", permission: "computer.exec", decision: "allow", ok: false, duration_ms: 3 }));
    expect(failed).toMatchObject({ detail: "failed in 3 ms | exec [computer.exec] allow", tone: "error" });
  });

  it("says what a tool call acted on and what policy decided, in the words of the tool", () => {
    const call = { permission: "computer.exec", decision: "allow", ok: true, duration_ms: 1200 };
    expect(viewEvent(event(20, "tool.called", { tool: "exec", target: "ls -la /home/dot", ...call }))).toMatchObject({
      title: "Ran a command",
      detail: "ls -la /home/dot | done in 1.2 s | exec [computer.exec] allow",
      tool: "exec",
      family: "tools",
    });
    expect(viewEvent(event(23, "tool.called", { tool: "exec", target: "python3", permission: "computer.exec", decision: "allow", ok: true, duration_ms: 50, tty: true }))).toMatchObject({
      title: "Started a terminal session",
      detail: "python3 | done in 50 ms | exec [computer.exec] allow",
    });
    // A call that waited for the person says so in its decision; one cut off by a restart is neither a success nor a failure of the call.
    expect(viewEvent(event(21, "tool.called", { tool: "write_file", permission: "files.write", decision: "ask", ok: true, duration_ms: 3 })).detail).toBe(
      "done in 3 ms | write_file [files.write] ask",
    );
    expect(viewEvent(event(22, "tool.called", { tool: "exec", target: "sleep 99", permission: "computer.exec", decision: "allow", ok: false, duration_ms: 0, interrupted: true }))).toMatchObject({
      detail: "sleep 99 | interrupted in 0 ms | exec [computer.exec] allow",
      tone: "warn",
    });
    expect(viewEvent(event(23, "tool.called", { tool: "browser_click", target: "a: #buy", permission: "browser.act", decision: "allow", ok: false, duration_ms: 40 }))).toMatchObject({ tone: "error" });
    expect(viewEvent(event(24, "tool.called", {})).title).toBe("Tool call");
  });

  it("says in words that the engine started, instead of showing its empty data", () => {
    expect(viewEvent(event(25, "agent.started", {}))).toMatchObject({ title: "The engine started", detail: "The key was sent again", family: "computer" });
  });

  it("shows what the person sent, and the channel it came through", () => {
    expect(viewEvent(event(26, "user.message", { message_id: "m1", text: "hello" }, "host"))).toMatchObject({ title: "You sent a message", detail: "hello", via: null, family: "chat" });
    const origin = { channel: "telegram", binding_id: "b1", chat_id: "9", external_id: "77" };
    expect(viewEvent(event(27, "user.message", { message_id: "m2", text: "hi from the phone", origin }, "host")).via).toBe("via Telegram");
    // A malformed origin is no origin.
    expect(viewEvent(event(28, "user.message", { message_id: "m3", text: "x", origin: { channel: "carrier pigeon" } }, "host")).via).toBeNull();
  });

  it("says when an approval was answered for good, and the priority a task was created with", () => {
    expect(viewEvent(event(29, "approval.resolved", { approval_id: "apr_2", decision: "approve", always: true }, "host"))).toMatchObject({ title: "Allowed for good", tone: "ok" });
    expect(viewEvent(event(30, "approval.resolved", { approval_id: "apr_3", decision: "approve" }, "host")).title).toBe("Allowed");
    expect(viewEvent(event(31, "task.created", { task_id: "t", description: "look", priority: 100 }, "host")).detail).toBe("look (priority 100)");
    expect(viewEvent(event(32, "task.created", { task_id: "t", description: "look" }, "host")).detail).toBe("look");
  });

  it("names browser identities by name and id", () => {
    const entry = viewEvent(event(6, "browser.identity.created", { identity_id: "shop-ab12cd", name: "shop" }));
    expect(entry).toMatchObject({ title: "Browser identity created", detail: "shop (shop-ab12cd)" });
  });

  it("says when the next automation is due, or that none is", () => {
    expect(viewEvent(event(20, "automation.next_run", { next_run_at_ms: 1_790_000_000_000 }))).toMatchObject({
      title: "Next automation",
      detail: "due 2026-09-21T14:13:20.000Z",
      tone: "neutral",
      family: "computer",
    });
    expect(viewEvent(event(21, "automation.next_run", { next_run_at_ms: null }))).toMatchObject({ detail: "none due" });
  });

  it("says that the computer sent an event that was not read, with what can be named of it", () => {
    expect(viewEvent(event(22, "guest.event.refused", { seq: 41, type: "approval.requested", problem: "data.permission: Invalid option" }, "host"))).toMatchObject({
      title: "The computer sent an event that was not read",
      detail: "approval.requested (#41) - data.permission: Invalid option",
      tone: "warn",
      family: "computer",
    });
    expect(viewEvent(event(23, "guest.event.refused", { seq: null, type: null, problem: "not JSON" }, "host")).detail).toBe("- not JSON");
  });

  it("tells a Dot that went to ERROR from a saved configuration, though both are dot.updated", () => {
    expect(viewEvent(event(24, "dot.updated", { name: "fares" }, "host"))).toMatchObject({ title: "Configuration updated", detail: "fares", tone: "neutral" });
    expect(viewEvent(event(25, "dot.updated", { name: "fares", status: "ERROR", error: "start failed: QEMU did not start" }, "host"))).toMatchObject({
      title: "The Dot failed",
      detail: "fares - start failed: QEMU did not start",
      tone: "error",
    });
  });

  it("describes host events and resolutions", () => {
    expect(viewEvent(event(7, "computer.state", { state: "ERROR" }, "host"))).toMatchObject({
      title: "Computer state",
      detail: "ERROR",
      tone: "error",
      source: "host",
    });
    expect(viewEvent(event(8, "approval.resolved", { approval_id: "apr_1", decision: "reject", note: "no" }, "host")))
      .toMatchObject({ title: "Denied", detail: "apr_1 - no", tone: "warn" });
  });

  it("describes the channel events by their kind and status", () => {
    expect(viewEvent(event(12, "channel.status", { kind: "telegram", status: "connected" }, "host"))).toMatchObject({
      title: "Channel status",
      detail: "Telegram connected",
      tone: "ok",
    });
    expect(viewEvent(event(13, "channel.status", { kind: "whatsapp", status: "needs_relink" }, "host")).tone).toBe("warn");
    expect(viewEvent(event(14, "channel.status", { kind: "telegram", status: "connecting" }, "host")).tone).toBe("neutral");
    expect(
      viewEvent(event(15, "channel.status", { kind: "telegram", status: "error", detail: "bot token revoked" }, "host")),
    ).toMatchObject({ detail: "Telegram error - bot token revoked", tone: "error" });
    expect(
      viewEvent(event(16, "channel.peer.paired", { kind: "telegram", peer_id: "4242", label: "Ada" }, "host")),
    ).toMatchObject({ title: "Person paired", detail: "Ada on Telegram", tone: "ok" });
    expect(viewEvent(event(17, "channel.changed", { kind: "telegram", change: "paused" }, "host"))).toMatchObject({ title: "Channel paused", detail: "Telegram", tone: "neutral", family: "channels" });
    expect(viewEvent(event(18, "channel.changed", { kind: "whatsapp", change: "removed" }, "host"))).toMatchObject({ title: "Channel removed", detail: "WhatsApp", tone: "warn" });
  });

  it("falls back to the raw data for an unknown type and tolerates missing fields", () => {
    expect(viewEvent(event(9, "something.new", { a: 1 })).detail).toBe('{"a":1}');
    expect(viewEvent(event(10, "task.progress", {})).detail).toBe("");
  });

  it("truncates long details to one line", () => {
    const long = `${"word ".repeat(200)}\nend`;
    const detail = viewEvent(event(11, "message.assistant", { text: long })).detail;
    expect(detail.length).toBeLessThanOrEqual(280);
    expect(detail).not.toContain("\n");
    expect(detail.endsWith("...")).toBe(true);
    expect(truncate("short")).toBe("short");
  });
});

describe("families", () => {
  it("give every type the log can hold exactly one family, and every family a type", () => {
    for (const type of STORED_EVENT_TYPES) expect(familyOf(type), type).not.toBeNull();
    const claimed = EVENT_FAMILIES.flatMap(typesOf);
    expect([...claimed].sort()).toEqual([...STORED_EVENT_TYPES].sort());
    for (const family of EVENT_FAMILIES) expect(typesOf(family).length, family).toBeGreaterThan(0);
  });

  it("put each row in the family of its type, and leave a type this version does not know in none", () => {
    expect(viewEvent(event(40, "task.progress", { task_id: "t", text: "a" })).family).toBe("tasks");
    expect(viewEvent(event(41, "approval.requested", {})).family).toBe("approvals");
    expect(viewEvent(event(42, "browser.identity.closed", {})).family).toBe("browser");
    expect(viewEvent(event(43, "channel.status", {}, "host")).family).toBe("channels");
    expect(viewEvent(event(44, "something.new", { a: 1 })).family).toBeNull();
  });
});
