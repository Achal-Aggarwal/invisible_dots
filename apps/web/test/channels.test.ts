import { CHANNEL_KINDS, CHANNEL_STATUSES, type ChannelKind, type ChannelPeerRecord, type ChannelRecord } from "@invisible-dots/shared/browser";
import { describe, expect, it } from "vitest";
import {
  accountHref,
  CHANNEL_LABELS,
  CHANNEL_NOTES,
  channelState,
  countdown,
  loadRelinks,
  needsRelinking,
  pairingHref,
  peerLine,
  peersInOrder,
  SETTING_ORDER,
  settingTexts,
  viaChannel,
} from "../src/lib/channels";
import { channelRecord } from "./support/control-plane";

describe("channel names", () => {
  it("has a name for every kind of channel the contract has", () => {
    expect(Object.keys(CHANNEL_LABELS).sort()).toEqual([...CHANNEL_KINDS].sort());
  });

  it("says where a message came from, and nothing for one that came through the web", () => {
    expect(viaChannel({ channel: "telegram", binding_id: "b", chat_id: "c", external_id: "e" })).toBe("via Telegram");
    expect(viaChannel({ channel: "whatsapp", binding_id: "b", chat_id: "c", external_id: "e" })).toBe("via WhatsApp");
    expect(viaChannel(undefined)).toBeUndefined();
  });
});

describe("the chip of a channel", () => {
  it("says how the connection stands, in a tone", () => {
    expect(channelState({ enabled: true, status: "connecting" })).toEqual({ label: "Connecting", tone: "info" });
    expect(channelState({ enabled: true, status: "connected" })).toEqual({ label: "Connected", tone: "ok" });
    expect(channelState({ enabled: true, status: "needs_relink" })).toEqual({ label: "Needs linking again", tone: "warn" });
    expect(channelState({ enabled: true, status: "error" })).toEqual({ label: "Error", tone: "error" });
  });

  it("says Paused for a channel the person switched off, whatever it last was", () => {
    for (const status of CHANNEL_STATUSES) expect(channelState({ enabled: false, status })).toEqual({ label: "Paused", tone: "neutral" });
  });

  it("has a word for every status the contract has", () => {
    for (const status of CHANNEL_STATUSES) expect(channelState({ enabled: true, status }).label).not.toBe("");
  });
});

describe("the account of a channel", () => {
  it("links a Telegram bot's page, and nothing for a number or for a name that is not a bot's", () => {
    expect(accountHref("telegram", "dot_helper_bot")).toBe("https://t.me/dot_helper_bot");
    expect(accountHref("telegram", "../evil")).toBeNull();
    expect(accountHref("telegram", null)).toBeNull();
    expect(accountHref("whatsapp", "15550001111")).toBeNull();
  });
});

describe("the link a pairing code comes with", () => {
  it("is used only when it is https", () => {
    expect(pairingHref("https://t.me/bot?start=ABC")).toBe("https://t.me/bot?start=ABC");
    expect(pairingHref("https://wa.me/15550001111?text=pair%20ABC")).toBe("https://wa.me/15550001111?text=pair%20ABC");
    expect(pairingHref("javascript:alert(1)")).toBeNull();
    expect(pairingHref("http://t.me/bot")).toBeNull();
    expect(pairingHref("not a link")).toBeNull();
    expect(pairingHref(null)).toBeNull();
  });
});

describe("the time a pairing code has left", () => {
  const ends = "2026-03-10T12:10:00.000Z";
  const at = (iso: string) => Date.parse(iso);

  it("counts minutes and seconds down", () => {
    expect(countdown(ends, at("2026-03-10T12:00:00.000Z"))).toEqual({ text: "10:00", expired: false });
    expect(countdown(ends, at("2026-03-10T12:00:18.400Z"))).toEqual({ text: "9:42", expired: false });
    expect(countdown(ends, at("2026-03-10T12:09:59.100Z"))).toEqual({ text: "0:01", expired: false });
  });

  it("is expired from the moment it ends, and for a time it cannot read", () => {
    expect(countdown(ends, at(ends))).toEqual({ text: "0:00", expired: true });
    expect(countdown(ends, at("2026-03-10T13:00:00.000Z"))).toEqual({ text: "0:00", expired: true });
    expect(countdown("soon", at(ends))).toEqual({ text: "0:00", expired: true });
  });
});

