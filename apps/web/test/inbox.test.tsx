// @vitest-environment jsdom
import { APPROVAL_LIST_LIMIT } from "@invisible-dots/shared/browser";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ApprovalsRedirect from "../src/app/(app)/approvals/page";
import DotApprovalsRedirect from "../src/app/(app)/dots/[id]/approvals/page";
import InboxPage from "../src/app/(app)/inbox/page";
import { EventStreamProvider } from "../src/components/events";
import { InboxView } from "../src/components/inbox/InboxView";
import { AttentionProvider } from "../src/components/shell/attention";
import { inboxHref, parseInboxQuery, type InboxQuery } from "../src/lib/inbox";
import { stubMatchMedia } from "./support/browser";
import { approvalRecord, channelRecord, dotRecord, FakeControlPlane, taskRecord } from "./support/control-plane";

const router = { push: vi.fn(), replace: vi.fn() };
vi.mock("next/navigation", () => ({
  usePathname: () => "/inbox",
  useRouter: () => router,
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));

let plane: FakeControlPlane;

beforeEach(() => {
  window.localStorage.clear();
  router.push.mockClear();
  router.replace.mockClear();
  plane = new FakeControlPlane();
  plane.dots = [dotRecord("d1", { name: "fares" }), dotRecord("d2", { name: "mailer" })];
  plane.install();
  stubMatchMedia();
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

async function renderInbox(query: Partial<InboxQuery> = {}) {
  const full: InboxQuery = { tab: "needs-you", dot: null, permission: null, ...query };
  const view = render(
    <EventStreamProvider>
      <AttentionProvider>
        <InboxView query={full} />
      </AttentionProvider>
    </EventStreamProvider>,
  );
  await waitFor(() => expect(plane.streamOpen).toBe(true));
  return view;
}

const cards = () => screen.queryAllByRole("article", { name: /^Wants to / });
const cardNames = () => cards().map((card) => card.getAttribute("data-approval-id"));

describe("Needs you", () => {
  it("lists the approvals of every Dot, the one that has waited longest first, each with its Dot", async () => {
    plane.approvals = [
      approvalRecord("late", "d2", { created_at: hoursAgo(1), tool: "write_file", permission: "files.write", arguments: { path: "a.md", content: "x" } }),
      approvalRecord("early", "d1", { created_at: hoursAgo(5), arguments: { command: "make test" } }),
      approvalRecord("done", "d1", { status: "approved", created_at: hoursAgo(9), resolved_at: hoursAgo(8) }),
    ];
    await renderInbox();
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(cardNames()).toEqual(["early", "late"]);
    expect(within(cards()[0]!).getByText("fares")).toBeTruthy();
    expect(within(cards()[1]!).getByText("mailer")).toBeTruthy();
    // Each card shows the face of its Dot (decorative: the name is said in words beside it), so cards of several Dots are told apart at a glance.
    for (const [card, initial] of [[cards()[0]!, "F"], [cards()[1]!, "M"]] as const) {
      const face = card.querySelector("[data-ring]");
      expect(face?.textContent).toBe(initial);
      expect(face?.closest("[aria-hidden=true]")).not.toBeNull();
    }
    expect(screen.getByRole("heading", { name: /Waiting for your answer/ }).textContent).toContain("2");
    expect(within(screen.getByRole("navigation", { name: "Inbox sections" })).getByLabelText("2 need you")).toBeTruthy();
  });

  it("adds the Dots in an error state and the tasks that failed lately, each as a compact card with its action", async () => {
    plane.dots = [dotRecord("d1", { name: "fares", status: "ERROR", error: "the disk is full", computer_state: "ERROR" }), dotRecord("d2", { name: "mailer" })];
    plane.tasks = [
      taskRecord("t1", { dot_id: "d2", description: "Send the digest", status: "FAILED", error: "the SMTP server refused", finished_at: hoursAgo(2) }),
      taskRecord("t2", { dot_id: "d2", description: "Too old", status: "FAILED", error: "x", finished_at: hoursAgo(40) }),
    ];
    await renderInbox();
    const broken = await screen.findByRole("article", { name: "fares is in an error state" });
    expect(within(broken).getByText("the disk is full")).toBeTruthy();
    expect(within(broken).getByRole("link", { name: "Open" }).getAttribute("href")).toBe("/dots/d1/chat");
    expect(within(broken).getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/dots/d1/settings");
    const failed = await screen.findByRole("article", { name: "Failed: Send the digest" });
    expect(within(failed).getByText("the SMTP server refused")).toBeTruthy();
    expect(within(failed).getByRole("link", { name: "Open task" }).getAttribute("href")).toBe("/dots/d2/tasks/t1");
    expect(screen.queryByRole("article", { name: "Failed: Too old" })).toBeNull();
    expect(within(screen.getByRole("navigation", { name: "Inbox sections" })).getByLabelText("2 need you")).toBeTruthy();
  });

  it("takes a failed task out when it is dismissed, remembers it, and lowers the count", async () => {
    plane.tasks = [taskRecord("t1", { dot_id: "d1", description: "Send the digest", status: "FAILED", error: "no", finished_at: hoursAgo(2) })];
    const view = await renderInbox();
    const failed = await screen.findByRole("article", { name: "Failed: Send the digest" });
    await userEvent.click(within(failed).getByRole("button", { name: /^Dismiss/ }));
    expect(screen.queryByRole("article", { name: "Failed: Send the digest" })).toBeNull();
    expect(screen.getByText("Nothing needs you")).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem("idots.dismissed-tasks")!)).toEqual(["t1"]);
    expect(within(screen.getByRole("navigation", { name: "Inbox sections" })).queryByLabelText(/need you/)).toBeNull();

    // Opened again, it stays away.
    view.unmount();
    await renderInbox();
    await screen.findByText("Nothing needs you");
  });

  it("says that failed tasks may be missing when they could not be read", async () => {
    const real = plane.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => (String(input).startsWith("/api/tasks?") ? Response.json({ error: "down", message: "down" }, { status: 502 }) : real(input, init))),
    );
    await renderInbox();
    expect(await screen.findByText("Failed tasks may be missing")).toBeTruthy();
    expect(screen.getByText("The tasks that failed today could not be read.")).toBeTruthy();
  });

  it("adds the channels that need linking again, with what the host says and the page where it is done", async () => {
    plane.channels = {
      d1: [channelRecord("telegram", { status: "needs_relink", status_detail: "Telegram refused the token: it was revoked." }), channelRecord("whatsapp")],
      d2: [channelRecord("telegram", { enabled: false, status: "needs_relink" })],
    };
    await renderInbox();
    const card = await screen.findByRole("article", { name: "Telegram of fares needs linking again" });
    expect(within(card).getByText("Telegram refused the token: it was revoked.")).toBeTruthy();
    expect(within(card).getByRole("link", { name: "Open channels" }).getAttribute("href")).toBe("/dots/d1/channels");
    expect(screen.getByRole("heading", { name: /Channels to link again/ }).textContent).toContain("1");
    // A channel the person paused is theirs to resume, and one that is connected needs nothing.
    expect(screen.queryByRole("article", { name: /mailer/ })).toBeNull();
    expect(screen.queryByRole("article", { name: /WhatsApp/ })).toBeNull();
    expect(within(screen.getByRole("navigation", { name: "Inbox sections" })).getByLabelText("1 need you")).toBeTruthy();
  });

  it("leaves the channels out of a permission filter, and keeps only one Dot's when a Dot is chosen", async () => {
    plane.channels = { d1: [channelRecord("telegram", { status: "needs_relink" })], d2: [channelRecord("telegram", { status: "needs_relink" })] };
    await renderInbox({ dot: "d2" });
    await screen.findByRole("article", { name: "Telegram of mailer needs linking again" });
    expect(screen.queryByRole("article", { name: "Telegram of fares needs linking again" })).toBeNull();
    cleanup();

    await renderInbox({ permission: "files.write" });
    await screen.findByText("Nothing needs you");
    expect(screen.queryByRole("article", { name: /needs linking again/ })).toBeNull();
  });

  it("says that channels may be missing when they could not be read", async () => {
    plane.failChannels = { status: 502, error: "down", message: "down" };
    await renderInbox();
    expect(await screen.findByText("Channels may be missing")).toBeTruthy();
    expect(screen.getByText("The channels could not be read.")).toBeTruthy();
  });

  it("says that nothing needs the person when nothing does, and loads without flashing that before it knows", async () => {
    await renderInbox();
    expect(await screen.findByText("Nothing needs you")).toBeTruthy();
    cleanup();

    plane.approvals = [approvalRecord("a1", "d1")];
    await renderInbox();
    await screen.findByRole("article", { name: "Wants to run a command" });
    expect(screen.queryByText("Nothing needs you")).toBeNull();
  });

  it("says when the approvals could not be loaded", async () => {
    const real = plane.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => (String(input).startsWith("/api/approvals") ? Response.json({ error: "down", message: "the control plane said no" }, { status: 500 }) : real(input, init))),
    );
    await renderInbox();
    expect((await screen.findByText("Could not load the approvals")).closest("[role=alert]")?.textContent).toContain("the control plane said no");
  });

  it("follows the stream: a new approval appears, and one answered elsewhere goes away", async () => {
    await renderInbox();
    await screen.findByText("Nothing needs you");
    plane.approvals = [approvalRecord("a1", "d1", { arguments: { command: "make test" } })];
    act(() => plane.push("d1", "approval.requested", { approval_id: "a1" }));
    await screen.findByRole("article", { name: "Wants to run a command" });
    expect(screen.queryByText("Nothing needs you")).toBeNull();

    plane.approvals[0]!.status = "approved";
    act(() => plane.push("d1", "approval.resolved", { approval_id: "a1", decision: "approve" }));
    await waitFor(() => expect(cards()).toHaveLength(0));
    expect(screen.getByText("Nothing needs you")).toBeTruthy();
  });

  it("drops the approvals of a Dot once its delete finishes: they go with the Dot, and nothing resolves them", async () => {
    plane.approvals = [approvalRecord("a1", "d1")];
    await renderInbox();
    await waitFor(() => expect(cards()).toHaveLength(1));
    // The delete removes the Dot's approvals with it; the stream says dot.deleted and no approval.resolved.
    plane.approvals = [];
    act(() => plane.push("d1", "dot.deleted", { name: "fares" }));
    await waitFor(() => expect(cards()).toHaveLength(0));
    expect(screen.getByText("Nothing needs you")).toBeTruthy();
  });

  it("drops the answers of a Dot from the History once its delete finishes", async () => {
    plane.approvals = [approvalRecord("a1", "d1", { status: "approved", resolved_at: hoursAgo(1) })];
    await renderInbox({ tab: "history" });
    const table = await screen.findByRole("table");
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(2));
    plane.approvals = [];
    act(() => plane.push("d1", "dot.deleted", { name: "fares" }));
    await waitFor(() => expect(screen.queryByRole("table")).toBeNull());
  });

  it("keeps an approval it answered in its place as a receipt, so that nothing moves under the pointer", async () => {
    plane.approvals = [approvalRecord("a1", "d1", { created_at: hoursAgo(3) }), approvalRecord("a2", "d1", { created_at: hoursAgo(2), tool: "browser_navigate", permission: "browser.navigate", arguments: { identity_id: "x", url: "https://example.com" } })];
    await renderInbox();
    await waitFor(() => expect(cards()).toHaveLength(2));
    await userEvent.click(within(cards()[0]!).getByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(within(cards()[0]!).getByRole("status").textContent).toBe("Allowed"));
    // The host's list of waiting approvals has dropped it by now; the card is still the first one.
    await waitFor(() => expect(plane.requests.filter((r) => r === "GET /api/approvals").length).toBeGreaterThan(1));
    expect(cardNames()).toEqual(["a1", "a2"]);
    expect(within(cards()[0]!).getByRole("status").textContent).toBe("Allowed");
    expect(screen.getByRole("heading", { name: /Waiting for your answer/ }).textContent).toContain("1");
  });
});

