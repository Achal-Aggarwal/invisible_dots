import { describe, expect, it } from "vitest";
import { DEFAULT_WEB_LISTEN, ENV } from "@invisible-dots/shared";
import { EXIT } from "../src/exit.js";
import { runSetupAll, SETUP_ALL_COMMAND, webAddress, type SetupAllDeps } from "../src/setup/all.js";
import type { StepResult } from "../src/setup/build.js";
import type { HostOutcome } from "../src/setup/setup.js";

const DONE: StepResult = { ok: true, lines: ["done"] };

/** A run of `setup --all` against fake steps; `calls` is the order they ran in. */
async function all(overrides: Partial<SetupAllDeps> = {}) {
  let text = "";
  const calls: string[] = [];
  const deps: SetupAllDeps = {
    out: (t) => (text += t),
    agent: async () => (calls.push("agent"), { ok: true, lines: ["built /repo/guest/dot-agentd/bin/dot-agentd"] }),
    host: async () => (calls.push("host"), { ready: true, results: [] } satisfies HostOutcome),
    web: async () => (calls.push("web"), DONE),
    images: async () => (calls.push("images"), EXIT.ok),
    env: {},
    ...overrides,
  };
  const code = await runSetupAll(deps);
  return { code, text, calls };
}

describe("setup --all", () => {
  it("runs the guest daemon, QEMU, the web client and the images in that order, then says how to open the web client", async () => {
    const result = await all();
    expect(result.code).toBe(EXIT.ok);
    expect(result.calls).toEqual(["agent", "host", "web", "images"]);
    expect(result.text).toMatch(/\[1\/4\] the guest daemon[\s\S]*\[2\/4\] QEMU[\s\S]*\[3\/4\] the web client[\s\S]*\[4\/4\] the guest images/);
    expect(result.text).toContain("built /repo/guest/dot-agentd/bin/dot-agentd");
    expect(result.text).toContain("1. start the server and leave it running:   invisible-dots server");
    expect(result.text).toContain(`2. open http://${DEFAULT_WEB_LISTEN} in your browser\n`);
    expect(result.text).not.toMatch(/sign in|api\.token/);
    expect(result.text).toContain("OpenRouter key");
  });

  it("names the address the web client is configured to listen on", async () => {
    expect(webAddress({})).toBe("http://127.0.0.2:3000");
    expect(webAddress({ [ENV.WEB_LISTEN]: " 127.0.0.1:4100 " })).toBe("http://127.0.0.1:4100");
    expect(webAddress({ [ENV.WEB_LISTEN]: "" })).toBe("http://127.0.0.2:3000");
    const result = await all({ env: { [ENV.WEB_LISTEN]: "127.0.0.1:4100" } });
    expect(result.text).toContain("open http://127.0.0.1:4100 in your browser");
  });

  it("stops at a missing Go before it changes anything on the host, and says to run the same command again", async () => {
    const result = await all({ agent: async () => ({ ok: false, lines: ["Go is not installed", "install it with: winget install -e --id GoLang.Go"] }) });
    expect(result.code).toBe(EXIT.failed);
    expect(result.calls).toEqual([]);
    expect(result.text).toContain("  install it with: winget install -e --id GoLang.Go\n");
    expect(result.text).toContain(`run ${SETUP_ALL_COMMAND} again: it skips what is done`);
    expect(result.text).not.toContain("This computer is ready");
  });

  it("stops with exit code 5 where Windows must restart, runs no later step, and says the same command carries on", async () => {
    const result = await all({ host: async () => ({ ready: false, code: EXIT.restart }) });
    expect(result.code).toBe(EXIT.restart);
    expect(result.text).toContain(`Restart the computer now, then run ${SETUP_ALL_COMMAND} again from this folder: it carries on with step 3.`);
    expect(result.text).not.toContain("[3/4]");
    expect(result.text).not.toContain("This computer is ready");
  });

  it("stops where QEMU or the accelerator cannot be made ready (a new login on Linux), keeping setup's own exit code", async () => {
    const result = await all({ host: async () => ({ ready: false, code: EXIT.failed }) });
    expect(result.code).toBe(EXIT.failed);
    expect(result.calls).toEqual(["agent"]);
    expect(result.text).toContain("log out and in again if it says so");
    expect(result.text).toContain(`run ${SETUP_ALL_COMMAND} again`);
  });

  it("adds nothing to setup's refusal to run as root", async () => {
    const result = await all({ host: async () => ({ ready: false, code: EXIT.usage }) });
    expect(result.code).toBe(EXIT.usage);
    expect(result.text).not.toContain("Restart");
    expect(result.text).not.toContain("Stopped");
  });

  it("stops at a web build that failed, before the long image build", async () => {
    const calls: string[] = [];
    const result = await all({
      web: async () => ({ ok: false, lines: ["building the web client failed (exit code 1; its output is above)"] }),
      images: async () => (calls.push("images"), EXIT.ok),
    });
    expect(result.code).toBe(EXIT.failed);
    expect(calls).toEqual([]);
    expect(result.text).toContain("building the web client failed");
  });

  it("reports an image build that failed or threw, and how to continue", async () => {
    const failed = await all({ images: async () => EXIT.failed });
    expect(failed.code).toBe(EXIT.failed);
    expect(failed.text).toContain("image build ended with exit code 1");
    const threw = await all({
      images: async () => {
        throw new Error("the download of the Ubuntu image failed");
      },
    });
    expect(threw.code).toBe(EXIT.failed);
    expect(threw.text).toContain("image build stopped: the download of the Ubuntu image failed");
    expect(threw.text).toContain(`run ${SETUP_ALL_COMMAND} again`);
    expect(threw.text).not.toContain("This computer is ready");
  });

  it("stops between steps once Ctrl-C was pressed", async () => {
    const controller = new AbortController();
    const result = await all({
      signal: controller.signal,
      host: async () => {
        controller.abort();
        return { ready: true, results: [] };
      },
    });
    expect(result.code).toBe(EXIT.failed);
    expect(result.calls).toEqual(["agent"]);
    expect(result.text).toContain("interrupted");
  });
});
