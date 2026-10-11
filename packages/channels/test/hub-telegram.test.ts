/**
 * The hub with the real Telegram adapter: a Telegram update comes in at FakeBotApi (a real HTTP server the real
 * grammY client polls), goes through the real Scheduler with a fake guest, and the Dot's answer is a message
 * the fake receives. The policies themselves are tested in hub.test.ts with an in-memory channel; this proves
 * they hold through the adapter.
 */
import type { Database } from "@invisible-dots/database";
import { createTestDatabase, testAdapters, type TestDatabase } from "@invisible-dots/database/testing";
import { type Logger } from "@invisible-dots/shared";
import { waitFor } from "@invisible-dots/scheduler/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_CHANNEL_SETTINGS, TelegramChannelType } from "../src/index.js";
import { FakeBotApi } from "../src/testing.js";
import { makeWorlds, quiet, type World } from "./world.js";

const TOKEN = "123456:SECRET-TOKEN-VALUE";
const ANN = { id: 10, first_name: "Ann", username: "ann" };

describe.each(testAdapters())("the hub with the real Telegram adapter (%s)", { timeout: 60_000 }, (kind) => {
  let t: TestDatabase;
  let db: Database;
  let bots: FakeBotApi;
  let world: ReturnType<typeof makeWorlds>["world"];
  let closeAll: ReturnType<typeof makeWorlds>["closeAll"];

  beforeAll(async () => {
    t = await createTestDatabase(kind);
    db = t.db;
    bots = await FakeBotApi.start();
    ({ world, closeAll } = makeWorlds(db));
    await db.secrets.put("global", "openrouter_api_key", "sk-or-test");
  }, 60_000);

  afterEach(async () => {
    await closeAll();
    await db.query("DELETE FROM channel_bindings");
    await db.query("DELETE FROM secrets WHERE name = 'telegram_bot_token'");
  });

  afterAll(async () => {
    await bots?.close();
    await t?.drop();
  });

  const telegram = (pollSeconds = 30) => new TelegramChannelType({ apiRoot: bots.apiRoot, pollSeconds });
  const logs = () => {
    const lines: string[] = [];
    const log = (level: string) => (message: string, fields?: Record<string, unknown>) => void lines.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`);
    const logger: Logger = { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") };
    return { lines, logger };
  };

  /** A Dot linked to a Telegram bot, with Ann (user 10) paired through the code in the deep link. */
  async function linked(w: World, token = TOKEN, username = "dot_helper_bot", options: Parameters<World["hub"]>[1] = {}) {
    bots.addBot(token, username);
    const { hub } = await w.hub(telegram(), options);
    const dot = await w.dot();
    const added = await hub.add(dot.id, "telegram", { credentials: { telegram_bot_token: token } });
    await waitFor(() => bots.polling(token), "the bot to be polled");
    const { code, deep_link } = await hub.pair(dot.id, "telegram");
    bots.say(token, `/start ${code}`, ANN);
    await waitFor(async () => (await hub.list(dot.id))[0]!.peers.length === 1, "the pairing");
    await waitFor(() => bots.sent(token, 10).length === 1, "the welcome");
    bots.clearSent(token);
    return { hub, dot, added, code, deepLink: deep_link };
  }

  const userMessages = (dotId: string) => db.events.list({ dotId, types: ["user.message"] });

  it("links a bot, shows its name and the deep link, and pairs the person who opens it", async () => {
    const w = await world();
    bots.addBot(TOKEN, "dot_helper_bot");
    const { hub } = await w.hub(telegram());
    const dot = await w.dot();
    const added = await hub.add(dot.id, "telegram", { credentials: { telegram_bot_token: TOKEN } });
    expect(added).toMatchObject({ kind: "telegram", enabled: true, account: "dot_helper_bot", peers: [] });
    await waitFor(async () => (await hub.list(dot.id))[0]!.status === "connected", "connected");

    const { code, deep_link, expires_at } = await hub.pair(dot.id, "telegram");
    expect(deep_link).toBe(`https://t.me/dot_helper_bot?start=${code}`);
    expect(new Date(expires_at).getTime()).toBeGreaterThan(Date.now() - 1000);
    await waitFor(() => bots.polling(TOKEN), "polling");
    bots.say(TOKEN, `/start ${code}`, ANN);
    await waitFor(async () => (await hub.list(dot.id))[0]!.peers.length === 1, "the pairing");
    expect((await hub.list(dot.id))[0]!.peers[0]).toMatchObject({ peer_id: "10", role: "owner", label: "Ann (@ann)" });
    await waitFor(() => bots.sent(TOKEN, 10).length === 1, "the welcome");
    expect(bots.sent(TOKEN, 10)[0]!.text).toMatch(/^Paired\./);
    expect((await db.events.list({ dotId: dot.id, types: ["channel.peer.paired"] })).map((e) => e.data)).toEqual([{ kind: "telegram", peer_id: "10", label: "Ann (@ann)" }]);

    // The code is gone: a second person with it is a stranger.
    bots.say(TOKEN, `/start ${code}`, { id: 66, first_name: "Eve" });
    await quiet();
    expect((await hub.list(dot.id))[0]!.peers.map((p) => p.peer_id)).toEqual(["10"]);
    expect(bots.sent(TOKEN, 66)).toEqual([]);
  });

  it("carries a message to the Dot and its answer back to the chat that asked, through the real Scheduler", async () => {
    const w = await world();
    const { dot } = await linked(w);
    bots.say(TOKEN, "hello dot", ANN);
    await waitFor(() => bots.sent(TOKEN, 10).length === 1, "the answer");
    expect(bots.sent(TOKEN, 10)).toEqual([{ chat_id: "10", text: "echo: hello dot" }]);
    expect(dot.guest.inbound.at(-1)).toMatchObject({ type: "user.message", data: { text: "hello dot" } });
    const [logged] = await userMessages(dot.id);
    expect(logged!.data.origin).toMatchObject({ channel: "telegram", chat_id: "10", external_id: expect.stringMatching(/^123456:\d+$/) });
    expect(bots.actions(TOKEN).every((a) => a.action === "typing")).toBe(true);
  });

  it("says a photo is not supported to a paired person, and nothing to a stranger", async () => {
    const w = await world();
    const { dot } = await linked(w);
    const before = (await db.events.list({ dotId: dot.id })).length;
    bots.sendPhoto(TOKEN, ANN, "see this");
    bots.sendPhoto(TOKEN, { id: 66 }, "me too");
    await waitFor(() => bots.sent(TOKEN, 10).length === 1, "the notice");
    await quiet();
    expect(bots.sent(TOKEN, 10)[0]!.text).toMatch(/Attachments are not supported yet/);
    expect(bots.sent(TOKEN, 66)).toEqual([]);
    expect((await db.events.list({ dotId: dot.id })).length).toBe(before);
  });

  it("drops a stranger's hundred messages with no row written, no model event and no reply", async () => {
    const w = await world();
    const { dot } = await linked(w);
    const counts = async () => ({
      events: (await db.events.list({ dotId: dot.id })).length,
      delivered: dot.guest.inbound.length,
    });
    const before = await counts();
    for (let i = 0; i < 100; i++) bots.say(TOKEN, `spam ${i}`, { id: 666, first_name: "Mallory" });
    bots.say(TOKEN, "in a group", ANN, { id: -100, type: "supergroup" });
    bots.say(TOKEN, "/start WRONG123", { id: 666 });
    await waitFor(() => bots.unconfirmed(TOKEN).length === 0, "every update to be read and confirmed");
    await quiet(100);
    expect(await counts()).toEqual(before);
    expect(bots.sent(TOKEN, 666)).toEqual([]);
    expect(bots.sent(TOKEN, -100)).toEqual([]);
  });

  it("answers a revoked person with silence", async () => {
    const w = await world();
    const { hub, dot } = await linked(w);
    await hub.removePeer(dot.id, "telegram", "10");
    bots.say(TOKEN, "am I still in?", ANN);
    await quiet(200);
    expect(await userMessages(dot.id)).toEqual([]);
    expect(bots.sent(TOKEN, 10)).toEqual([]);
  });

  it("restarts in the middle: an update Telegram offers again is not run twice, and what a restart missed is sent", async () => {
    const w = await world();
    const { hub, dot } = await linked(w);
    const first = bots.say(TOKEN, "first", ANN);
    await waitFor(() => bots.sent(TOKEN, 10).length === 1, "the first answer");

    // Telegram offers an update again when the bot died before it confirmed it: the hub knows it by its id.
    bots.redeliver(TOKEN, first);
    await waitFor(() => bots.unconfirmed(TOKEN).length === 0, "the offer to be taken and confirmed");
    await quiet(100);
    expect((await userMessages(dot.id)).map((e) => e.data.text)).toEqual(["first"]);
    expect(bots.sent(TOKEN, 10)).toHaveLength(1);
    await hub.close();

    // While no hub runs the person writes and the Dot (an automation) speaks; the old update is offered once more.
    const waiting = bots.say(TOKEN, "while you were away", ANN);
    bots.redeliver(TOKEN, first);
    expect(bots.unconfirmed(TOKEN)).toContain(waiting);
    dot.guest.emit("message.assistant", { text: "daily report" });

    const second = await w.hub(telegram());
    await waitFor(() => bots.sent(TOKEN, 10).length === 3, "the missed report and the answer to the missed message");
    expect(
      bots
        .sent(TOKEN, 10)
        .map((m) => m.text)
        .sort(),
    ).toEqual(["daily report", "echo: first", "echo: while you were away"]);
    expect((await userMessages(dot.id)).map((e) => e.data.text)).toEqual(["first", "while you were away"]);

    await second.hub.close();
    await w.hub(telegram());
    await quiet(200);
    expect(bots.sent(TOKEN, 10)).toHaveLength(3);
  });

  it("hands a message to the Dot once when the failure comes after it was stored, and confirms the redelivery", async () => {
    const w = await world();
    const { hub, dot } = await linked(w);
    await hub.close();
    // A host that stores the message and then fails, as a lost connection or a crash after COMMIT does: the update stays with Telegram and is offered again.
    let failed = 0;
    const host = new Proxy(w.scheduler, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (property === "sendMessage") {
          return async (...args: Parameters<typeof target.sendMessage>) => {
            const answer = await target.sendMessage(...args);
            if (failed++ === 0) throw new Error("the connection dropped after the commit");
            return answer;
          };
        }
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const { ChannelHub } = await import("../src/index.js");
    const failing = new ChannelHub({ db, host, types: [telegram()], backoff: { initialMs: 1, maxMs: 5, jitter: 0 } });
    await failing.start();
    const id = bots.say(TOKEN, "do not lose me", ANN);
    await waitFor(() => failed >= 2, "the redelivery to reach the host");
    await waitFor(() => bots.sent(TOKEN, 10).some((m) => m.text === "echo: do not lose me"), "the answer");
    await waitFor(() => !bots.unconfirmed(TOKEN).includes(id), "the update to be confirmed");
    // Let anything still in flight land before counting: a duplicate would show here.
    await quiet(300);
    expect((await userMessages(dot.id)).filter((e) => e.data.text === "do not lose me")).toHaveLength(1);
    expect(bots.sent(TOKEN, 10).filter((m) => m.text === "echo: do not lose me")).toHaveLength(1);
    expect(dot.guest.inbound.filter((e) => e.type === "user.message")).toHaveLength(1);
    await failing.close();
  });

  it("reports a second poller as an error that explains itself, and recovers when it goes away", async () => {
    const w = await world();
    const { hub, dot } = await linked(w);
    // Another process starts polling the same bot: Telegram ends our poll with a 409.
    const intruder = new AbortController();
    const { Api } = await import("grammy");
    const other = new Api(TOKEN, { apiRoot: bots.apiRoot });
    void other.getUpdates({ timeout: 30 }, intruder.signal as never).catch(() => {});
    const errors = async () => (await db.events.list({ dotId: dot.id, types: ["channel.status"] })).filter((e) => e.data.status === "error");
    await waitFor(async () => (await errors()).length > 0, "the error status in the log");
    const detail = String((await errors())[0]!.data.detail);
    expect(detail).toMatch(/another process is polling this bot/);
    expect(detail).not.toContain(TOKEN);
    intruder.abort();
    // Our adapter polls again after its backoff (FAST), and the status is connected once more.
    await waitFor(async () => (await hub.list(dot.id))[0]!.status === "connected", "connected again");
  });

  it("keeps backing off a bot whose polls always fail (a 409), and never calls it connected", async () => {
    const w = await world();
    bots.addBot(TOKEN, "dot_helper_bot");
    // The same 409 every time: a second server polling the same bot.
    bots.failNext(TOKEN, "getUpdates", { error_code: 409, description: "Conflict: terminated by other getUpdates request" }, 100_000);
    const before = bots.requests.length;
    const { hub } = await w.hub(telegram(), { backoff: { initialMs: 20, maxMs: 160, jitter: 0 } });
    const dot = await w.dot();
    await hub.add(dot.id, "telegram", { credentials: { telegram_bot_token: TOKEN } });
    await quiet(1500);
    const polls = bots.requests.slice(before).filter((r) => r.method === "getUpdates").length;
    const statuses = (await db.events.list({ dotId: dot.id, types: ["channel.status"] })).map((e) => e.data.status);
    // 20, 40, 80 and then 160 ms apart: about a dozen tries in 1.5 s; a backoff that restarts at 20 ms would make about seventy.
    expect(polls).toBeGreaterThan(3);
    expect(polls).toBeLessThanOrEqual(20);
    expect(statuses).not.toContain("connected");
    expect(statuses.length).toBeLessThanOrEqual(3);
    expect((await hub.list(dot.id))[0]!.status).toBe("error");
  });

  it("waits at least what Telegram asks when a poll is answered with a 429", async () => {
    const w = await world();
    bots.addBot(TOKEN, "dot_helper_bot");
    bots.failNext(TOKEN, "getUpdates", { error_code: 429, description: "x", retry_after: 1 });
    const { hub } = await w.hub(telegram());
    const dot = await w.dot();
    await hub.add(dot.id, "telegram", { credentials: { telegram_bot_token: TOKEN } });
    // Read from the log, where every change of status is recorded: polling the status itself can miss an error that
    // lasts only the second Telegram asked for, when a loaded machine makes one read longer than that.
    const changes = async () =>
      (await db.events.list({ dotId: dot.id, types: ["channel.status"] })).map((e) => ({ status: e.data.status, at: Date.parse(e.created_at) }));
    const [failed, back] = await waitFor(
      async () => {
        const seen = await changes();
        const failed = seen.find((change) => change.status === "error");
        const back = failed && seen.find((change) => change.status === "connected" && change.at >= failed.at);
        return failed && back ? ([failed, back] as const) : undefined;
      },
      "the error and the reconnection in the log",
      15_000,
    );
    // The backoff of these tests is a few milliseconds: only the 429's own wait can make this long.
    expect(back.at - failed.at).toBeGreaterThanOrEqual(800);
  });

  it("waits out a 429 when sending and delivers the answer once", async () => {
    const w = await world();
    await linked(w);
    bots.failNext(TOKEN, "sendMessage", { error_code: 429, description: "x", retry_after: 1 });
    bots.say(TOKEN, "slow down", ANN);
    await waitFor(() => bots.sent(TOKEN, 10).length === 1, "the answer after the wait", 15_000);
    expect(bots.sent(TOKEN, 10)).toEqual([{ chat_id: "10", text: "echo: slow down" }]);
  });

  it("drops a reply to a person who blocked the bot and goes on with the next one", async () => {
    const w = await world();
    const { dot } = await linked(w);
    bots.blockChat(TOKEN, 10);
    bots.say(TOKEN, "block me", ANN);
    await waitFor(async () => (await db.events.list({ dotId: dot.id, types: ["message.assistant"] })).length === 1, "the answer in the log");
    await quiet();
    expect(bots.sent(TOKEN, 10)).toEqual([]);
    dot.guest.emit("message.assistant", { text: "marker" });
    await quiet(200);
    // The marker goes to every owner, and the only owner blocked the bot: dropped for good, nothing is stuck.
    expect(bots.sent(TOKEN, 10)).toEqual([]);
  });

  it("needs a new token when the bot's was revoked, and starts again with the one it is given", async () => {
    const w = await world();
    const { hub, dot } = await linked(w);
    bots.revoke(TOKEN);
    await waitFor(async () => (await hub.list(dot.id))[0]!.status === "needs_relink", "needs_relink");
    const [record] = await hub.list(dot.id);
    expect(record!.status_detail).toMatch(/refused the bot token/);

    const fresh = "123456:ANOTHER-TOKEN-VALUE";
    bots.addBot(fresh, "dot_helper_bot");
    const updated = await hub.setCredentials(dot.id, "telegram", { telegram_bot_token: fresh });
    expect(updated.peers.map((p) => p.peer_id)).toEqual(["10"]);
    expect(JSON.stringify(updated)).not.toContain("ANOTHER-TOKEN");
    expect(await db.secrets.get(dot.id, "telegram_bot_token")).toBe(fresh);
    await waitFor(async () => (await hub.list(dot.id))[0]!.status === "connected", "connected with the new token");
    bots.say(fresh, "back again", ANN);
    await waitFor(() => bots.sent(fresh, 10).length === 1, "an answer through the new token");
    expect(bots.sent(fresh, 10)[0]!.text).toBe("echo: back again");
  });

  it("keeps the people when the token is replaced by another bot's, and does not mistake its updates for old ones", async () => {
    const w = await world();
    const { hub, dot } = await linked(w);
    bots.say(TOKEN, "from the first bot", ANN);
    await waitFor(() => bots.sent(TOKEN, 10).length === 1, "the first answer");
    const other = "654321:OTHER-BOT-TOKEN-VALUE";
    bots.addBot(other, "second_bot");
    const record = await hub.setCredentials(dot.id, "telegram", { telegram_bot_token: other });
    expect(record.account).toBe("second_bot");
    await waitFor(() => bots.polling(other), "the second bot to be polled");
    // Update ids start at the same number for both bots: the message must still be taken.
    bots.say(other, "from the second bot", ANN);
    await waitFor(() => bots.sent(other, 10).length === 1, "an answer through the second bot");
    expect((await userMessages(dot.id)).map((e) => e.data.text)).toEqual(["from the first bot", "from the second bot"]);
  });

  it("goes on from where it had got when new credentials are refused after the channel was stopped, and sends nothing again", async () => {
    const w = await world();
    const { hub, dot } = await linked(w);
    bots.say(TOKEN, "hello", ANN);
    await waitFor(() => bots.sent(TOKEN, 10).length === 1, "the answer");
    const other = "654321:OTHER-BOT-TOKEN-VALUE";
    bots.addBot(other, "second_bot");
    const two = await w.dot();
    // The check finds the bot free, and takes its time: the Dot answers meanwhile, so the cursor written for it is newer
    // than the binding the call read. Another Dot's binding lands before this one's write, after the channel was stopped.
    const listBindings = db.channels.listBindings.bind(db.channels);
    const spy = vi.spyOn(db.channels, "listBindings").mockImplementationOnce(async (...args) => {
      const seen = await listBindings(...args);
      dot.guest.emit("message.assistant", { text: "during the check" });
      await waitFor(() => bots.sent(TOKEN, 10).length === 2, "the answer given during the check");
      await db.channels.createBinding({ id: "chb_rival", dotId: two.id, kind: "telegram", settings: DEFAULT_CHANNEL_SETTINGS, eventCursor: 0, account: "second_bot" });
      return seen;
    });
    try {
      await expect(hub.setCredentials(dot.id, "telegram", { telegram_bot_token: other })).rejects.toMatchObject({ status: 409, code: "account_in_use" });
    } finally {
      spy.mockRestore();
    }
    // It runs again on the token it had, and its Dot's answer is not sent a second time.
    await waitFor(() => bots.polling(TOKEN), "the first bot to be polled again");
    await waitFor(async () => (await hub.list(dot.id))[0]!.status === "connected", "connected again");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(bots.sent(TOKEN, 10).map((m) => m.text)).toEqual(["echo: hello", "during the check"]);
    expect(await db.secrets.get(dot.id, "telegram_bot_token")).toBe(TOKEN);
  });

  it("refuses as account_in_use a bot that another Dot takes between the check and the insert, and stores nothing", async () => {
    const w = await world();
    bots.addBot(TOKEN, "dot_helper_bot");
    const { hub } = await w.hub(telegram());
    const one = await w.dot();
    const two = await w.dot();
    // The check finds the account free; the other request's binding lands before this one's insert.
    const listBindings = db.channels.listBindings.bind(db.channels);
    const spy = vi.spyOn(db.channels, "listBindings").mockImplementationOnce(async (...args) => {
      const seen = await listBindings(...args);
      await db.channels.createBinding({ id: "chb_rival", dotId: two.id, kind: "telegram", settings: DEFAULT_CHANNEL_SETTINGS, eventCursor: 0, account: "dot_helper_bot" });
      return seen;
    });
    try {
      await expect(hub.add(one.id, "telegram", { credentials: { telegram_bot_token: TOKEN } })).rejects.toMatchObject({ status: 409, code: "account_in_use" });
    } finally {
      spy.mockRestore();
    }
    expect((await db.channels.listBindings()).map((b) => b.id)).toEqual(["chb_rival"]);
    expect(await db.secrets.get(one.id, "telegram_bot_token")).toBeNull();
  });

  it("refuses a token Telegram does not accept, a malformed one and a bot another Dot uses, and stores nothing", async () => {
    const w = await world();
    bots.addBot(TOKEN, "dot_helper_bot");
    const { hub } = await w.hub(telegram());
    const one = await w.dot();
    const two = await w.dot();
    await expect(hub.add(one.id, "telegram", { credentials: { telegram_bot_token: "999:UNKNOWN-TOKEN-VALUE" } })).rejects.toMatchObject({ status: 400, code: "invalid_credentials" });
    await expect(hub.add(one.id, "telegram", { credentials: { telegram_bot_token: "no token" } })).rejects.toMatchObject({ status: 400, code: "invalid_credentials" });
    await expect(hub.add(one.id, "telegram")).rejects.toMatchObject({ status: 400, code: "invalid_credentials" });
    expect(await hub.list(one.id)).toEqual([]);
    expect(await db.secrets.get(one.id, "telegram_bot_token")).toBeNull();

    await hub.add(one.id, "telegram", { credentials: { telegram_bot_token: TOKEN } });
    await expect(hub.add(two.id, "telegram", { credentials: { telegram_bot_token: TOKEN } })).rejects.toMatchObject({ status: 409, code: "account_in_use" });
    expect(await hub.list(two.id)).toEqual([]);
    expect(await db.secrets.get(two.id, "telegram_bot_token")).toBeNull();
    await expect(hub.setCredentials(two.id, "telegram", { telegram_bot_token: TOKEN })).rejects.toMatchObject({ status: 404 });

    // The same Dot may give its own bot again.
    expect((await hub.setCredentials(one.id, "telegram", { telegram_bot_token: TOKEN })).account).toBe("dot_helper_bot");

    bots.addBot("777:ANOTHER-TOKEN-VALUE", "third_bot");
    bots.failNext("777:ANOTHER-TOKEN-VALUE", "getMe", "drop");
    const unreachable = await hub.add(two.id, "telegram", { credentials: { telegram_bot_token: "777:ANOTHER-TOKEN-VALUE" } }).catch((e: unknown) => e);
    expect(unreachable).toMatchObject({ status: 502, code: "channel_unreachable" });
    expect(String((unreachable as Error).message)).not.toContain("ANOTHER-TOKEN-VALUE");
  });

  it("puts the token in no log line, no status, no event and no row but its own encrypted one", async () => {
    const w = await world();
    const { lines, logger } = logs();
    bots.addBot(TOKEN, "dot_helper_bot");
    const { hub } = await w.hub(telegram(), { logger });
    const dot = await w.dot();
    await hub.add(dot.id, "telegram", { credentials: { telegram_bot_token: TOKEN } });
    await waitFor(() => bots.polling(TOKEN), "polling");
    const { code } = await hub.pair(dot.id, "telegram");
    bots.say(TOKEN, `/start ${code}`, ANN);
    await waitFor(async () => (await hub.list(dot.id))[0]!.peers.length === 1, "the pairing");

    // Everything that can go wrong on the wire: a dropped connection, a server error, a rate limit, a block.
    bots.failNext(TOKEN, "getUpdates", "drop");
    bots.failNext(TOKEN, "sendMessage", "drop", 2);
    bots.failNext(TOKEN, "sendMessage", { error_code: 500, description: "Internal Server Error" });
    bots.failNext(TOKEN, "sendMessage", { error_code: 429, description: "x", retry_after: 1 });
    bots.say(TOKEN, "talk to me", ANN);
    await waitFor(() => bots.sent(TOKEN, 10).some((m) => m.text === "echo: talk to me"), "the answer after every failure", 20_000);
    bots.revoke(TOKEN);
    await waitFor(async () => (await hub.list(dot.id))[0]!.status === "needs_relink", "needs_relink");

    expect(lines.some((l) => l.includes("could not reach Telegram") || l.includes("could not send"))).toBe(true);
    const everything = [
      lines.join("\n"),
      JSON.stringify(await hub.list(dot.id)),
      JSON.stringify(await db.events.list({ dotId: dot.id })),
      JSON.stringify((await db.query("SELECT * FROM channel_bindings")).rows),
    ].join("\n");
    expect(everything).not.toContain("SECRET-TOKEN-VALUE");
    expect(everything).not.toContain(`bot${TOKEN}`);
    const stored = await db.query<{ value_enc: Uint8Array }>("SELECT value_enc FROM secrets WHERE scope = $1", [dot.id]);
    expect(Buffer.from(stored.rows[0]!.value_enc).includes(Buffer.from("SECRET-TOKEN"))).toBe(false);
  });

  it("asks for an approval with Approve and Reject buttons, takes the owner's press to the guest, and edits the prompt once", async () => {
    const w = await world();
    const { lines, logger } = logs();
    const { dot } = await linked(w, TOKEN, "dot_helper_bot", { logger });
    const id = dot.guest.requestApproval(undefined, "exec");
    await waitFor(() => bots.prompts(TOKEN, 10).length === 1, "the prompt");
    const [prompt] = bots.prompts(TOKEN, 10);
    expect(prompt!.text).toContain("The Dot wants to run a command.");
    expect(prompt!.buttons.map((b) => b.text)).toEqual(["Approve", "Reject"]);
    expect(prompt!.buttons.every((b) => Buffer.byteLength(b.data) <= 64 && b.data.endsWith(id))).toBe(true);

    // The prompt is edited later and loses its buttons: keep what they carried.
    const [approve, reject] = prompt!.buttons.map((b) => b.data) as [string, string];
    const message = prompt!.message_id;
    const { queryId } = bots.press(TOKEN, message, approve);
    await waitFor(() => bots.answers(TOKEN).length === 1, "the notice");
    expect(bots.answers(TOKEN)).toEqual([{ query_id: queryId, text: "Approved." }]);
    expect((await db.approvals.get(id))?.status).toBe("approved");
    await waitFor(() => dot.guest.inbound.some((e) => e.type === "approval.received"), "the decision at the guest");
    expect(dot.guest.inbound.filter((e) => e.type === "approval.received")).toHaveLength(1);
    await waitFor(() => bots.prompts(TOKEN, 10)[0]!.edits === 1, "the prompt edited");
    expect(bots.prompts(TOKEN, 10)[0]).toMatchObject({ buttons: [] });
    expect(bots.prompts(TOKEN, 10)[0]!.text.endsWith("\n\nApproved.")).toBe(true);

    // A second press, on a client that still shows the buttons, is the second click of the scheduler's 409.
    bots.press(TOKEN, message, reject);
    await waitFor(() => bots.answers(TOKEN).length === 2, "the second notice");
    expect(bots.answers(TOKEN)[1]!.text).toBe("It was answered already.");
    await quiet();
    expect(dot.guest.inbound.filter((e) => e.type === "approval.received")).toHaveLength(1);
    expect(bots.prompts(TOKEN, 10)[0]!.edits).toBe(1);
    expect(lines.join("\n") + JSON.stringify(bots.prompts(TOKEN))).not.toContain("SECRET-TOKEN-VALUE");
  });

  it("does not resolve for a press by someone else, a forged id or a button of another version", async () => {
    const w = await world();
    const { dot } = await linked(w);
    const id = dot.guest.requestApproval(undefined, "exec");
    await waitFor(() => bots.prompts(TOKEN, 10).length === 1, "the prompt");
    const message = bots.prompts(TOKEN, 10)[0]!.message_id;
    const other = await w.dot();
    const otherId = other.guest.requestApproval(undefined, "exec");
    await waitFor(async () => (await db.approvals.get(otherId)) !== null, "the other approval");

    bots.press(TOKEN, message, `ap1:y:${id}`, { id: 66, first_name: "Eve" });
    bots.press(TOKEN, message, `ap1:y:${otherId}`, ANN);
    bots.press(TOKEN, message, `ap9:y:${id}`, ANN);
    await waitFor(() => bots.answers(TOKEN).length === 3, "a notice for each");
    expect(bots.answers(TOKEN).map((a) => a.text)).toEqual(["You are not allowed to answer this.", "That request does not exist.", "This button is out of date."]);
    await quiet();
    expect((await db.approvals.get(id))?.status).toBe("pending");
    expect((await db.approvals.get(otherId))?.status).toBe("pending");
    expect(dot.guest.inbound.filter((e) => e.type === "approval.received")).toEqual([]);
    expect(other.guest.inbound.filter((e) => e.type === "approval.received")).toEqual([]);
  });

  it("stops polling and wipes the token and the people when the channel is unlinked or the Dot is deleted", async () => {
    const w = await world();
    const { hub, dot } = await linked(w);
    await hub.remove(dot.id, "telegram");
    await waitFor(() => !bots.polling(TOKEN), "polling to stop");
    expect(await db.secrets.get(dot.id, "telegram_bot_token")).toBeNull();
    expect(await hub.list(dot.id)).toEqual([]);

    // A second Dot, deleted with its channel running.
    bots.addBot("555:ANOTHER-BOT-TOKEN-VALUE", "bot_two");
    const two = await w.dot();
    await hub.add(two.id, "telegram", { credentials: { telegram_bot_token: "555:ANOTHER-BOT-TOKEN-VALUE" } });
    await waitFor(() => bots.polling("555:ANOTHER-BOT-TOKEN-VALUE"), "the second bot to be polled");
    await w.scheduler.deleteDot(two.id);
    await waitFor(() => !bots.polling("555:ANOTHER-BOT-TOKEN-VALUE"), "polling to stop");
    // The delete runs in the background: polling stops when it begins, the Dot's secrets and bindings go when it ends.
    await waitFor(async () => (await db.secrets.get(two.id, "telegram_bot_token")) === null, "the token wiped with the Dot");
    expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM channel_bindings")).rows[0]!.n).toBe(0);
  });
});
