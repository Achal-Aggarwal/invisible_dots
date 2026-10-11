import type { FakeGuest } from "@invisible-dots/scheduler/testing";
import { newId, resolvePermission, type ApprovalRequestedData } from "@invisible-dots/shared";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { lookOf } from "./look.js";

type Ask = Pick<ApprovalRequestedData, "tool" | "permission" | "arguments"> & Partial<Pick<ApprovalRequestedData, "reason" | "task_id">>;

/** The Dot asks for an approval, as its engine does on an `ask`. Returns the approval's id. */
function ask(guest: FakeGuest, data: Ask): string {
  const approval_id = newId("apr");
  guest.emit("approval.requested", { approval_id, reason: "to get the job done", ...data });
  return approval_id;
}

const exec = (command: string): Ask => ({ tool: "exec", permission: "computer.exec", arguments: { command } });
const navigate = (url: string): Ask => ({ tool: "browser_navigate", permission: "browser.navigate", arguments: { identity_id: "shop-abc123", url } });

const cards = (page: Page) => page.getByRole("article", { name: /^Wants to / });
const railInbox = (page: Page) => page.getByRole("complementary", { name: "Navigation" }).getByRole("link", { name: /^Inbox/ });

/** What the guest was told about approvals, in order. */
function answersHeard(guest: FakeGuest) {
  return guest.inbound.flatMap((event) => (event.type === "approval.received" ? [event.data] : []));
}

// The Inbox counts across every Dot of the host: each test leaves it as it found it, with no approval waiting and no Dot.
test.afterEach(async ({ fresh }) => {
  for (const approval of await fresh.api.listApprovals("pending")) await fresh.api.reject(approval.id);
  for (const dot of await fresh.api.listDots()) await fresh.api.deleteDot(dot.id);
  await expect.poll(async () => (await fresh.api.listDots()).length).toBe(0);
});

