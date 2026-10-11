/**
 * The channel hub: the one owner of every channel policy. It runs inside the control plane process next
 * to the Scheduler and uses only what the Scheduler offers (`ChannelHost`): the Dot never sees a channel
 * and nothing of the guest protocol changes. A message from a paired person becomes a user message of
 * the Dot with an origin; the answer is routed back by that origin (see `BindingRunner`).
 *
 * Who may talk: only a person paired with a one-time code, identified by the channel's stable id.
 * Everyone else is dropped before anything is written or any model is paid for.
 */
import type { ChannelBindingRecord, ChannelPeerRow, Database } from "@invisible-dots/database";
import { isUniqueViolation } from "@invisible-dots/database";
import type { EventLog } from "@invisible-dots/events";
import { type ApprovalRecord, CHANNEL_KINDS, type ChannelChange, type ChannelKind, type ChannelLinkFrame, type ChannelPairingAnswer, type ChannelRecord, type ChannelSettings, type Clock, ControlPlaneError, errorMessage, type Logger, type MessageAnswer, type MessageOrigin, newId, notFound, silentLogger, type StoredEvent, systemClock } from "@invisible-dots/shared";
import { DEFAULT_BACKOFF, type BackoffOptions } from "./backoff.js";
import { parseApprovalReply } from "./approval-text.js";
import { ChannelCredentialsError, type ApprovalAction, type ChannelSink, type ChannelStatusReport, type ChannelType, type InboundChat, type PairingAttempt } from "./channel.js";
import { LinkSessions } from "./link.js";
import { hashPairingCode, newPairingCode } from "./pairing.js";
import { RateLimiter } from "./rate.js";
import { BindingRunner } from "./runner.js";
import { WHATSAPP_ENABLE_HELP } from "./whatsapp-baileys/client.js";

/** What the hub asks of the control plane; the Scheduler satisfies it. */
export interface ChannelHost {
  sendMessage(idOrName: string, text: string, origin?: MessageOrigin): Promise<MessageAnswer>;
  resolveApproval(id: string, decision: "approve" | "reject"): Promise<ApprovalRecord>;
  requireDot(idOrName: string): Promise<{ id: string; name: string }>;
  events: Pick<EventLog, "stream" | "userMessage" | "tail" | "appendHostIn" | "publish">;
}

/** What the hub stores through. */
export type ChannelStore = Pick<Database, "channels" | "secrets" | "approvals" | "transaction">;

export interface ChannelLimits {
  /** Messages a person can send at once before being slowed down. Default 10. */
  burst: number;
  /** Messages a person can send per minute once the burst is used. Default 20. */
  perMinute: number;
  /** The longest message taken from a person, in characters. Default 8000. */
  maxChars: number;
}

export interface ChannelHubOptions {
  db: ChannelStore;
  host: ChannelHost;
  /** The kinds of channel this process can run. */
  types: readonly ChannelType[];
  clock?: Clock;
  logger?: Logger;
  backoff?: BackoffOptions;
  limits?: Partial<ChannelLimits>;
  /** How long a pairing code lasts. Default ten minutes. */
  pairingTtlMs?: number;
}

export const DEFAULT_CHANNEL_SETTINGS: ChannelSettings = { approvals: true, notify_tasks: true, show_arguments: true };

const DEFAULT_LIMITS: ChannelLimits = { burst: 10, perMinute: 20, maxChars: 8_000 };
const STATUS_DETAIL_MAX = 300;
const LABEL_MAX = 64;

const SETTING_KEYS = Object.keys(DEFAULT_CHANNEL_SETTINGS);

/** The unique index that holds the rule "one account serves one Dot" (migration 0004: Telegram only). */
const ACCOUNT_KEY = "channel_bindings_account_key";

function accountInUse(kind: ChannelKind, account: string | null): ControlPlaneError {
  return new ControlPlaneError(409, "account_in_use", `${kind} account "${account}" is already linked to another Dot: use one account per Dot`);
}

