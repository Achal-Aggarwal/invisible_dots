/**
 * WhatsApp as a channel of the hub, over the port of `port.ts`. This is where WhatsApp's own decisions are
 * made; every policy that is the same on all channels (who may talk, rate limits, retries, where an answer
 * goes) is still the hub's.
 *
 * - Opt-in and unofficial. The default connection is Baileys, which acts as a linked device of a personal
 *   WhatsApp account; WhatsApp does not allow automation on those and can ban the account. Use a number of its
 *   own (a spare SIM or eSIM), never the one a person lives on.
 * - Reply-only. Nothing is sent to a chat that did not write first: the hub sends only to paired people, who
 *   pair by writing the code. Strangers are never answered, not even told they are refused, and a read receipt
 *   goes only to a chat the Dot is about to answer, so no stranger learns that the number is alive. Every send
 *   is preceded by a short human-sized pause with a typing indicator. No groups, no broadcast, no attachments.
 * - Identity. A person is the phone number when it is known (from the address, its twin, or what the account
 *   learned before) and the LID otherwise, so the same person is the same peer whichever address WhatsApp uses.
 *   The one edge: a person paired while only their LID was known, whose number is learned later, appears under
 *   the number and has to pair again.
 * - No buttons. A prompt tells the person to answer `yes ap-xxxxxx` or `no ap-xxxxxx`; the hub reads the reply.
 * - WhatsApp confirms a message to its sender when it arrives, not when the hub dealt with it, so a message the
 *   hub could not record is lost: the connection is dropped, the channel shows `error`, and the person writes again.
 */
import type { ChannelBindingRecord } from "@invisible-dots/database";
import { abortableSleep, errorMessage } from "@invisible-dots/shared";
import { approvalReplyHint } from "../approval-text.js";
import {
  ChannelNeedsRelinkError,
  type ApprovalPrompt,
  type Channel,
  type ChannelCapabilities,
  type ChannelSecrets,
  type ChannelSink,
  type ChannelType,
} from "../channel.js";
import { WHATSAPP_AUTH_SECRETS } from "./auth-state.js";
import { BaileysConnector, type BaileysOptions } from "./baileys.js";
import { isDirectJid, lidJid, lidOf, phoneJid, phoneOf } from "./jid.js";
import type { WhatsAppConnection, WhatsAppConnector, WhatsAppEnd, WhatsAppEvents, WhatsAppIncoming } from "./port.js";

/** The connection is made by Baileys, loaded from where the opt-in client is installed, or by whatever `connector` makes (the tests give it a fake). */
export type WhatsAppOptions = (
  | { connector: (dotId: string, secrets: ChannelSecrets) => WhatsAppConnector }
  | { baileys: BaileysOptions }
) & {
  /** How long to wait before a send, in milliseconds; default a random 0.4 to 1.5 seconds. */
  pauseMs?: () => number;
};

const PAIRING_MESSAGE = /^pair\s+([A-Za-z0-9]+)$/i;
/** More restarts than this in a row, with no connection in between, is a loop and not a link finishing. */
const MAX_RESTARTS = 3;
/** How many chats' last unread message are remembered, so a read receipt can follow an answer. Strangers fill this, so it is bounded. */
const UNREAD_MAX = 500;

const defaultPause = () => 400 + Math.random() * 1100;

interface Identity {
  peerId: string;
  chatId: string;
  label: string | undefined;
}

class WhatsAppChannel implements Channel {
  readonly capabilities: ChannelCapabilities = { maxText: 4000, typing: true, approvalByText: true };
  #connection: WhatsAppConnection | null = null;
  /** The newest message of each chat that wrote and was not marked read, by the chat's id as the hub knows it. */
  readonly #unread = new Map<string, { chat: string; id: string }>();

  constructor(
    private readonly connector: WhatsAppConnector,
    private readonly pauseMs: () => number,
  ) {}

  async run(sink: ChannelSink, signal: AbortSignal): Promise<void> {
    let restarts = 0;
    while (!signal.aborted) {
      const end = await this.#connectOnce(sink, signal, () => (restarts = 0));
      if (end === null) return;
      if (end.reason === "restart") {
        if (++restarts > MAX_RESTARTS) throw new Error("WhatsApp keeps asking for a new connection");
        continue;
      }
      throw failureOf(end);
    }
  }