describe("the filters", () => {
  beforeEach(() => {
    plane.dots = [dotRecord("d1", { name: "fares", status: "ERROR", error: "broken", computer_state: "ERROR" }), dotRecord("d2", { name: "mailer" })];
    plane.approvals = [
      approvalRecord("a1", "d1", { created_at: hoursAgo(5), permission: "computer.exec" }),
      approvalRecord("a2", "d2", { created_at: hoursAgo(4), tool: "write_file", permission: "files.write", arguments: { path: "a.md", content: "x" } }),
      approvalRecord("a3", "d2", { created_at: hoursAgo(3), permission: "computer.exec" }),
    ];
  });

  it("narrows to one Dot, named by its id or by its name, and keeps the other things of that Dot", async () => {
    await renderInbox({ dot: "d2" });
    await waitFor(() => expect(cardNames()).toEqual(["a2", "a3"]));
    expect(screen.queryByRole("article", { name: "fares is in an error state" })).toBeNull();
    expect((screen.getByLabelText("Dot") as HTMLSelectElement).value).toBe("d2");
    cleanup();

    await renderInbox({ dot: "fares" });
    await waitFor(() => expect(cardNames()).toEqual(["a1"]));
    expect(screen.getByRole("article", { name: "fares is in an error state" })).toBeTruthy();
    expect((screen.getByLabelText("Dot") as HTMLSelectElement).value).toBe("d1");
  });

  it("narrows to one permission, and then leaves out what has no permission: Dots in error and failed tasks", async () => {
    await renderInbox({ permission: "files.write" });
    await waitFor(() => expect(cardNames()).toEqual(["a2"]));
    expect(screen.queryByRole("article", { name: "fares is in an error state" })).toBeNull();
    expect((screen.getByLabelText("Permission") as HTMLSelectElement).value).toBe("files.write");
  });

  it("says so when the filters leave nothing", async () => {
    await renderInbox({ dot: "d2", permission: "browser.act" });
    expect(await screen.findByText("Nothing needs you")).toBeTruthy();
  });

  it("puts a choice in the address, where the whole state of the Inbox lives", async () => {
    await renderInbox({ tab: "history" });
    await userEvent.selectOptions(screen.getByLabelText("Dot"), "d2");
    expect(router.replace).toHaveBeenLastCalledWith("/inbox?tab=history&dot=d2");
    await userEvent.selectOptions(screen.getByLabelText("Permission"), "files.write");
    expect(router.replace).toHaveBeenLastCalledWith("/inbox?tab=history&permission=files.write");
    cleanup();

    await renderInbox({ dot: "d2", permission: "files.write" });
    await userEvent.selectOptions(screen.getByLabelText("Dot"), "");
    expect(router.replace).toHaveBeenLastCalledWith("/inbox?permission=files.write");
  });

  it("offers a Dot the list does not hold when the address asks for it (a deleted Dot's approvals)", async () => {
    await renderInbox({ dot: "dot_gone" });
    const select = screen.getByLabelText("Dot") as HTMLSelectElement;
    expect(select.value).toBe("dot_gone");
    expect(within(select).getByRole("option", { name: "dot_gone" })).toBeTruthy();
  });

  it("has the two tabs as links that keep the filters, and marks the open one", async () => {
    await renderInbox({ dot: "d2" });
    const tabs = within(screen.getByRole("navigation", { name: "Inbox sections" }));
    expect(tabs.getByRole("link", { name: /Needs you/ }).getAttribute("aria-current")).toBe("page");
    expect(tabs.getByRole("link", { name: "History" }).getAttribute("href")).toBe("/inbox?tab=history&dot=d2");
    expect(tabs.getByRole("link", { name: "History" }).getAttribute("aria-current")).toBeNull();
  });
});