const NEEDS_RELINK_DETAIL = "The channel has to be linked again.";

/** What a status means to a person who is linking: a connection that failed is tried again by itself, one that needs the person is the end. */
function linkFrame(report: ChannelStatusReport, detail: string | null): ChannelLinkFrame {
  switch (report.status) {
    case "connected":
      return { state: "linked", account: report.account ?? null };
    case "needs_relink":
      return { state: "failed", detail: detail ?? NEEDS_RELINK_DETAIL };
    case "error":
      return { state: "waiting", ...(detail !== null && { detail }) };
    case "connecting":
      return { state: "waiting" };
  }
}

function bad(message: string): ControlPlaneError {
  return new ControlPlaneError(400, "invalid_request", message);
}

/** The settings in `patch` applied to `base`; anything that is not a known boolean setting is a 400. */
function applySettings(base: ChannelSettings, patch: unknown): ChannelSettings {
  if (patch === undefined) return { ...base };
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw bad("settings must be an object");
  const out: Record<string, boolean> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (!SETTING_KEYS.includes(key)) throw bad(`unknown channel setting "${key}"; the settings are ${SETTING_KEYS.join(", ")}`);
    if (typeof value !== "boolean") throw bad(`the channel setting "${key}" must be true or false`);
    out[key] = value;
  }
  return out as unknown as ChannelSettings;
}

export class ChannelHub {
  readonly #o: ChannelHubOptions;
  readonly #types = new Map<ChannelKind, ChannelType>();
  readonly #runners = new Map<string, BindingRunner>();
  readonly #clock: Clock;
  readonly #log: Logger;
  readonly #limits: ChannelLimits;
  readonly #rate: RateLimiter;
  readonly #links = new LinkSessions();
  /** Peers told they are slowed down, until their bucket has a token again: one notice, not one per message. */
  readonly #slowed = new Set<string>();
  #state: "new" | "started" | "closed" = "new";

