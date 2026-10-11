import { MAX_EVENT_PAGE, type StoredEvent } from "@invisible-dots/shared/browser";
import { describe, expect, it } from "vitest";
import { mergeEvents, readEventLog, readEventRange, readRecentEvents } from "../src/index.js";

function log(count: number): StoredEvent[] {
  return Array.from({ length: count }, (_, i) => ({ id: i + 1, dot_id: "d1", type: i % 3 === 0 ? "tool.called" : "agent.state", data: {}, source: "guest", guest_seq: i, created_at: "2026-03-10T12:00:00Z" }) as StoredEvent);
}

function clientOf(events: StoredEvent[]) {
  const asked: Array<{ after?: number; before?: number; limit?: number; types?: readonly string[]; tools?: readonly string[]; order?: string }> = [];
  return {
    asked,
    // The control plane's filter: the types a caller names are kept in the database, the limit counts what is kept.
    async events(_dot: string, options: { after?: number; before?: number; limit?: number; types?: readonly string[]; tools?: readonly string[]; order?: "asc" | "desc" } = {}) {
      asked.push(options);
      const kept = events.filter(
        (e) => e.id > (options.after ?? 0) && e.id < (options.before ?? Infinity) && (!options.types || options.types.includes(e.type)) && (!options.tools || e.type !== "tool.called" || options.tools.includes(String(e.data.tool))),
      );
      return (options.order === "desc" ? [...kept].reverse() : kept).slice(0, options.limit);
    },
  };
}

describe("readEventLog", () => {
  it("asks the control plane for the types it reads and pages through what is kept, oldest first", async () => {
    const client = clientOf(log(5 * MAX_EVENT_PAGE + 500));
    const read = await readEventLog(client, "d1", { types: ["tool.called"] });
    expect(read).toHaveLength(Math.ceil((5 * MAX_EVENT_PAGE + 500) / 3));
    expect(read.every((event) => event.type === "tool.called")).toBe(true);
    expect(read.map((event) => event.id)).toEqual([...read.map((event) => event.id)].sort((a, b) => a - b));
    // Every page asked for the type: the log was not read in full to be cut here (a third of it is that type, so two pages).
    expect(client.asked.every((a) => a.types?.join() === "tool.called")).toBe(true);
    expect(client.asked).toHaveLength(2);
    expect(client.asked.map((a) => a.after)).toEqual([0, read[MAX_EVENT_PAGE - 1]!.id]);
  });

  it("also keeps only what the caller's predicate accepts, for what a type alone cannot say", async () => {
    const client = clientOf(log(30));
    const read = await readEventLog(client, "d1", { types: ["tool.called", "agent.state"], keep: (event) => event.id % 2 === 0 });
    expect(read.map((event) => event.id)).toEqual(Array.from({ length: 15 }, (_, i) => 2 * (i + 1)));
  });

  it("reads a log the way the control plane serves it: pages cut at the cap it publishes, never longer", async () => {
    // A control plane that clamps like the store does, and a log of three pages and a bit.
    const events = log(3 * MAX_EVENT_PAGE + 7);
    const asked: number[] = [];
    const client = {
      async events(_dot: string, options: { after?: number; limit?: number; types?: readonly string[] } = {}) {
        asked.push(options.limit ?? 0);
        return events.filter((e) => e.id > (options.after ?? 0)).slice(0, Math.min(options.limit ?? MAX_EVENT_PAGE, MAX_EVENT_PAGE));
      },
    };
    expect(await readEventLog(client, "d1", { types: ["tool.called", "agent.state"] })).toHaveLength(events.length);
    expect(asked).toEqual([MAX_EVENT_PAGE, MAX_EVENT_PAGE, MAX_EVENT_PAGE, MAX_EVENT_PAGE]);
  });

  it("returns an empty log as nothing", async () => {
    expect(await readEventLog(clientOf([]), "d1", { types: ["tool.called"] })).toEqual([]);
  });

  it("starts after the id it is given, so what is older is never asked for", async () => {
    const client = clientOf(log(30));
    const read = await readEventLog(client, "d1", { types: ["tool.called", "agent.state"], after: 20 });
    expect(read.map((e) => e.id)).toEqual(Array.from({ length: 10 }, (_, i) => 21 + i));
    expect(client.asked.map((a) => a.after)).toEqual([20]);
  });
});

