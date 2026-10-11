import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { hostPaths, type HostPaths, silentLogger } from "@invisible-dots/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AcceleratorUnavailableError,
  CpuModelError,
  GuestRequestError,
  NotImplementedError,
  pickFreePort,
  QemuNotFoundError,
  VmManager,
  VmManagerError,
  VmStartError,
  VmStateError,
  generateToken,
  qemuArgs,
  vmSpecFromConfig,
  type VmManagerOptions,
  type VmSpec,
} from "../src/index.js";
import { FakeQemuHost, FakeRunner, argAfter, guestPortOf } from "./fakes.js";

const DOT = "dot_01k6h3w2ze8m4qv7r1xk9bntc5";
const QEMU = { system: "/opt/qemu/bin/qemu-system-x86_64", img: "/opt/qemu/bin/qemu-img" };

let root: string;
let paths: HostPaths;
let runner: FakeRunner;
let host: FakeQemuHost;
let manager: VmManager;
let spec: VmSpec;
let diskSize: number;

function makeManager(extra: Partial<VmManagerOptions> = {}): VmManager {
  return new VmManager({
    paths,
    logger: silentLogger,
    qemu: QEMU,
    accelerator: "kvm",
    runner,
    processes: host,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 2))),
    pollIntervalMs: 1,
    startSettleMs: 1,
    // Generous: a guest that powers off must never be mistaken for one that does
    // not on a loaded host. The tests of the forced kill pass their own short timeoutMs.
    shutdownTimeoutMs: 5_000,
    killTimeoutMs: 40,
    startTimeoutMs: 200,
    ...extra,
  });
}

async function processFile(dotId = DOT): Promise<{ pid: number; guest_port: number }> {
  return JSON.parse(await readFile(paths.processFilePath(dotId), "utf8")) as { pid: number; guest_port: number };
}

/** A port nothing listens on: bound once by the kernel's choice, then released. */
const deadPort = () => pickFreePort();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "idots-vm-"));
  paths = hostPaths({ INVISIBLE_DOTS_HOME: root });
  await mkdir(paths.imagesDir, { recursive: true });
  const golden = paths.goldenImagePath("1");
  const runtime = paths.runtimeIsoPath("1");
  await writeFile(golden, "golden");
  await writeFile(runtime, "runtime");
  diskSize = 40 * 1024 ** 3;
  runner = new FakeRunner(async (command, args) => {
    expect(command).toBe(QEMU.img);
    if (args[0] === "create") await writeFile(args.at(-2)!, "qcow2");
    if (args[0] === "info") return { stdout: JSON.stringify({ "virtual-size": diskSize, format: "qcow2" }), stderr: "" };
    if (args[0] === "resize") diskSize = Number(args.at(-1));
    return undefined;
  });
  host = new FakeQemuHost();
  manager = makeManager();
  spec = { dotId: DOT, token: "tok-1", goldenImage: golden, runtimeImage: runtime, cpus: 2, memoryMiB: 4096, diskBytes: diskSize };
});

