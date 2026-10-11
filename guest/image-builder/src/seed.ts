/**
 * The builder VM's seed disk. It is one ISO labelled `cidata`: cloud-init's
 * NoCloud datasource reads user-data and meta-data from it, and the
 * provisioner mounts it again to reach its own files, so the builder needs
 * this one read-only disk (a virtio disk, as every ISO of this project is
 * attached: the vm-manager's isoDriveArg) and no second payload disk.
 */
import type { IsoEntry } from "@invisible-dots/iso";
import { downloadFileName, type GuestPins } from "./pins.js";
import type { PythonLock } from "./python-lock.js";

/** The lock's name on the builder seed, where provision.sh reads it. */
export const SEED_PYTHON_LOCK = "mcp-requirements.lock";
/** The engine's lock and the script that builds its Python environment from it, on the builder seed. */
export const SEED_ENGINE_LOCK = "engine-requirements.lock";
export const SEED_ENGINE_BUILD = "build-engine-env.sh";
/** The script that builds the Dot's browser from the MCP lock, on the builder seed. */
export const SEED_BROWSER_BUILD = "build-browser-env.sh";

export interface BuilderSeedInput {
  version: string;
  pins: GuestPins;
  userData: Uint8Array;
  provision: Uint8Array;
  /** builder/mcp-requirements.lock, as read, and what it pins. */
  pythonLock: Uint8Array;
  python: PythonLock;
  /** Host path of the verified uv tarball, streamed into the image. */
  uvTarball: string;
  /** The verified hev-socks5-tunnel binary (pins.tunnel). */
  tunnelBinary: string;
  /** builder/engine-requirements.lock and builder/build-engine-env.sh, as read. */
  engineLock: Uint8Array;
  engineBuild: Uint8Array;
  /** builder/build-browser-env.sh, as read. */
  browserBuild: Uint8Array;
}

/**
 * pins.env is sourced by provision.sh. Every value was restricted to
 * characters that need no quoting when the pins were parsed, so single
 * quotes are only a second guard; the check below keeps it that way if a
 * caller builds GuestPins by hand.
 */
export function pinsEnv(pins: GuestPins, python: PythonLock): string {
  const values: Array<[string, string]> = [
    ["UV_VERSION", pins.uv.version],
    ["UV_TARBALL", downloadFileName(pins.uv)],
    ["TUNNEL_VERSION", pins.tunnel.version],
    ["TUNNEL_BINARY", downloadFileName(pins.tunnel)],
    ["MCP_VERSION", python.mcpVersion],
    ["PLAYWRIGHT_VERSION", python.playwrightVersion],
    ["PYTHON_LOCK", SEED_PYTHON_LOCK],
    ["ENGINE_LOCK", SEED_ENGINE_LOCK],
    ["ENGINE_BUILD", SEED_ENGINE_BUILD],
    ["BROWSER_BUILD", SEED_BROWSER_BUILD],
    ["APT_SNAPSHOT", pins.apt_snapshot],
    ["APT_PACKAGES", pins.apt_packages.join(" ")],
  ];
  return values
    .map(([key, value]) => {
      if (!/^[A-Za-z0-9.+_ -]*$/.test(value)) throw new Error(`pins.env: ${key} holds characters that are not allowed: ${value}`);
      return `${key}='${value}'\n`;
    })
    .join("");
}

export function builderMetaData(version: string): string {
  // A new instance-id per build: cloud-init then treats every build as a first boot.
  return `instance-id: idots-golden-${version}\nlocal-hostname: idots-golden-builder\n`;
}

export function builderSeedEntries(input: BuilderSeedInput): IsoEntry[] {
  return [
    { path: "user-data", data: input.userData },
    { path: "meta-data", data: builderMetaData(input.version) },
    { path: "provision.sh", data: input.provision },
    { path: "pins.env", data: pinsEnv(input.pins, input.python) },
    { path: SEED_PYTHON_LOCK, data: input.pythonLock },
    { path: downloadFileName(input.pins.uv), file: input.uvTarball },
    { path: downloadFileName(input.pins.tunnel), file: input.tunnelBinary },
    { path: SEED_ENGINE_LOCK, data: input.engineLock },
    { path: SEED_ENGINE_BUILD, data: input.engineBuild },
    { path: SEED_BROWSER_BUILD, data: input.browserBuild },
  ];
}
