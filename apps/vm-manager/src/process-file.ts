/**
 * The pid file of a Dot's VM (architecture section 3.2): what lets a control plane that restarted find the QEMU it
 * left running. The VmManager decides from it whether that QEMU still runs and may be killed (`processIsOurs`).
 */
import { readFile, writeFile } from "node:fs/promises";
import { replaceFile } from "@invisible-dots/shared";

/**
 * The QEMU process of a Dot, the guest port it forwards, and the host's uptime when it was spawned. A host uptime
 * lower than that one means the host restarted since, so the process is gone whatever now runs under that pid.
 */
export interface ProcessFile {
  pid: number;
  guest_port: number;
  host_uptime_s?: number;
}

export function parseProcessFile(text: string): ProcessFile | undefined {
  try {
    const value = JSON.parse(text) as Partial<ProcessFile>;
    const pid = value.pid;
    const port = value.guest_port;
    if (Number.isSafeInteger(pid) && pid! > 0 && Number.isInteger(port) && port! >= 1 && port! <= 65535) {
      const record: ProcessFile = { pid: pid!, guest_port: port! };
      if (typeof value.host_uptime_s === "number" && Number.isFinite(value.host_uptime_s)) record.host_uptime_s = value.host_uptime_s;
      return record;
    }
  } catch {
    // Falls through: not JSON is as unreadable as JSON of the wrong shape.
  }
  return undefined;
}

/** The pid file at `path`: undefined when there is none, "unreadable" when it is not one this code wrote. */
export async function readProcessFile(path: string): Promise<ProcessFile | "unreadable" | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return parseProcessFile(text) ?? "unreadable";
}

/** Written whole or not at all (a temporary file renamed over it), so a reader never sees half a pid file. */
export async function writeProcessFile(path: string, record: ProcessFile): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await replaceFile(temporary, path);
}