afterEach(async () => {
  for (const vm of [...host.vms.values()]) host.terminate(vm);
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

describe("create", () => {
  it("creates the overlay on the golden image and writes the seed", async () => {
    const result = await manager.create(spec);
    expect(result.diskCreated).toBe(true);
    expect(runner.lines()).toEqual([
      `${QEMU.img} create -f qcow2 -F qcow2 -b ${spec.goldenImage} ${paths.diskPath(DOT)} ${spec.diskBytes}`,
    ]);
    const seed = await readFile(paths.seedPath(DOT));
    // The primary volume descriptor at sector 16 carries the label cloud-init looks for.
    expect(seed.subarray(16 * 2048 + 40, 16 * 2048 + 46).toString("latin1")).toBe("cidata");
    expect(seed.includes(Buffer.from("tok-1"))).toBe(true);
    expect(result.instanceId).toMatch(new RegExp(`^iid-${DOT}-[0-9a-f]{16}$`));
  });

  it("keeps an existing disk and the instance-id when nothing changed", async () => {
    const first = await manager.create(spec);
    const second = await manager.create(spec);
    expect(second.diskCreated).toBe(false);
    expect(runner.lines().filter((line) => line.includes(" create "))).toHaveLength(1);
    expect(second.instanceId).toBe(first.instanceId);
    const third = await manager.create({ ...spec, token: "tok-2" });
    expect(third.instanceId).not.toBe(first.instanceId);
  });

  it("gives a seed that goes back to an earlier content an id cloud-init has not seen, so its config.json is written again", async () => {
    // A VM proxy set and then cleared: the third seed has the first one's content. With the content's id alone it
    // got the first boot's id again, cloud-init skipped write_files, and the Dot kept the proxy it no longer had.
    const ids = [];
    for (const proxy of [undefined, "socks5://10.0.2.2:1081", undefined, "socks5://10.0.2.2:1081", undefined]) {
      ids.push((await manager.create({ ...spec, ...(proxy ? { proxy } : {}) })).instanceId);
    }
    expect(new Set(ids).size).toBe(ids.length);
    // The same seed again is still the same id: a restart re-runs nothing.
    expect((await manager.create(spec)).instanceId).toBe(ids[4]);
  });

  it("refuses missing images, bad ids and relative image paths", async () => {
    await expect(manager.create({ ...spec, goldenImage: join(root, "nope.qcow2") })).rejects.toThrow(/golden image .* does not exist.*image build/);
    await expect(manager.create({ ...spec, dotId: "../etc" })).rejects.toBeInstanceOf(VmManagerError);
    await expect(manager.create({ ...spec, runtimeImage: "runtime.iso" })).rejects.toThrow(/absolute/);
    await expect(manager.create({ ...spec, cpus: 0 })).rejects.toThrow(/cpus/);
  });

  it("refuses to rewrite the seed of a running VM", async () => {
    await manager.create(spec);
    await manager.start(spec);
    await expect(manager.create(spec)).rejects.toBeInstanceOf(VmStateError);
  });
});

describe("start", () => {
  beforeEach(async () => {
    await manager.create(spec);
  });

  it("spawns QEMU with the argv of section 3.4, records pid and port, and reports them", async () => {
    const started = await manager.start(spec);
    expect(host.spawned).toHaveLength(1);
    const { command, args, logPath } = host.spawned[0]!;
    expect(command).toBe(QEMU.system);
    expect(args).toEqual(
      qemuArgs({
        dotId: DOT,
        accelerator: "kvm",
        cpus: 2,
        memoryMiB: 4096,
        diskPath: paths.diskPath(DOT),
        seedPath: paths.seedPath(DOT),
        runtimeIsoPath: spec.runtimeImage,
        guestPort: started.guestPort,
        serialLogPath: paths.serialLogPath(DOT),
      }),
    );
    expect(logPath).toBe(join(paths.logsDir, `qemu-${DOT}.log`));
    expect(started).toEqual({ pid: host.only().pid, guestPort: host.only().guestPort, alreadyRunning: false });
    expect(await processFile()).toEqual({ pid: started.pid, guest_port: started.guestPort, host_uptime_s: expect.any(Number) });
    expect(await manager.state(DOT)).toEqual({ state: "RUNNING", pid: started.pid, guestPort: started.guestPort });
  });

  it("does nothing when the VM already runs", async () => {
    const first = await manager.start(spec);
    const second = await manager.start(spec);
    expect(second).toEqual({ pid: first.pid, guestPort: first.guestPort, alreadyRunning: true });
    expect(host.spawned).toHaveLength(1);
  });

  it("takes the new cpus, memory and runtime ISO from the spec", async () => {
    const runtime2 = paths.runtimeIsoPath("2");
    await writeFile(runtime2, "runtime 2");
    await manager.start({ ...spec, cpus: 4, memoryMiB: 8192, runtimeImage: runtime2 });
    const args = host.spawned[0]!.args;
    expect(argAfter(args, "-smp")).toBe("4");
    expect(argAfter(args, "-m")).toBe("8192");
    expect(args).toContain(`if=virtio,file=${runtime2},format=raw,readonly=on`);
  });

  it("retries with another port when QEMU cannot bind the forward", async () => {
    host.behaviour = (_args, attempt) =>
      attempt === 1 ? { kind: "exit", code: 1, output: "qemu: -netdev user,id=net0: Could not set up host forwarding rule 'tcp:127.0.0.1:1-:1024'\n" } : { kind: "run" };
    const started = await manager.start(spec);
    expect(host.spawned).toHaveLength(2);
    expect(started.guestPort).toBe(guestPortOf(host.spawned[1]!.args));
    expect(await processFile()).toEqual({ pid: started.pid, guest_port: started.guestPort, host_uptime_s: expect.any(Number) });
  });

  it("gives up after the configured number of taken ports, leaving no pid file", async () => {
    host.behaviour = () => ({ kind: "exit", code: 1, output: "Could not set up host forwarding rule 'x'\n" });
    const manager3 = makeManager({ maxPortAttempts: 3 });
    await expect(manager3.start(spec)).rejects.toBeInstanceOf(VmStartError);
    expect(host.spawned).toHaveLength(3);
    expect(existsSync(paths.processFilePath(DOT))).toBe(false);
  });

  it("names setup and doctor when the accelerator is unusable", async () => {
    host.behaviour = () => ({ kind: "exit", code: 1, output: "Could not access KVM kernel module: No such file or directory\nqemu-system-x86_64: -accel kvm: failed to initialize kvm: No such file or directory\n" });
    const error = await manager.start(spec).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AcceleratorUnavailableError);
    expect((error as Error).message).toContain("invisible-dots setup");
    expect((error as Error).message).toContain("invisible-dots doctor");
    expect((error as Error).message).toContain("never falls back to software emulation");
    expect(existsSync(paths.processFilePath(DOT))).toBe(false);
  });

  it("reports the CPU model refused even when QEMU set up its forward first, without trying another model", async () => {
    host.behaviour = () => ({ kind: "exitAfterForward", code: 1, output: "qemu-system-x86_64: CPU model 'host' requires KVM or HVF\n" });
    const settling = makeManager({ startSettleMs: 100, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) });
    const error = await settling.start(spec).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CpuModelError);
    expect((error as Error).message).toContain('"-cpu host,-vmx,-svm"');
    expect(host.spawned).toHaveLength(1);
    expect((await settling.state(DOT)).state).toBe("STOPPED");
  });

  it("kills a QEMU that never sets up its port forward, and says so", async () => {
    host.behaviour = () => ({ kind: "hang" });
    const error = (await manager.start(spec).catch((e: unknown) => e)) as VmStartError;
    expect(error).toBeInstanceOf(VmStartError);
    expect(error.message).toMatch(/did not set up its port forward .* and was killed/);
    expect(host.killed).toHaveLength(1);
    expect(host.alive.size).toBe(0);
    expect(existsSync(paths.processFilePath(DOT))).toBe(false);
  });

  it("includes what QEMU wrote during this start only", async () => {
    await mkdir(paths.logsDir, { recursive: true });
    await writeFile(join(paths.logsDir, `qemu-${DOT}.log`), "old run noise\n");
    host.behaviour = () => ({ kind: "exit", code: 1, output: "qemu-system-x86_64: -drive if=virtio: Could not open 'x': Permission denied\n" });
    const error = (await manager.start(spec).catch((e: unknown) => e)) as VmStartError;
    expect(error).toBeInstanceOf(VmStartError);
    expect(error.qemuOutput).toContain("Permission denied");
    expect(error.qemuOutput).not.toContain("old run noise");
    expect(error.message).toContain("exited with code 1");
  });

  it("refuses to start before create", async () => {
    await expect(manager.start({ ...spec, dotId: "dot_other" })).rejects.toThrow(/create the VM first/);
  });

  it("fails clearly when QEMU is not installed", async () => {
    const empty = join(root, "no-qemu");
    await mkdir(empty);
    const bare = makeManager({ qemu: undefined, env: { INVISIBLE_DOTS_QEMU_DIR: empty } });
    const error = await bare.start(spec).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QemuNotFoundError);
    expect((error as Error).message).toContain("invisible-dots setup");
  });

  it("starts over a pid file whose process is gone", async () => {
    await writeFile(paths.processFilePath(DOT), JSON.stringify({ pid: 999999, guest_port: await deadPort() }));
    expect((await manager.state(DOT)).state).toBe("STOPPED");
    const started = await manager.start(spec);
    expect(started.alreadyRunning).toBe(false);
  });

  it("never kills or starts over a live pid whose guest port does not listen: it may be another program", async () => {
    await writeFile(paths.processFilePath(DOT), JSON.stringify({ pid: 777, guest_port: await deadPort() }));
    host.foreignPids.add(777);
    const state = await manager.state(DOT);
    expect(state.state).toBe("ERROR");
    expect(state.detail).toContain("the pid now belongs to another process");
    await expect(manager.start(spec)).rejects.toBeInstanceOf(VmStateError);
    await expect(manager.stop(DOT, spec.token)).rejects.toThrow(/cannot stop it safely/);
    await expect(manager.destroy(DOT)).rejects.toThrow(/cannot destroy it safely/);
    expect(host.killed).toEqual([]);
  });

  it("never takes another user's process for this Dot's QEMU, even when the recorded port listens", async () => {
    const listener: Server = createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = (listener.address() as { port: number }).port;
    try {
      await writeFile(paths.processFilePath(DOT), JSON.stringify({ pid: 780, guest_port: port }));
      host.otherUserPids.add(780);
      const state = await manager.state(DOT);
      // Not ours, and not gone either: reported, never killed, never adopted.
      expect(state.state).toBe("ERROR");
      await expect(manager.stop(DOT, spec.token)).rejects.toThrow(/cannot stop it safely/);
      expect(host.killed).toEqual([]);
    } finally {
      listener.close();
    }
  });

  it("accepts a live pid whose recorded guest port listens as this Dot's QEMU", async () => {
    // A restarted control plane holds no ChildProcess: pid and port from the pid file prove it.
    const listener: Server = createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = (listener.address() as { port: number }).port;
    try {
      await writeFile(paths.processFilePath(DOT), JSON.stringify({ pid: 778, guest_port: port }));
      host.foreignPids.add(778);
      expect(await manager.state(DOT)).toEqual({ state: "RUNNING", pid: 778, guestPort: port });
    } finally {
      listener.close();
    }
  });

  it("treats a pid file it cannot read as unknown, never as stopped", async () => {
    await writeFile(paths.processFilePath(DOT), "12345\n");
    const state = await manager.state(DOT);
    expect(state.state).toBe("ERROR");
    expect(state.detail).toContain("is not a pid file this version wrote");
    await expect(manager.start(spec)).rejects.toBeInstanceOf(VmStateError);
  });
});

