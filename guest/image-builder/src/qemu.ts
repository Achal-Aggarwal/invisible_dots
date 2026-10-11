/**
 * The QEMU command line of the one-off builder VM. It is built from the same
 * pieces as the Dot command line of architecture section 3.4 (the
 * vm-manager's machineArgs, drive and device arguments), so a golden image is
 * provisioned on the machine type, accelerator, CPU model and devices a Dot
 * later boots it on; it leaves out what a builder has no use for (the port
 * forward, the runtime ISO) and adds only what is its own (below).
 */
import { deviceArgs, diskDriveArg, isoDriveArg, machineArgs, type Accelerator } from "@invisible-dots/vm-manager";

export type { Accelerator };

/** Absolute paths of the two QEMU programs, as the vm-manager's discovery found them (section 3.1). */
export interface QemuPrograms {
  system: string;
  img: string;
}

export interface BuilderVmSpec {
  accelerator: Accelerator;
  cpus: number;
  memoryMib: number;
  /** The qcow2 disk being provisioned. */
  disk: string;
  /** The builder's NoCloud seed, which also carries the provisioning payload. */
  seed: string;
  serialLog: string;
}

/** The builder VM's command line; its cpus and memory are held to a Dot's bounds by `machineArgs()`. */
export function builderQemuArgs(spec: BuilderVmSpec): string[] {
  return [
    "-name",
    "invisible-dots-image-builder",
    ...machineArgs({ accelerator: spec.accelerator, cpus: spec.cpus, memoryMiB: spec.memoryMib }),
    "-drive",
    diskDriveArg(spec.disk),
    "-drive",
    isoDriveArg("seed ISO", spec.seed),
    // No forward: nothing on the host talks to the builder. The serial
    // console is the only channel back from the provisioner: its progress
    // lines and the final result marker are read from that file.
    ...deviceArgs("user,id=net0", spec.serialLog),
    // The builder's own additions.
    "-monitor",
    "none",
    // The provisioner ends with a power-off. A reboot instead means
    // something restarted the guest half way; exiting makes that visible
    // instead of provisioning a second time over a half-done disk.
    "-no-reboot",
  ];
}
