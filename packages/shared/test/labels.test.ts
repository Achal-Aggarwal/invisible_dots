import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { accountLabel, permissionPhrase, TOOL_LABELS, toolLabel } from "../src/index.js";

/** The tool names of the engine's table: the keys of `TOOL_PERMISSIONS` in nanobot/dots/permissions.py. */
function engineTools(): string[] {
  const source = readFileSync(fileURLToPath(new URL("../../../invisible_engine_dots/nanobot/dots/permissions.py", import.meta.url)), "utf8");
  const table = source.slice(source.indexOf("TOOL_PERMISSIONS: Mapping"));
  const body = table.slice(0, table.indexOf("\n)\n"));
  return [...body.matchAll(/^\s+"([a-z_]+)": ToolEntry\(/gm)].map((match) => match[1]!);
}

describe("the words for the engine's tools", () => {
  it("cover every tool of the engine's table, and name no tool that is not in it", () => {
    const tools = engineTools();
    // If the scan stopped seeing the table, both comparisons below would pass for nothing.
    expect(tools.length).toBeGreaterThan(25);
    expect(Object.keys(TOOL_LABELS).sort()).toEqual([...tools].sort());
  });

  it("say a command that started a terminal session as that, and no other tool for it", () => {
    expect(toolLabel("exec", true)).toEqual({ label: "Started a terminal session", ask: "run a command", family: "command" });
    expect(toolLabel("exec", false).label).toBe("Ran a command");
    expect(toolLabel("read_file", true)).toEqual(toolLabel("read_file"));
    expect(toolLabel("rm_rf", true)).toEqual(toolLabel("rm_rf"));
  });

  it("say what the call did, in a short phrase of its own", () => {
    expect(toolLabel("exec")).toEqual({ label: "Ran a command", ask: "run a command", family: "command" });
    expect(toolLabel("browser_navigate").family).toBe("browser");
    expect(toolLabel("write_file").family).toBe("write");
    for (const [tool, { label }] of Object.entries(TOOL_LABELS)) {
      expect(label, tool).toMatch(/^[A-Z][a-z]/);
      expect(label, tool).not.toMatch(/[._]/);
    }
  });

  it("say what a call would do, in the infinitive, for the question put to the person", () => {
    for (const [tool, { ask }] of Object.entries(TOOL_LABELS)) {
      // Lowercase, as it follows "wants to"; an acronym (MCP) keeps its capitals.
      expect(ask, tool).toMatch(/^[a-z][A-Za-z ]+[a-z]$/);
      expect(ask, tool).not.toMatch(/[._]/);
    }
    expect(toolLabel("browser_identity_delete").ask).toBe("delete a browser identity");
    expect(toolLabel("write_file").ask).toBe("write a file");
  });

  it("keep the name of a tool the table does not know, as the model called it", () => {
    expect(toolLabel("rm_rf")).toEqual({ label: "Called rm_rf", ask: "call rm_rf", family: "other" });
    // Not a lookup on the object's own prototype.
    expect(toolLabel("constructor")).toEqual({ label: "Called constructor", ask: "call constructor", family: "other" });
    expect(toolLabel("toString").family).toBe("other");
  });
});

describe("the words for a permission an approval names", () => {
  it("say its name and how risky it is, an MCP server's included, and keep a name with no words as it is", () => {
    expect(permissionPhrase("computer.exec")).toBe("Run commands (high risk)");
    expect(permissionPhrase("files.read")).toBe("Read files (low risk)");
    expect(permissionPhrase("mcp.time")).toBe("MCP server time (high risk)");
    expect(permissionPhrase("exec.run")).toBe("exec.run");
  });
});

describe("the account of a channel", () => {
  it("is a bot's @name and a number with its plus, and nothing before the channel reports one", () => {
    expect(accountLabel("telegram", "dot_helper_bot")).toBe("@dot_helper_bot");
    expect(accountLabel("whatsapp", "15550001111")).toBe("+15550001111");
    expect(accountLabel("whatsapp", "+15550001111")).toBe("+15550001111");
    expect(accountLabel("telegram", null)).toBeNull();
    expect(accountLabel("whatsapp", "")).toBeNull();
  });
});
