/**
 * What the web client says about a Dot's messaging channels: their names, how a connection reads, what the person
 * is told to send to pair, and which channels need the person (a login that has to be done again). The host owns
 * the facts (`ChannelRecord`, the codes, the link stream); this file only puts them in words.
 */
import type { InvisibleDotsClient } from "@invisible-dots/sdk";
import { APPROVAL_PROMPT_TEXT_MAX, type ChannelKind, type ChannelPeerRecord, type ChannelRecord, type ChannelSettings, type ChannelStatus, type MessageOrigin } from "@invisible-dots/shared/browser";
import type { Tone } from "./tone";

/** How a channel is named to the person. A `Record` over the contract's kinds, so a kind added there is a compile error here until it has a name. */
export const CHANNEL_LABELS: Record<ChannelKind, string> = {
  telegram: "Telegram",
  whatsapp: "WhatsApp",
};

/** What to show beside a message that came through a channel; nothing for one sent from the web, the CLI or the SDK. */
export function viaChannel(origin: MessageOrigin | undefined): string | undefined {
  return origin ? `via ${CHANNEL_LABELS[origin.channel]}` : undefined;
}

export interface ChannelState {
  label: string;
  tone: Tone;
}

const STATUS_VIEW: Record<ChannelStatus, ChannelState> = {
  connecting: { label: "Connecting", tone: "info" },
  connected: { label: "Connected", tone: "ok" },
  needs_relink: { label: "Needs linking again", tone: "warn" },
  error: { label: "Error", tone: "error" },
};

/** The chip of a channel: its connection, or "Paused" while the person has switched it off (what it was connected to is not news then). */
export function channelState(record: Pick<ChannelRecord, "enabled" | "status">): ChannelState {
  return record.enabled ? STATUS_VIEW[record.status] : { label: "Paused", tone: "neutral" };
}

/** Where a channel's account can be opened in a browser: a Telegram bot's page; WhatsApp has no page for a number. */
export function accountHref(kind: ChannelKind, account: string | null): string | null {
  return kind === "telegram" && account !== null && /^[A-Za-z0-9_]+$/.test(account) ? `https://t.me/${account}` : null;
}

/**
 * A link the host made for pairing, if it is safe to put in an `href`: only https. The host builds these from the
 * account's name and a code, but a page that links whatever string it was given would run a `javascript:` one.
 */
export function pairingHref(deepLink: string | null): string | null {
  if (deepLink === null) return null;
  try {
    return new URL(deepLink).protocol === "https:" ? deepLink : null;
  } catch {
    return null;
  }
}

export interface Countdown {
  /** "9:42", or "0:00" once it has run out. */
  text: string;
  expired: boolean;
}

/** How long a pairing code still works: minutes and seconds, from `now` (milliseconds) to when the host says it ends. */
export function countdown(expiresAt: string, now: number): Countdown {
  const end = Date.parse(expiresAt);
  const left = Number.isFinite(end) ? Math.max(0, Math.ceil((end - now) / 1000)) : 0;
  const seconds = left % 60;
  return { text: `${Math.floor(left / 60)}:${String(seconds).padStart(2, "0")}`, expired: left === 0 };
}

export type SettingName = keyof ChannelSettings;

export interface SettingText {
  label: string;
  /** What it changes, in the words of the channel (Telegram has buttons; WhatsApp is answered by text). */
  description: string;
}

const ANSWERED_BY: Record<ChannelKind, string> = {
  telegram: "with Approve and Reject buttons",
  whatsapp: "and is answered by replying yes or no to the message",
};

/** The three switches of a channel, in the order they are shown, with what each does there. */
export function settingTexts(kind: ChannelKind): Record<SettingName, SettingText> {
  return {
    approvals: {
      label: "Ask for approvals here",
      description: `When the Dot needs your permission, it asks in the chat ${ANSWERED_BY[kind]}. Only the owner can answer. The answer counts like one given on the web.`,
    },
    notify_tasks: {
      label: "Tell me when a task ends",
      description: "The chat hears when a task completes or fails, and when the Dot speaks without being asked (an automation's answer). Replies to your own messages always arrive.",
    },
    show_arguments: {
      label: "Show what the Dot wants to run",
      description: `An approval in the chat shows the tool's arguments, cut to ${APPROVAL_PROMPT_TEXT_MAX} characters. Off, it shows the tool and the Dot's reason only.`,
    },
  };
}

export const SETTING_ORDER: readonly SettingName[] = ["approvals", "notify_tasks", "show_arguments"];

/** What the person is told about the privacy of a channel, where it needs saying. */
export const CHANNEL_NOTES: Record<ChannelKind, string> = {
  telegram: "Telegram bot chats are not end-to-end encrypted: Telegram can read what is said in them.",
  whatsapp: "This uses an unofficial WhatsApp client, which WhatsApp does not allow and can answer by banning the linked number. Link a number of its own (a spare SIM or eSIM), never the one you live on.",
};

/** A paired person as a line: what they are called and which id the channel knows them by. */
export function peerLine(peer: ChannelPeerRecord): string {
  return peer.label === peer.peer_id ? peer.peer_id : `${peer.label} (${peer.peer_id})`;
}

/** The owner first (the person who paired first and can answer approvals), then the others in the order they paired. */
export function peersInOrder(peers: readonly ChannelPeerRecord[]): ChannelPeerRecord[] {
  return [...peers].sort((a, b) => Number(b.role === "owner") - Number(a.role === "owner") || Date.parse(a.created_at) - Date.parse(b.created_at) || a.peer_id.localeCompare(b.peer_id));
}

/** A channel the person has to link again, with what the host says went wrong. */
export interface ChannelRelink {
  dot_id: string;
  kind: ChannelKind;
  detail: string | null;
}

/** Whether a channel waits for the person: its login was refused and only they can do it again. A channel they paused is theirs to resume, not a thing to nag about. */
export function needsRelinking(record: Pick<ChannelRecord, "enabled" | "status">): boolean {
  return record.enabled && record.status === "needs_relink";
}

/** The channels of every Dot that need the person, in the order the host lists them: one read of every Dot's (`GET /api/channels`). */
export async function loadRelinks(client: Pick<InvisibleDotsClient, "everyChannel">): Promise<ChannelRelink[]> {
  return (await client.everyChannel()).filter(needsRelinking).map((record): ChannelRelink => ({ dot_id: record.dot_id, kind: record.kind, detail: record.status_detail }));
}