describe("what a channel's switches say", () => {
  it("names the three settings of the contract, each with words for the channel it is on", () => {
    for (const kind of CHANNEL_KINDS) {
      const texts = settingTexts(kind);
      expect([...SETTING_ORDER].sort()).toEqual(Object.keys(texts).sort());
      for (const name of SETTING_ORDER) {
        expect(texts[name].label).not.toBe("");
        expect(texts[name].description).not.toBe("");
      }
    }
  });

  it("describes approvals by buttons on Telegram and by a reply on WhatsApp, as the adapters work", () => {
    expect(settingTexts("telegram").approvals.description).toContain("Approve and Reject buttons");
    expect(settingTexts("whatsapp").approvals.description).toContain("replying yes or no");
  });

  it("says what each channel costs the person in privacy or risk", () => {
    expect(CHANNEL_NOTES.telegram).toContain("not end-to-end encrypted");
    expect(CHANNEL_NOTES.whatsapp).toContain("ban");
  });
});

describe("the people paired", () => {
  const peer = (peer_id: string, role: "owner" | "user", created_at: string, label = peer_id): ChannelPeerRecord => ({ peer_id, role, label, created_at });

  it("lists the owner first and the others in the order they paired", () => {
    const ordered = peersInOrder([peer("3", "user", "2026-01-03T00:00:00Z"), peer("1", "owner", "2026-01-02T00:00:00Z"), peer("2", "user", "2026-01-01T00:00:00Z")]);
    expect(ordered.map((p) => p.peer_id)).toEqual(["1", "2", "3"]);
  });

  it("writes a person with their id unless the id is all they are called", () => {
    expect(peerLine(peer("42", "owner", "2026-01-01T00:00:00Z", "Ann"))).toBe("Ann (42)");
    expect(peerLine(peer("42", "owner", "2026-01-01T00:00:00Z"))).toBe("42");
  });
});

describe("the channels that need the person", () => {
  const record = (kind: ChannelKind, change: Partial<ChannelRecord> = {}) => channelRecord(kind, change);

  it("is a login that was refused, and not one the person paused", () => {
    expect(needsRelinking({ enabled: true, status: "needs_relink" })).toBe(true);
    expect(needsRelinking({ enabled: false, status: "needs_relink" })).toBe(false);
    expect(needsRelinking({ enabled: true, status: "error" })).toBe(false);
    expect(needsRelinking({ enabled: true, status: "connecting" })).toBe(false);
  });

  it("reads every Dot's channels, keeps those to link again with the host's words, and counts the Dots it could not read", async () => {
    const answers: Record<string, ChannelRecord[] | Error> = {
      a: [record("telegram", { status: "needs_relink", status_detail: "Telegram refused the token" }), record("whatsapp")],
      b: [record("telegram"), record("whatsapp", { status: "needs_relink", status_detail: null })],
      c: new Error("down"),
      d: [record("telegram", { enabled: false, status: "needs_relink" })],
    };
    const client = {
      channels: async (id: string) => {
        const answer = answers[id]!;
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
    expect(await loadRelinks(client, [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }])).toEqual({
      relinks: [
        { dot_id: "a", kind: "telegram", detail: "Telegram refused the token" },
        { dot_id: "b", kind: "whatsapp", detail: null },
      ],
      unread: 1,
    });
    expect(await loadRelinks(client, [])).toEqual({ relinks: [], unread: 0 });
  });
});
