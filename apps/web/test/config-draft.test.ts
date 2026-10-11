import type { ToolInfo } from "@invisible-dots/shared";
import { describe, expect, it } from "vitest";
import { discard, edit, follow, startDraft } from "../src/lib/config-draft";
import { setField, setPermission } from "../src/lib/config-fields";
import { DECISIONS, permissionGroups } from "../src/lib/permission-table";
import { fullConfig } from "./support/config";

describe("the draft of a config", () => {
  const config = fullConfig();

  it("starts as the host's config, at its version, with nothing rebased", () => {
    expect(startDraft(config, 3)).toEqual({ base: config, version: 3, draft: config, rebased: false });
  });

  it("edits the draft and goes back to the base on discard, keeping the version", () => {
    const edited = edit(startDraft(config, 3), setField(config, "instructions", "mine"));
    expect(edited.draft.instructions).toBe("mine");
    expect(edited.base).toBe(config);
    expect(discard(edited)).toEqual(startDraft(config, 3));
  });

  it("takes the host's newer config as it is when nothing was edited, without saying anything", () => {
    const newer = setField(config, "instructions", "elsewhere");
    expect(follow(startDraft(config, 3), newer, 4)).toEqual(startDraft(newer, 4));
  });

  it("keeps edits that are under way on top of the newer config, and says so", () => {
    const mine = edit(startDraft(config, 3), setPermission(config, "computer.exec", "ask"));
    const newer = setField(config, "instructions", "elsewhere");
    const followed = follow(mine, newer, 4);
    expect(followed.rebased).toBe(true);
    expect(followed.version).toBe(4);
    expect(followed.base).toBe(newer);
    expect(followed.draft.instructions).toBe("elsewhere");
    expect(followed.draft.permissions).toEqual({ "computer.exec": "ask" });
  });

  it("changes nothing for the version it has, or an older one that was slow to arrive", () => {
    const mine = edit(startDraft(config, 3), setField(config, "instructions", "mine"));
    expect(follow(mine, setField(config, "instructions", "x"), 3)).toBe(mine);
    expect(follow(mine, setField(config, "instructions", "x"), 2)).toBe(mine);
  });
});

const TOOLS: ToolInfo[] = [
  { name: "exec", permission: "computer.exec", offered: true, description: "Run a command." },
  { name: "exec_session", permission: "computer.exec", offered: true, description: "Use a session." },
  { name: "read_file", permission: "files.read", offered: false, description: "Read a file." },
];

describe("the permission rows", () => {
  const saved = fullConfig();

  it("are grouped by the first word of the permission, in the order of the permissions", () => {
    const groups = permissionGroups(saved, saved, null);
    expect(groups.map((g) => g.label)).toEqual(["Commands and desktop", "Files", "Browser", "Automations", "MCP servers"]);
    expect(groups.find((g) => g.id === "browser")?.rows.map((r) => r.permission)).toEqual([
      "browser.identity.list",
      "browser.identity.create",
      "browser.identity.delete",
      "browser.identity.launch",
      "browser.identity.close",
      "browser.navigate",
      "browser.read",
      "browser.act",
    ]);
  });

  it("carry the words and risk of each permission, what it is set to and what it is set to by default", () => {
    const rows = permissionGroups(saved, saved, null).flatMap((g) => g.rows);
    const exec = rows.find((r) => r.permission === "computer.exec")!;
    expect(exec).toMatchObject({ label: "Run commands", risk: "high", decision: "allow", defaultDecision: "allow", changed: false });
    const automations = rows.find((r) => r.permission === "automations")!;
    expect(automations).toMatchObject({ decision: "ask", defaultDecision: "ask" });
    for (const row of rows) expect(DECISIONS).toContain(row.decision);
  });

  it("mark a row that differs from the saved config, and only that row", () => {
    const draft = setPermission(saved, "files.write", "deny");
    const changed = permissionGroups(draft, saved, null).flatMap((g) => g.rows).filter((r) => r.changed);
    expect(changed.map((r) => [r.permission, r.decision])).toEqual([["files.write", "deny"]]);
  });

  it("list the tools of each permission from the Dot's own table, with whether the model is offered each", () => {
    const rows = permissionGroups(saved, saved, TOOLS).flatMap((g) => g.rows);
    expect(rows.find((r) => r.permission === "computer.exec")?.tools).toEqual([
      { name: "exec", offered: true },
      { name: "exec_session", offered: true },
    ]);
    expect(rows.find((r) => r.permission === "files.read")?.tools).toEqual([{ name: "read_file", offered: false }]);
    // A permission no tool of the table uses has an empty list, which is not the same as the table being unknown.
    expect(rows.find((r) => r.permission === "browser.act")?.tools).toEqual([]);
  });

  it("have no tool lists at all while the table cannot be read", () => {
    for (const row of permissionGroups(saved, saved, null).flatMap((g) => g.rows)) expect(row.tools).toBeNull();
  });
});
