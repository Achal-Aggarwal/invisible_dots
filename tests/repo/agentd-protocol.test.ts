/**
 * The host-to-guest contract of architecture section 5 is written down once, in packages/shared (protocol.ts), and
 * held twice more in the guest: by dot-agentd's Go sources (its routes and its defaults) and by the engine's Python
 * (the sockets and the workspace it reaches when its unit names none). Neither copy imports the TypeScript, so these
 * checks read them and compare: a route or a path changed on one side only fails here, not inside every Dot.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENTD_ROUTES, EXEC_OUTPUT_CAP_BYTES, GUEST_DISPLAY, GUEST_PATHS, GUEST_PORT, GUEST_PROOF_CONTEXT } from "@invisible-dots/shared";
import { describe, expect, it } from "vitest";

const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const read = (path: string) => readFileSync(join(repo, path), "utf8").replace(/\r\n/g, "\n");
const agentd = (file: string) => read(join("guest/dot-agentd/internal/agentd", file));

/** The value of a Go constant: a string literal, a sum of literals and constants of the same sources, or `a << b`. */
function goConstant(sources: string, name: string): string | number {
  const match = new RegExp(`^\\s*(?:const\\s+)?${name}\\s*=\\s*(.+?)\\s*(//.*)?$`, "m").exec(sources);
  if (!match) throw new Error(`no Go constant ${name}`);
  const expression = match[1]!;
  const shift = /^(\d+)\s*<<\s*(\d+)$/.exec(expression);
  if (shift) return Number(shift[1]) * 2 ** Number(shift[2]);
  return expression
    .split("+")
    .map((term) => term.trim())
    .map((term) => (term.startsWith('"') ? (JSON.parse(term) as string) : String(goConstant(sources, term))))
    .join("");
}

/** The value of a top-level Python string constant. */
function pyConstant(source: string, name: string): string | undefined {
  return new RegExp(`^${name} = "([^"]*)"$`, "m").exec(source)?.[1];
}

describe("dot-agentd's Go copy of the protocol", () => {
  const go = ["server.go", "exec.go", "proof.go"].map(agentd).join("\n");

  it("serves exactly the routes of AGENTD_ROUTES, plus the engine's process route on its socket", () => {
    const served = new Set([...go.matchAll(/mux\.Handle(?:Func)?\("(?:[A-Z]+ )?(\/[^"]*)"/g)].map((m) => m[1]!));
    served.delete("/");
    // The agent proxy is registered by its prefix constant, with and without the trailing slash.
    for (const handle of go.matchAll(/mux\.Handle\(agentProxyPrefix(\+"\/")?,/g)) served.add(`${goConstant(go, "agentProxyPrefix")}${handle[1] ? "/" : ""}`);
    expect([...served].sort()).toEqual([...Object.values(AGENTD_ROUTES), `${AGENTD_ROUTES.agent}/`, "/v1/proc"].sort());
  });

  it("listens on GUEST_PORT, caps exec output at EXEC_OUTPUT_CAP_BYTES, and signs the proof with GUEST_PROOF_CONTEXT", () => {
    expect(goConstant(go, "DefaultListenAddr")).toBe(`0.0.0.0:${GUEST_PORT}`);
    expect(goConstant(go, "ExecOutputCap")).toBe(EXEC_OUTPUT_CAP_BYTES);
    expect(goConstant(go, "proofContext")).toBe(GUEST_PROOF_CONTEXT);
  });

  it("defaults to the guest paths and the display of GUEST_PATHS and GUEST_DISPLAY", () => {
    expect(goConstant(go, "DefaultConfigPath")).toBe(GUEST_PATHS.config);
    expect(goConstant(go, "DefaultHome")).toBe(GUEST_PATHS.home);
    expect(goConstant(go, "DefaultRunDir")).toBe(GUEST_PATHS.runDir);
    expect(goConstant(go, "DefaultAgentdSocket")).toBe(GUEST_PATHS.agentdSocket);
    expect(goConstant(go, "DefaultAgentSocket")).toBe(GUEST_PATHS.agentSocket);
    expect(goConstant(go, "DefaultDisplay")).toBe(GUEST_DISPLAY);
  });
});

describe("the engine's defaults", () => {
  const computer = read("invisible_engine_dots/nanobot/dots/computer.py");
  const main = read("invisible_engine_dots/nanobot/dots/main.py");

  it("are the guest paths of GUEST_PATHS", () => {
    expect(pyConstant(computer, "DEFAULT_AGENTD_SOCKET")).toBe(GUEST_PATHS.agentdSocket);
    expect(pyConstant(computer, "DEFAULT_WORKSPACE")).toBe(GUEST_PATHS.workspace);
    expect(pyConstant(computer, "DEFAULT_AGENTD_BIN")).toBe(`${GUEST_PATHS.runtime}/bin/dot-agentd`);
    expect(pyConstant(main, "DEFAULT_AGENT_SOCKET")).toBe(GUEST_PATHS.agentSocket);
  });
});
