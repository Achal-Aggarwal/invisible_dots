/**
 * The process boundary of the builder: the two calls it makes into the host, in the vm-manager's terms (its
 * CommandRunner's `run` and the process `startProcess` gives). The real runner joins those two (the CLI's host.ts),
 * and tests pass a fake.
 */
import type { CommandResult, StartedProcess } from "@invisible-dots/vm-manager";

export type RunningProcess = StartedProcess;

export interface ProcessRunner {
  /** Runs to completion; rejects unless the command exits 0. Argument arrays only, never a shell. */
  run(command: string, args: readonly string[], options?: { timeoutMs?: number }): Promise<CommandResult>;
  /** `cwd` is the child's working directory: never inherited, see the vm-manager's startProcess. */
  spawn(command: string, args: readonly string[], options: { cwd: string }): RunningProcess;
}

export interface ExitStatus {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export function waitForExit(child: RunningProcess): Promise<ExitStatus> {
  return new Promise((resolve) => child.onExit((code, signal, error) => resolve(error ? { code, signal, error } : { code, signal })));
}