describe("readEventRange", () => {
  it("reads what lies between two ids, newest page first and given oldest first, and stops at the lower one", async () => {
    const events = log(5 * MAX_EVENT_PAGE);
    const client = clientOf(events);
    const read = await readEventRange(client, "d1", { types: ["tool.called", "agent.state"], after: 100, before: 2 * MAX_EVENT_PAGE + 50 });
    expect(read.map((e) => e.id)).toEqual(Array.from({ length: 2 * MAX_EVENT_PAGE + 50 - 101 }, (_, i) => 101 + i));
    // Two pages (a full one and the rest); nothing below `after` was read.
    expect(client.asked).toHaveLength(2);
    expect(client.asked.every((a) => a.after === 100 && a.order === "desc")).toBe(true);
    expect(client.asked.map((a) => a.before)).toEqual([2 * MAX_EVENT_PAGE + 50, MAX_EVENT_PAGE + 50]);
  });

  it("is empty when nothing lies between", async () => {
    expect(await readEventRange(clientOf(log(10)), "d1", { types: ["tool.called"], after: 5, before: 6 })).toEqual([]);
  });
});

describe("readRecentEvents", () => {
  it("asks once for the newest events of the types and tools, newest first, and gives them oldest first", async () => {
    const events = log(5 * MAX_EVENT_PAGE).map((e) => ({ ...e, data: { tool: e.id % 2 === 0 ? "browser_click" : "exec" } }) as StoredEvent);
    const client = clientOf(events);
    const read = await readRecentEvents(client, "d1", { types: ["tool.called"], tools: ["browser_click"], count: 10 });
    expect(client.asked).toEqual([{ limit: 10, types: ["tool.called"], tools: ["browser_click"], order: "desc" }]);
    expect(read).toHaveLength(10);
    expect(read.every((event) => event.data.tool === "browser_click")).toBe(true);
    expect(read.map((event) => event.id)).toEqual([...read.map((event) => event.id)].sort((a, b) => a - b));
    expect(read.at(-1)!.id).toBe(events.filter((e) => e.type === "tool.called" && e.data.tool === "browser_click").at(-1)!.id);
  });

  it("never asks for more than a page, and drops from what it got what the caller's predicate refuses", async () => {
    const client = clientOf(log(30));
    const read = await readRecentEvents(client, "d1", { types: ["tool.called", "agent.state"], keep: (event) => event.id % 2 === 0, count: 10 * MAX_EVENT_PAGE });
    expect(client.asked.map((a) => a.limit)).toEqual([MAX_EVENT_PAGE]);
    expect(read.map((event) => event.id)).toEqual(Array.from({ length: 15 }, (_, i) => 2 * (i + 1)));
  });

  it("goes on from `before`: the page of events that came before the oldest one read, oldest first", async () => {
    const events = log(30);
    const client = clientOf(events);
    const newest = await readRecentEvents(client, "d1", { types: ["tool.called", "agent.state"], count: 10 });
    expect(newest.map((e) => e.id)).toEqual(Array.from({ length: 10 }, (_, i) => 21 + i));
    const older = await readRecentEvents(client, "d1", { types: ["tool.called", "agent.state"], count: 10, before: newest[0]!.id });
    expect(older.map((e) => e.id)).toEqual(Array.from({ length: 10 }, (_, i) => 11 + i));
    expect(client.asked[1]).toMatchObject({ before: 21, limit: 10, order: "desc" });
    // The start of the log: fewer than asked for, then nothing.
    const first = await readRecentEvents(client, "d1", { types: ["tool.called", "agent.state"], count: 10, before: 11 });
    expect(first.map((e) => e.id)).toEqual(Array.from({ length: 10 }, (_, i) => 1 + i));
    expect(await readRecentEvents(client, "d1", { types: ["tool.called", "agent.state"], count: 10, before: 1 })).toEqual([]);
  });
});

describe("mergeEvents", () => {
  const at = (id: number, type: string) => ({ id, dot_id: "d1", type, data: {}, source: "guest", guest_seq: id, created_at: "2026-03-10T12:00:00Z" }) as StoredEvent;

  it("orders by id and drops duplicates from a replayed stream", () => {
    const a = at(1, "agent.state");
    const b = at(2, "agent.state");
    const c = at(3, "agent.state");
    expect(mergeEvents([a, c], [b, c]).map((e) => e.id)).toEqual([1, 2, 3]);
  });
});
