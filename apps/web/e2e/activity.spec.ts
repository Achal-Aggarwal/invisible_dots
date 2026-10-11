import { readFile } from "node:fs/promises";
import type { OutboundEventDataMap, StoredEvent } from "@invisible-dots/shared";
import { expect, test } from "./fixtures.js";
import { lookOf } from "./look.js";

/** A tool call as the engine reports it once it has ended. */
function called(tool: string, target: string, change: Partial<OutboundEventDataMap["tool.called"]> = {}): OutboundEventDataMap["tool.called"] {
  return { tool, permission: "computer.exec", decision: "allow", ok: true, duration_ms: 40, target, ...change };
}

const PAGE = 200;

test("the Activity tab reads the log as lines, filters by family at the host, follows the Dot live, and the old Timeline address leads to it", async ({ page, harness }) => {
  const dot = await harness.createDot("activity-lines");
  const guest = harness.driver.guestOf(dot.id);
  guest.emit("tool.called", called("exec", "ls -la /home/dot"));
  guest.emit("browser.identity.created", { identity_id: "bi_fares", name: "fares.md" });
  guest.emit("tool.called", called("exec", "rm -rf /", { decision: "deny", ok: false, duration_ms: 0 }));
  await harness.api.sendMessage(dot.id, "hello there");
  await expect.poll(async () => (await harness.api.events(dot.id, { types: ["tool.called", "browser.identity.created"] })).length).toBe(3);

  // The old Timeline address leads here, and the tab is in the bar.
  await page.goto(`${harness.webUrl}/dots/${dot.id}/timeline`);
  await expect(page).toHaveURL(new RegExp(`/dots/${dot.id}/activity$`));
  await expect(page.getByRole("navigation", { name: "Dot sections" }).getByRole("link", { name: "Activity" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("navigation", { name: "Dot sections" }).getByRole("link", { name: "Timeline" })).toHaveCount(0);

  const rows = page.getByRole("list", { name: "Events" }).getByRole("listitem");
  await expect(rows.filter({ hasText: "Ran a command" })).toHaveCount(2);
  const allowed = rows.filter({ hasText: "ls -la /home/dot" });
  await expect(allowed).toContainText("done in 40 ms | exec [computer.exec] allow");
  // The refused call is a warning line (the config refused it; nothing failed), and says it never ran.
  const refused = rows.filter({ hasText: "rm -rf /" });
  await expect(refused).toContainText("denied in 0 ms | exec [computer.exec] deny");
  await expect(refused).toHaveAttribute("data-tone", "warn");
  await expect(rows.filter({ hasText: "You sent a message" })).toContainText("hello there");
  // The engine's own start, in words, not as empty data.
  await expect(rows.filter({ hasText: "The engine started" })).toContainText("The key was sent again");
  // The data under a line is the event as stored.
  await allowed.getByText("Data", { exact: true }).click();
  await expect(allowed.getByLabel(/^Data of event/)).toContainText('"target": "ls -la /home/dot"');

  // A family narrows what the host is asked for.
  const asked: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/dots\/[^/]+\/events\?/.test(request.url())) asked.push(new URL(request.url()).search);
  });
  await page.getByRole("button", { name: "Browser", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("fares.md");
  expect(asked.some((search) => search.includes("browser.identity.created") && search.includes("order=desc"))).toBe(true);

  // Live: an event of the chosen family arrives on top, one of another family does not.
  guest.emit("agent.state", { state: "THINKING" });
  guest.emit("browser.identity.created", { identity_id: "bi_rome", name: "trips/rome.md" });
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("trips/rome.md");
  await expect(page.getByRole("list", { name: "Events" }).getByText("THINKING")).toHaveCount(0);

  // Search the lines read.
  await page.getByRole("button", { name: "All" }).click();
  await page.getByRole("searchbox", { name: "Search the events read so far" }).fill("ROME");
  await expect(rows).toHaveCount(1);
  await page.getByRole("searchbox", { name: "Search the events read so far" }).fill("");
});

test("a long log is read a page at a time from the newest, with nothing skipped or repeated, and the oldest first when asked", async ({ page, harness }) => {
  const dot = await harness.createDot("activity-paging");
  const guest = harness.driver.guestOf(dot.id);
  const total = 2 * PAGE + 30;
  for (let i = 0; i < total; i++) guest.emit("browser.identity.created", { identity_id: `bi_${i}`, name: `note-${String(i).padStart(4, "0")}.md` });
  await expect.poll(async () => (await harness.api.events(dot.id, { types: ["browser.identity.created"], order: "desc", limit: 1 }))[0]?.data.name).toBe(`note-${String(total - 1).padStart(4, "0")}.md`);

  await page.goto(`${harness.webUrl}/dots/${dot.id}/activity`);
  await page.getByRole("button", { name: "Browser", exact: true }).click();
  const rows = page.getByRole("list", { name: "Events" }).getByRole("listitem");
  await expect(rows).toHaveCount(PAGE);
  await expect(rows.first()).toContainText(`note-${String(total - 1).padStart(4, "0")}.md`);
  await page.getByRole("button", { name: "Load older events" }).click();
  await expect(rows).toHaveCount(2 * PAGE);
  await page.getByRole("button", { name: "Load older events" }).click();
  await expect(rows).toHaveCount(total);
  await expect(page.getByText("That is the start of the log.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Load older events" })).toHaveCount(0);
  const keys = await rows.evaluateAll((items) => items.map((item) => /note-(\d+)\.md/.exec(item.textContent ?? "")![1]));
  expect(keys).toEqual(Array.from({ length: total }, (_, i) => String(total - 1 - i).padStart(4, "0")));

  await page.getByRole("switch", { name: "Newest first" }).click();
  await expect(rows.first()).toContainText("note-0000.md");
  await expect(rows.last()).toContainText(`note-${String(total - 1).padStart(4, "0")}.md`);
});

