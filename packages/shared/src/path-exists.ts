import { access } from "node:fs/promises";

/** Whether something is at `path` that this process may see. Node-only. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
