/**
 * The real ComputerDriver: an adapter over vm-manager's VmManager (QEMU
 * started directly, sections 3.4 and 3.5). It adds the one decision
 * VmManager leaves to its caller, which images a computer uses:
 *
 * - a new computer gets the newest `golden-<version>.qcow2`; its overlay
 *   stays on that golden image for its whole life (a backing file never
 *   changes under a disk);
 * - every start uses the newest `runtime-<version>.iso`, so a new version of
 *   our code reaches a Dot with a restart (section 3.3).
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { type ComputerDriver, type ComputerSpecInput, type ComputerState, type CreatedComputer, type GuestApi, type GuestEndpoint, type StartedComputer, type WaitForHealthOptions } from "@invisible-dots/scheduler";
import { type HealthAnswer, type HostPaths, type ImageKind, imageLabel, imageVersionOf, type Logger, pathExists } from "@invisible-dots/shared";
import { VmManager, type StartVmResult, type VmSpec } from "@invisible-dots/vm-manager";

/** Compare versions such as "2026.10.1" and "2026.9.3" numerically, part by part. */
export function compareVersions(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
}

/** The image of that kind in `dir` with the highest version, as an absolute path. */
export async function latestImage(dir: string, kind: ImageKind): Promise<string> {
  const label = imageLabel(kind);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    throw new Error(`cannot list the images directory ${dir}: ${(error as Error).message}`, { cause: error });
  }
  const candidates = names
    .map((name) => ({ name, version: imageVersionOf(kind, name) }))
    .filter((c): c is { name: string; version: string } => c.version !== undefined)
    .sort((x, y) => compareVersions(x.version, y.version));
  const newest = candidates.at(-1);
  if (!newest) throw new Error(`no ${label} in ${dir}: build one with "invisible-dots image build"`);
  return join(dir, newest.name);
}

export const latestGoldenImage = (imagesDir: string) => latestImage(imagesDir, "golden");
export const latestRuntimeImage = (imagesDir: string) => latestImage(imagesDir, "runtime");

export class VmManagerDriver implements ComputerDriver {
  readonly #vm: VmManager;
  readonly #imagesDir: string;

  constructor(vm: VmManager, options: { imagesDir?: string } = {}) {
    this.#vm = vm;
    this.#imagesDir = options.imagesDir ?? vm.paths.imagesDir;
  }

  latestGolden(): Promise<string> {
    return latestGoldenImage(this.#imagesDir);
  }

  latestRuntime(): Promise<string> {
    return latestRuntimeImage(this.#imagesDir);
  }

  #spec(input: ComputerSpecInput, goldenImage: string, runtimeImage: string): VmSpec {
    return {
      dotId: input.dotId,
      token: input.token,
      ...(input.proxy ? { proxy: input.proxy } : {}),
      goldenImage,
      runtimeImage,
      cpus: input.resources.cpus,
      memoryMiB: input.resources.memoryMiB,
      diskBytes: input.resources.diskBytes,
    };
  }

  #started(result: StartVmResult, runtimeImage: string): StartedComputer {
    return { guestPort: result.guestPort, pid: result.pid, runtimeImage, alreadyRunning: result.alreadyRunning };
  }

  async create(input: ComputerSpecInput): Promise<CreatedComputer> {
    const [golden, runtime] = await Promise.all([this.latestGolden(), this.latestRuntime()]);
    await this.#vm.create(this.#spec(input, golden, runtime));
    return { goldenImage: golden, runtimeImage: runtime };
  }

  async start(input: ComputerSpecInput & { goldenImage: string }): Promise<StartedComputer> {
    const runtime = await this.latestRuntime();
    const spec = this.#spec(input, input.goldenImage, runtime);
    // A bigger computer.disk from a PATCH: the overlay can only grow while the VM is off.
    if ((await this.#vm.state(input.dotId)).state === "STOPPED") await this.#vm.resize(spec);
    return this.#started(await this.#vm.start(spec), runtime);
  }

  waitForHealth(endpoint: GuestEndpoint, token: string, options: WaitForHealthOptions): Promise<HealthAnswer> {
    return this.#vm.waitForGuestHealth(endpoint.dotId, endpoint.port, token, {
      timeoutMs: options.timeoutMs,
      intervalMs: options.intervalMs,
      requestTimeoutMs: options.requestTimeoutMs,
    });
  }

  async stop(dotId: string, token: string): Promise<{ forced: boolean }> {
    const { forced } = await this.#vm.stop(dotId, token);
    return { forced };
  }

  async reboot(input: ComputerSpecInput & { goldenImage: string }): Promise<StartedComputer> {
    const runtime = await this.latestRuntime();
    return this.#started(await this.#vm.reboot(this.#spec(input, input.goldenImage, runtime)), runtime);
  }

  destroy(dotId: string): Promise<void> {
    return this.#vm.destroy(dotId);
  }

  async state(dotId: string): Promise<ComputerState> {
    const [info, exists] = await Promise.all([this.#vm.state(dotId), pathExists(this.#vm.paths.diskPath(dotId))]);
    return {
      exists,
      state: info.state,
      pid: info.pid,
      guestPort: info.guestPort,
      detail: info.detail ?? null,
    };
  }

  guest(endpoint: GuestEndpoint, token: string): GuestApi {
    return this.#vm.guestClient(endpoint.port, token);
  }

  /** VmManager holds no connection between calls, so there is nothing to release. */
  async close(): Promise<void> {}
}


/** The driver `invisible-dots server` uses: VmManager over this host's QEMU and INVISIBLE_DOTS_HOME. */
export function createVmDriver(options: { env: Record<string, string | undefined>; paths: HostPaths; logger: Logger }): VmManagerDriver {
  return new VmManagerDriver(new VmManager({ env: options.env, paths: options.paths, logger: options.logger }));
}
