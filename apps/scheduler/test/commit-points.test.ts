/**
 * A change of state and the host event that tells it commit together or not at all. The control plane can be killed
 * (kill -9, a power cut) between any two statements; a transaction cannot be half done, so what is left is the state it
 * was in before the change, which recovery knows how to finish, never a state nobody was told of.
 *
 * Each test plays the kill by making the last write of the change throw (`killedAt`, database/testing): the process
 * dies there, and whatever was written before it in the same transaction must not have been committed. The events
 * checked are those the change would have logged.
 */
import type { Database } from "@invisible-dots/database";
import { createTestDatabase, killedAt, type TestDatabase } from "@invisible-dots/database/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Scheduler } from "../src/index.js";
import { FakeDriver, ManualClock, waitFor, waitUntilSettledReady } from "../src/testing.js";

const yaml = (name: string) => `name: ${name}\nmodel:\n  provider: openrouter\n  id: test/model\n`;

describe("the commit points of the host", () => {
  let t: TestDatabase;
  let db: Database;
  const open: Scheduler[] = [];

  beforeAll(async () => {
    t = await createTestDatabase("pglite");
    db = t.db;
    await db.secrets.put("global", "openrouter_api_key", "sk-or-test");
  });

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });

  afterAll(async () => {
    await t?.drop();
  });

  function make(driver: FakeDriver, over: Database = db) {
    const scheduler = new Scheduler({
      db: over,
      driver,
      clock: new ManualClock(),
      lifecycle: { healthPollMs: 5, readyTimeoutMs: 3_000, pumpRetryMs: 10, pumpMaxRetryMs: 50 },
      dispatcher: { retryDelayMs: 0, maxDeliveryAttempts: 2 },
      dispatchIntervalMs: 60_000,
      idleCheckIntervalMs: 60_000,
    });
    open.push(scheduler);
    return scheduler;
  }

  const typesOf = async (dotId: string, ...types: string[]) => (await db.events.list({ dotId, types })).map((e) => e.type);

  it("a stop killed at its last write leaves the computer STOPPING and says nothing of a stop; recovery finishes it, and tells of it once", async () => {
    const driver = new FakeDriver();
    const killed = killedAt(db, "dots", "setStatus");
    const first = make(driver, killed.db);
    const dot = await first.createDot(yaml("killed-stop"));
    await waitUntilSettledReady(first, driver, dot.id, "killed-stop");
    const before = (await typesOf(dot.id, "computer.stopped")).length;

    killed.kill();
    await first.stopComputer(dot.id);
    await first.settle();

    // Before the change the stop's rows were four statements, so the state was STOPPED, the Dot's status old and no event.
    expect(await db.computers.get(dot.id)).toMatchObject({ state: "STOPPING", stop_reason: "user" });
    expect((await db.events.list({ dotId: dot.id, types: ["computer.state"] })).map((e) => e.data.state)).not.toContain("STOPPED");
    expect(await typesOf(dot.id, "computer.stopped")).toHaveLength(before);

    // The control plane starts again: the interrupted stop is finished, and told once.
    killed.revive();
    await first.close();
    open.splice(open.indexOf(first), 1);
    const second = make(driver);
    await second.start();
    await second.settle();
    expect(await db.computers.get(dot.id)).toMatchObject({ state: "STOPPED", stop_reason: "user", pid: null, guest_port: null });
    expect(await db.events.list({ dotId: dot.id, types: ["computer.stopped"] })).toHaveLength(before + 1);
    expect((await db.events.list({ dotId: dot.id, types: ["computer.state"] })).map((e) => e.data.state).filter((state) => state === "STOPPED")).toHaveLength(1);
    expect((await db.dots.get(dot.id))?.status).toBe("IDLE");
  });

  it("a deletion killed at its last write leaves the Dot, and no dot.deleted; the event and the Dot go together", async () => {
    const driver = new FakeDriver();
    const killed = killedAt(db, "dots", "delete");
    const scheduler = make(driver, killed.db);
    const dot = await scheduler.createDot(yaml("killed-delete"));
    await waitUntilSettledReady(scheduler, driver, dot.id, "killed-delete");

    killed.kill();
    await scheduler.deleteDot(dot.id);
    await scheduler.settle();
    expect(await db.dots.get(dot.id)).not.toBeNull();
    expect(await typesOf(dot.id, "dot.deleted")).toEqual([]);

    killed.revive();
    await scheduler.deleteDot(dot.id);
    await scheduler.settle();
    expect(await db.dots.get(dot.id)).toBeNull();
    expect(await typesOf(dot.id, "dot.deleted")).toEqual(["dot.deleted"]);
  });

  it("a Dot killed at its second insert is not created and is not announced", async () => {
    const killed = killedAt(db, "computers", "insert");
    const scheduler = make(new FakeDriver(), killed.db);
    killed.kill();
    await expect(scheduler.createDot(yaml("killed-create"))).rejects.toThrow(/killed at computers.insert/);
    expect(await db.dots.resolve("killed-create")).toBeNull();
    expect((await db.events.list({ types: ["dot.created"] })).filter((e) => e.data.name === "killed-create")).toEqual([]);

    killed.revive();
    const dot = await scheduler.createDot(yaml("killed-create"));
    expect(await typesOf(dot.id, "dot.created", "computer.state")).toEqual(["dot.created", "computer.state"]);
  });

  it("a task killed at its insert is not announced, and an announced one exists", async () => {
    const driver = new FakeDriver();
    const killed = killedAt(db, "tasks", "insert");
    const scheduler = make(driver, killed.db);
    const dot = await scheduler.createDot(yaml("killed-task"));
    await waitUntilSettledReady(scheduler, driver, dot.id, "killed-task");

    killed.kill();
    await expect(scheduler.createTask(dot.id, { description: "never stored" })).rejects.toThrow(/killed at tasks.insert/);
    expect(await typesOf(dot.id, "task.created")).toEqual([]);

    killed.revive();
    const task = await scheduler.createTask(dot.id, { description: "stored" });
    await waitFor(async () => (await typesOf(dot.id, "task.created")).length === 1, "the event of the task");
    expect((await db.events.list({ dotId: dot.id, types: ["task.created"] }))[0]!.data.task_id).toBe(task.id);
  });

  it("a task given up killed at its last write is neither FAILED nor told; given up whole, it is both", async () => {
    const driver = new FakeDriver();
    const killed = killedAt(db, "inbound", "drop");
    const scheduler = make(driver, killed.db);
    const dot = await scheduler.createDot(yaml("killed-give-up"));
    await waitUntilSettledReady(scheduler, driver, dot.id, "killed-give-up");
    await scheduler.lifecycle.stop(dot.id, "user");
    driver.failNext("start", new Error("qemu-system-x86_64 exited: boom"), 3);
    const failures = async (taskId: string) =>
      (await db.query<{ failures: number }>("SELECT failures FROM inbound_events WHERE task_id = $1", [taskId])).rows[0]?.failures ?? 0;

    killed.kill();
    const task = await scheduler.createTask(dot.id, { description: "undeliverable" });
    await waitFor(async () => (await failures(task.id)) >= 2, "its attempts used up");
    await scheduler.settle();
    expect((await db.tasks.get(task.id))?.status).toBe("RUNNING");
    expect(await typesOf(dot.id, "task.failed")).toEqual([]);

    // The next attempt gives it up whole: the state and its event in one commit.
    killed.revive();
    await scheduler.inbound.kick(dot.id);
    expect((await db.tasks.get(task.id))?.status).toBe("FAILED");
    expect(await typesOf(dot.id, "task.failed")).toEqual(["task.failed"]);
  });

  it("a config killed at its save is not announced, and a saved one is, in the same commit", async () => {
    const driver = new FakeDriver();
    const killed = killedAt(db, "dots", "updateConfig");
    const scheduler = make(driver, killed.db);
    const dot = await scheduler.createDot(yaml("killed-config"));
    await waitUntilSettledReady(scheduler, driver, dot.id, "killed-config");
    const before = (await typesOf(dot.id, "dot.updated")).length;

    killed.kill();
    await expect(scheduler.updateDot(dot.id, `${yaml("killed-config")}instructions: be brief\n`)).rejects.toThrow(/killed at dots.updateConfig/);
    expect(await typesOf(dot.id, "dot.updated")).toHaveLength(before);
    expect((await db.dots.get(dot.id))?.config.instructions).toBeUndefined();

    killed.revive();
    await scheduler.updateDot(dot.id, `${yaml("killed-config")}instructions: be brief\n`);
    expect(await typesOf(dot.id, "dot.updated")).toHaveLength(before + 1);
    expect((await db.dots.get(dot.id))?.config.instructions).toBe("be brief");
  });

  it("the person's stop of a computer that is asleep is told, so that every view learns the automations will not wake it", async () => {
    const driver = new FakeDriver();
    const scheduler = make(driver);
    const dot = await scheduler.createDot(yaml("asleep-then-stopped"));
    await waitUntilSettledReady(scheduler, driver, dot.id, "asleep-then-stopped");
    await scheduler.lifecycle.stop(dot.id, "idle");
    expect(await db.computers.get(dot.id)).toMatchObject({ state: "STOPPED", stop_reason: "idle" });
    const stops = async () => (await db.events.list({ dotId: dot.id, types: ["computer.stopped"] })).map((e) => e.data);
    expect(await stops()).toEqual([{ reason: "idle", forced: false }]);

    await scheduler.stopComputer(dot.id);
    await scheduler.settle();
    expect(await db.computers.get(dot.id)).toMatchObject({ state: "STOPPED", stop_reason: "user" });
    expect(await stops()).toEqual([{ reason: "idle", forced: false }, { reason: "user", forced: false }]);

    // Asked again, it changes nothing and says nothing more.
    await scheduler.stopComputer(dot.id);
    await scheduler.settle();
    expect(await stops()).toHaveLength(2);
  });
});
