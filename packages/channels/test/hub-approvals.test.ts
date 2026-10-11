/**
 * Approvals over a channel, with the real Scheduler and a fake guest and an in-memory channel: the prompt each
 * owner gets, who may answer it, what the answer does, and how the prompts stay true across restarts and
 * across answers given somewhere else. The Telegram adapter's side is in telegram.test.ts and hub-telegram.test.ts.
 */
import type { Database } from "@invisible-dots/database";
import { createTestDatabase, testAdapters, type TestDatabase } from "@invisible-dots/database/testing";
import { waitFor } from "@invisible-dots/scheduler/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ChannelSendError } from "../src/index.js";
import { FakeChannelType } from "../src/testing.js";
import { linkedFake, makeWorlds, quiet, type World } from "./world.js";

describe.each(testAdapters())("approvals over a channel, with the real Scheduler and a fake guest (%s)", { timeout: 60_000 }, (kind) => {
  let t: TestDatabase;
  let db: Database;
  let world: ReturnType<typeof makeWorlds>["world"];
  let closeAll: ReturnType<typeof makeWorlds>["closeAll"];

  beforeAll(async () => {
    t = await createTestDatabase(kind);
    db = t.db;
    ({ world, closeAll } = makeWorlds(db));
    await db.secrets.put("global", "openrouter_api_key", "sk-or-test");
  }, 60_000);

  afterEach(async () => {
    await closeAll();
    await db.query("DELETE FROM channel_bindings");
  });

  afterAll(async () => {
    await t?.drop();
  });

  const received = (guest: { inbound: { type: string }[] }) => guest.inbound.filter((e) => e.type === "approval.received");
  const statusOf = async (id: string) => (await db.approvals.get(id))?.status;

  /** The Dot asks for an approval and the control plane has it recorded. */
  async function ask(w: World, dot: Awaited<ReturnType<World["dot"]>>, tool = "exec") {
    const id = dot.guest.requestApproval(undefined, tool);
    await waitFor(async () => (await db.approvals.get(id)) !== null, "the approval to be recorded");
    return id;
  }

  it("asks every owner's chat, once, with the tool, the permission and the reason", async () => {
    const w = await world();
    const { dot, channel } = await linkedFake(w, ["10", "20"]);
    const id = await ask(w, dot);
    await waitFor(() => channel.prompts.length === 2, "a prompt for each owner");
    expect(channel.prompts.map((p) => [p.chatId, p.approvalId])).toEqual([
      ["10", id],
      ["20", id],
    ]);
    expect(channel.prompts[0]!.text).toBe(
      ["The Dot wants to run a command.", "Permission: Delete browser identities (high risk)", "Reason: the tool needs approval", 'Arguments: {"identity_id":"shop-abc123"}'].join("\n"),
    );
    // A prompt is recorded once its chat took it, so the record follows the channel.
    const bindingId = (await db.channels.listBindings(dot.id))[0]!.id;
    await waitFor(async () => (await db.channels.prompts(bindingId)).length === 2, "both prompts recorded");
    await quiet();
    expect(channel.prompts).toHaveLength(2);
    expect((await db.channels.prompts(bindingId)).map((p) => p.chat_id)).toEqual(["10", "20"]);
  });

  it("leaves the arguments out of the prompt and of its outcome when show_arguments is off", async () => {
    const w = await world();
    const { hub, dot, channel } = await linkedFake(w, ["10"]);
    await hub.setSettings(dot.id, "telegram", { show_arguments: false });
    const id = await ask(w, dot);
    await waitFor(() => channel.prompts.length === 1, "the prompt");
    const question = ["The Dot wants to run a command.", "Permission: Delete browser identities (high risk)", "Reason: the tool needs approval"].join("\n");
    expect(channel.prompts[0]!.text).toBe(question);
    expect(await channel.press(id, "approve", "10")).toBe("Approved.");
    await waitFor(() => channel.edits.length === 1, "the edit");
    expect(channel.edits[0]!.text).toBe(`${question}\n\nApproved.`);
  });

  it("approves from the chat: the guest gets the decision, the notice says so, and every prompt is edited to the outcome", async () => {
    const w = await world();
    const { dot, channel } = await linkedFake(w, ["10", "20"]);
    const id = await ask(w, dot);
    await waitFor(() => channel.prompts.length === 2, "the prompts");

    expect(await channel.press(id, "approve", "10")).toBe("Approved.");
    expect(await statusOf(id)).toBe("approved");
    await waitFor(() => received(dot.guest).length === 1, "the decision at the guest");
    expect(received(dot.guest)[0]).toMatchObject({ data: { approval_id: id, decision: "approve" } });
    await waitFor(() => channel.edits.length === 2, "both prompts edited");
    expect(channel.edits.map((e) => [e.chatId, e.ref]).sort()).toEqual([
      ["10", "prompt-1"],
      ["20", "prompt-2"],
    ]);
    expect(channel.edits.every((e) => e.text.endsWith("\n\nApproved."))).toBe(true);
    // The prompts are forgotten once they were edited, so that follows the channel.
    const bindingId = (await db.channels.listBindings(dot.id))[0]!.id;
    await waitFor(async () => (await db.channels.prompts(bindingId)).length === 0, "the prompts forgotten");
  });

  it("rejects from the chat", async () => {
    const w = await world();
    const { dot, channel } = await linkedFake(w);
    const id = await ask(w, dot);
    await waitFor(() => channel.prompts.length === 1, "the prompt");
    expect(await channel.press(id, "reject", "10")).toBe("Rejected.");
    expect(await statusOf(id)).toBe("rejected");
    await waitFor(() => received(dot.guest).length === 1, "the decision at the guest");
    expect(received(dot.guest)[0]).toMatchObject({ data: { decision: "reject" } });
    await waitFor(() => channel.edits.length === 1, "the edit");
    expect(channel.edits[0]!.text.endsWith("\n\nRejected.")).toBe(true);
  });

  it("edits the prompts when the approval is answered somewhere else", async () => {
    const w = await world();
    const { dot, channel } = await linkedFake(w, ["10", "20"]);
    const id = await ask(w, dot);
    await waitFor(() => channel.prompts.length === 2, "the prompts");
    await w.scheduler.resolveApproval(id, "reject");
    await waitFor(() => channel.edits.length === 2, "both prompts edited");
    expect(channel.edits.every((e) => e.text.endsWith("\n\nRejected."))).toBe(true);
  });

  it("answers a second press with 'answered already', and the guest hears the decision once", async () => {
    const w = await world();
    const { dot, channel } = await linkedFake(w, ["10", "20"]);
    const id = await ask(w, dot);
    await waitFor(() => channel.prompts.length === 2, "the prompts");
    expect(await channel.press(id, "approve", "10")).toBe("Approved.");
    expect(await channel.press(id, "reject", "20")).toBe("It was answered already.");
    expect(await channel.press(id, "approve", "10")).toBe("It was answered already.");
    await quiet();
    expect(received(dot.guest)).toHaveLength(1);
    expect(await statusOf(id)).toBe("approved");
  });

  it("lets nobody answer who is not a paired owner in their private chat, and resolves nothing for them", async () => {
    const w = await world();
    const { hub: h, dot, channel } = await linkedFake(w, ["10"]);
    const binding = (await db.channels.listBindings(dot.id))[0]!;
    await db.channels.upsertPeer({ bindingId: binding.id, peerId: "30", chatId: "30", role: "user", label: "Guest" });
    const id = await ask(w, dot);
    await waitFor(() => channel.prompts.length === 1, "the prompt");

    const refused = "You are not allowed to answer this.";
    expect(await channel.press(id, "approve", "99")).toBe(refused); // a stranger
    expect(await channel.press(id, "approve", "30")).toBe(refused); // paired, but not an owner
    expect(await channel.press(id, "approve", "10", "999")).toBe(refused); // an owner, from a chat that is not theirs
    expect(await channel.press(id, "approve", "10", "10", false)).toBe(refused); // not a private chat
    await quiet();
    expect(await statusOf(id)).toBe("pending");
    expect(received(dot.guest)).toEqual([]);
    expect(channel.edits).toEqual([]);

    // A revoked owner is a stranger again.
    await h.removePeer(dot.id, "telegram", "10");
    expect(await channel.press(id, "approve", "10")).toBe(refused);
    expect(await statusOf(id)).toBe("pending");
  });

  it("does not let an owner of one Dot answer another Dot's approval, nor one that does not exist", async () => {
    const w = await world();
    const mine = await linkedFake(w, ["10"]);
    const other = await w.dot();
    const theirs = await ask(w, other);
    await quiet();
    expect(await mine.channel.press(theirs, "approve", "10")).toBe("That request does not exist.");
    expect(await mine.channel.press("appr_nothing", "approve", "10")).toBe("That request does not exist.");
    expect(await statusOf(theirs)).toBe("pending");
    expect(received(other.guest)).toEqual([]);
    expect(mine.channel.prompts).toEqual([]);
  });

  it("asks nothing while approvals are off, refuses a stale button, and asks what is waiting when they are switched on", async () => {
    const w = await world();
    const { hub: h, dot, channel } = await linkedFake(w, ["10"]);
    await h.setSettings(dot.id, "telegram", { approvals: false });
    const id = await ask(w, dot);
    await quiet();
    expect(channel.prompts).toEqual([]);
    expect(await channel.press(id, "approve", "10")).toBe("Approvals are not answered in this chat. Open the app to answer.");
    expect(await statusOf(id)).toBe("pending");

    await h.setSettings(dot.id, "telegram", { approvals: true });
    await waitFor(() => channel.prompts.length === 1, "the waiting approval asked");
    expect(channel.prompts[0]!.approvalId).toBe(id);
    // Setting it on again changes nothing: it was on already.
    await h.setSettings(dot.id, "telegram", { approvals: true });
    await quiet();
    expect(channel.prompts).toHaveLength(1);
  });

  it("asks a person who pairs while an approval waits", async () => {
    const w = await world();
    const { hub: h, dot, channel } = await linkedFake(w, ["10"]);
    const id = await ask(w, dot);
    await waitFor(() => channel.prompts.length === 1, "the first owner asked");
    const { code } = await h.pair(dot.id, "telegram");
    expect(await channel.pair(code, "20", "20", "Second")).toBe(true);
    await waitFor(() => channel.prompts.length === 2, "the new owner asked");
    expect(channel.prompts.map((p) => [p.chatId, p.approvalId])).toEqual([
      ["10", id],
      ["20", id],
    ]);
  });

  it("asks again after a restart only what has no prompt, and edits what was settled while the hub was down", async () => {
    const w = await world();
    const type = new FakeChannelType();
    const first = await linkedFake(w, ["10"], {}, type);
    const answered = await ask(w, first.dot);
    const waiting = await ask(w, first.dot, "write");
    await waitFor(() => first.channel.prompts.length === 2, "both asked");
    await first.hub.close();

    await w.scheduler.resolveApproval(answered, "approve");
    await w.hub(type);
    const channel = await waitFor(() => (type.channels.length === 2 ? type.channels[1] : undefined), "the channel to run again");
    await waitFor(() => channel.edits.length === 1, "the settled prompt edited");
    expect(channel.edits[0]).toMatchObject({ chatId: "10", ref: "prompt-1" });
    expect(channel.edits[0]!.text.endsWith("\n\nApproved.")).toBe(true);
    await quiet();
    // The one still waiting has its prompt: nobody is asked twice.
    expect(channel.prompts).toEqual([]);
    expect(channel.edits).toHaveLength(1);
    expect(await statusOf(waiting)).toBe("pending");
  });

  it("asks at start for an approval that came while nobody could be asked", async () => {
    const w = await world();
    const type = new FakeChannelType();
    const first = await linkedFake(w, ["10"], {}, type);
    const binding = (await db.channels.listBindings(first.dot.id))[0]!;
    await first.hub.setSettings(first.dot.id, "telegram", { approvals: false });
    const id = await ask(w, first.dot);
    await quiet();
    expect(first.channel.prompts).toEqual([]);
    await first.hub.close();

    // The owner switched approvals on while the server was down, past the event that asked.
    await db.channels.setSettings(binding.id, { ...binding.settings, approvals: true });
    await w.hub(type);
    const channel = await waitFor(() => (type.channels.length === 2 ? type.channels[1] : undefined), "the channel to run again");
    await waitFor(() => channel.prompts.length === 1, "the prompt");
    expect(channel.prompts[0]!.approvalId).toBe(id);
  });

  it("says an approval is no longer needed when its task ended before anyone answered", async () => {
    const w = await world();
    const type = new FakeChannelType();
    const first = await linkedFake(w, ["10"], {}, type);
    const id = await ask(w, first.dot);
    await waitFor(() => first.channel.prompts.length === 1, "asked");
    await first.hub.close();
    await db.query("UPDATE approvals SET status = 'expired', resolved_at = now() WHERE id = $1", [id]);

    await w.hub(type);
    const channel = await waitFor(() => (type.channels.length === 2 ? type.channels[1] : undefined), "the channel to run again");
    await waitFor(() => channel.edits.length === 1, "the edit");
    expect(channel.edits[0]!.text.endsWith("\n\nNo longer needed: the task ended before anyone answered.")).toBe(true);
    expect(await channel.press(id, "approve", "10")).toBe("It was answered already.");
  });

  it("tries a prompt again when the channel cannot take it now", async () => {
    const w = await world();
    const { dot, channel, type } = await linkedFake(w, ["10"]);
    type.sendFailures.push(new Error("network down"));
    const id = await ask(w, dot);
    await waitFor(() => channel.prompts.length === 1, "the prompt, after a retry");
    await quiet();
    expect(channel.prompts).toHaveLength(1);
    expect(await channel.press(id, "approve", "10")).toBe("Approved.");
  });

  it("drops a prompt for a chat that refuses it for good, and still asks the others", async () => {
    const w = await world();
    const { dot, channel, type } = await linkedFake(w, ["10", "20"]);
    type.sendFailures.push(new ChannelSendError("blocked", { retryable: false }));
    await ask(w, dot);
    const binding = (await db.channels.listBindings(dot.id))[0]!;
    // The prompt is recorded once the chat took it, so the record is what to wait for.
    await waitFor(async () => (await db.channels.prompts(binding.id)).length === 1, "the other owner's prompt recorded");
    await quiet();
    expect(channel.prompts.map((p) => p.chatId)).toEqual(["20"]);
    expect((await db.channels.prompts(binding.id)).map((p) => p.chat_id)).toEqual(["20"]);
  });

  it("does not ask for an approval that was answered before the hub looked at it", async () => {
    const w = await world();
    const { hub: h, dot, type } = await linkedFake(w, ["10"]);
    await h.close();
    const id = await ask(w, dot);
    await w.scheduler.resolveApproval(id, "approve");
    await w.hub(type);
    const channel = await waitFor(() => (type.channels.length === 2 ? type.channels[1] : undefined), "the channel to run again");
    await waitFor(() => channel.sink !== null, "connected");
    await quiet();
    expect(channel.prompts).toEqual([]);
    expect(channel.edits).toEqual([]);
  });
});