  constructor(options: ChannelHubOptions) {
    this.#o = options;
    for (const type of options.types) {
      if (this.#types.has(type.kind)) throw new Error(`two channel types for "${type.kind}"`);
      this.#types.set(type.kind, type);
    }
    this.#clock = options.clock ?? systemClock;
    this.#log = options.logger ?? silentLogger;
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.#rate = new RateLimiter(this.#limits.burst, this.#limits.perMinute / 60, this.#clock);
  }

  /** The kinds of channel this process can run (WhatsApp only when the server was started with it). */
  get kinds(): ChannelKind[] {
    return [...this.#types.keys()];
  }

  /**
   * Start every enabled binding, except one that needs its person (a revoked token, a device removed on the phone):
   * connecting with what is known not to work only gets it refused again, which on WhatsApp counts against the
   * account. It starts when they give new credentials or link again. A binding that cannot start does not keep
   * the others from it.
   */
  async start(): Promise<void> {
    if (this.#state !== "new") return;
    this.#state = "started";
    for (const binding of await this.#o.db.channels.listBindings()) {
      if (binding.enabled && binding.status !== "needs_relink") this.#run(binding);
    }
  }

  /** Stop every adapter and write the cursors. Idempotent. */
  async close(): Promise<void> {
    if (this.#state === "closed") return;
    this.#state = "closed";
    await Promise.all([...this.#runners.values()].map((runner) => runner.stop()));
    this.#runners.clear();
  }

  // Managing bindings (the API's side)

  /** Every channel of the Dot, with the people paired to it. Never a credential. */
  async list(dotIdOrName: string): Promise<ChannelRecord[]> {
    const dot = await this.#o.host.requireDot(dotIdOrName);
    const bindings = await this.#o.db.channels.listBindings(dot.id);
    return Promise.all(bindings.map(async (b) => this.#record(b, await this.#o.db.channels.peers(b.id))));
  }

  /**
   * Link the Dot to a channel and start it. `credentials` are checked with the channel first, then stored
   * encrypted as secrets of the Dot, by the names the channel type declares, and never returned. The
   * channel starts after the Dot's latest event: what happened before is not replayed into the chat.
   */
  async add(
    dotIdOrName: string,
    kind: ChannelKind,
    options: { settings?: unknown; credentials?: Record<string, string> } = {},
  ): Promise<ChannelRecord> {
    this.#assertOpen();
    const type = this.#type(kind);
    if (type.scanned) throw bad(`a ${kind} channel is linked by scanning a code on the phone, not with credentials`);
    const dot = await this.#o.host.requireDot(dotIdOrName);
    const settings = applySettings(DEFAULT_CHANNEL_SETTINGS, options.settings);
    const credentials = this.#credentials(type, options.credentials);
    const account = await this.#check(type, credentials);
    await this.#assertAccountFree(kind, account, dot.id);
    const eventCursor = (await this.#o.host.events.tail(dot.id, 1))[0]?.id ?? 0;
    let binding: ChannelBindingRecord;
    try {
      binding = await this.#o.db.transaction(async (tx) => {
        const created = await tx.channels.createBinding({ id: newId("chb"), dotId: dot.id, kind, settings, eventCursor, ...(account !== null && { account }) });
        for (const [name, value] of Object.entries(credentials)) await tx.secrets.put(dot.id, name, value);
        return created;
      });
    } catch (error) {
      if (isUniqueViolation(error, ACCOUNT_KEY)) throw accountInUse(kind, account);
      if (isUniqueViolation(error)) throw new ControlPlaneError(409, "channel_exists", `Dot "${dot.name}" already has a ${kind} channel`);
      throw error;
    }
    if (this.#state === "started") this.#run(binding);
    return this.#record(binding, []);
  }

  /**
   * Start linking a channel of a `scanned` kind (WhatsApp): the adapter shows a code for the phone to scan
   * (`watchLink`) and keeps what the phone gives it as the binding's secrets. A binding that is linked is
   * refused (unlink it first); one that is waiting for a scan goes on; one that failed or needs the person
   * again starts over from nothing, so no key of an old device stays.
   */
  async link(dotIdOrName: string, kind: ChannelKind): Promise<ChannelRecord> {
    this.#assertOpen();
    const type = this.#type(kind);
    if (!type.scanned) throw bad(`a ${kind} channel is linked with credentials, not by scanning a code`);
    const dot = await this.#o.host.requireDot(dotIdOrName);
    const existing = await this.#o.db.channels.binding(dot.id, kind);
    let binding: ChannelBindingRecord;
    if (!existing) {
      const eventCursor = (await this.#o.host.events.tail(dot.id, 1))[0]?.id ?? 0;
      try {
        binding = await this.#o.db.channels.createBinding({ id: newId("chb"), dotId: dot.id, kind, settings: DEFAULT_CHANNEL_SETTINGS, eventCursor });
      } catch (error) {
        if (isUniqueViolation(error)) throw new ControlPlaneError(409, "channel_exists", `Dot "${dot.name}" already has a ${kind} channel`);
        throw error;
      }
    } else {
      if (existing.status === "connected") {
        throw new ControlPlaneError(409, "already_linked", `Dot "${dot.name}" is linked to ${kind} already: remove the channel first to link another account`);
      }
      if (existing.enabled && existing.status === "connecting" && this.#runners.has(existing.id)) {
        return this.#record(existing, await this.#o.db.channels.peers(existing.id));
      }
      await this.#stop(existing.id);
      binding = await this.#o.db.transaction(async (tx) => {
        for (const name of type.secretNames) await tx.secrets.delete(dot.id, name);
        await tx.channels.setEnabled(existing.id, true);
        await tx.channels.setStatus(existing.id, "connecting", null, null);
        return (await tx.channels.bindingById(existing.id)) ?? existing;
      });
    }
    this.#links.publish(binding.id, { state: "waiting" });
    if (this.#state === "started") this.#run(binding);
    return this.#record(binding, await this.#o.db.channels.peers(binding.id));
  }

  /**
   * What happens while the person links: the state now, then every change (a new code, linked, failed), ending
   * with the last. It checks that the channel exists before it returns, so a caller can refuse a request first.
   */
  async watchLink(dotIdOrName: string, kind: ChannelKind, signal: AbortSignal): Promise<AsyncGenerator<ChannelLinkFrame>> {
    if (!this.#type(kind).scanned) throw bad(`a ${kind} channel has no code to scan`);
    const binding = await this.#binding(dotIdOrName, kind);
    let initial: ChannelLinkFrame;
    if (binding.status === "connected") initial = { state: "linked", account: binding.account };
    else if (binding.status === "needs_relink") initial = { state: "failed", detail: binding.status_detail ?? NEEDS_RELINK_DETAIL };
    else initial = this.#links.latest(binding.id) ?? { state: "waiting", ...(binding.status_detail !== null && { detail: binding.status_detail }) };
    return this.#links.watch(binding.id, initial, signal);
  }

  /**
   * Give an existing channel new credentials (the token was revoked, or the person wants another bot) and
   * start it again with them. The people paired to it stay. A channel the person paused stays paused.
   */
  async setCredentials(dotIdOrName: string, kind: ChannelKind, credentials: Record<string, string>): Promise<ChannelRecord> {
    this.#assertOpen();
    const type = this.#type(kind);
    if (type.scanned) throw bad(`a ${kind} channel is linked again by scanning a code on the phone, not with credentials`);
    const binding = await this.#binding(dotIdOrName, kind);
    const checked = this.#credentials(type, credentials);
    const account = await this.#check(type, checked);
    await this.#assertAccountFree(kind, account, binding.dot_id);
    await this.#stop(binding.id);
    let updated: ChannelBindingRecord;
    try {
      updated = await this.#o.db.transaction(async (tx) => {
        for (const [name, value] of Object.entries(checked)) await tx.secrets.put(binding.dot_id, name, value);
        // The new credentials may belong to another account: its name is shown, and what the old one reported is stale.
        await tx.channels.setStatus(binding.id, "connecting", null, account ?? undefined);
        return (await tx.channels.bindingById(binding.id)) ?? binding;
      });
    } catch (error) {
      // Nothing changed: the channel goes on with the credentials it had, from the cursor the stop above wrote (the
      // binding read before it holds an older one, and what was delivered since would be sent again).
      const current = (await this.#o.db.channels.bindingById(binding.id)) ?? binding;
      if (current.enabled && this.#state === "started") this.#run(current);
      if (isUniqueViolation(error, ACCOUNT_KEY)) throw accountInUse(kind, account);
      throw error;
    }
    if (updated.enabled && this.#state === "started") this.#run(updated);
    return this.#record(updated, await this.#o.db.channels.peers(binding.id));
  }

  /** Unlink: stop the channel and delete its binding, the people paired to it and its credentials. */
  async remove(dotIdOrName: string, kind: ChannelKind): Promise<void> {
    const binding = await this.#binding(dotIdOrName, kind);
    await this.#stop(binding.id);
    const secretNames = this.#types.get(kind)?.secretNames ?? [];
    const logged = await this.#o.db.transaction(async (tx) => {
      // The event first (database events.ts); it commits with the removal it tells of, or neither does.
      const logged = await this.#changed(tx, binding, "removed");
      await tx.channels.deleteBinding(binding.id);
      for (const name of secretNames) await tx.secrets.delete(binding.dot_id, name);
      return logged;
    });
    this.#o.host.events.publish(logged);
    // Whoever still watches the link is told it is over.
    this.#links.publish(binding.id, { state: "failed", detail: "The channel was removed." });
    this.#links.forget(binding.id);
  }

  async setSettings(dotIdOrName: string, kind: ChannelKind, patch: unknown): Promise<ChannelRecord> {
    const binding = await this.#binding(dotIdOrName, kind);
    const updated = await this.#o.db.channels.setSettings(binding.id, applySettings(binding.settings, patch));
    // Switched on: what is waiting for an answer is asked now, not only what comes next.
    if (updated?.settings.approvals && !binding.settings.approvals) void this.#runners.get(binding.id)?.syncPrompts();
    return this.#record(updated ?? binding, await this.#o.db.channels.peers(binding.id));
  }

  /** Pause or resume a channel without losing its credentials or its people. */
  async setEnabled(dotIdOrName: string, kind: ChannelKind, enabled: boolean): Promise<ChannelRecord> {
    this.#assertOpen();
    const binding = await this.#binding(dotIdOrName, kind);
    const { updated, logged } = await this.#o.db.transaction(async (tx) => {
      // The event first (database events.ts); it commits with the change it tells of, or neither does.
      const logged = binding.enabled !== enabled ? await this.#changed(tx, binding, enabled ? "resumed" : "paused") : null;
      return { updated: (await tx.channels.setEnabled(binding.id, enabled)) ?? binding, logged };
    });
    if (logged) this.#o.host.events.publish(logged);
    if (enabled) {
      if (this.#state === "started") this.#run(updated);
    } else {
      await this.#stop(binding.id);
    }
    return this.#record(updated, await this.#o.db.channels.peers(binding.id));
  }

  /** Tell every view of the channel what the person did to it: the event is stored in the transaction that makes the change, and published once it committed. */
  #changed(tx: Parameters<Parameters<ChannelStore["transaction"]>[0]>[0], binding: ChannelBindingRecord, change: ChannelChange): Promise<StoredEvent> {
    return this.#o.host.events.appendHostIn(tx, binding.dot_id, "channel.changed", { kind: binding.kind, change });
  }

  /** A one-time code that pairs a person's chat to the Dot, valid for ten minutes and stored hashed. */
  async pair(dotIdOrName: string, kind: ChannelKind): Promise<ChannelPairingAnswer> {
    const binding = await this.#binding(dotIdOrName, kind);
    const now = this.#clock.now();
    const expiresAt = new Date(now.getTime() + (this.#o.pairingTtlMs ?? 10 * 60_000));
    const code = newPairingCode();
    await this.#o.db.channels.createPairing(binding.id, hashPairingCode(binding.id, code), expiresAt, now);
    const deepLink = this.#types.get(kind)?.pairingLink?.(binding.account, code) ?? null;
    return { code, deep_link: deepLink, message: this.#type(kind).pairingMessage(code), expires_at: expiresAt.toISOString() };
  }

  /** Revoke a paired person: they are strangers again, and nothing more is sent to their chat. */
  async removePeer(dotIdOrName: string, kind: ChannelKind, peerId: string): Promise<void> {
    const binding = await this.#binding(dotIdOrName, kind);
    if (!(await this.#o.db.channels.deletePeer(binding.id, peerId))) throw notFound("peer", peerId);
  }

  // Running bindings

  #assertOpen(): void {
    if (this.#state === "closed") throw new ControlPlaneError(503, "channels_stopped", "the channels are shutting down");
  }

  #type(kind: ChannelKind): ChannelType {
    const type = this.#types.get(kind);
    if (!type) {
      const off =
        kind === "whatsapp"
          ? `it is off: ${WHATSAPP_ENABLE_HELP} (read its risks in the architecture document first)`
          : "this server has no adapter for it";
      const known = CHANNEL_KINDS.includes(kind) ? off : `the channels are ${CHANNEL_KINDS.join(", ")}`;
      throw bad(`no "${String(kind)}" channel: ${known}`);
    }
    return type;
  }

  /** The credentials to store: only the names the type declares, each a non-empty string. */
  #credentials(type: ChannelType, given: Record<string, string> | undefined): Record<string, string> {
    for (const [name, value] of Object.entries(given ?? {})) {
      if (!type.secretNames.includes(name)) throw bad(`a ${type.kind} channel has no credential "${name}"`);
      if (typeof value !== "string" || value === "") throw bad(`the credential "${name}" must be a non-empty string`);
    }
    return { ...given };
  }

  /** What the channel says of the credentials, as the answer the API gives: refused ones are the person's to fix, an unreachable channel is a 502. */
  async #check(type: ChannelType, credentials: Record<string, string>): Promise<string | null> {
    if (!type.check) return null;
    try {
      return (await type.check(credentials)).account;
    } catch (error) {
      if (error instanceof ChannelCredentialsError) throw new ControlPlaneError(400, "invalid_credentials", error.message);
      let reason = errorMessage(error);
      for (const value of Object.values(credentials)) reason = reason.split(value).join("[redacted]");
      throw new ControlPlaneError(502, "channel_unreachable", `could not check the ${type.kind} credentials: ${reason.slice(0, STATUS_DETAIL_MAX)}`);
    }
  }

  /**
   * An account (a bot) serves one Dot: two pollers on one bot take turns failing. This is the early, readable
   * answer; the rule itself is the unique index `channel_bindings_account_key`, which a request that races
   * past this check meets (`accountInUse`). Only kinds linked with credentials have it: a WhatsApp number is
   * known after the scan and several Dots may be devices of one phone.
   */
  async #assertAccountFree(kind: ChannelKind, account: string | null, dotId: string): Promise<void> {
    if (account === null) return;
    const other = (await this.#o.db.channels.listBindings()).find((b) => b.kind === kind && b.account === account && b.dot_id !== dotId);
    if (other) throw accountInUse(kind, account);
  }

  async #binding(dotIdOrName: string, kind: ChannelKind): Promise<ChannelBindingRecord> {
    const dot = await this.#o.host.requireDot(dotIdOrName);
    const binding = await this.#o.db.channels.binding(dot.id, kind);
    if (!binding) throw notFound(`${kind} channel of`, dot.name);
    return binding;
  }

  #record(binding: ChannelBindingRecord, peers: ChannelPeerRow[]): ChannelRecord {
    return {
      kind: binding.kind,
      enabled: binding.enabled,
      status: binding.status,
      status_detail: binding.status_detail,
      account: binding.account,
      settings: binding.settings,
      peers: peers.map((p) => ({ peer_id: p.peer_id, role: p.role, label: p.label, created_at: p.created_at })),
      created_at: binding.created_at,
    };
  }

  #run(binding: ChannelBindingRecord): void {
    if (this.#runners.has(binding.id)) return;
    const type = this.#types.get(binding.kind);
    if (!type) {
      this.#log.warn("a binding has no channel type in this build, leaving it stopped", { binding: binding.id, kind: binding.kind });
      return;
    }
    const runner = new BindingRunner({
      binding,
      type,
      db: this.#o.db,
      events: this.#o.host.events,
      logger: this.#log,
      backoff: this.#o.backoff ?? DEFAULT_BACKOFF,
      sink: (r) => this.#sink(r),
      onStatus: (r, report) => this.#status(r, report),
      onDotDeleted: (r) => {
        // The rows went with the Dot; only the adapter is left to stop.
        this.#runners.delete(r.bindingId);
        void r.stop();
      },
    });
    this.#runners.set(binding.id, runner);
    runner.start();
  }

  async #stop(bindingId: string): Promise<void> {
    const runner = this.#runners.get(bindingId);
    this.#runners.delete(bindingId);
    await runner?.stop();
  }

  // What an adapter reports

  #sink(runner: BindingRunner): ChannelSink {
    return {
      inbound: (message) => this.#inbound(runner, message),
      pairing: (attempt) => this.#pairing(runner, attempt),
      status: (report) => runner.report(report),
      approval: (action) => this.#approval(runner, action),
      linkCode: (code) => this.#links.publish(runner.bindingId, { state: "code", code }),
    };
  }

  /** Record a status; a change is announced as a `channel.status` event, a repeat is not. */
  async #status(runner: BindingRunner, report: ChannelStatusReport): Promise<void> {
    const detail = report.detail === undefined ? null : (await runner.scrub(report.detail)).slice(0, STATUS_DETAIL_MAX);
    // The status and its event commit together or neither does; the event first (database events.ts), so a repeat is found out before.
    const logged = await this.#o.db.transaction(async (tx) => {
      if (!(await tx.channels.statusWouldChange(runner.bindingId, report.status, detail, report.account))) return null;
      const logged = await this.#o.host.events.appendHostIn(tx, runner.dotId, "channel.status", {
        kind: runner.kind,
        status: report.status,
        ...(detail !== null && { detail }),
      });
      await tx.channels.setStatus(runner.bindingId, report.status, detail, report.account);
      return logged;
    });
    if (!logged) return;
    this.#o.host.events.publish(logged);
    if (this.#types.get(runner.kind)?.scanned) this.#links.publish(runner.bindingId, linkFrame(report, detail));
  }

