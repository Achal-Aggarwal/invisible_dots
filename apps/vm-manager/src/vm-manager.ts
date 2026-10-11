/**
 * The QEMU driver (architecture sections 3, 9.4, 9.5). What a VM is lives in
 * its directory (disk, seed, pid file) and in the QEMU process; the control
 * plane passes the rest (token, images, resources) on every call that needs
 * it. That is what lets the control plane restart while VMs keep running.
 *
 * There is no monitor: QEMU is seen only as a process (alive or not, and the
 * guest port its user networking listens on), and the guest only through the
 * guest channel (section 5.1). Both work the same way on Linux and Windows,
 * which is why there is nothing else (section 1.1).
 *
 * The one thing kept in memory is the ChildProcess of every QEMU this
 * process spawned: while it is held, its exit is known exactly. After a
 * restart the pid file stands in for it, checked as `processIsOurs` says.
 */
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  allowlistedEnvironment,
  computerResources,
  hostPaths,
  hostRestartedSince,
  hostUptimeSeconds,
  isFatalGuestError,
  pathExists,
  prefixedStderrLogger,
  replaceFile,
  type DotConfig,
  type HostPaths,
  type Logger,
  type VmState,
} from "@invisible-dots/shared";
import {
  AcceleratorUnavailableError,
  CommandError,
  CpuModelError,
  GuestRequestError,
  NotImplementedError,
  VmManagerError,
  VmStartError,
  VmStateError,
} from "./errors.js";
import { GuestClient, waitForGuestHealth, type GuestClientOptions, type WaitForGuestHealthOptions } from "./guest-client.js";
import { accelerator as hostAccelerator, findQemu, type Accelerator, type QemuInstallation } from "./host.js";
import { pickFreePort, portListens } from "./ports.js";
import { readProcessFile, writeProcessFile, type ProcessFile } from "./process-file.js";
import { checkVmResources, CPU_MODEL, qemuArgs, qemuPathArg } from "./qemu-args.js";
import {
  fileSize,
  NodeCommandRunner,
  NodeProcessControl,
  retryWhileInUse,
  type CommandRunner,
  type DetachedProcess,
  type ProcessControl,
  type ProcessExit,
} from "./runner.js";
import { DEFAULT_VIRTUALIZATION_DIR, loadSeedTemplates, renderSeed, writeSeedIso, type PreviousSeed, type SeedTemplates } from "./seed.js";

/** Everything the vm-manager needs to know about one Dot's computer. */
export interface VmSpec {
  dotId: string;
  /** The Dot token, in clear (the control plane decrypts `token_enc`). It goes into the seed. */
  token: string;
  /** The Dot's VM proxy in clear, or absent for a direct exit. It goes into the seed. */
  proxy?: string;
  /** Absolute path of the golden image the overlay is backed by. */
  goldenImage: string;
  /** Absolute path of the runtime ISO attached on every start. */
  runtimeImage: string;
  cpus: number;
  memoryMiB: number;
  /** Size of the overlay at create; resizeDisk grows it later. */
  diskBytes: number;
}

/** Build a VmSpec from a parsed Dot config plus what the control plane stored. */
export function vmSpecFromConfig(
  dotId: string,
  config: Pick<DotConfig, "computer">,
  stored: { token: string; goldenImage: string; runtimeImage: string },
): VmSpec {
  const resources = computerResources(config);
  return { dotId, ...stored, cpus: resources.cpus, memoryMiB: resources.memoryMiB, diskBytes: resources.diskBytes };
}

/** A new Dot token: 32 random bytes, base64url. It only authorizes requests to that Dot's VM. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export interface VmStateInfo {
  /** RUNNING while this Dot's QEMU process runs, STOPPED when it does not, ERROR when a live pid cannot be identified. */
  state: VmState;
  /** The QEMU pid from the pid file, null when no QEMU runs. */
  pid: number | null;
  /** The host port forwarded to dot-agentd, from the pid file; null when no QEMU runs. */
  guestPort: number | null;
  /** Why the state is ERROR, in words. */
  detail?: string;
}

export interface CreateVmResult {
  vmDir: string;
  diskPath: string;
  seedPath: string;
  /** False when the overlay already existed and was kept (a retried create never wipes a disk). */
  diskCreated: boolean;
  /** The cloud-init instance-id written into the seed. */
  instanceId: string;
}

export interface StartVmResult {
  /** QEMU's pid; store it as `computers.pid`. */
  pid: number;
  /** The host port forwarded to dot-agentd; store it as `computers.guest_port`. */
  guestPort: number;
  /** True when QEMU was already running and nothing was started. */
  alreadyRunning: boolean;
}