describe("stop, reboot, destroy", () => {
  beforeEach(async () => {
    await manager.create(spec);
  });

  it("asks the guest to power off through the guest channel and waits for QEMU to exit", async () => {
    await manager.start(spec);
    const vm = host.only();
    const result = await manager.stop(DOT, spec.token);
    expect(result).toEqual({ forced: false, wasRunning: true });
    expect(vm.requests.map((r) => r.replace(/\?nonce=[0-9a-f]+$/, ""))).toEqual(["GET /v1/proof", "POST /v1/system/poweroff"]);
    expect(host.killed).toEqual([]);
    expect(existsSync(paths.processFilePath(DOT))).toBe(false);
    expect((await manager.state(DOT)).state).toBe("STOPPED");
  });

  it("kills QEMU when the guest accepts the poweroff but does not power off in time", async () => {
    host.behaviour = () => ({ kind: "run", ignorePoweroff: true });
    const started = await manager.start(spec);
    const result = await manager.stop(DOT, spec.token, { timeoutMs: 20 });
    expect(result).toEqual({ forced: true, wasRunning: true });
    expect(host.killed).toEqual([started.pid]);
  });

  it("kills QEMU at once when the guest is not up to take the poweroff", async () => {
    host.behaviour = () => ({ kind: "run", guestUp: false });
    const started = await manager.start(spec);
    const result = await makeManager({ shutdownTimeoutMs: 60_000 }).stop(DOT, spec.token);
    expect(result.forced).toBe(true);
    expect(host.killed).toEqual([started.pid]);
  });

  it("kills a QEMU found after a restart only once its pid and port prove it is the Dot's", async () => {
    host.behaviour = () => ({ kind: "run", ignorePoweroff: true });
    const started = await manager.start(spec);
    const restarted = makeManager();
    expect(await restarted.stop(DOT, spec.token, { timeoutMs: 10 })).toEqual({ forced: true, wasRunning: true });
    expect(host.killed).toEqual([started.pid]);
  });

  it("is a no-op on a stopped VM", async () => {
    expect(await manager.stop(DOT, spec.token)).toEqual({ forced: false, wasRunning: false });
  });

  it("reboots as stop then start, on a new process and port", async () => {
    const first = await manager.start(spec);
    const second = await manager.reboot(spec);
    expect(second.alreadyRunning).toBe(false);
    expect(second.pid).not.toBe(first.pid);
    expect(host.spawned).toHaveLength(2);
    expect(await processFile()).toEqual({ pid: second.pid, guest_port: second.guestPort, host_uptime_s: expect.any(Number) });
  });

  it("destroys a running VM, its directory and its log", async () => {
    await manager.start(spec);
    await manager.destroy(DOT);
    expect(host.alive.size).toBe(0);
    expect(existsSync(paths.vmDir(DOT))).toBe(false);
    expect(existsSync(join(paths.logsDir, `qemu-${DOT}.log`))).toBe(false);
  });

  it("spawns QEMU in the data directory with an allowlisted environment, never the server's secrets", async () => {
    process.env.INVISIBLE_DOTS_TOKEN = "server-api-token-must-not-leak";
    process.env.DATABASE_URL = "postgres://user:secret@db/idots";
    try {
      await manager.start(spec);
    } finally {
      delete process.env.INVISIBLE_DOTS_TOKEN;
      delete process.env.DATABASE_URL;
    }
    const spawned = host.spawned.at(-1)!;
    expect(spawned.cwd).toBe(paths.home);
    expect(Object.keys(spawned.env)).not.toContain("INVISIBLE_DOTS_TOKEN");
    expect(Object.keys(spawned.env)).not.toContain("DATABASE_URL");
    expect(Object.keys(spawned.env).map((k) => k.toUpperCase())).toContain("PATH");
  });

  it("serializes operations on the same Dot", async () => {
    const [a, b] = await Promise.all([manager.start(spec), manager.start(spec)]);
    expect(host.spawned).toHaveLength(1);
    expect([a.alreadyRunning, b.alreadyRunning].sort()).toEqual([false, true]);
  });
});

