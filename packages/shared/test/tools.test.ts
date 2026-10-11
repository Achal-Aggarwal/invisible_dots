import { describe, expect, it } from "vitest";
import { isPermission, PERMISSION_INFO, PERMISSIONS } from "../src/index.js";

describe("the permission registry", () => {
  it("names each permission once, as `namespace.name` or a bare word", () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
    for (const permission of PERMISSIONS) expect(permission).toMatch(/^[a-z]+(\.[a-z]+)*$/);
  });

  it("knows exactly the permissions a tool of the Dot can exercise", () => {
    expect([...PERMISSIONS]).toEqual([
      "computer.exec",
      "computer.screenshot",
      "files.read",
      "files.write",
      "browser.identity.list",
      "browser.identity.create",
      "browser.identity.delete",
      "browser.identity.launch",
      "browser.identity.close",
      "browser.navigate",
      "browser.read",
      "browser.act",
      "automations",
      "mcp.servers.add",
    ]);
  });

  it("does not know a name that no tool can ever exercise", () => {
    // Web reading and search and sub-agents are removed from the Dot's engine (architecture section 8.8),
    // a Dot has no tool that messages anyone, and its notes are files written with files.write (section 8.6).
    for (const name of ["web.fetch", "web.search", "subagents", "message.send", "memory.read", "memory.write"]) {
      expect(isPermission(name), name).toBe(false);
    }
    expect(isPermission("computer.exec")).toBe(true);
    expect(isPermission(undefined)).toBe(false);
    expect(isPermission(3)).toBe(false);
  });
});

describe("PERMISSION_INFO", () => {
  it("describes exactly the permissions of the registry, none missing and none extra", () => {
    expect(Object.keys(PERMISSION_INFO).sort()).toEqual([...PERMISSIONS].sort());
  });

  it("gives each one a label, a description and a risk the UI can show", () => {
    const labels = new Set<string>();
    for (const permission of PERMISSIONS) {
      const info = PERMISSION_INFO[permission];
      expect(info.label.trim(), permission).not.toBe("");
      expect(info.description.trim(), permission).not.toBe("");
      expect(["low", "medium", "high"], permission).toContain(info.risk);
      labels.add(info.label);
    }
    expect(labels.size, "labels are distinct").toBe(PERMISSIONS.length);
  });

  it("rates what can change the world or spend the Dot's logins above what only reads", () => {
    expect(PERMISSION_INFO["computer.exec"].risk).toBe("high");
    expect(PERMISSION_INFO["browser.identity.delete"].risk).toBe("high");
    expect(PERMISSION_INFO["browser.act"].risk).toBe("high");
    expect(PERMISSION_INFO["files.read"].risk).toBe("low");
  });
});