  /** One connection, from opening it to its end; null when `signal` stopped it. */
  async #connectOnce(sink: ChannelSink, signal: AbortSignal, opened: () => void): Promise<WhatsAppEnd | null> {
    let finish!: (end: WhatsAppEnd | null) => void;
    let fail!: (error: Error) => void;
    const ended = new Promise<WhatsAppEnd | null>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    // A failure that arrives while the connection is still opening is read when `ended` is awaited below.
    ended.catch(() => {});
    // Messages are dealt with one at a time, in the order they arrived.
    let queue: Promise<unknown> = Promise.resolve();
    const events: WhatsAppEvents = {
      code: (code) => sink.linkCode(code),
      open: ({ phone }) => {
        opened();
        sink.status({ status: "connected", ...(phone !== null && { account: phone }) });
      },
      message: (message) => {
        queue = queue.then(() => this.#handle(message, sink)).catch((error: unknown) => fail(new Error(`could not hand a WhatsApp message to the hub: ${errorMessage(error)}`)));
      },
      end: (end) => finish(end),
    };
    const connection = await this.connector.connect(events);
    this.#connection = connection;
    const onAbort = () => finish(null);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) finish(null);
    try {
      return await ended;
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.#connection = null;
      await connection.close().catch(() => {});
      await queue.catch(() => {});
    }
  }

  // Sending

  async sendText(chatId: string, text: string): Promise<void> {
    await this.#send(chatId, text);
  }

  async typing(chatId: string): Promise<void> {
    await this.#need().typing(chatId);
  }

  async sendApproval(chatId: string, prompt: ApprovalPrompt): Promise<string> {
    return this.#send(chatId, `${prompt.text}\n\n${approvalReplyHint(prompt.approvalId)}`);
  }

  async editApproval(chatId: string, ref: string, text: string): Promise<void> {
    await this.#need().editText(chatId, ref, text);
  }

  #need(): WhatsAppConnection {
    if (!this.#connection) throw new Error("WhatsApp is not connected");
    return this.#connection;
  }

  /** Read what the chat wrote, show typing, wait a human-sized moment, send. */
  async #send(chatId: string, text: string): Promise<string> {
    const connection = this.#need();
    const unread = this.#unread.get(chatId);
    if (unread) {
      this.#unread.delete(chatId);
      await connection.markRead(unread).catch(() => {});
    }
    await connection.typing(chatId).catch(() => {});
    await abortableSleep(this.pauseMs());
    return connection.sendText(chatId, text);
  }

  // Receiving

  async #handle(message: WhatsAppIncoming, sink: ChannelSink): Promise<void> {
    if (message.fromMe || !isDirectJid(message.chat) || message.content.kind === "none") return;
    const who = await this.#identify(message);
    if (!who) return;
    this.#remember(who.chatId, { chat: message.chat, id: message.id });
    if (message.content.kind === "text") {
      const code = PAIRING_MESSAGE.exec(message.content.text.trim())?.[1];
      if (code !== undefined) {
        await sink.pairing({ code, peerId: who.peerId, chatId: who.chatId, label: who.label });
        return;
      }
    }
    await sink.inbound({
      externalId: `${who.peerId}:${message.id}`,
      peerId: who.peerId,
      chatId: who.chatId,
      text: message.content.kind === "text" ? message.content.text : "",
      direct: true,
      label: who.label,
      ...(message.content.kind === "attachment" && { attachment: true }),
    });
  }

  #remember(chatId: string, message: { chat: string; id: string }): void {
    this.#unread.delete(chatId);
    this.#unread.set(chatId, message);
    const oldest = this.#unread.keys().next().value;
    if (this.#unread.size > UNREAD_MAX && oldest !== undefined) this.#unread.delete(oldest);
  }

  /** Who wrote: the number when any address or what the account learned gives it, else the LID. Null when the address is neither. */
  async #identify(message: WhatsAppIncoming): Promise<Identity | null> {
    const addresses = [message.chat, message.chatAlt];
    let phone = addresses.map(phoneOf).find((value) => value !== null) ?? null;
    const lid = addresses.map(lidOf).find((value) => value !== null) ?? null;
    if (phone === null && lid !== null) phone = await this.#connection?.phoneForLid(lid).catch(() => null) ?? null;
    const name = message.senderName?.trim() || undefined;
    if (phone !== null) return { peerId: phone, chatId: phoneJid(phone), label: name ? `${name} (+${phone})` : `+${phone}` };
    if (lid !== null) return { peerId: `lid:${lid}`, chatId: lidJid(lid), label: name ?? "WhatsApp user" };
    return null;
  }
}

/** What a connection that ended means to the hub: an error that is retried, or one only the person can fix. */
function failureOf(end: Exclude<WhatsAppEnd, { reason: "restart" }>): Error {
  switch (end.reason) {
    case "logged_out":
      return new ChannelNeedsRelinkError("WhatsApp unlinked this device (it was removed under Linked devices on the phone). Link it again.");
    case "rejected":
      return new ChannelNeedsRelinkError("WhatsApp no longer accepts this linked device: the account may be restricted or banned. Link it again, or use another number.");
    case "code_expired":
      return new ChannelNeedsRelinkError("The link was not completed: the code expired, or the connection dropped, before it was scanned. Start linking again.");
    case "replaced":
      return new Error("another session took over this WhatsApp device (a second server using the same link?)");
    case "lost":
      return new Error(`the connection to WhatsApp was lost: ${end.detail}`);
  }
}

export class WhatsAppChannelType implements ChannelType {
  readonly kind = "whatsapp" as const;
  readonly secretNames = WHATSAPP_AUTH_SECRETS;
  /** What the account keeps is keys, not a token someone typed: no log line holds it. */
  readonly scrubNames = [] as const;
  readonly scanned = true as const;

  constructor(private readonly options: WhatsAppOptions) {}

  async create(binding: ChannelBindingRecord, secrets: ChannelSecrets): Promise<Channel> {
    const connector = "connector" in this.options ? this.options.connector(binding.dot_id, secrets) : new BaileysConnector(binding.dot_id, secrets, this.options.baileys);
    return new WhatsAppChannel(connector, this.options.pauseMs ?? defaultPause);
  }

  /** `https://wa.me/<number>?text=pair <code>`: it opens the chat with the account and the words of the code ready to send. */
  pairingLink(account: string | null, code: string): string | null {
    return account === null ? null : `https://wa.me/${account}?text=${encodeURIComponent(this.pairingMessage(code))}`;
  }

  pairingMessage(code: string): string {
    return `pair ${code}`;
  }
}