describe("reconciliation after a control plane restart", () => {
  it("a new manager finds a running VM by its pid file, and state() removes the pid file of one that is gone", async () => {
    await manager.create(spec);
    const started = await manager.start(spec);
    const deadId = "dot_dead";
    await mkdir(paths.vmDir(deadId), { recursive: true });
    await writeFile(paths.processFilePath(deadId), JSON.stringify({ pid: 999998, guest_port: await deadPort() }));

    const restarted = makeManager();
    expect(await restarted.state(DOT)).toEqual({ state: "RUNNING", pid: started.pid, guestPort: started.guestPort });
    expect(await restarted.state(deadId)).toEqual({ state: "STOPPED", pid: null, guestPort: null });
    // Removed at once: a pid recycled later can never make it look alive again.
    expect(existsSync(paths.processFilePath(deadId))).toBe(false);
    host.foreignPids.add(999998);
    expect((await restarted.state(deadId)).state).toBe("STOPPED");
  });

  it("a pid file from before a host restart is stopped, whatever runs under its pid now", async () => {
    const listener: Server = createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = (listener.address() as { port: number }).port;
    try {
      await mkdir(paths.vmDir(DOT), { recursive: true });
      // Written when the host had been up a year longer than it has now.
      await writeFile(paths.processFilePath(DOT), JSON.stringify({ pid: 779, guest_port: port, host_uptime_s: 365 * 86_400 + uptime() }));
      host.foreignPids.add(779);
      expect((await manager.state(DOT)).state).toBe("STOPPED");
      expect(existsSync(paths.processFilePath(DOT))).toBe(false);
      expect(host.killed).toEqual([]);
    } finally {
      listener.close();
    }
  });
});