export interface StopVmResult {
  /** True when the guest did not power off by itself in time and QEMU was killed. */
  forced: boolean;
  /** False when there was no running VM to stop. */
  wasRunning: boolean;
}

export interface ResizeResult {
  /** True when the VM is running and new cpus or memory apply from its next start. */
  restartRequired: boolean;
  /** True when the overlay was grown. */
  diskResized: boolean;
}

export interface VmManagerOptions {
  /** Environment for INVISIBLE_DOTS_HOME and INVISIBLE_DOTS_QEMU_DIR. Default process.env. */
  env?: Record<string, string | undefined>;
  /** Host paths; default `hostPaths(env)`. */
  paths?: HostPaths;
  logger?: Logger;
  /** Where the cloud-init templates live. Default the repository's `virtualization/`. */
  virtualizationDir?: string;
  /** QEMU binaries; default found by `findQemu(env)` on first use. */
  qemu?: QemuInstallation;
  /** The accelerator; default `accelerator()` of this host. */
  accelerator?: Accelerator;
  /** Runs qemu-img. */
  runner?: CommandRunner;
  /** Starts, probes and kills QEMU. */
  processes?: ProcessControl;
  /** Picks the guest port; default a kernel-chosen free port on 127.0.0.1. */
  pickPort?: () => Promise<number>;
  /** How long a stop waits for the guest to power off before QEMU is killed (sections 3.4 and 9.5). Default 60 s. */
  shutdownTimeoutMs?: number;
  /** How long QEMU gets to disappear after it was killed. Default 10 s. */
  killTimeoutMs?: number;
  /** Timeout of the poweroff request itself. Default 10 s. */
  powerOffRequestTimeoutMs?: number;
  /** How long a start waits for QEMU to set up the guest port forward. Default 30 s. */
  startTimeoutMs?: number;
  /**
   * Once the forward is up, QEMU must still be running this much later: it
   * builds the machine (and checks the CPU model) after it sets up networking,
   * so a refused CPU model ends the process just after the port listens.
   * Default 1 s.
   */
  startSettleMs?: number;
  /** Ports tried when QEMU cannot bind the forward (section 3.5). Default 5. */
  maxPortAttempts?: number;
  /** How often liveness is polled while waiting. Default 500 ms. */
  pollIntervalMs?: number;
  /** Timeout of qemu-img commands. Default 5 minutes. */
  qemuImgTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Dot ids become directory names, QEMU `-name` values and parts of hostnames. */
const DOT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function assertDotId(dotId: string): void {
  if (!DOT_ID_PATTERN.test(dotId)) {
    throw new VmManagerError(`invalid dot id "${dotId}": expected lowercase letters, digits, "_" and "-", at most 64 characters`);
  }
}

/** QEMU wrote this when it could not bind the host side of the port forward. */
const PORT_TAKEN = /Could not set up host forwarding rule/i;

/** What QEMU prints when the accelerator itself is unusable, on either host. */
const ACCELERATOR_FAILURES = [
  /Could not access KVM kernel module/i,
  /failed to initialize kvm/i,
  /\/dev\/kvm/i,
  /WHPX: No accelerator found/i,
  /failed to initialize whpx/i,
  /WHPX: Failed to/i,
  /invalid accelerator/i,
  /no accelerator found/i,
  /accelerator .* not (?:found|available|supported)/i,
];

const CPU_MODEL_FAILURES = [/CPU model 'host' requires/i, /unable to find CPU model 'host'/i];

/** How much of the end of a log goes into an error: enough for QEMU's last words and the guest's last boot lines. */
const LOG_TAIL_BYTES = 4 * 1024;

/** seed-instance.json, or undefined for one this code did not write: the next seed then takes the content's own id. */
function parsePreviousSeed(text: string): PreviousSeed | undefined {
  try {
    const value = JSON.parse(text) as Partial<PreviousSeed>;
    if (typeof value.digest === "string" && typeof value.instanceId === "string") return { digest: value.digest, instanceId: value.instanceId };
  } catch {
    // Not JSON: as if there were none.
  }
  return undefined;
}

/** A QEMU this process spawned: its exit is set the moment Node reports it. */
interface OwnedProcess {
  pid: number;
  exited: Promise<ProcessExit>;
  exit?: ProcessExit;
}

interface Probe extends VmStateInfo {
  /** The pid file, when there is one that can be read. */
  record?: ProcessFile;
  /** Whether the live process is proven to be this Dot's QEMU, so it may be killed. */
  verified: boolean;
}

const STOPPED: Probe = { state: "STOPPED", pid: null, guestPort: null, verified: false };

export class VmManager {
  readonly paths: HostPaths;
  private readonly env: Record<string, string | undefined>;
  private readonly logger: Logger;
  private readonly options: VmManagerOptions;
  private readonly runner: CommandRunner;
  private readonly processes: ProcessControl;
  private readonly sleep: (ms: number) => Promise<void>;
  private qemuPromise: Promise<QemuInstallation> | undefined;
  private templates: Promise<SeedTemplates> | undefined;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly owned = new Map<string, OwnedProcess>();