  /**
   * A message from a chat. Nothing is written for anyone who is not paired, for a chat that is not a
   * private one, or for a message over the rate or length limit. A message already handed to the Dot
   * (the channel redelivers after a restart) is recognised by its channel id and dropped.
   */
  async #inbound(runner: BindingRunner, message: InboundChat): Promise<void> {
    if (runner.stopped) throw new Error("the channel is stopped");
    if (!message.direct) return;
    const peer = await this.#o.db.channels.peer(runner.bindingId, message.peerId);
    if (!peer) return;
    if (message.text.trim() === "" && !message.attachment) return;
    const key = `${runner.bindingId}:${peer.peer_id}`;
    if (!this.#rate.take(key)) {
      if (!this.#slowed.has(key)) {
        this.#slowed.add(key);
        await this.#tell(runner, message.chatId, "You are sending messages too fast. Wait a moment, then write again.");
      }
      return;
    }
    this.#slowed.delete(key);
    if (message.attachment) {
      await this.#tell(runner, message.chatId, "Attachments are not supported yet: send the message as text.");
      return;
    }
    if (message.text.length > this.#limits.maxChars) {
      await this.#tell(runner, message.chatId, `That message is too long: the limit is ${this.#limits.maxChars} characters.`);
      return;
    }
    // On a channel without buttons the answer to a prompt is a message in the words the prompt taught: from a paired person it is the answer, not something for the Dot.
    const reply = runner.channel?.capabilities.approvalByText ? parseApprovalReply(message.text) : null;
    if (reply) {
      await this.#tell(runner, message.chatId, await this.#answerApproval(runner, peer, message.chatId, { shortId: reply.shortId }, reply.decision));
      return;
    }
    await runner.serial(async () => {
      try {
        // The Dot gets a channel message once however often the channel offers it: the control plane stores it by its id in the same transaction as the message.
        await this.#o.host.sendMessage(runner.dotId, message.text, {
          channel: runner.kind,
          binding_id: runner.bindingId,
          chat_id: message.chatId,
          external_id: message.externalId,
        });
        runner.activeChat = message.chatId;
      } catch (error) {
        // The Dot is gone or the message is refused for good: offering it again cannot change that.
        if (error instanceof ControlPlaneError && error.status >= 400 && error.status < 500) {
          this.#log.warn("dropped a channel message the control plane refused", { binding: runner.bindingId, code: error.code });
          return;
        }
        throw error;
      }
    });
  }

  /** The code pairs the sender as an owner of the Dot's channel, once. The code is used and the person added together. */
  async #pairing(runner: BindingRunner, attempt: PairingAttempt): Promise<boolean> {
    if (runner.stopped) throw new Error("the channel is stopped");
    const label = attempt.label?.trim().slice(0, LABEL_MAX) || attempt.peerId;
    const hash = hashPairingCode(runner.bindingId, attempt.code);
    const paired = await this.#o.db.transaction(async (tx) => {
      if (!(await tx.channels.consumePairing(runner.bindingId, hash, this.#clock.now()))) return null;
      await tx.channels.upsertPeer({ bindingId: runner.bindingId, peerId: attempt.peerId, chatId: attempt.chatId, role: "owner", label });
      // The pairing and its event commit together or neither does. Whether the code was good is known only from the
      // update that uses it, so here the event follows the rows (every other event of a transaction comes first,
      // database events.ts): no writer of events takes a pairing's or a peer's rows, so this order cannot deadlock.
      return this.#o.host.events.appendHostIn(tx, runner.dotId, "channel.peer.paired", { kind: runner.kind, peer_id: attempt.peerId, label });
    });
    if (!paired) return false;
    this.#o.host.events.publish(paired);
    const dot = await this.#o.host.requireDot(runner.dotId).catch(() => null);
    await this.#tell(runner, attempt.chatId, `Paired. What you write here now goes to ${dot?.name ?? "your Dot"}, and its answers come back here.`);
    // Whatever waits for an answer is asked of the new owner too.
    void runner.syncPrompts();
    return true;
  }

  /**
   * A person pressed Approve or Reject. Only a paired owner, in their private chat, while approvals are asked in
   * chats, and only for an approval of this binding's own Dot: the id comes from the button, which anyone could
   * have forged, so it proves nothing. The answer is the person's notice; the prompt itself is edited when the
   * `approval.resolved` event comes, whoever answered.
   */
  async #approval(runner: BindingRunner, action: ApprovalAction): Promise<string> {
    if (runner.stopped) throw new Error("the channel is stopped");
    const peer = action.direct ? await this.#o.db.channels.peer(runner.bindingId, action.peerId) : null;
    return this.#answerApproval(runner, peer, action.chatId, { approvalId: action.approvalId }, action.decision);
  }

  /** The one place an approval is answered from a chat, by button or by words; what it returns is the notice for the person. */
  async #answerApproval(
    runner: BindingRunner,
    peer: ChannelPeerRow | null,
    chatId: string,
    target: { approvalId: string } | { shortId: string },
    decision: "approve" | "reject",
  ): Promise<string> {
    if (!peer || peer.role !== "owner" || peer.chat_id !== chatId) return "You are not allowed to answer this.";
    const binding = await this.#o.db.channels.bindingById(runner.bindingId);
    if (!binding?.settings.approvals) return "Approvals are not answered in this chat. Open the app to answer.";
    let approval: ApprovalRecord | null;
    if ("approvalId" in target) {
      approval = await this.#o.db.approvals.get(target.approvalId);
    } else {
      const named = await this.#o.db.approvals.endingWith(runner.dotId, target.shortId);
      const pending = named.filter((a) => a.status === "pending");
      if (pending.length > 1) return "Two requests have that code. Answer them in the app.";
      // Nothing pending under that code but something settled: the person is late, and is told so.
      approval = pending[0] ?? named.at(-1) ?? null;
    }
    if (!approval || approval.dot_id !== runner.dotId) return "That request does not exist.";
    try {
      await this.#o.host.resolveApproval(approval.id, decision);
    } catch (error) {
      if (error instanceof ControlPlaneError && error.code === "already_resolved") return "It was answered already.";
      throw error;
    }
    return decision === "approve" ? "Approved." : "Rejected.";
  }

  /** A message of the hub's own to a chat; best effort, because nothing depends on it arriving. */
  async #tell(runner: BindingRunner, chatId: string, text: string): Promise<void> {
    try {
      await runner.channel?.sendText(chatId, text);
    } catch (error) {
      this.#log.warn("could not send a notice", { binding: runner.bindingId, error: await runner.scrub(errorMessage(error)) });
    }
  }
}