describe("resize", () => {
  beforeEach(async () => {
    await manager.create(spec);
  });

  it("grows the disk of a stopped VM and never shrinks it", async () => {
    const bigger = diskSize + 1024 ** 3;
    expect(await manager.resizeDisk(DOT, bigger)).toEqual({ resized: true, previousBytes: 40 * 1024 ** 3 });
    expect(runner.lines().at(-1)).toBe(`${QEMU.img} resize -f qcow2 ${paths.diskPath(DOT)} ${bigger}`);
    expect(await manager.resizeDisk(DOT, bigger)).toEqual({ resized: false, previousBytes: bigger });
    await expect(manager.resizeDisk(DOT, 1024)).rejects.toThrow(/shrinking/);
  });

  it("leaves cpus and memory to the next start of a running VM, and refuses its disk", async () => {
    await manager.start(spec);
    expect(await manager.resize({ ...spec, cpus: 8 })).toEqual({ restartRequired: true, diskResized: false });
    await expect(manager.resize({ ...spec, diskBytes: spec.diskBytes * 2 })).rejects.toBeInstanceOf(VmStateError);
    await expect(manager.resizeDisk(DOT, spec.diskBytes * 2)).rejects.toThrow(/while the VM is stopped/);
  });

  it("grows the disk through resize when stopped", async () => {
    expect(await manager.resize({ ...spec, diskBytes: spec.diskBytes * 2 })).toEqual({ restartRequired: false, diskResized: true });
  });
});

