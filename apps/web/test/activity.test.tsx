// @vitest-environment jsdom
import type { StoredEvent } from "@invisible-dots/shared/browser";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityView } from "../src/components/activity/ActivityView";
import { DotShell } from "../src/components/DotShell";
import { DotEventScope, EventStreamProvider } from "../src/components/events";
import { AttentionProvider } from "../src/components/shell/attention";
import { ACTIVITY_PAGE } from "../src/lib/activity";
import { stubMatchMedia } from "./support/browser";
import { dotRecord, FakeControlPlane } from "./support/control-plane";

vi.mock("next/navigation", () => ({ usePathname: () => "/dots/d1/activity", useRouter: () => ({ push() {}, replace() {} }) }));

let plane: FakeControlPlane;

beforeEach(() => {
  plane = new FakeControlPlane();
  plane.dots = [dotRecord("d1", { name: "fares" })];
  plane.install();
  stubMatchMedia();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The Activity page as the Dot's layout puts it: inside the Dot's shell. */
async function renderActivity() {
  render(
    <EventStreamProvider>
      <AttentionProvider>
        <DotEventScope dotId="d1">
          <DotShell dotId="d1">
            <ActivityView />
          </DotShell>
        </DotEventScope>
      </AttentionProvider>
    </EventStreamProvider>,
  );
  await screen.findByRole("heading", { level: 1, hidden: true });
  await waitFor(() => expect(plane.streamOpen).toBe(true));
}

const rows = () => screen.queryAllByTestId("activity-row");
const titles = () => rows().map((row) => within(row).getAllByText(/./)[0]!.textContent);
const call = { permission: "computer.exec", decision: "allow", ok: true, duration_ms: 12 };
const eventQueries = () => plane.eventQueries.filter((q) => q.order === "desc");

describe("the Activity page", () => {
  it("says so when the log is empty, and when a family has nothing yet", async () => {
    await renderActivity();
    expect(await screen.findByText("No events yet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Export 0 events$/ }).hasAttribute("disabled")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Tasks" }));
    expect(await screen.findByText("No tasks events yet.")).toBeTruthy();
  });

  it("reads the newest page first and shows the newest line on top, with what each event says", async () => {
    plane.store("d1", "agent.started", {});
    plane.store("d1", "user.message", { message_id: "m1", text: "find fares", origin: { channel: "telegram", binding_id: "b", chat_id: "1", external_id: "2" } });
    plane.store("d1", "tool.called", { tool: "exec", target: "ls -la", ...call, task_id: "task_1" });
    plane.store("d1", "message.assistant", { text: "Done." });
    await renderActivity();
    await waitFor(() => expect(rows()).toHaveLength(4));
    expect(eventQueries()).toEqual([{ after: 0, limit: ACTIVITY_PAGE, types: null, tools: null, taskId: null, order: "desc" }]);
    expect(titles()).toEqual(["Assistant replied", "Ran a command", "You sent a message", "The engine started"]);

    const [reply, tool, message, started] = rows();
    expect(within(tool!).getByText("ls -la | done in 12 ms | exec [computer.exec] allow")).toBeTruthy();
    expect(within(tool!).getByText("tool.called")).toBeTruthy();
    expect(within(message!).getByText("via Telegram")).toBeTruthy();
    expect(within(message!).getByText("find fares")).toBeTruthy();
    expect(within(started!).getByText("The key was sent again")).toBeTruthy();
    // The data is the event as stored, not the line.
    const data = within(tool!).getByLabelText(/^Data of event \d+$/);
    expect(JSON.parse(data.textContent ?? "")).toMatchObject({ tool: "exec", target: "ls -la", task_id: "task_1" });
    expect(reply!.getAttribute("data-tone")).toBe("info");
  });

  it("pages older with `before`, keeps the order and the count, and says where the log starts", async () => {
    for (let i = 0; i < 2 * ACTIVITY_PAGE + 50; i++) plane.store("d1", "message.assistant", { text: `note-${i}.md` });
    await renderActivity();
    await waitFor(() => expect(rows()).toHaveLength(ACTIVITY_PAGE));
    expect(screen.getByRole("status", { name: "" }).textContent).toBe(`${ACTIVITY_PAGE} events read so far.`);
    // Newest first: the newest note is on top, and the page ends with the 200th newest.
    expect(within(rows()[0]!).getByText(`note-${2 * ACTIVITY_PAGE + 49}.md`)).toBeTruthy();
    expect(within(rows().at(-1)!).getByText(`note-${ACTIVITY_PAGE + 50}.md`)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Load older events" }));
    await waitFor(() => expect(rows()).toHaveLength(2 * ACTIVITY_PAGE));
    const oldest = plane.events.at(-ACTIVITY_PAGE)!.id;
    expect(eventQueries().at(-1)).toMatchObject({ before: oldest, limit: ACTIVITY_PAGE, order: "desc" });

    await userEvent.click(screen.getByRole("button", { name: "Load older events" }));
    await waitFor(() => expect(rows()).toHaveLength(2 * ACTIVITY_PAGE + 50));
    // A short page was the last: nothing more is offered, and no event was read twice or skipped.
    expect(screen.queryByRole("button", { name: "Load older events" })).toBeNull();
    expect(screen.getByText("That is the start of the log.")).toBeTruthy();
    const keys = rows().map((row) => /note-(\d+)\.md/.exec(row.textContent ?? "")![1]);
    expect(keys).toEqual(Array.from({ length: 2 * ACTIVITY_PAGE + 50 }, (_, i) => String(2 * ACTIVITY_PAGE + 49 - i)));
  });

  it("puts the oldest first, with the way to older events above the list", async () => {
    for (let i = 0; i < ACTIVITY_PAGE + 5; i++) plane.store("d1", "message.assistant", { text: `note-${i}.md` });
    await renderActivity();
    await waitFor(() => expect(rows()).toHaveLength(ACTIVITY_PAGE));
    const list = screen.getByRole("list", { name: "Events" });
    // Newest first: the way to older events is after the list. Oldest first: before it.
    expect(list.compareDocumentPosition(screen.getByRole("button", { name: "Load older events" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(screen.getByRole("switch", { name: "Newest first" }));
    expect(list.compareDocumentPosition(screen.getByRole("button", { name: "Load older events" })) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(within(rows()[0]!).getByText("note-5.md")).toBeTruthy();
    expect(within(rows().at(-1)!).getByText(`note-${ACTIVITY_PAGE + 4}.md`)).toBeTruthy();
  });

  it("asks the control plane for the families chosen only, and shows live events of those and no others", async () => {
    plane.store("d1", "tool.called", { tool: "exec", target: "ls", ...call });
    plane.store("d1", "message.assistant", { text: "a.md" });
    plane.store("d1", "agent.state", { state: "IDLE" });
    plane.store("d1", "browser.identity.launched", { identity_id: "shop", name: "shop" });
    await renderActivity();
    await waitFor(() => expect(rows()).toHaveLength(4));

    await userEvent.click(screen.getByRole("button", { name: "Tools" }));
    await userEvent.click(screen.getByRole("button", { name: "Chat" }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.getByRole("button", { name: "Tools" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("false");
    expect(eventQueries().at(-1)!.types).toEqual(["tool.called", "user.message", "message.assistant"]);

    await act(async () => plane.push("d1", "agent.state", { state: "THINKING" }));
    await act(async () => plane.push("d1", "message.assistant", { text: "b.md" }));
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(within(rows()[0]!).getByText("b.md")).toBeTruthy();
    expect(screen.queryByText("THINKING")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Tools" }));
    await userEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(rows().length).toBeGreaterThan(4));
    expect(eventQueries().at(-1)!.types).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Browser" }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(within(rows()[0]!).getByText("shop (shop)")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => expect(rows().length).toBeGreaterThan(4));
  });

  it("drops the answer to a choice that was changed while it was on its way", async () => {
    plane.store("d1", "tool.called", { tool: "exec", target: "ls", ...call });
    plane.store("d1", "message.assistant", { text: "slow.md" });
    // The first request, for every type, is held until the person has chosen Tools.
    const real = plane.fetch;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const answer = real(input, init);
        if (/\/events\?/.test(String(input)) && first) {
          first = false;
          await held;
        }
        return answer;
      }),
    );
    await renderActivity();
    await userEvent.click(screen.getByRole("button", { name: "Tools" }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    release();
    await act(async () => {
      await Promise.resolve();
    });
    // The late answer held the reply too: it must not have come in under the choice of Tools.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rows()).toHaveLength(1);
    expect(screen.queryByText("slow.md")).toBeNull();
  });

  it("searches what has been read, by the words of the lines, and counts the matches", async () => {
    plane.store("d1", "message.assistant", { text: "The cheapest day is Tuesday." });
    plane.store("d1", "tool.called", { tool: "exec", target: "grep -r fares", ...call });
    plane.store("d1", "task.completed", { task_id: "task_9", summary: "Fares compared." });
    await renderActivity();
    await waitFor(() => expect(rows()).toHaveLength(3));

    await userEvent.type(screen.getByRole("searchbox", { name: "Search the events read so far" }), "FARES");
    expect(rows()).toHaveLength(2);
    expect(screen.getByRole("status", { name: "" }).textContent).toBe("2 of the 3 events read so far match.");
    expect(screen.getByRole("button", { name: "Export 2 events" })).toBeTruthy();
    await userEvent.type(screen.getByRole("searchbox"), " compared");
    expect(rows()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Export 1 event" })).toBeTruthy();
    await userEvent.type(screen.getByRole("searchbox"), " nothing-says-this");
    expect(rows()).toHaveLength(0);
    expect(screen.getByText(/No event read so far says that/)).toBeTruthy();
    // Search is over the events read, never a request of its own.
    expect(eventQueries()).toHaveLength(1);
  });

  it("offers older events when the search finds nothing in the page read", async () => {
    for (let i = 0; i < ACTIVITY_PAGE + 1; i++) plane.store("d1", "message.assistant", { text: i === 0 ? "needle.md" : `hay-${i}.md` });
    await renderActivity();
    await waitFor(() => expect(rows()).toHaveLength(ACTIVITY_PAGE));
    await userEvent.type(screen.getByRole("searchbox"), "needle");
    expect(rows()).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Load older events" }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(within(rows()[0]!).getByText("needle.md")).toBeTruthy();
  });

  it("shows an event that arrives while it is open at the top, once, even when the stream repeats it", async () => {
    plane.store("d1", "message.assistant", { text: "old.md" });
    await renderActivity();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await act(async () => plane.push("d1", "task.failed", { task_id: "task_2", error: "max steps exceeded" }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(titles()).toEqual(["Task failed", "Assistant replied"]);
    expect(rows()[0]!.getAttribute("data-tone")).toBe("error");
  });

  it("says when the log cannot be read, and reads it again on request", async () => {
    plane.failEvents = 500;
    await renderActivity();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not load events");
    expect(alert.textContent).toContain("the event log is not available");
    plane.failEvents = null;
    plane.store("d1", "message.assistant", { text: "back.md" });
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  describe("export", () => {
    async function exportedText(): Promise<{ name: string; text: string }> {
      const blobs: Blob[] = [];
      URL.createObjectURL = (blob: Blob | MediaSource) => {
        blobs.push(blob as Blob);
        return "blob:test/export";
      };
      URL.revokeObjectURL = () => {};
      const names: string[] = [];
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
        names.push(this.download);
      });
      await userEvent.click(screen.getByRole("button", { name: /^Export \d+ events?$/ }));
      expect(blobs).toHaveLength(1);
      expect(blobs[0]!.type).toBe("application/x-ndjson");
      return { name: names[0]!, text: await blobs[0]!.text() };
    }

    it("saves the events shown as JSON Lines, oldest first, as stored", async () => {
      const stored: StoredEvent[] = [
        plane.store("d1", "message.assistant", { text: "a.md" }),
        plane.store("d1", "tool.called", { tool: "exec", target: "ls", ...call }),
        plane.store("d1", "message.assistant", { text: "b.md" }),
      ];
      await renderActivity();
      await waitFor(() => expect(rows()).toHaveLength(3));
      const all = await exportedText();
      expect(all.name).toBe(`d1-events-${stored[0]!.id}-${stored[2]!.id}.jsonl`);
      expect(all.text.trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual(stored);
      expect(all.text.endsWith("\n")).toBe(true);
    });

    it("saves only what the search leaves", async () => {
      const stored = [plane.store("d1", "message.assistant", { text: "a.md" }), plane.store("d1", "message.assistant", { text: "b.md" })];
      await renderActivity();
      await waitFor(() => expect(rows()).toHaveLength(2));
      await userEvent.type(screen.getByRole("searchbox"), "b.md");
      const part = await exportedText();
      expect(part.text.trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual([stored[1]]);
      expect(part.name).toBe(`d1-events-${stored[1]!.id}-${stored[1]!.id}.jsonl`);
    });
  });
});
