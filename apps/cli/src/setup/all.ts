/**
 * `invisible-dots setup --all`: everything the quick start did by hand after `npm ci`, in order, as one command that
 * can be run again. Each step is the code of the command that owns it (the guest daemon and web client builds in
 * build.ts, QEMU and its accelerator in setup.ts, `image build` in host.ts) and skips what is already done, so a run
 * that stopped, for a restart, a new login or a failure, is continued by running the same command again.
 *
 * The one step that needs administrator rights stays one step: it is `setup`'s, which asks once. It comes second,
 * after the quick daemon build that finds a missing Go before anything is changed, and before the long builds, so a
 * restart it asks for costs nothing already done.
 */
import { DEFAULT_WEB_LISTEN, ENV } from "@invisible-dots/shared";
import { EXIT } from "../exit.js";
import type { StepResult } from "./build.js";
import type { HostOutcome } from "./setup.js";

/** The command this prints wherever the person has to come back: the same one, which continues. */
export const SETUP_ALL_COMMAND = "invisible-dots setup --all";

export interface SetupAllDeps {
  out(text: string): void;
  /** Build dot-agentd. */
  agent(): Promise<StepResult>;
  /** Get QEMU and its accelerator ready (`setup`). */
  host(): Promise<HostOutcome>;
  /** Build the web client unless it is built. */
  web(): Promise<StepResult>;
  /** `image build`: the exit code, or a rejection with the reason. */
  images(): Promise<number>;
  env: Record<string, string | undefined>;
  /** Aborted by Ctrl-C. Checked between steps: only `image build` can stop in the middle of one. */
  signal?: AbortSignal;
}

/** The address the web client listens on: the setting, or its default. */
export function webAddress(env: Record<string, string | undefined>): string {
  return `http://${env[ENV.WEB_LISTEN]?.trim() || DEFAULT_WEB_LISTEN}`;
}

const STEPS = 4;

export async function runSetupAll(deps: SetupAllDeps): Promise<number> {
  const { out } = deps;
  const heading = (n: number, text: string) => out(`\n[${n}/${STEPS}] ${text}\n`);
  const interrupted = () => deps.signal?.aborted === true;
  const stopped = (lines: readonly string[]) => {
    for (const line of lines) out(`  ${line}\n`);
    out(`\nStopped. Nothing after this step was run. Once it is fixed, run ${SETUP_ALL_COMMAND} again: it skips what is done.\n`);
    return EXIT.failed;
  };
  out(`${SETUP_ALL_COMMAND}: ${STEPS} steps. Each skips what is already done, so run it again after anything that stops it.\n`);

  heading(1, "the guest daemon dot-agentd (Go builds it)");
  const agent = await deps.agent();
  if (!agent.ok) return stopped(agent.lines);
  for (const line of agent.lines) out(`  ${line}\n`);
  if (interrupted()) return stopped(["interrupted"]);

  heading(2, "QEMU and its accelerator (the `setup` command: it asks for administrator rights once, and only if something is missing)");
  const host = await deps.host();
  if (!host.ready) {
    if (host.code === EXIT.restart) {
      out(`\nRestart the computer now, then run ${SETUP_ALL_COMMAND} again from this folder: it carries on with step 3.\n`);
    } else if (host.code !== EXIT.usage) {
      out(`\nStopped. When what is listed above is done (log out and in again if it says so), run ${SETUP_ALL_COMMAND} again: it skips what is done.\n`);
    }
    return host.code;
  }

  if (interrupted()) return stopped(["interrupted"]);
  heading(3, "the web client");
  const web = await deps.web();
  if (!web.ok) return stopped(web.lines);
  for (const line of web.lines) out(`  ${line}\n`);
  if (interrupted()) return stopped(["interrupted"]);

  heading(4, "the guest images (what `invisible-dots image build` does: the golden image is downloaded when one is published for these inputs)");
  try {
    const code = await deps.images();
    if (code !== EXIT.ok) return stopped([`image build ended with exit code ${code}`]);
  } catch (error) {
    return stopped([`image build stopped: ${(error as Error).message}`]);
  }

  out(`
This computer is ready. To use it:
  1. start the server and leave it running:   invisible-dots server
  2. open ${webAddress(deps.env)} in your browser
  3. the page asks for your OpenRouter key, then lets you create your first Dot.
`);
  return EXIT.ok;
}