describe("the keyboard", () => {
  beforeEach(() => {
    plane.approvals = [
      approvalRecord("first", "d1", { created_at: hoursAgo(5), tool: "browser_navigate", permission: "browser.navigate", arguments: { identity_id: "x", url: "https://example.com/one" } }),
      approvalRecord("second", "d1", { created_at: hoursAgo(4), tool: "browser_navigate", permission: "browser.navigate", arguments: { identity_id: "x", url: "https://example.com/two" } }),
      approvalRecord("third", "d1", { created_at: hoursAgo(3), arguments: { command: "make test" } }),
    ];
  });

  const approvalList = () => screen.getByRole("list", { name: "Approvals waiting for your answer" });
  const selected = () => screen.queryAllByRole("article").filter((card) => card.getAttribute("aria-current") === "true").map((card) => card.getAttribute("data-approval-id"));

  it("selects the first card, moves with j and k and stops at the ends", async () => {
    await renderInbox();
    await waitFor(() => expect(cards()).toHaveLength(3));
    await userEvent.click(approvalList());
    expect(selected()).toEqual(["first"]);
    await userEvent.keyboard("j");
    expect(selected()).toEqual(["second"]);
    await userEvent.keyboard("jj");
    expect(selected()).toEqual(["third"]);
    await userEvent.keyboard("k");
    expect(selected()).toEqual(["second"]);
    await userEvent.keyboard("kkk");
    expect(selected()).toEqual(["first"]);
  });

  it("says which card is selected when j or k moves, since the selection is drawn and not focused", async () => {
    await renderInbox();
    await waitFor(() => expect(cards()).toHaveLength(3));
    await userEvent.click(approvalList());
    const spoken = () => screen.getAllByRole("status").map((status) => status.textContent).filter((text) => /\d of \d/.test(text ?? ""));
    expect(spoken()).toEqual([]);
    await userEvent.keyboard("j");
    expect(spoken()).toEqual(["fares: Wants to open a page. 2 of 3."]);
    await userEvent.keyboard("jj");
    expect(spoken()).toEqual(["fares: Wants to run a command. 3 of 3."]);
    await userEvent.keyboard("k");
    expect(spoken()).toEqual(["fares: Wants to open a page. 2 of 3."]);
  });

  it("allows the selected card once with a, and denies it with d, and moves nowhere by itself", async () => {
    await renderInbox();
    await waitFor(() => expect(cards()).toHaveLength(3));
    await userEvent.click(approvalList());
    await userEvent.keyboard("a");
    await waitFor(() => expect(plane.answers).toEqual([{ id: "first", decision: "approve", body: {} }]));
    await waitFor(() => expect(within(cards()[0]!).getByRole("status").textContent).toBe("Allowed"));
    expect(selected()).toEqual(["first"]);

    await userEvent.keyboard("j");
    await userEvent.keyboard("d");
    await waitFor(() => expect(plane.answers[1]).toEqual({ id: "second", decision: "reject", body: {} }));
    await waitFor(() => expect(within(cards()[1]!).getByRole("status").textContent).toContain("Denied"));

    // An answered card is not answered again by the key.
    await userEvent.keyboard("k");
    await userEvent.keyboard("ad");
    expect(plane.answers).toHaveLength(2);
  });

  it("sends the note written for the card with an answer made by key", async () => {
    await renderInbox();
    await waitFor(() => expect(cards()).toHaveLength(3));
    await userEvent.click(approvalList());
    await userEvent.click(within(cards()[0]!).getByRole("button", { name: "Add a note for the Dot" }));
    const field = within(cards()[0]!).getByLabelText("Note for the Dot (optional)");
    await userEvent.type(field, "go ahead");
    // The keys typed in the field are text, not shortcuts.
    expect(plane.answers).toEqual([]);
    // Back to the list (a click on it): the keys are its own again.
    await userEvent.click(approvalList());
    await userEvent.keyboard("a");
    await waitFor(() => expect(plane.answers).toEqual([{ id: "first", decision: "approve", body: { note: "go ahead" } }]));
  });

  it("does not allow a destructive card by key: it moves the focus to Allow once and says to confirm", async () => {
    await renderInbox();
    await waitFor(() => expect(cards()).toHaveLength(3));
    await userEvent.click(approvalList());
    await userEvent.keyboard("jj");
    expect(selected()).toEqual(["third"]);
    await userEvent.keyboard("a");
    expect(plane.answers).toEqual([]);
    const allow = within(cards()[2]!).getByRole("button", { name: "Allow once" });
    expect(document.activeElement).toBe(allow);
    expect(screen.getAllByRole("status").some((status) => status.textContent?.includes("Press Enter on Allow once to confirm"))).toBe(true);
    // The press of the button is the confirmation.
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(plane.answers).toEqual([{ id: "third", decision: "approve", body: {} }]));
  });

  it("denies a destructive card at once, since a denial can do no harm", async () => {
    await renderInbox();
    await waitFor(() => expect(cards()).toHaveLength(3));
    await userEvent.click(approvalList());
    await userEvent.keyboard("jj");
    await userEvent.keyboard("d");
    await waitFor(() => expect(plane.answers).toEqual([{ id: "third", decision: "reject", body: {} }]));
  });

  it("leaves the keys to a dialog that is open", async () => {
    await renderInbox();
    await waitFor(() => expect(cards()).toHaveLength(3));
    await userEvent.click(approvalList());
    await userEvent.keyboard("jj");
    await userEvent.click(within(cards()[2]!).getByRole("button", { name: "Always allow" }));
    await screen.findByRole("dialog");
    await userEvent.keyboard("a");
    await userEvent.keyboard("d");
    expect(plane.answers).toEqual([]);
  });

  it("ignores a key with a modifier, and does nothing when no card waits", async () => {
    await renderInbox();
    await waitFor(() => expect(cards()).toHaveLength(3));
    await userEvent.click(approvalList());
    await userEvent.keyboard("{Control>}a{/Control}");
    await userEvent.keyboard("{Alt>}d{/Alt}");
    expect(plane.answers).toEqual([]);
    cleanup();

    plane.approvals = [];
    await renderInbox();
    await screen.findByText("Nothing needs you");
    await userEvent.keyboard("jkad");
    expect(plane.answers).toEqual([]);
  });

  it("says in words which keys there are and where they act, and the list says it too", async () => {
    await renderInbox();
    expect(screen.getByText(/Keys,/).textContent).toContain("once the list of approvals has the focus");
    expect(screen.getByText(/Keys,/).textContent).toContain("allows the selected one");
    await waitFor(() => expect(cards()).toHaveLength(3));
    expect(approvalList().getAttribute("aria-describedby")).toBe(screen.getByText(/Keys,/).id);
  });

  it("answers nothing for a key typed while the focus is not in the list: a single key is not the page's (WCAG 2.1.4)", async () => {
    await renderInbox();
    await waitFor(() => expect(cards()).toHaveLength(3));
    expect(document.activeElement).toBe(document.body);
    await userEvent.keyboard("jdad");
    expect(plane.answers).toEqual([]);
    expect(selected()).toEqual(["first"]);
    // Tab reaches the list, and then the keys are its own.
    await userEvent.tab();
    while (document.activeElement !== approvalList()) await userEvent.tab();
    await userEvent.keyboard("d");
    await waitFor(() => expect(plane.answers).toEqual([{ id: "first", decision: "reject", body: {} }]));
  });

  it("selects the card the focus enters, so the keys act on the card the person is on", async () => {
    await renderInbox();
    await waitFor(() => expect(cards()).toHaveLength(3));
    within(cards()[1]!).getByRole("button", { name: "Deny" }).focus();
    await waitFor(() => expect(selected()).toEqual(["second"]));
    await userEvent.keyboard("a");
    await waitFor(() => expect(plane.answers).toEqual([{ id: "second", decision: "approve", body: {} }]));
  });
});