test("the events on screen are saved as JSON Lines, as the host stored them", async ({ page, harness }) => {
  const dot = await harness.createDot("activity-export");
  const guest = harness.driver.guestOf(dot.id);
  guest.emit("browser.identity.created", { identity_id: "bi_a", name: "a.md" });
  guest.emit("browser.identity.created", { identity_id: "bi_b", name: "b.md" });
  await expect.poll(async () => (await harness.api.events(dot.id, { types: ["browser.identity.created"] })).length).toBe(2);
  await page.goto(`${harness.webUrl}/dots/${dot.id}/activity`);
  await page.getByRole("button", { name: "Browser", exact: true }).click();
  await expect(page.getByRole("list", { name: "Events" }).getByRole("listitem")).toHaveCount(2);

  const stored = await harness.api.events(dot.id, { types: ["browser.identity.created"] });
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export 2 events" }).click()]);
  expect(download.suggestedFilename()).toBe(`${dot.id}-events-${stored[0]!.id}-${stored[1]!.id}.jsonl`);
  const text = await readFile((await download.path())!, "utf8");
  expect(text.trimEnd().split("\n").map((line) => JSON.parse(line) as StoredEvent)).toEqual(stored);
});

test("the Activity page is usable from the keyboard alone, and fits a phone", async ({ page, harness }) => {
  const dot = await harness.createDot("activity-keys");
  const guest = harness.driver.guestOf(dot.id);
  guest.emit("tool.called", called("exec", "a very long command ".repeat(20)));
  await expect.poll(async () => (await harness.api.events(dot.id, { types: ["tool.called"] })).length).toBe(1);
  await page.goto(`${harness.webUrl}/dots/${dot.id}/activity`);
  const rows = page.getByRole("list", { name: "Events" }).getByRole("listitem");
  await expect(rows.filter({ hasText: "Ran a command" })).toHaveCount(1);

  // A family is chosen with the keyboard, and the line's data opens with it.
  await page.getByRole("button", { name: "Tools" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Tools" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("switch", { name: "Newest first" }).focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("switch", { name: "Newest first" })).not.toBeChecked();
  const data = rows.first().locator("summary");
  await data.focus();
  await page.keyboard.press("Enter");
  await expect(rows.first().getByLabel(/^Data of event/)).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${harness.webUrl}/dots/${dot.id}/activity`);
  await expect(rows.filter({ hasText: "Ran a command" })).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});

for (const scheme of ["light", "dark"] as const) {
  test(`the Activity page is readable in ${scheme}: the chips, the lines, the notes under them`, async ({ page, harness }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const dot = await harness.createDot(`activity-look-${scheme}`);
    const guest = harness.driver.guestOf(dot.id);
    guest.emit("tool.called", called("exec", "ls"));
    guest.emit("tool.called", called("exec", "rm", { decision: "deny", ok: false }));
    await harness.control.scheduler.sendMessage(dot.id, "from the phone", { channel: "telegram", binding_id: "b", chat_id: "1", external_id: "2" });
    await expect.poll(async () => (await harness.api.events(dot.id, { types: ["tool.called"] })).length).toBe(2);
    await page.goto(`${harness.webUrl}/dots/${dot.id}/activity`);
    await expect(page.getByRole("list", { name: "Events" }).getByRole("listitem").filter({ hasText: "via Telegram" })).toBeVisible();

    const spots: Record<string, string> = {
      "a family that is not chosen": "button[aria-pressed=false]:text-is('Tools')",
      "the family that is chosen": "button[aria-pressed=true]:text-is('All')",
      "the count": "p[role=status]",
      "a line's title": "li[data-testid=activity-row] span.text-sm",
      "a line's detail": "li[data-testid=activity-row] p",
      "a line's type": "li[data-testid=activity-row] code",
      "the time of a line": "li[data-testid=activity-row] time",
      "the channel chip": "li[data-testid=activity-row] [data-slot=badge]",
      "the way to the data": "li[data-testid=activity-row] summary",
    };
    for (const [name, selector] of Object.entries(spots)) {
      expect((await lookOf(page, selector)).contrast, name).toBeGreaterThanOrEqual(4.5);
    }
  });
}
