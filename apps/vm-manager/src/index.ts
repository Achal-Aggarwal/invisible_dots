/**
 * @invisible-dots/vm-manager: the QEMU driver of the control plane
 * (architecture sections 3, 5.1, 9.4, 9.5).
 *
 * The control plane uses one VmManager per process:
 *
 *   const vm = new VmManager({ env, logger, virtualizationDir });
 *
 * Every call that needs more than a dot id takes a VmSpec (dotId, token in
 * clear, absolute goldenImage and runtimeImage paths, cpus, memoryMiB,
 * diskBytes); `vmSpecFromConfig(dotId, config, stored)` builds one. The
 * manager stores nothing itself: a VM is its directory under
 * INVISIBLE_DOTS_HOME/vms/<dot_id>/ plus the QEMU process.
 *
 * Lifecycle
 *   create(spec)        qcow2 overlay on the golden image + seed.iso. Keeps an
 *                       existing disk, so a retried create is safe.
 *                       -> { vmDir, diskPath, seedPath, diskCreated, instanceId }
 *   start(spec)         rewrites the seed, picks a free guest port, spawns QEMU
 *                       detached with the argv of `qemuArgs()`, writes the pid
 *                       file, returns when QEMU listens on the guest port and
 *                       still runs a moment later. Retries on a taken port.
 *                       -> { pid, guestPort, alreadyRunning }; store pid and
 *                       guestPort in `computers`.
 *   waitForGuestHealth(dotId, guestPort, token, options?)
 *                       polls GET /v1/health until dot-agentd and the agent
 *                       report ok; fails early if QEMU exits, and with the
 *                       end of QEMU's log and the serial console when the
 *                       guest never comes up.
 *   stop(dotId, token, { timeoutMs? })
 *                       POST /v1/system/poweroff through the guest channel,
 *                       waits for QEMU to exit, kills it after 60 s.
 *                       -> { forced, wasRunning }. Call the agent's
 *                       prepare-sleep first when sleeping a Dot (9.5).
 *   reboot(spec)        stop then start, so new cpus, memory and runtime ISO
 *                       apply. -> StartVmResult.
 *   destroy(dotId)      kills QEMU and removes the VM directory and its log.
 *   state(dotId)        -> { state: VmState, pid, guestPort, detail? } from the
 *                       pid file and the process; STOPPED with no live QEMU.
 *                       This is also the reconciliation after a control plane
 *                       restart: the scheduler asks it for every Dot, and a
 *                       pid file whose QEMU is gone is removed right there.
 *   resize(spec)        cpus and memory apply at the next start; the disk is
 *                       grown (never shrunk) while stopped.
 *                       -> { restartRequired, diskResized }
 *   resizeDisk(dotId, bytes)
 *   guestClient(guestPort, token)
 *                       a GuestClient for every route of sections 5.2 and 5.3,
 *                       including the resumable event stream `events({ after })`.
 *   createSnapshot / listSnapshots / restoreSnapshot / deleteSnapshot
 *                       reject with NotImplementedError (section 10).
 *
 * A process is killed only when it is proven to be the Dot's QEMU: this
 * process spawned it and has not seen it exit, or its pid is alive, runs as
 * this user, was spawned in this boot of the host, and its guest port
 * listens (see `processIsOurs` in vm-manager.ts).
 *
 * Errors name their fix: QemuNotFoundError and AcceleratorUnavailableError
 * point at "invisible-dots setup" and "invisible-dots doctor"; CpuModelError
 * is QEMU refusing the Dots' CPU model (CPU_MODEL); VmStartError carries QEMU's own output (and the
 * serial console when the guest never came up); VmStateError is an operation
 * the VM's current state does not allow.
 *
 * Host helpers for doctor and setup: findQemu, qemuSearchDirs,
 * parseQemuVersion, isSupportedQemuVersion, MIN_QEMU_VERSION, accelerator
 * (the one platform function of section 1.1) and officialQemuDir.
 * The doctor report (section 11.1) is `runDoctor(deps)`, with the real
 * machine's deps from `hostDoctorDeps` and the accelerator's host side read
 * by `checkAcceleratorAccess` (the other platform function).
 * The process runner every host command goes through: runProcess,
 * startProcess, NodeCommandRunner and NodeProcessControl (runner.ts).
 */
export * from "./accelerator-access.js";
export * from "./doctor.js";
export * from "./errors.js";
export * from "./guest-client.js";
export * from "./host-doctor.js";
export * from "./host.js";
export * from "./ports.js";
export * from "./powershell.js";
export * from "./process-file.js";
export * from "./qemu-args.js";
export * from "./runner.js";
export * from "./seed.js";
export * from "./vm-manager.js";