describe("guest health through the manager", () => {
  beforeEach(async () => {
    await manager.create(spec);
  });

  it("answers once the guest is up", async () => {
    const started = await manager.start(spec);
    expect(await manager.waitForGuestHealth(DOT, started.guestPort, spec.token, { intervalMs: 1, timeoutMs: 2_000 })).toMatchObject({ agentd: "ok" });
  });

  it("stops waiting when QEMU exits, with the end of both logs", async () => {
    host.behaviour = () => ({ kind: "run", guestUp: false, qemuOutput: "qemu: last words\n" });
    const started = await manager.start(spec);
    host.terminate(host.only());
    const error = (await manager.waitForGuestHealth(DOT, started.guestPort, spec.token, { intervalMs: 1, timeoutMs: 1000 }).catch((e: unknown) => e)) as VmStartError;
    expect(error).toBeInstanceOf(VmStartError);
    expect(error.message).toMatch(/QEMU is not running any more/);
    expect(error.qemuOutput).toContain("qemu: last words");
  });

  it("reports a QEMU that runs but never brings the guest up with its log and the serial console", async () => {
    // What a paused vCPU looks like from outside: QEMU alive, its forward up, nothing behind it.
    host.behaviour = () => ({ kind: "run", guestUp: false, qemuOutput: "WHPX: Unexpected VP exit code 4\n", serial: "SeaBIOS (version 1.16.3)\nBooting from Hard Disk...\n" });
    const started = await manager.start(spec);
    const error = (await manager.waitForGuestHealth(DOT, started.guestPort, spec.token, { intervalMs: 1, timeoutMs: 50, requestTimeoutMs: 20 }).catch((e: unknown) => e)) as VmStartError;
    expect(error).toBeInstanceOf(VmStartError);
    expect(error.message).toContain("the guest did not come up");
    expect(error.message).toContain(paths.qemuLogPath(DOT));
    expect(error.message).toContain(paths.serialLogPath(DOT));
    expect(error.qemuOutput).toContain("WHPX: Unexpected VP exit code 4");
    expect(error.serialOutput).toContain("Booting from Hard Disk");
    expect(error.message).toContain("The serial console ends with: SeaBIOS");
  });

  it("passes a guest that cannot prove it holds the token on as it is, at once", async () => {
    const started = await manager.start(spec);
    await expect(manager.waitForGuestHealth(DOT, started.guestPort, "wrong-token", { intervalMs: 1, timeoutMs: 1000 })).rejects.toSatisfy(
      (error: unknown) => error instanceof GuestRequestError && error.code === "guest_unproven",
    );
  });
});

describe("helpers", () => {
  it("builds a spec from a Dot config", () => {
    const built = vmSpecFromConfig(DOT, { computer: { cpu: 2, memory: "4gb", disk: "40gb", idle_timeout: "15m" } }, {
      token: "t",
      goldenImage: "/g",
      runtimeImage: "/r",
    });
    expect(built).toEqual({ dotId: DOT, token: "t", goldenImage: "/g", runtimeImage: "/r", cpus: 2, memoryMiB: 4096, diskBytes: 40 * 1024 ** 3 });
  });

  it("generates distinct url-safe tokens", () => {
    const a = generateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(a);
  });

  it("rejects snapshots as out of scope", async () => {
    await expect(manager.createSnapshot(DOT, "s")).rejects.toBeInstanceOf(NotImplementedError);
    await expect(manager.listSnapshots(DOT)).rejects.toThrow(/out of scope/);
    await expect(manager.restoreSnapshot(DOT, "s")).rejects.toThrow(/section 10/);
    await expect(manager.deleteSnapshot(DOT, "s")).rejects.toBeInstanceOf(NotImplementedError);
  });
});