test("the Inbox lists what every Dot waits on, counts it in the rail and the title, and an answer is heard by the Dot and clears the count", async ({ page, fresh: harness }) => {
  const a = await harness.createDot("inbox-a");
  const b = await harness.createDot("inbox-b");
  const guestA = harness.driver.guestOf(a.id);
  const idA = ask(guestA, exec("make test"));
  ask(harness.driver.guestOf(b.id), navigate("https://example.com/cart"));

  await page.goto(`${harness.webUrl}/inbox`);
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
  await expect(cards(page)).toHaveCount(2);
  const first = page.getByRole("article", { name: "Wants to run a command" });
  await expect(first.getByText("inbox-a")).toBeVisible();
  await expect(first.getByText("make test", { exact: true })).toBeVisible();
  await expect(first.getByText("to get the job done")).toBeVisible();
  await expect(first.getByText("Run commands (high risk)")).toBeVisible();
  await expect(page.getByRole("article", { name: "Wants to open a page" }).getByText("inbox-b")).toBeVisible();
  await expect(railInbox(page).getByLabel("2 need you")).toBeVisible();
  await expect(page).toHaveTitle(/^\(2\) /);

  // Nothing below reloads the page: this marker would not survive it.
  await page.evaluate(() => ((window as unknown as { marker: number }).marker = 7));
  await first.getByRole("button", { name: "Allow once" }).click();
  await expect(first.getByRole("status")).toHaveText("Allowed");
  await expect(railInbox(page).getByLabel("1 need you")).toBeVisible();
  await expect(page).toHaveTitle(/^\(1\) /);
  expect((await harness.api.listApprovals("approved")).map((x) => x.id)).toEqual([idA]);
  await expect.poll(() => answersHeard(guestA)).toEqual([{ approval_id: idA, decision: "approve" }]);
  // The card is a receipt, still where it was; the other one is untouched.
  await expect(cards(page)).toHaveCount(2);
  expect(await page.evaluate(() => (window as unknown as { marker: number }).marker)).toBe(7);

  // Another Dot's answer from elsewhere (the CLI, a channel) reaches this page by itself.
  const [other] = await harness.api.listApprovals("pending");
  await harness.api.reject(other!.id);
  await expect(railInbox(page).getByLabel(/need you/)).toHaveCount(0);
  await expect(page).toHaveTitle(/^(?!\()/);
});

test("Always allow says what it changes, changes the Dot's settings and its computer's, and is remembered as the answer", async ({ page, fresh: harness }) => {
  const dot = await harness.createDot("inbox-always");
  const guest = harness.driver.guestOf(dot.id);
  expect(guest.config?.permissions["automations"]).toBe("ask");
  const id = ask(guest, { tool: "cron", permission: "automations", arguments: { action: "add", name: "standup", message: "Say hello", every_seconds: 3600 } });

  await page.goto(`${harness.webUrl}/inbox`);
  const card = page.getByRole("article", { name: "Wants to manage an automation" });
  await expect(card.getByText("every hour")).toBeVisible();
  await card.getByRole("button", { name: "Always allow" }).click();
  const dialog = page.getByRole("dialog", { name: /Always allow .Automations.\?/ });
  await expect(dialog.getByText("Medium risk")).toBeVisible();
  // The tools of this permission, read from the Dot's own computer.
  await expect(dialog.getByRole("list", { name: "Tools covered" }).getByRole("listitem")).toHaveText(["cron"]);
  await expect(dialog.getByText(/automations: allow/)).toBeVisible();
  expect(resolvePermission((await harness.api.getDot(dot.id)).config, "automations")).toBe("ask");

  await dialog.getByRole("button", { name: "Always allow" }).click();
  await expect(card.getByRole("status")).toContainText('The Dot will not ask for "Automations" again.');
  expect(resolvePermission((await harness.api.getDot(dot.id)).config, "automations")).toBe("allow");
  await expect.poll(() => guest.config?.permissions["automations"]).toBe("allow");
  // The guest hears the plain decision.
  await expect.poll(() => answersHeard(guest)).toEqual([{ approval_id: id, decision: "approve" }]);
});

test("Keep asking in that question changes nothing, and Deny sends the note with it", async ({ page, fresh: harness }) => {
  const dot = await harness.createDot("inbox-deny");
  const guest = harness.driver.guestOf(dot.id);
  const id = ask(guest, exec("make deploy"));
  await page.goto(`${harness.webUrl}/inbox`);
  const card = page.getByRole("article", { name: "Wants to run a command" });
  const version = (await harness.api.getDot(dot.id)).config_version;

  await card.getByRole("button", { name: "Always allow" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Keep asking" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Nothing was answered and the Dot's settings were not written.
  expect(await harness.api.listApprovals("pending")).toHaveLength(1);
  expect((await harness.api.getDot(dot.id)).config_version).toBe(version);

  await card.getByRole("button", { name: "Add a note for the Dot" }).click();
  await card.getByLabel("Note for the Dot (optional)").fill("not before the review");
  await card.getByRole("button", { name: "Deny" }).click();
  await expect(card.getByRole("status")).toContainText("Denied");
  await expect(card.getByText("Your note: not before the review")).toBeVisible();
  await expect.poll(() => answersHeard(guest)).toEqual([{ approval_id: id, decision: "reject", note: "not before the review" }]);

  // The History keeps it, with the note, and the filters are in the address.
  await page.getByRole("navigation", { name: "Inbox sections" }).getByRole("link", { name: "History" }).click();
  await expect(page).toHaveURL(/\/inbox\?tab=history$/);
  const row = page.getByRole("table").getByRole("row", { name: /Asked to run a command/ });
  await expect(row.getByText("Answer: Denied")).toBeVisible();
  await expect(row.getByText("Note: not before the review")).toBeVisible();
  await expect(row.getByRole("link", { name: "inbox-deny" })).toBeVisible();

  await page.getByLabel("Permission").selectOption("files.write");
  await expect(page).toHaveURL(/permission=files\.write/);
  await expect(page.getByText("No approval has been answered under these filters.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Permission")).toHaveValue("files.write");
  await page.getByLabel("Permission").selectOption("");
  await expect(page.getByRole("table")).toBeVisible();
});

test("the old addresses lead to the Inbox, a Dot's approvals to the Inbox filtered to that Dot", async ({ page, fresh: harness }) => {
  const kept = await harness.createDot("inbox-kept");
  const other = await harness.createDot("inbox-other");
  ask(harness.driver.guestOf(kept.id), exec("ls"));
  ask(harness.driver.guestOf(other.id), navigate("https://example.com"));

  await page.goto(`${harness.webUrl}/approvals`);
  await expect(page).toHaveURL(`${harness.webUrl}/inbox`);
  await expect(cards(page)).toHaveCount(2);

  await page.goto(`${harness.webUrl}/dots/${kept.id}/approvals`);
  await expect(page).toHaveURL(`${harness.webUrl}/inbox?dot=${kept.id}`);
  await expect(page.getByLabel("Dot", { exact: true })).toHaveValue(kept.id);
  await expect(cards(page)).toHaveCount(1);
  await expect(page.getByRole("article", { name: "Wants to run a command" })).toBeVisible();

  // By name, as the control plane takes it.
  await page.goto(`${harness.webUrl}/inbox?dot=inbox-other`);
  await expect(page.getByLabel("Dot", { exact: true })).toHaveValue(other.id);
  await expect(page.getByRole("article", { name: "Wants to open a page" })).toBeVisible();
  await expect(cards(page)).toHaveCount(1);

  // The Dot's own tab bar no longer has an Approvals tab.
  await page.goto(`${harness.webUrl}/dots/${kept.id}/chat`);
  await expect(page.getByRole("navigation", { name: "Dot sections" }).getByRole("link", { name: /Approvals/ })).toHaveCount(0);
});

test("the Inbox is answered from the keyboard alone: Tab to the list, j and k choose, a allows once, d denies, and a command waits for its confirmation", async ({ page, fresh: harness }) => {
  const dot = await harness.createDot("inbox-keys");
  const guest = harness.driver.guestOf(dot.id);
  const one = ask(guest, navigate("https://example.com/one"));
  const two = ask(guest, navigate("https://example.com/two"));
  const three = ask(guest, exec("make test"));
  await page.goto(`${harness.webUrl}/inbox`);
  await expect(cards(page)).toHaveCount(3);
  const selected = page.locator("article[aria-current=true]");
  await expect(selected).toHaveAttribute("data-approval-id", one);

  // A key typed while the focus is elsewhere on the page answers nothing (WCAG 2.1.4): the keys are the list's.
  await page.keyboard.press("d");
  await page.keyboard.press("a");
  expect(await harness.api.listApprovals("pending")).toHaveLength(3);
  const list = page.getByRole("list", { name: "Approvals waiting for your answer" });
  while (!(await list.evaluate((element) => element === document.activeElement))) await page.keyboard.press("Tab");

  await page.keyboard.press("a");
  await expect(selected.getByRole("status")).toHaveText("Allowed");
  await page.keyboard.press("j");
  await expect(selected).toHaveAttribute("data-approval-id", two);
  await page.keyboard.press("d");
  await expect(selected.getByRole("status")).toContainText("Denied");

  await page.keyboard.press("j");
  await expect(selected).toHaveAttribute("data-approval-id", three);
  await page.keyboard.press("a");
  // A command is not allowed by a key press: the focus is on its Allow once button, and nothing is answered yet.
  await expect(selected.getByRole("button", { name: "Allow once" })).toBeFocused();
  expect(await harness.api.listApprovals("pending")).toHaveLength(1);
  await page.keyboard.press("Enter");
  await expect(selected.getByRole("status")).toHaveText("Allowed");
  expect((await harness.api.listApprovals("approved")).map((x) => x.id).sort()).toEqual([one, three].sort());
  expect((await harness.api.listApprovals("rejected")).map((x) => x.id)).toEqual([two]);
});

test("an approval answered somewhere else while this page was cut off says so, and is not a failure", async ({ page, fresh: harness }) => {
  const dot = await harness.createDot("inbox-race");
  const id = ask(harness.driver.guestOf(dot.id), exec("pwd"));
  await page.goto(`${harness.webUrl}/inbox`);
  const card = page.getByRole("article", { name: "Wants to run a command" });
  await expect(card).toBeVisible();
  // This page stops hearing the stream, as one behind a sleeping laptop does; the CLI answers meanwhile.
  await page.route("**/api/stream", (route) => route.abort());
  await page.reload();
  await expect(card).toBeVisible();
  await harness.api.reject(id);

  await card.getByRole("button", { name: "Allow once" }).click();
  await expect(card.getByRole("status")).toHaveText("Already answered, on another tab or another channel");
  await expect(page.getByRole("alert").filter({ hasText: "not recorded" })).toHaveCount(0);
  expect((await harness.api.listApprovals("rejected")).map((x) => x.id)).toEqual([id]);
});

test("a task's approval is a card on the task, in its drawer too, and answering it lets the task go on", async ({ page, fresh: harness }) => {
  const dot = await harness.createDot("inbox-task");
  const guest = harness.driver.guestOf(dot.id);
  const onInbound = guest.onInbound;
  guest.onInbound = (event, g) => {
    if (event.type !== "task.created") return onInbound(event, g);
    g.emit("agent.state", { state: "THINKING" });
    g.emit("task.started", { task_id: event.data.task_id });
    ask(g, { ...exec("make build"), task_id: event.data.task_id });
  };
  const task = await harness.api.createTask(dot.id, { description: "Build the site" });
  await page.goto(`${harness.webUrl}/dots/${dot.id}/tasks`);
  const taskCard = page.getByRole("article", { name: "Build the site" });
  await expect(taskCard.getByText("Waiting for you").first()).toBeVisible();
  const approval = taskCard.getByRole("article", { name: "Wants to run a command" });
  await expect(approval.getByText("make build", { exact: true })).toBeVisible();
  await expect(approval.getByRole("link", { name: "From a task" })).toHaveAttribute("href", `/dots/${dot.id}/tasks/${task.id}`);

  await approval.getByRole("link", { name: "From a task" }).click();
  const drawer = page.getByRole("dialog", { name: "Build the site" });
  await expect(drawer.getByRole("article", { name: "Wants to run a command" }).getByText("make build", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  await approval.getByRole("button", { name: "Allow once" }).click();
  await expect(approval.getByRole("status")).toHaveText("Allowed");
  await expect.poll(async () => (await harness.api.getTask(task.id)).status).toBe("COMPLETED");
  // The task finished and left Running; the Dot's own history holds the answer.
  await expect(page.getByRole("region", { name: /^History/ }).getByRole("row", { name: /Build the site/ })).toBeVisible();
});

test("a failed task is in the Inbox for a day, opens in its drawer, and leaves for good when dismissed", async ({ page, fresh: harness }) => {
  const dot = await harness.createDot("inbox-failed");
  const guest = harness.driver.guestOf(dot.id);
  const onInbound = guest.onInbound;
  guest.onInbound = (event, g) => {
    if (event.type !== "task.created") return onInbound(event, g);
    g.emit("task.started", { task_id: event.data.task_id });
    g.emit("task.failed", { task_id: event.data.task_id, error: "the SMTP server refused the connection" });
  };
  const task = await harness.api.createTask(dot.id, { description: "Send the digest" });
  await expect.poll(async () => (await harness.api.getTask(task.id)).status).toBe("FAILED");

  await page.goto(`${harness.webUrl}/inbox`);
  const failed = page.getByRole("article", { name: "Failed: Send the digest" });
  await expect(failed.getByText("the SMTP server refused the connection")).toBeVisible();
  await expect(railInbox(page).getByLabel("1 need you")).toBeVisible();
  await failed.getByRole("link", { name: "Open task" }).click();
  await expect(page).toHaveURL(new RegExp(`/dots/${dot.id}/tasks/${task.id}$`));
  await page.keyboard.press("Escape");
  await railInbox(page).click();
  await failed.getByRole("button", { name: /^Dismiss/ }).click();
  await expect(failed).toHaveCount(0);
  await expect(page.getByText("Nothing needs you")).toBeVisible();
  await expect(railInbox(page).getByLabel(/need you/)).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Nothing needs you")).toBeVisible();
});

test("an approval with a long command and a long file fits a phone, and its answers stay in reach", async ({ page, fresh: harness }) => {
  const dot = await harness.createDot("inbox-phone");
  const guest = harness.driver.guestOf(dot.id);
  const content = Array.from({ length: 120 }, (_, i) => `line ${i} of a file that is long enough to need the sideways scroll of its own, ${"x".repeat(80)}`).join("\n");
  ask(guest, { tool: "write_file", permission: "files.write", arguments: { path: "workspace-report-with-a-very-long-name-for-a-phone.md", content } });
  ask(guest, exec(`echo ${"very-long-argument-".repeat(20)}`));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${harness.webUrl}/inbox`);
  await expect(cards(page)).toHaveCount(2);
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);

  // The long card is taller than the screen, and its answers are on the screen anyway.
  const long = page.getByRole("article", { name: "Wants to write a file" });
  await long.scrollIntoViewIfNeeded();
  await expect(long.getByRole("button", { name: "Allow once" })).toBeInViewport();
  await expect(long.getByRole("button", { name: "Deny" })).toBeInViewport();
  await long.getByRole("button", { name: /Show the other/ }).click();
  expect(await overflow()).toBeLessThanOrEqual(0);

  await long.getByRole("button", { name: "Always allow" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
});

for (const scheme of ["light", "dark"] as const) {
  test(`the approval card is readable: answers, diff and receipt keep their contrast (${scheme})`, async ({ page, fresh: harness }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const dot = await harness.createDot(`inbox-look-${scheme}`);
    const guest = harness.driver.guestOf(dot.id);
    ask(guest, { tool: "edit_file", permission: "files.write", arguments: { path: "/etc/motd", old_text: "welcome", new_text: "welcome back" } });
    ask(guest, navigate("https://example.com"));
    await page.goto(`${harness.webUrl}/inbox`);
    await expect(cards(page)).toHaveCount(2);

    // The first is destructive (a file outside the workspace), the second is not.
    const parts: Record<string, string> = {
      "Allow once of a destructive card": "article:has-text('Wants to edit a file') button[data-action=allow]",
      "Allow once of an ordinary card": "article:has-text('Wants to open a page') button[data-action=allow]",
      "Deny": "button[data-action=deny]",
      "Always allow": "button[data-action=always]",
      "an added line": "[data-kind=add]",
      "a removed line": "[data-kind=remove]",
      "the title": "article:has-text('Wants to open a page') [data-slot=approval-card] p",
    };
    for (const [name, selector] of Object.entries(parts)) {
      expect((await lookOf(page, selector)).contrast, name).toBeGreaterThanOrEqual(4.5);
    }
    await page.getByRole("article", { name: "Wants to open a page" }).getByRole("button", { name: "Allow once" }).click();
    await expect(page.getByRole("article", { name: "Wants to open a page" }).getByRole("status")).toBeVisible();
    expect((await lookOf(page, "article:has-text('Wants to open a page') [role=status]")).contrast, "the receipt").toBeGreaterThanOrEqual(4.5);
  });
}
