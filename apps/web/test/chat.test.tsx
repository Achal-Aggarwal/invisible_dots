// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CONVERSATION_LIST_LIMIT } from "@invisible-dots/shared/browser";
import { CHAT_PAGE_SIZE } from "../src/lib/chat-window";
import { CHAT_ACTIVITY_EVENT_TYPES } from "../src/lib/chat-thread";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "../src/components/chat/ChatView";
import { DotShell } from "../src/components/DotShell";
import { DotEventScope, EventStreamProvider } from "../src/components/events";
import { AttentionProvider } from "../src/components/shell/attention";
import { stubMatchMedia, stubObjectUrls, stubResizeObserver } from "./support/browser";
import { approvalRecord, dotRecord, FakeControlPlane } from "./support/control-plane";

let pathname = "/dots/d1/chat";
/** Where `router.replace` was asked to go, in order; the page that renders the chat at an address follows it. */
const replaced: string[] = [];
let navigate: (path: string) => void = () => {};
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({
    push() {},
    replace: (to: string) => {
      replaced.push(to);
      navigate(to);
    },
  }),
}));

let plane: FakeControlPlane;

beforeEach(() => {
  pathname = "/dots/d1/chat";
  replaced.length = 0;
  navigate = () => {};
  window.localStorage.clear();
  plane = new FakeControlPlane();
  plane.dots = [dotRecord("d1", { name: "fares" })];
  plane.install();
  stubMatchMedia();
  stubResizeObserver();
  stubObjectUrls();
  // The thread scrolls itself to its end; jsdom has no layout to scroll.
  Element.prototype.scrollTo = () => {};
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const requested = (pattern: RegExp) => plane.requests.filter((r) => pattern.test(r));
const call = (data: Record<string, unknown>) => ({ tool: "exec", permission: "computer.exec", decision: "allow", ok: true, duration_ms: 40, ...data });

async function renderChat() {
  const view = render(
    <EventStreamProvider>
      <AttentionProvider>
        <DotEventScope dotId="d1">
          <DotShell dotId="d1">
            <ChatView />
          </DotShell>
        </DotEventScope>
      </AttentionProvider>
    </EventStreamProvider>,
  );
  await screen.findByRole("heading", { level: 1, name: "fares" });
  await waitFor(() => expect(plane.streamOpen).toBe(true));
  return view;
}

/** The chat as the app routes it: the address names the Dot, `router.replace` changes the address, and the Dot's page starts over at the new one. */
async function renderChatAt(address: string) {
  function Page() {
    const [path, setPath] = useState(`/dots/${address}/chat`);
    pathname = path;
    navigate = setPath;
    const id = decodeURIComponent(/^\/dots\/([^/]+)/.exec(path)![1]!);
    return (
      <EventStreamProvider>
        <AttentionProvider>
          <DotEventScope key={id} dotId={id}>
            <DotShell dotId={id}>
              <ChatView />
            </DotShell>
          </DotEventScope>
        </AttentionProvider>
      </EventStreamProvider>
    );
  }
  const view = render(<Page />);
  await screen.findByRole("heading", { level: 1, name: "fares" });
  await waitFor(() => expect(plane.streamOpen).toBe(true));
  return view;
}

const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;

describe("the conversation", () => {
  it("shows what the person said as a bubble and what the Dot said as markdown, with the Dot's face at the start of its group", async () => {
    plane.store("d1", "user.message", { text: "What is the cheapest fare?" });
    plane.store("d1", "message.assistant", { text: "It is **EUR 41** on Tuesday." });
    plane.store("d1", "message.assistant", { text: "Second part, [the source](https://example.com/f)." });
    await renderChat();
    const you = await screen.findByRole("article", { name: "You" });
    expect(within(you).getByText("What is the cheapest fare?")).toBeTruthy();
    const dots = screen.getAllByRole("article", { name: "fares" });
    expect(dots).toHaveLength(2);
    expect(dots[0]!.querySelector("strong")?.textContent).toBe("EUR 41");
    expect(dots[1]!.querySelector("a")?.getAttribute("href")).toBe("https://example.com/f");
    // One face for the group of two answers: the avatar of the chat, not counting the header's own.
    expect(within(dots[0]!).getByRole("img")).toBeTruthy();
    expect(within(dots[1]!).queryByRole("img")).toBeNull();
  });

  it("says which chat a message came through, and nothing for one typed here", async () => {
    plane.store("d1", "user.message", { text: "from my phone", origin: { channel: "telegram", binding_id: "b1", chat_id: "42", external_id: "7" } });
    plane.store("d1", "user.message", { text: "from a number", origin: { channel: "whatsapp", binding_id: "b2", chat_id: "393", external_id: "8" } });
    plane.store("d1", "user.message", { text: "from this page" });
    await renderChat();
    const phone = within(await screen.findByText("from my phone").then((node) => node.closest("article")!));
    expect(phone.getByText("via Telegram")).toBeTruthy();
    expect(within(screen.getByText("from a number").closest("article")!).getByText("via WhatsApp")).toBeTruthy();
    expect(within(screen.getByText("from this page").closest("article")!).queryByText(/^via /)).toBeNull();
  });

  it("invites the first message with three ways to begin, which fill the box and do not send", async () => {
    await renderChat();
    expect(await screen.findByRole("heading", { name: "Say hello to fares" })).toBeTruthy();
    expect(screen.getByText("Tell it what you need.")).toBeTruthy();
    const ways = within(screen.getByRole("list", { name: "Ways to begin" })).getAllByRole("button");
    expect(ways).toHaveLength(3);
    await userEvent.click(within(screen.getByRole("list", { name: "Ways to begin" })).getByRole("button", { name: "What can you do on your computer?" }));
    expect(box().value).toBe("What can you do on your computer?");
    expect(document.activeElement).toBe(box());
    expect(plane.sentMessages).toEqual([]);
  });

  it("does not invite a first message when the Dot has already done something, though no message is listed yet", async () => {
    plane.store("d1", "tool.called", call({ tool: "list_dir", target: "/home/dot" }));
    await renderChat();
    await screen.findByText("Listed a folder");
    expect(screen.queryByRole("heading", { name: /Say hello/ })).toBeNull();
  });

  it("says so when the conversation cannot be loaded", async () => {
    const real = plane.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        new URL(String(input), "http://web.test").pathname.endsWith("/messages") && (init?.method ?? "GET") === "GET" ? Response.json({ error: "down", message: "the control plane said no" }, { status: 500 }) : real(input, init),
      ),
    );
    await renderChat();
    expect((await screen.findByText(/Could not load the conversation/)).closest("[role=alert]")?.textContent).toContain("the control plane said no");
  });

  it("opens on the newest page of a long conversation, and goes back a page at a time on request", async () => {
    const stored = Array.from({ length: 2 * CHAT_PAGE_SIZE + 50 }, (_, i) => plane.store("d1", i % 2 === 0 ? "user.message" : "message.assistant", { text: `m${i}` }));
    await renderChat();
    const newest = stored.length - 1;
    await screen.findByText(`m${newest}`);
    // One request, the newest page: the rest of the conversation is not read to open it.
    expect(plane.messageQueries).toEqual([{ limit: CHAT_PAGE_SIZE, order: "desc", before: null }]);
    expect(screen.getByText(`m${newest - CHAT_PAGE_SIZE + 1}`)).toBeTruthy();
    expect(screen.queryByText(`m${newest - CHAT_PAGE_SIZE}`)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Show earlier messages" }));
    await screen.findByText(`m${newest - CHAT_PAGE_SIZE}`);
    expect(plane.messageQueries.at(-1)).toEqual({ limit: CHAT_PAGE_SIZE, order: "desc", before: stored[stored.length - CHAT_PAGE_SIZE]!.id });
    expect(screen.getByText(`m${newest - 2 * CHAT_PAGE_SIZE + 1}`)).toBeTruthy();
    expect(screen.queryByText(`m${newest - 2 * CHAT_PAGE_SIZE}`)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Show earlier messages" }));
    await screen.findByText("m0");
    // The last page was short: nothing is earlier.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Show earlier messages" })).toBeNull());
    expect(screen.getAllByRole("article")).toHaveLength(stored.length);
  });

  it("does not offer earlier messages for a conversation that fits one page", async () => {
    plane.store("d1", "message.assistant", { text: "hi" });
    await renderChat();
    await screen.findByText("hi");
    expect(screen.queryByRole("button", { name: "Show earlier messages" })).toBeNull();
  });

  it("says so when the earlier messages cannot be read, and keeps what is shown", async () => {
    for (let i = 0; i < CHAT_PAGE_SIZE + 5; i++) plane.store("d1", "message.assistant", { text: `m${i}` });
    await renderChat();
    await screen.findByText(`m${CHAT_PAGE_SIZE + 4}`);
    const real = plane.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).includes("/messages?") && String(input).includes("before=") ? Response.json({ error: "down", message: "the control plane said no" }, { status: 500 }) : real(input, init),
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "Show earlier messages" }));
    expect((await screen.findByText(/Could not load earlier messages/)).closest("[role=alert]")?.textContent).toContain("the control plane said no");
    expect(screen.getByText(`m${CHAT_PAGE_SIZE + 4}`)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show earlier messages" })).toBeTruthy();
  });

  it("keeps showing what the Dot says after the conversation passed the length the route used to list", async () => {
    for (let i = 0; i < CONVERSATION_LIST_LIMIT + 20; i++) plane.store("d1", i % 2 === 0 ? "user.message" : "message.assistant", { text: `m${i}` });
    await renderChat();
    await screen.findByText(`m${CONVERSATION_LIST_LIMIT + 19}`);
    act(() => plane.push("d1", "message.assistant", { text: "a reply far past the five hundredth message" }));
    expect(await screen.findByText("a reply far past the five hundredth message")).toBeTruthy();
  });

  it("reads the activity from the oldest message shown on, and the stretch between when going back", async () => {
    // 150 messages with a tool call before each of them: the call before the first message shown is not in this window.
    const stored = [];
    for (let i = 0; i < CHAT_PAGE_SIZE + 50; i++) {
      plane.store("d1", "tool.called", call({ tool: "list_dir", target: `/call-${i}` }));
      stored.push(plane.store("d1", "message.assistant", { text: `m${i}` }));
    }
    await renderChat();
    await screen.findByText(`m${CHAT_PAGE_SIZE + 49}`);
    const oldestShown = stored[50]!;
    await waitFor(() => expect(plane.eventQueries.length).toBeGreaterThan(0));
    expect(plane.eventQueries.every((q) => q.after >= oldestShown.id)).toBe(true);
    expect(plane.eventQueries.every((q) => q.after !== 0)).toBe(true);

    plane.eventQueries.length = 0;
    await userEvent.click(screen.getByRole("button", { name: "Show earlier messages" }));
    await screen.findByText("m0");
    await waitFor(() => expect(plane.eventQueries.length).toBeGreaterThan(0));
    // Only the stretch before what was read: from the new oldest message up to the old one, newest page first.
    expect(plane.eventQueries).toEqual([expect.objectContaining({ after: stored[0]!.id, before: oldestShown.id, order: "desc" })]);
  });
});