  constructor(options: VmManagerOptions = {}) {
    this.options = options;
    this.env = options.env ?? process.env;
    this.paths = options.paths ?? hostPaths(this.env);
    this.logger = options.logger ?? prefixedStderrLogger("vm-manager");
    this.runner = options.runner ?? new NodeCommandRunner();
    this.processes = options.processes ?? new NodeProcessControl();
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    if (options.qemu) this.qemuPromise = Promise.resolve(options.qemu);
  }

  /** The QEMU binaries this manager runs; throws QemuNotFoundError naming the fix. */
  qemu(): Promise<QemuInstallation> {
    this.qemuPromise ??= findQemu(this.env).catch((error: unknown) => {
      // Not cached: `invisible-dots setup` may install QEMU while the server runs.
      this.qemuPromise = undefined;
      throw error;
    });
    return this.qemuPromise;
  }

  /** The accelerator every VM of this host starts with. */
  get accelerator(): Accelerator {
    return this.options.accelerator ?? hostAccelerator();
  }

  generateToken(): string {
    return generateToken();
  }

  /** A client for every guest route of a running Dot. */
  guestClient(guestPort: number, token: string, options: GuestClientOptions = {}): GuestClient {
    return new GuestClient(guestPort, token, { logger: this.logger, ...options });
  }

  /**
   * Wait until the guest answers `GET /v1/health` (section 9.4). Fails early
   * when QEMU exits meanwhile instead of waiting out the whole timeout. A
   * guest that never comes up is reported with the end of QEMU's log and of
   * the serial console, because a VM that QEMU runs but that never boots
   * (a vCPU the accelerator stopped, a guest stuck in its firmware) shows
   * nothing anywhere else. A refused token (401) is passed on as it is.
   */
  async waitForGuestHealth(dotId: string, guestPort: number, token: string, options: WaitForGuestHealthOptions = {}) {
    assertDotId(dotId);
    const client = this.guestClient(guestPort, token);
    try {
      return await waitForGuestHealth(client, {
        ...options,
        check: async () => {
          await options.check?.();
          if (!(await this.qemuRuns(dotId))) throw new VmStateError(dotId, "QEMU is not running any more");
        },
      });
    } catch (error) {
      if (isFatalGuestError(error) || options.signal?.aborted) throw error;
      throw await this.guestNotUp(dotId, error as Error);
    }
  }

  private async guestNotUp(dotId: string, cause: Error): Promise<VmStartError> {
    const qemuLog = this.paths.qemuLogPath(dotId);
    const serialLog = this.paths.serialLogPath(dotId);
    const [qemuOutput, serialOutput] = await Promise.all([this.readTail(qemuLog), this.readTail(serialLog)]);
    return new VmStartError(dotId, `the guest did not come up (${cause.message}); QEMU's log is ${qemuLog}, the serial console ${serialLog}`, qemuOutput, {
      cause,
      serialOutput,
    });
  }

  private loadTemplates(): Promise<SeedTemplates> {
    this.templates ??= loadSeedTemplates(this.options.virtualizationDir ?? DEFAULT_VIRTUALIZATION_DIR).catch((error: unknown) => {
      this.templates = undefined;
      throw error;
    });
    return this.templates;
  }

  /** Run `fn` with no other operation on the same Dot in flight in this process. */
  private async withLock<T>(dotId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(dotId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.locks.set(dotId, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(dotId) === tail) this.locks.delete(dotId);
    }
  }

  private vmDir(dotId: string): string {
    const dir = resolve(this.paths.vmDir(dotId));
    const rel = relative(resolve(this.paths.vmsDir), dir);
    // Belt and braces next to assertDotId: this directory is removed recursively on destroy.
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new VmManagerError(`refusing VM directory ${dir}: it is not inside ${this.paths.vmsDir}`);
    }
    return dir;
  }

  private validateSpec(spec: VmSpec): void {
    assertDotId(spec.dotId);
    checkVmResources(spec);
    if (!Number.isSafeInteger(spec.diskBytes) || spec.diskBytes <= 0) {
      throw new VmManagerError(`diskBytes must be a positive integer, got ${spec.diskBytes}`);
    }
    if (!spec.token) throw new VmManagerError("the Dot token is empty");
    if (!isAbsolute(spec.goldenImage) || !isAbsolute(spec.runtimeImage)) {
      throw new VmManagerError("goldenImage and runtimeImage must be absolute paths: QEMU runs detached and qemu-img records the backing path");
    }
  }