describe("History", () => {
  it("lists what was answered, the last answer first, with what it was and who answered what", async () => {
    plane.approvals = [
      approvalRecord("old", "d1", { status: "approved", created_at: hoursAgo(9), resolved_at: hoursAgo(8), reason: "to build it" }),
      approvalRecord("new", "d2", { status: "rejected", created_at: hoursAgo(4), resolved_at: hoursAgo(1), note: "no thanks", tool: "write_file", permission: "files.write", arguments: { path: "a.md" } }),
      approvalRecord("lapsed", "d1", { status: "expired", created_at: hoursAgo(6), resolved_at: null, tool: "browser_navigate", permission: "browser.navigate" }),
      approvalRecord("waiting", "d1", { created_at: hoursAgo(1) }),
    ];
    await renderInbox({ tab: "history" });
    const table = await screen.findByRole("table", { name: /answered/ });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell")[0]!.textContent)).toEqual(["Answer: Denied", "Answer: Expired", "Answer: Allowed"]);
    // Each answer has its own tone: denied is the danger one, allowed the ok one, expired the quiet one.
    const chip = (row: HTMLElement) => within(row).getByText(/^(Allowed|Denied|Expired)$/).closest("span")!.className;
    expect(chip(rows[0]!)).toContain("text-danger");
    expect(chip(rows[1]!)).toContain("text-muted-foreground");
    expect(chip(rows[2]!)).toContain("text-ok");
    expect(within(rows[0]!).getByText("Asked to write a file")).toBeTruthy();
    expect(within(rows[0]!).getByText("Note: no thanks")).toBeTruthy();
    expect(within(rows[0]!).getByRole("link", { name: "mailer" }).getAttribute("href")).toBe("/dots/d2/chat");
    expect(within(rows[0]!).getByText("Change files")).toBeTruthy();
    expect(within(rows[2]!).getByText("to build it")).toBeTruthy();
    // What waits is the other tab's.
    expect(within(table).queryByText("waiting")).toBeNull();
    // No cards, no keys: the history is a table.
    expect(cards()).toHaveLength(0);
  });

  it("filters by Dot and by permission, and says so when nothing is left", async () => {
    plane.approvals = [
      approvalRecord("a1", "d1", { status: "approved", resolved_at: hoursAgo(1) }),
      approvalRecord("a2", "d2", { status: "approved", resolved_at: hoursAgo(2), tool: "write_file", permission: "files.write" }),
    ];
    await renderInbox({ tab: "history", dot: "d2" });
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(within(table).getByText("Asked to write a file")).toBeTruthy();
    cleanup();

    await renderInbox({ tab: "history", dot: "d1", permission: "files.write" });
    expect(await screen.findByText("No approval has been answered under these filters.")).toBeTruthy();
    cleanup();

    plane.approvals = [];
    await renderInbox({ tab: "history" });
    expect(await screen.findByText("No approval has been answered yet.")).toBeTruthy();
  });

  it("asks for the answered approvals newest first, fifty at a time, and reads older ones on request", async () => {
    plane.approvals = Array.from({ length: 120 }, (_, i) => approvalRecord(`a${String(i).padStart(3, "0")}`, "d1", { status: "approved", resolved_at: hoursAgo(i + 1) }));
    await renderInbox({ tab: "history" });
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(51);
    const history = () => plane.approvalQueries.filter((q) => q.status?.includes("approved"));
    expect(history()).toEqual([{ status: ["approved", "rejected", "expired"], limit: 50, order: "desc", before: null, dot_id: null }]);

    await userEvent.click(screen.getByRole("button", { name: "Show older answers" }));
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(101));
    await userEvent.click(screen.getByRole("button", { name: "Show older answers" }));
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(121));
    // Each page went on after the last row of the one before, and the list ended in the short one.
    expect(history().map((q) => q.before)).toEqual([null, "a049", "a099"]);
    expect(screen.queryByRole("button", { name: "Show older answers" })).toBeNull();
  });

  it("lists the newest answer however many approvals were asked before it, and no waiting one takes its place", async () => {
    // More than the control plane lists oldest first by default, and a pending one that is the oldest of all.
    plane.approvals = [
      approvalRecord("pending-old", "d1", { created_at: hoursAgo(5000) }),
      ...Array.from({ length: APPROVAL_LIST_LIMIT + 20 }, (_, i) => approvalRecord(`b${i}`, "d1", { status: "approved", created_at: hoursAgo(4000 - i), resolved_at: hoursAgo(3000 - i) })),
      approvalRecord("newest", "d1", { status: "rejected", resolved_at: hoursAgo(0) }),
    ];
    await renderInbox({ tab: "history" });
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("row")[1]!.textContent).toContain("Denied");
    expect(screen.queryByText(/first [0-9]+ approvals/)).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps the older answers it read when a new answer arrives", async () => {
    plane.approvals = Array.from({ length: 70 }, (_, i) => approvalRecord(`a${String(i).padStart(3, "0")}`, "d1", { status: "approved", resolved_at: hoursAgo(i + 2) }));
    await renderInbox({ tab: "history" });
    const table = await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Show older answers" }));
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(71));
    plane.approvals.push(approvalRecord("fresh", "d1", { status: "rejected", resolved_at: hoursAgo(0) }));
    act(() => plane.push("d1", "approval.resolved", { approval_id: "fresh", decision: "reject" }));
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(72));
    expect(within(table).getAllByRole("row")[1]!.textContent).toContain("Denied");
  });

  it("says so when none of the newest answers is under the filters while older ones remain", async () => {
    // The Dot is chosen in the database; the permission is not (the route has no such filter), so it is the one a page can come up empty under.
    plane.approvals = Array.from({ length: 60 }, (_, i) => approvalRecord(`a${i}`, "d1", { status: "approved", resolved_at: hoursAgo(i + 1) }));
    await renderInbox({ tab: "history", permission: "files.write" });
    expect(await screen.findByText("None of the newest answers are under these filters.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show older answers" })).toBeTruthy();
  });

  it("asks the control plane for the Dot's own answers, so that its history is not hunted for among every Dot's pages", async () => {
    plane.approvals = [
      ...Array.from({ length: 60 }, (_, i) => approvalRecord(`m${i}`, "d2", { status: "approved", resolved_at: hoursAgo(i + 1) })),
      approvalRecord("mine", "d1", { status: "rejected", resolved_at: hoursAgo(500) }),
    ];
    await renderInbox({ tab: "history", dot: "d1" });
    const table = await screen.findByRole("table");
    // The one answer of this Dot is on the first page though sixty newer answers belong to another Dot.
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(plane.approvalQueries.filter((q) => q.status?.includes("approved")).map((q) => q.dot_id)).toEqual(["d1"]);
    expect(screen.queryByRole("button", { name: "Show older answers" })).toBeNull();
  });

  it("reads the log again when an approval is answered, and says when it cannot be read", async () => {
    await renderInbox({ tab: "history" });
    await screen.findByText("No approval has been answered yet.");
    plane.approvals = [approvalRecord("a1", "d1", { status: "approved", resolved_at: hoursAgo(0) })];
    act(() => plane.push("d1", "approval.resolved", { approval_id: "a1", decision: "approve" }));
    await screen.findByRole("table");
    cleanup();

    const real = plane.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => (String(input).startsWith("/api/approvals") ? Response.json({ error: "down", message: "no history today" }, { status: 500 }) : real(input, init))),
    );
    await renderInbox({ tab: "history" });
    expect((await screen.findByText("Could not load the history")).closest("[role=alert]")?.textContent).toContain("no history today");
  });
});

describe("the old addresses", () => {
  it("send /approvals to the Inbox and a Dot's approvals to the Inbox filtered to that Dot", async () => {
    expect(() => ApprovalsRedirect()).toThrow("redirect:/inbox");
    await expect(DotApprovalsRedirect({ params: Promise.resolve({ id: "dot_01" }) })).rejects.toThrow("redirect:/inbox?dot=dot_01");
    // A name with characters that need escaping stays one value.
    await expect(DotApprovalsRedirect({ params: Promise.resolve({ id: "my dot&x" }) })).rejects.toThrow("redirect:/inbox?dot=my+dot%26x");
  });

  it("serve the Inbox page the address's own state", async () => {
    const element = await InboxPage({ searchParams: Promise.resolve({ tab: "history", dot: "d1" }) });
    expect(element.props.query).toEqual(parseInboxQuery({ tab: "history", dot: "d1" }));
    expect(inboxHref(element.props.query)).toBe("/inbox?tab=history&dot=d1");
  });
});