describe("a Dot opened by its name", () => {
  it("moves to the address that holds its id, so its live events reach the chat", async () => {
    await renderChatAt("fares");
    await waitFor(() => expect(replaced).toEqual(["/dots/d1/chat"]));
    await waitFor(() => expect(requested(/^GET \/api\/dots\/d1\/messages/)).not.toEqual([]));
    act(() => plane.push("d1", "message.assistant", { text: "the fare fell to EUR 38" }));
    expect(await screen.findByText("the fare fell to EUR 38")).toBeTruthy();
  });

  it("keeps the tab, the query and the fragment when it moves", async () => {
    window.history.replaceState(null, "", "/dots/fares/chat?panel=1#end");
    try {
      await renderChatAt("fares");
      await waitFor(() => expect(replaced).toEqual(["/dots/d1/chat?panel=1#end"]));
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });

  it("does not move a Dot opened by its id", async () => {
    await renderChat();
    expect(replaced).toEqual([]);
  });
});

describe("what the Dot did between its messages", () => {
  it("shows tool calls as quiet lines with their words, their target and how they ended", async () => {
    plane.store("d1", "user.message", { text: "tidy up" });
    plane.store("d1", "tool.called", call({ tool: "list_dir", target: "/home/dot/workspace", duration_ms: 12 }));
    plane.store("d1", "tool.called", call({ tool: "exec", target: "rm old.txt", ok: false, duration_ms: 2500 }));
    plane.store("d1", "tool.called", call({ tool: "browser_navigate", target: "https://example.com", decision: "deny", ok: false, duration_ms: 0 }));
    plane.store("d1", "message.assistant", { text: "done" });
    plane.store("d1", "tool.called", call({ tool: "exec", interrupted: true, ok: false, duration_ms: 0 }));
    await renderChat();
    const [steps, later] = await screen.findAllByRole("list", { name: "What the Dot did" });
    const lines = within(steps!).getAllByTestId("activity-step");
    expect(lines.map((l) => l.textContent)).toEqual(["Listed a folder/home/dot/workspace", "Ran a commandrm old.txtfailed2.5 s", "Opened a pagehttps://example.comdenied"]);
    expect(within(later!).getByTestId("activity-step").textContent).toBe("Ran a commandinterrupted");
    // The line is cut short on a narrow screen; its whole text is its title.
    expect(lines[1]!.querySelector("[title]")?.getAttribute("title")).toBe("Ran a command: rm old.txt (failed, 2.5 s)");
  });

  it("is between the messages it happened between, in the order of the log", async () => {
    plane.store("d1", "user.message", { text: "first question" });
    plane.store("d1", "tool.called", call({ tool: "grep", target: "needle" }));
    plane.store("d1", "message.assistant", { text: "first answer" });
    plane.store("d1", "user.message", { text: "second question" });
    plane.store("d1", "tool.called", call({ tool: "read_file", target: "b.txt" }));
    plane.store("d1", "message.assistant", { text: "second answer" });
    await renderChat();
    await screen.findByText("second answer");
    const order = screen.getByRole("log").textContent ?? "";
    const at = (text: string) => order.indexOf(text);
    expect(at("first question")).toBeLessThan(at("Searched in files"));
    expect(at("Searched in files")).toBeLessThan(at("first answer"));
    expect(at("first answer")).toBeLessThan(at("second question"));
    expect(at("second question")).toBeLessThan(at("Read a file"));
    expect(at("Read a file")).toBeLessThan(at("second answer"));
  });

  it("folds a run of more than three calls into one line that opens", async () => {
    plane.store("d1", "user.message", { text: "dig" });
    for (let i = 0; i < 5; i++) plane.store("d1", "tool.called", call({ tool: "read_file", target: `f${i}.txt`, ok: i !== 3 }));
    await renderChat();
    const fold = await screen.findByRole("button", { name: "5 steps, 1 did not go through" });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("f0.txt")).toBeNull();
    await userEvent.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(within(screen.getByRole("list", { name: "Steps" })).getAllByTestId("activity-step")).toHaveLength(5);
    expect(screen.getByText("f3.txt")).toBeTruthy();
  });

  it("shows a note the Dot saved as the call that wrote it, with no chip and no link to a page of notes, and leaves out what belongs to a task", async () => {
    plane.store("d1", "user.message", { text: "remember Rome" });
    plane.store("d1", "tool.called", call({ tool: "write_file", target: "/home/dot/memory/trips/rome.md" }));
    plane.store("d1", "tool.called", call({ tool: "exec", task_id: "t1", target: "the task's command" }));
    await renderChat();
    expect(await screen.findByText("/home/dot/memory/trips/rome.md")).toBeTruthy();
    expect(screen.queryByText(/Remembered/)).toBeNull();
    expect(screen.queryByText("the task's command")).toBeNull();
  });

  /** An approval the chat asked for: in the log, and in the host's list of what waits. */
  function ask(id: string, change: { tool?: string; permission?: string; arguments?: Record<string, unknown>; reason?: string } = {}) {
    const data = { tool: "exec", permission: "computer.exec", arguments: {}, reason: "", ...change };
    plane.approvals.push(approvalRecord(id, "d1", data as never));
    return { approval_id: id, ...data };
  }

  it("shows an approval where it was asked as a card the person answers there, and its receipt after", async () => {
    plane.store("d1", "user.message", { text: "clean the disk" });
    plane.store("d1", "approval.requested", ask("a1", { arguments: { command: "du -sh ~/cache" }, reason: "to measure the cache" }));
    await renderChat();
    const card = await screen.findByRole("article", { name: "Wants to run a command" });
    expect(within(card).getByText("du -sh ~/cache")).toBeTruthy();
    expect(within(card).getByText("to measure the cache")).toBeTruthy();
    // It sits in the thread, after the message that led to it.
    expect(screen.getByRole("log").contains(card)).toBe(true);
    expect(screen.queryByRole("link", { name: /Answer it in/ })).toBeNull();

    await userEvent.click(within(card).getByRole("button", { name: "Allow once" }));
    expect(plane.answers).toEqual([{ id: "a1", decision: "approve", body: {} }]);
    // The host's answer reaches the thread through the log, and the card becomes the receipt line.
    await waitFor(() => expect(screen.getByText(/^Allowed:/)).toBeTruthy());
    expect(screen.queryByRole("article", { name: "Wants to run a command" })).toBeNull();

    act(() => plane.push("d1", "approval.requested", ask("a2", { tool: "write_file", permission: "files.write", arguments: { path: "notes.md", content: "x" } })));
    const second = await screen.findByRole("article", { name: "Wants to write a file" });
    await userEvent.click(within(second).getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(screen.getByText(/^Denied:/)).toBeTruthy());
    expect(plane.answers[1]).toEqual({ id: "a2", decision: "reject", body: {} });
  });

  it("turns the card into a receipt when the approval is answered somewhere else, and says an always-allow was for good", async () => {
    plane.store("d1", "user.message", { text: "go" });
    plane.store("d1", "approval.requested", ask("a1"));
    await renderChat();
    await screen.findByRole("article", { name: "Wants to run a command" });
    act(() => plane.push("d1", "approval.resolved", { approval_id: "a1", decision: "approve", always: true }));
    await waitFor(() => expect(screen.getByText(/^Allowed for good:/)).toBeTruthy());
    expect(screen.queryByRole("article", { name: "Wants to run a command" })).toBeNull();
  });

  it("follows the Dot live: a call that arrives shows at once, and an answer arrives from the log", async () => {
    plane.store("d1", "user.message", { text: "go" });
    await renderChat();
    await screen.findByText("go");
    act(() => plane.push("d1", "tool.called", call({ tool: "find_files", target: "*.md" })));
    expect(await screen.findByText("Searched for files")).toBeTruthy();
    act(() => plane.push("d1", "message.assistant", { text: "found three" }));
    expect(await screen.findByText("found three")).toBeTruthy();
  });

  it("asks the log only for what the chat reads, page by page, so a step on a later page is found", async () => {
    // The route serves 1000 events a page and counts what the filter keeps: a step after a thousand kept ones is on the second.
    plane.store("d1", "user.message", { text: "long ago" });
    for (let i = 0; i < 1000; i++) plane.store("d1", "approval.resolved", { approval_id: `a${i}`, decision: "approve" });
    plane.store("d1", "agent.state", { state: "IDLE" });
    plane.store("d1", "tool.called", call({ tool: "grep", target: "deep" }));
    await renderChat();
    expect(await screen.findByText("deep")).toBeTruthy();
    expect(plane.eventQueries).toHaveLength(2);
    expect(plane.eventQueries.map((q) => q.types)).toEqual([CHAT_ACTIVITY_EVENT_TYPES, CHAT_ACTIVITY_EVENT_TYPES]);
  });

  it("says when what the Dot did cannot be read, keeps the messages, and reads again on request", async () => {
    plane.store("d1", "user.message", { text: "still here" });
    plane.store("d1", "tool.called", call({ tool: "grep", target: "later" }));
    plane.failEvents = 500;
    await renderChat();
    expect(await screen.findByText("still here")).toBeTruthy();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("the event log is not available");
    plane.failEvents = null;
    await userEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("later")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("while the Dot works", () => {
  it("shows a row with what it is doing and its last step, and takes it away when it is idle", async () => {
    plane.store("d1", "user.message", { text: "dig" });
    plane.store("d1", "tool.called", call({ tool: "read_file", target: "a.md" }));
    await renderChat();
    await screen.findByText("Read a file");
    expect(screen.queryByText("Thinking...", { selector: ".shimmer" })).toBeNull();
    act(() => plane.push("d1", "agent.state", { state: "THINKING" }));
    const label = await screen.findByText("Thinking...", { selector: ".shimmer" });
    expect(label.closest("[role=status]")?.textContent).toContain("Last step: read a file a.md");
    act(() => plane.push("d1", "agent.state", { state: "EXECUTING" }));
    expect(await screen.findByText("Running a tool...", { selector: ".shimmer" })).toBeTruthy();
    act(() => plane.push("d1", "agent.state", { state: "IDLE" }));
    await waitFor(() => expect(screen.queryByText("Running a tool...", { selector: ".shimmer" })).toBeNull());
  });

  it("says what the Dot is doing when the page was opened in the middle of its turn, from the newest agent event of the log", async () => {
    plane.store("d1", "user.message", { text: "dig" });
    plane.store("d1", "agent.state", { state: "IDLE" });
    plane.store("d1", "agent.state", { state: "THINKING" });
    plane.store("d1", "tool.called", call({ tool: "read_file", target: "a.md" }));
    await renderChat();
    const label = await screen.findByText("Thinking...", { selector: ".shimmer" });
    expect(label.closest("[role=status]")?.textContent).toContain("Last step: read a file a.md");
    // One request, for the newest of the two types that tell: the log is not read for this.
    expect(plane.agentQueries).toEqual([{ after: 0, limit: 1, types: ["agent.state", "agent.started"], tools: null, taskId: null, order: "desc" }]);
    act(() => plane.push("d1", "agent.state", { state: "IDLE" }));
    await waitFor(() => expect(screen.queryByText("Thinking...", { selector: ".shimmer" })).toBeNull());
  });

  it("does not say it of a computer that is stopped, and does not ask", async () => {
    plane.dots = [dotRecord("d1", { name: "fares", computer_state: "STOPPED" })];
    plane.store("d1", "agent.state", { state: "THINKING" });
    await renderChat();
    await screen.findByText(/Sending a message wakes it/);
    expect(plane.agentQueries).toEqual([]);
    expect(document.querySelector(".shimmer")).toBeNull();
  });

  it("stops saying the Dot is thinking when its computer is stopped in the middle of the turn", async () => {
    plane.store("d1", "user.message", { text: "dig" });
    await renderChat();
    act(() => plane.push("d1", "agent.state", { state: "THINKING" }));
    await screen.findByText("Thinking...", { selector: ".shimmer" });
    act(() => plane.push("d1", "computer.stopped", { reason: "user", forced: false }));
    await waitFor(() => expect(screen.queryByText("Thinking...", { selector: ".shimmer" })).toBeNull());
    expect(document.querySelector(".shimmer")).toBeNull();
  });

  it("does not show the row while the Dot waits for the person", async () => {
    await renderChat();
    act(() => plane.push("d1", "agent.state", { state: "WAITING_APPROVAL" }));
    await waitFor(() => expect(screen.getAllByText("Waiting for you").length).toBeGreaterThan(0));
    expect(document.querySelector(".shimmer")).toBeNull();
  });
});

describe("the composer", () => {
  it("sends on Enter, adds a line on Shift+Enter, and sends nothing when empty", async () => {
    await renderChat();
    await userEvent.type(box(), "hello{Shift>}{Enter}{/Shift}world");
    expect(box().value).toBe("hello\nworld");
    expect(plane.sentMessages).toEqual([]);
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(plane.sentMessages).toEqual(["hello\nworld"]));
    await waitFor(() => expect(box().value).toBe(""));
    await userEvent.type(box(), "   {Enter}");
    expect(plane.sentMessages).toHaveLength(1);
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("takes the focus, so the person can write at once", async () => {
    await renderChat();
    expect(document.activeElement).toBe(box());
  });

  it("shows the message at once, and replaces it with the logged one", async () => {
    let release!: () => void;
    plane.holdSend = new Promise<void>((resolve) => (release = resolve));
    await renderChat();
    await userEvent.type(box(), "are you there{Enter}");
    const bubble = await screen.findByText("are you there");
    expect(bubble.closest("article")?.textContent).toContain("Sending...");
    expect(box().value).toBe("");
    release();
    await waitFor(() => expect(screen.queryByText("Sending...")).toBeNull());
    // One bubble: the logged message, not the logged message and the one that was waiting for it.
    expect(screen.getAllByText("are you there")).toHaveLength(1);
    expect(screen.getByRole("article", { name: "You" })).toBeTruthy();
  });

  it("gives the text back and says why when the message is refused", async () => {
    plane.failSend = { status: 409, error: "dot_deleting", message: "Dot d1 is being deleted" };
    await renderChat();
    await userEvent.type(box(), "last words{Enter}");
    expect((await screen.findByText(/The message was not sent/)).closest("[role=alert]")?.textContent).toContain("Dot d1 is being deleted");
    expect(box().value).toBe("last words");
    expect(screen.queryByText("last words", { selector: "p" })).toBeNull();
    plane.failSend = null;
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(plane.sentMessages).toEqual(["last words", "last words"]));
    await waitFor(() => expect(screen.queryByText(/The message was not sent/)).toBeNull());
  });

  it("puts a refused message back in front of what the person typed while it was on its way", async () => {
    let release!: () => void;
    plane.holdSend = new Promise<void>((resolve) => (release = resolve));
    plane.failSend = { status: 409, error: "dot_deleting", message: "Dot d1 is being deleted" };
    await renderChat();
    await userEvent.type(box(), "first{Enter}");
    await waitFor(() => expect(plane.sentMessages).toEqual(["first"]));
    await userEvent.type(box(), "second");
    release();
    await screen.findByText(/The message was not sent/);
    expect(box().value).toBe("first\nsecond");
  });

  it("says that a message waits when the computer had to wake up, until the Dot picks it up", async () => {
    plane.delivery = "queued";
    await renderChat();
    await userEvent.type(box(), "wake up{Enter}");
    expect(await screen.findByText(/Queued: the computer is waking up/)).toBeTruthy();
    act(() => plane.push("d1", "agent.state", { state: "THINKING" }));
    await waitFor(() => expect(screen.queryByText(/Queued: the computer is waking up/)).toBeNull());
  });

  it("shows a message sent into a long conversation once, with the note of the wake-up", async () => {
    for (let i = 0; i < CONVERSATION_LIST_LIMIT + 20; i++) plane.store("d1", "message.assistant", { text: `m${i}` });
    plane.delivery = "queued";
    await renderChat();
    await screen.findByText(`m${CONVERSATION_LIST_LIMIT + 19}`);
    await userEvent.type(box(), "after the limit{Enter}");
    await waitFor(() => expect(plane.sentMessages).toEqual(["after the limit"]));
    const bubble = await screen.findByText("after the limit");
    await waitFor(() => expect(bubble.closest("article")?.textContent).toContain("Queued: the computer is waking up"));
    expect(screen.getAllByText("after the limit")).toHaveLength(1);
    expect(screen.queryByText("Sending...")).toBeNull();
  });

  it("keeps a draft per Dot across a reload, and forgets it once sent", async () => {
    const first = await renderChat();
    await userEvent.type(box(), "half a thought");
    first.unmount();
    cleanup();
    await renderChat();
    await waitFor(() => expect(box().value).toBe("half a thought"));
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(plane.sentMessages).toEqual(["half a thought"]));
    expect(window.localStorage.getItem("idots.draft.d1")).toBeNull();
  });

  it("says why it is closed for a Dot being deleted", async () => {
    plane.dots = [dotRecord("d1", { name: "fares", computer_state: "DELETING" })];
    await renderChat();
    await waitFor(() => expect(box().disabled).toBe(true));
    expect(screen.getAllByText("This Dot is being deleted.").length).toBeGreaterThan(0);
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("tells how long the answer will take while the computer is stopped, and still takes the message", async () => {
    plane.dots = [dotRecord("d1", { name: "fares", computer_state: "STOPPED" })];
    await renderChat();
    expect(await screen.findByText(/Sending a message wakes it/)).toBeTruthy();
    expect(box().disabled).toBe(false);
    await userEvent.type(box(), "hi{Enter}");
    await waitFor(() => expect(plane.sentMessages).toEqual(["hi"]));
  });
});

describe("the computer panel", () => {
  it("is always beside the thread, at any width, and shows the desktop: there is nothing to open", async () => {
    plane.dots = [dotRecord("d1", { name: "fares", computer_state: "RUNNING" })];
    await renderChat();
    const panel = await screen.findByRole("complementary", { name: "Computer" });
    expect(await within(panel).findByRole("img", { name: /current picture of the desktop/ })).toBeTruthy();
    // The thread is there beside it, and no button opens or closes the panel.
    expect(screen.getByRole("log")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Watch the computer" })).toBeNull();
  });

  it("says the computer is stopped instead of showing a picture", async () => {
    plane.dots = [dotRecord("d1", { name: "fares", computer_state: "STOPPED" })];
    await renderChat();
    const panel = await screen.findByRole("complementary", { name: "Computer" });
    expect(within(panel).getByText(/The computer is stopped/)).toBeTruthy();
    expect(within(panel).queryByRole("img")).toBeNull();
  });
});