  /** Both images of the spec exist: a VM is never created or started on a path that leads nowhere. */
  private async assertImages(spec: VmSpec): Promise<void> {
    for (const [label, path] of [
      ["golden image", spec.goldenImage],
      ["runtime ISO", spec.runtimeImage],
    ] as const) {
      if (!(await pathExists(path))) throw new VmManagerError(`${label} ${path} does not exist: build it with "invisible-dots image build" first`);
    }
  }

  private async qemuImg(args: string[]) {
    const { img } = await this.qemu();
    return this.runner.run(img, args, { timeoutMs: this.options.qemuImgTimeoutMs ?? 300_000 });
  }

  private async writeSeed(spec: VmSpec): Promise<string> {
    // The seed written last decides the id of this one (renderSeed): the same content keeps it, any other gets a new one.
    const record = join(this.paths.vmDir(spec.dotId), "seed-instance.json");
    const previous = await readFile(record, "utf8").then(parsePreviousSeed, () => undefined);
    const seed = renderSeed(await this.loadTemplates(), spec.dotId, spec.token, spec.proxy, previous);
    // Replaces a seed.iso a QEMU killed a moment ago may still hold open (Windows).
    await retryWhileInUse(() => writeSeedIso(this.paths.seedPath(spec.dotId), seed));
    const temporary = `${record}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ digest: seed.digest, instanceId: seed.instanceId })}\n`, { mode: 0o600 });
    await replaceFile(temporary, record);
    return seed.instanceId;
  }

  /**
   * Provision a Dot's computer (section 9.4, up to the seed): the overlay
   * backed by the golden image and the NoCloud seed. Safe to call again after
   * a failure: an existing disk is kept and the seed is rewritten.
   */
  async create(spec: VmSpec): Promise<CreateVmResult> {
    this.validateSpec(spec);
    return this.withLock(spec.dotId, async () => {
      await this.assertImages(spec);
      const current = await this.probe(spec.dotId);
      if (current.state !== "STOPPED") {
        throw new VmStateError(spec.dotId, `the VM is ${current.state}; stop it before creating its disk and seed again`);
      }
      const dir = this.vmDir(spec.dotId);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const diskPath = this.paths.diskPath(spec.dotId);
      let diskCreated = false;
      if (await pathExists(diskPath)) {
        this.logger.warn("overlay already exists, keeping it", { dotId: spec.dotId, disk: diskPath });
      } else {
        await this.qemuImg(["create", "-f", "qcow2", "-F", "qcow2", "-b", qemuPathArg("golden image", spec.goldenImage), qemuPathArg("disk", diskPath), String(spec.diskBytes)]);
        diskCreated = true;
      }
      const instanceId = await this.writeSeed(spec);
      this.logger.info("vm created", { dotId: spec.dotId, diskCreated, instanceId });
      return { vmDir: dir, diskPath, seedPath: this.paths.seedPath(spec.dotId), diskCreated, instanceId };
    });
  }

  /** Forget a QEMU that is gone: its pid file, and its ChildProcess if this process held it. */
  private async forget(dotId: string): Promise<void> {
    this.owned.delete(dotId);
    await rm(this.paths.processFilePath(dotId), { force: true });
  }

  /**
   * Whether the QEMU of the pid file still runs. Its exit when this process
   * spawned it; otherwise its pid, unless the host restarted since the file
   * was written. A pid that exists for another user counts as running here,
   * so such a VM is reported ERROR rather than STOPPED and forgotten.
   */
  private runs(dotId: string, record: ProcessFile): boolean {
    const owned = this.owned.get(dotId);
    if (owned && owned.pid === record.pid) return owned.exit === undefined;
    if (hostRestartedSince(record.host_uptime_s)) return false;
    return this.processes.presence(record.pid) !== "gone";
  }

  private async qemuRuns(dotId: string): Promise<boolean> {
    const record = await readProcessFile(this.paths.processFilePath(dotId));
    return record !== undefined && record !== "unreadable" && this.runs(dotId, record);
  }

  /**
   * The rule that decides whether a process may be killed or treated as a
   * Dot's QEMU: either this process spawned it and Node has not reported its
   * exit (Node holds the process, so its pid cannot be recycled meanwhile),
   * or its pid from the pid file is alive and runs as this user (a QEMU this
   * control plane spawned always does; EPERM means another user's process)
   * AND the guest port from the same file accepts connections. QEMU listens
   * there for as long as it runs; a process that got a recycled pid after a
   * crash or a host restart does not listen on that one port. Nothing else
   * is ever killed. A listener is still not trusted with the Dot token: the
   * guest client asks it for its proof first (section 5.1).
   */
  private async processIsOurs(dotId: string, record: ProcessFile): Promise<boolean> {
    const owned = this.owned.get(dotId);
    if (owned && owned.pid === record.pid) return owned.exit === undefined;
    if (hostRestartedSince(record.host_uptime_s)) return false;
    return this.processes.presence(record.pid) === "ours" && (await portListens(record.guest_port));
  }

  /** Read a VM's state from its pid file and its process (section 3.4). */
  private async probe(dotId: string): Promise<Probe> {
    const record = await readProcessFile(this.paths.processFilePath(dotId));
    if (record === undefined) return STOPPED;
    const file = this.paths.processFilePath(dotId);
    if (record === "unreadable") {
      return {
        state: "ERROR",
        pid: null,
        guestPort: null,
        verified: false,
        detail: `${file} is not a pid file this version wrote, so whether a QEMU runs on this disk is unknown; make sure none does, then remove the file`,
      };
    }
    if (!this.runs(dotId, record)) return { ...STOPPED, record };
    if (await this.processIsOurs(dotId, record)) {
      return { state: "RUNNING", pid: record.pid, guestPort: record.guest_port, verified: true, record };
    }
    return {
      state: "ERROR",
      pid: record.pid,
      guestPort: null,
      verified: false,
      record,
      detail:
        `process ${record.pid} from ${file} is alive but nothing listens on its guest port ${record.guest_port}: ` +
        `either the pid now belongs to another process or that QEMU hangs. It is never killed by invisible_dots; ` +
        `check the process, then remove ${file}`,
    };
  }

  /**
   * The VM's state (section 3.4): RUNNING while its QEMU runs, STOPPED when it
   * does not. Whether the guest is up is guest health (section 9.3). This is
   * the reconciliation of section 3.4 too, the one place it happens: a pid
   * file whose process is gone is removed the moment it is read, under the
   * Dot's lock, so a pid recycled later can never make it look alive.
   */
  async state(dotId: string): Promise<VmStateInfo> {
    assertDotId(dotId);
    return this.withLock(dotId, async () => {
      const { verified: _verified, record, ...info } = await this.probe(dotId);
      if (info.state === "STOPPED" && record) {
        this.logger.info("QEMU of the pid file is gone, removing the file", { dotId, pid: record.pid });
        await this.forget(dotId);
      }
      return info;
    });
  }

  /**
   * Start the VM (section 9.4 from "pick a guest port" to "spawn QEMU"). The
   * seed is rewritten from `spec` first, so the token on record is the one
   * the guest sees; cpus, memory and the runtime ISO come from `spec` too, so
   * new values apply on this start. Returns once QEMU listens on the guest
   * port and is still running a moment later; waiting for the guest is
   * `waitForGuestHealth`.
   */
  async start(spec: VmSpec): Promise<StartVmResult> {
    this.validateSpec(spec);
    return this.withLock(spec.dotId, () => this.startLocked(spec));
  }

  private async startLocked(spec: VmSpec): Promise<StartVmResult> {
    const { dotId } = spec;
    const current = await this.probe(dotId);
    if (current.state === "RUNNING" && current.record) {
      return { pid: current.record.pid, guestPort: current.record.guest_port, alreadyRunning: true };
    }
    if (current.state !== "STOPPED") {
      throw new VmStateError(dotId, `cannot start a VM that is ${current.state}${current.detail ? ` (${current.detail})` : ""}; stop or destroy it first`);
    }
    await this.forget(dotId);
    const diskPath = this.paths.diskPath(dotId);
    if (!(await pathExists(diskPath))) throw new VmStateError(dotId, `${diskPath} does not exist; create the VM first`);
    await this.assertImages(spec);
    await this.writeSeed(spec);
    const qemu = await this.qemu();
    const accel = this.accelerator;
    await mkdir(this.paths.logsDir, { recursive: true, mode: 0o700 });
    const logPath = this.paths.qemuLogPath(dotId);
    const attempts = this.options.maxPortAttempts ?? 5;
    const pickPort = this.options.pickPort ?? (() => pickFreePort());

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const guestPort = await pickPort();
      const args = qemuArgs({
        dotId,
        accelerator: accel,
        cpus: spec.cpus,
        memoryMiB: spec.memoryMiB,
        diskPath,
        seedPath: this.paths.seedPath(dotId),
        runtimeIsoPath: spec.runtimeImage,
        guestPort,
        serialLogPath: this.paths.serialLogPath(dotId),
      });
      await appendFile(logPath, `--- ${new Date().toISOString()} start, guest port ${guestPort}\n`, { mode: 0o600 });
      const logOffset = await fileSize(logPath);
      let child: DetachedProcess;
      try {
        child = await this.processes.spawnDetached(qemu.system, args, {
          logPath,
          cwd: this.paths.home,
          env: allowlistedEnvironment(process.env),
        });
      } catch (error) {
        if (error instanceof CommandError && error.notFound) {
          // Installed QEMU went away since it was found: look again next time.
          this.qemuPromise = this.options.qemu ? this.qemuPromise : undefined;
        }
        throw new VmStartError(dotId, `cannot run ${qemu.system}: ${(error as Error).message}`, "", { cause: error });
      }
      const owned: OwnedProcess = { pid: child.pid, exited: child.exited };
      void child.exited.then((exit) => {
        owned.exit = exit;
      });
      this.owned.set(dotId, owned);
      const record: ProcessFile = { pid: child.pid, guest_port: guestPort, host_uptime_s: hostUptimeSeconds() };
      try {
        // Before anything can fail: from here on a restarted control plane finds this QEMU.
        await writeProcessFile(this.paths.processFilePath(dotId), record);
      } catch (error) {
        await this.killOurs(dotId, record);
        await this.forget(dotId);
        throw new VmStartError(dotId, `cannot write the pid file ${this.paths.processFilePath(dotId)}: ${(error as Error).message}`, "", { cause: error });
      }
      this.logger.info("qemu spawned", { dotId, pid: child.pid, guestPort, attempt });

      const outcome = await this.waitForForward(owned, guestPort);
      if (outcome.kind === "exited") {
        const output = await this.readLogFrom(logPath, logOffset);
        await this.forget(dotId);
        if (PORT_TAKEN.test(output) && attempt < attempts) {
          this.logger.warn("guest port taken, trying another", { dotId, guestPort, attempt });
          continue;
        }
        throw this.startFailure(dotId, accel, output, outcome.exit);
      }
      if (outcome.kind === "timeout") {
        await this.killOurs(dotId, record);
        await this.forget(dotId);
        const output = await this.readLogFrom(logPath, logOffset);
        throw new VmStartError(
          dotId,
          `QEMU did not set up its port forward on 127.0.0.1:${guestPort} within ${this.options.startTimeoutMs ?? 30_000} ms and was killed`,
          output,
        );
      }
      this.logger.info("vm started", { dotId, pid: child.pid, guestPort });
      return { pid: child.pid, guestPort, alreadyRunning: false };
    }
    throw new VmStartError(dotId, `QEMU could not bind a guest port in ${attempts} attempts`);
  }

  /**
   * Wait until QEMU listens on the guest port and is still running
   * `startSettleMs` later, until it exits, or until the start timeout. The
   * listening port is the sign QEMU parsed its command line, opened the
   * accelerator and set up networking; the settle catches what fails right
   * after (the CPU model is checked when the machine is built).
   */
  private async waitForForward(owned: OwnedProcess, guestPort: number): Promise<{ kind: "ready" } | { kind: "exited"; exit: ProcessExit } | { kind: "timeout" }> {
    const deadline = Date.now() + (this.options.startTimeoutMs ?? 30_000);
    const interval = this.options.pollIntervalMs ?? 500;
    const exited = async () => {
      // A settled `exited` is seen only after the microtask queue drains.
      await Promise.resolve();
      if (owned.exit === undefined && this.processes.presence(owned.pid) !== "gone") return undefined;
      // Let the exit event deliver the code when it is about to.
      return owned.exit ?? (await Promise.race([owned.exited, this.sleep(interval).then(() => ({ code: null, signal: null }))]));
    };
    for (;;) {
      const exit = await exited();
      if (exit) return { kind: "exited", exit };
      if (await portListens(guestPort)) {
        await this.sleep(this.options.startSettleMs ?? 1000);
        const late = await exited();
        return late ? { kind: "exited", exit: late } : { kind: "ready" };
      }
      if (Date.now() >= deadline) return { kind: "timeout" };
      await this.sleep(interval);
    }
  }

  private startFailure(dotId: string, accel: Accelerator, output: string, exit: ProcessExit): Error {
    if (CPU_MODEL_FAILURES.some((pattern) => pattern.test(output))) return new CpuModelError(accel, CPU_MODEL, output);
    if (ACCELERATOR_FAILURES.some((pattern) => pattern.test(output))) return new AcceleratorUnavailableError(accel, output);
    const how = exit.signal ? `was killed by ${exit.signal}` : exit.code === null ? "exited" : `exited with code ${exit.code}`;
    return new VmStartError(dotId, `QEMU ${how} during start`, output);
  }

  /** What a log gained since `offset`, at most its last 64 KiB: the tail is what explains a failure. */
  private async readLogFrom(path: string, offset: number): Promise<string> {
    return this.readRange(path, offset, 64 * 1024);
  }

  /** The last few KiB of a log, or "" when it does not exist. */
  private readTail(path: string): Promise<string> {
    return this.readRange(path, 0, LOG_TAIL_BYTES);
  }

  private async readRange(path: string, offset: number, maxBytes: number): Promise<string> {
    try {
      const handle = await open(path, "r");
      try {
        const { size } = await handle.stat();
        // A runaway log must not be read whole.
        const start = Math.max(offset, size - maxBytes);
        const buffer = Buffer.alloc(Math.max(0, size - start));
        await handle.read(buffer, 0, buffer.length, start);
        return buffer.toString("utf8");
      } finally {
        await handle.close();
      }
    } catch {
      return "";
    }
  }

  /** Wait until the QEMU of `record` is gone; false when it still runs after `timeoutMs`. */
  private async waitForExit(dotId: string, record: ProcessFile, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const interval = this.options.pollIntervalMs ?? 500;
    for (;;) {
      // A settled `exited` is seen only after the microtask queue drains.
      await Promise.resolve();
      if (!this.runs(dotId, record)) return true;
      if (Date.now() >= deadline) return false;
      await this.sleep(interval);
    }
  }

  /** Kill the QEMU of `record`, only if `processIsOurs` still holds, and wait for it to go. */
  private async killOurs(dotId: string, record: ProcessFile): Promise<void> {
    if (!(await this.processIsOurs(dotId, record))) {
      this.logger.info("QEMU is gone, nothing to kill", { dotId, pid: record.pid });
      return;
    }
    this.logger.warn("killing QEMU", { dotId, pid: record.pid });
    this.processes.kill(record.pid);
    const timeoutMs = this.options.killTimeoutMs ?? 10_000;
    if (!(await this.waitForExit(dotId, record, timeoutMs))) {
      throw new VmStateError(dotId, `QEMU ${record.pid} is still running ${timeoutMs} ms after it was killed`);
    }
  }

  /**
   * Graceful stop (sections 3.4 and 9.5): `POST /v1/system/poweroff` through
   * the guest channel, then wait up to the shutdown timeout for QEMU to exit
   * (the guest powers off and QEMU exits with it), then kill it. A guest
   * that does not accept the poweroff (it is not up, or it refuses the
   * token) cannot power itself off, so its QEMU is killed at once. Callers
   * that want the guest's state flushed first call the agent's prepare-sleep
   * before this.
   */
  async stop(dotId: string, token: string, options: { timeoutMs?: number } = {}): Promise<StopVmResult> {
    assertDotId(dotId);
    return this.withLock(dotId, () => this.stopLocked(dotId, token, options.timeoutMs ?? this.options.shutdownTimeoutMs ?? 60_000));
  }

  private async stopLocked(dotId: string, token: string, timeoutMs: number): Promise<StopVmResult> {
    const current = await this.probe(dotId);
    if (current.state === "STOPPED") {
      await this.forget(dotId);
      return { forced: false, wasRunning: false };
    }
    if (!current.verified || !current.record) {
      throw new VmStateError(dotId, `cannot stop it safely: ${current.detail ?? "its QEMU cannot be identified"}`);
    }
    const record = current.record;
    let accepted = false;
    try {
      await this.guestClient(record.guest_port, token).powerOff(this.options.powerOffRequestTimeoutMs ?? 10_000);
      accepted = true;
    } catch (error) {
      this.logger.warn("the guest did not accept the poweroff, killing QEMU", { dotId, error: (error as Error).message });
    }
    let forced = false;
    if (!accepted || !(await this.waitForExit(dotId, record, timeoutMs))) {
      if (accepted) this.logger.warn("guest did not power off in time, killing QEMU", { dotId, timeoutMs });
      await this.killOurs(dotId, record);
      forced = true;
    }
    await this.forget(dotId);
    this.logger.info("vm stopped", { dotId, forced });
    return { forced, wasRunning: true };
  }

  /**
   * Reboot as a full stop and start, not a reset: a reset skips the guest's
   * shutdown (the agent's SQLite state, browser profiles) and keeps the old
   * QEMU process, so a new runtime ISO or new cpus and memory would not
   * apply. The guest port changes; store the result.
   */
  async reboot(spec: VmSpec, options: { timeoutMs?: number } = {}): Promise<StartVmResult> {
    this.validateSpec(spec);
    return this.withLock(spec.dotId, async () => {
      await this.stopLocked(spec.dotId, spec.token, options.timeoutMs ?? this.options.shutdownTimeoutMs ?? 60_000);
      return this.startLocked(spec);
    });
  }

  /** Remove everything: the running QEMU (killed, no graceful shutdown: the disk goes too) and the VM directory. */
  async destroy(dotId: string): Promise<void> {
    assertDotId(dotId);
    return this.withLock(dotId, async () => {
      const dir = this.vmDir(dotId);
      const current = await this.probe(dotId);
      if (current.state !== "STOPPED") {
        if (!current.verified || !current.record) {
          throw new VmStateError(dotId, `cannot destroy it safely: ${current.detail ?? "its QEMU cannot be identified"}`);
        }
        await this.killOurs(dotId, current.record);
      }
      this.owned.delete(dotId);
      await retryWhileInUse(() => rm(dir, { recursive: true, force: true }));
      await retryWhileInUse(() => rm(this.paths.qemuLogPath(dotId), { force: true }));
      this.logger.info("vm destroyed", { dotId, dir });
    });
  }

  /**
   * Apply new resources. cpus and memory are not stored here: they are part
   * of the VmSpec of every start, so a running VM gets them on its next
   * start. The disk is grown with `qemu-img resize` and only while the VM is
   * stopped; the guest's cloud-init grows the partition on the next boot.
   */
  async resize(spec: VmSpec): Promise<ResizeResult> {
    this.validateSpec(spec);
    return this.withLock(spec.dotId, async () => {
      const current = await this.probe(spec.dotId);
      if (current.state === "STOPPED") {
        const { resized } = await this.resizeDiskLocked(spec.dotId, spec.diskBytes);
        return { restartRequired: false, diskResized: resized };
      }
      const size = await this.diskSize(spec.dotId);
      if (spec.diskBytes !== size) {
        throw new VmStateError(spec.dotId, `the disk can only be resized while the VM is stopped (it is ${current.state})`);
      }
      return { restartRequired: true, diskResized: false };
    });
  }

  /** Grow the overlay; never shrink it, because that destroys the filesystem on it. */
  async resizeDisk(dotId: string, diskBytes: number): Promise<{ resized: boolean; previousBytes: number }> {
    assertDotId(dotId);
    return this.withLock(dotId, async () => {
      const current = await this.probe(dotId);
      if (current.state !== "STOPPED") {
        throw new VmStateError(dotId, `the disk can only be resized while the VM is stopped (it is ${current.state})`);
      }
      return this.resizeDiskLocked(dotId, diskBytes);
    });
  }

  private async diskSize(dotId: string): Promise<number> {
    const disk = this.paths.diskPath(dotId);
    // -U: read the header even if a QEMU holds the image; the size is in the header and never torn.
    const { stdout } = await this.qemuImg(["info", "--output=json", "-U", disk]);
    try {
      const size = Number((JSON.parse(stdout) as { "virtual-size": number })["virtual-size"]);
      if (!Number.isSafeInteger(size)) throw new Error(`virtual-size is ${size}`);
      return size;
    } catch (error) {
      throw new VmManagerError(`cannot read the size of ${disk} from qemu-img info`, { cause: error });
    }
  }

  private async resizeDiskLocked(dotId: string, diskBytes: number): Promise<{ resized: boolean; previousBytes: number }> {
    if (!Number.isSafeInteger(diskBytes) || diskBytes <= 0) {
      throw new VmManagerError(`diskBytes must be a positive integer, got ${diskBytes}`);
    }
    const disk = this.paths.diskPath(dotId);
    const previousBytes = await this.diskSize(dotId);
    if (diskBytes < previousBytes) {
      throw new VmManagerError(`dot ${dotId}: the disk is ${previousBytes} bytes; shrinking it to ${diskBytes} is not supported`);
    }
    if (diskBytes === previousBytes) return { resized: false, previousBytes };
    await this.qemuImg(["resize", "-f", "qcow2", disk, String(diskBytes)]);
    this.logger.info("disk resized", { dotId, previousBytes, diskBytes });
    return { resized: true, previousBytes };
  }

  // Snapshots and rollback are out of scope (architecture section 10).

  createSnapshot(_dotId: string, _name: string): Promise<never> {
    return Promise.reject(new NotImplementedError("VM snapshots"));
  }

  listSnapshots(_dotId: string): Promise<never> {
    return Promise.reject(new NotImplementedError("VM snapshots"));
  }

  restoreSnapshot(_dotId: string, _name: string): Promise<never> {
    return Promise.reject(new NotImplementedError("VM snapshot rollback"));
  }

  deleteSnapshot(_dotId: string, _name: string): Promise<never> {
    return Promise.reject(new NotImplementedError("VM snapshots"));
  }
}
