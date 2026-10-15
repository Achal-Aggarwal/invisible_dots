/**
 * Every built image has a manifest next to it: `golden-<v>.json` beside
 * `golden-<v>.qcow2`, `runtime-<v>.json` beside `runtime-<v>.iso`. It records
 * what went into the image and its SHA-256, which is what
 * `invisible-dots doctor` checks an image against (architecture 11.1).
 */
import { randomBytes } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { sha256File } from "./download.js";
import type { BaseImagePin } from "./pins.js";
import { replaceFile } from "@invisible-dots/shared";

export interface PinnedComponent {
  version: string;
  sha256: string;
  url: string;
}

export interface GoldenManifest {
  kind: "golden";
  version: string;
  /** File name of the image, in the same directory as the manifest. */
  file: string;
  sha256: string;
  size_bytes: number;
  /** The guest disk size the image was grown to, as passed to qemu-img resize. */
  virtual_size: string;
  built_at: string;
  /** Digest of every input; a build with the same digest is the same image. */
  inputs_digest: string;
  base: BaseImagePin;
  /** The pinned inputs, as they were when the image was built. */
  pinned: {
    uv: PinnedComponent;
    tunnel: PinnedComponent;
    /** The release of the Dot's browser the image installed: the newest on the index when it was built. */
    "invisible-playwright-mcp": string;
    "invisible-playwright": string;
    "invisible-core": string;
    /** The moment of the Ubuntu archive apt_packages came from (pins.json). */
    apt_snapshot: string;
    apt_packages: string[];
  };
  /** The engine's Python environment (builder/engine-requirements.lock): the lock the runtime disk's copy must equal. */
  engine: { lock_sha256: string };
  /** What the provisioner reported it installed (uv, browser-engine, ubuntu, kernel, ...). */
  installed: Record<string, string>;
  builder: { accelerator: string };
}

export interface RuntimeFile {
  path: string;
  sha256: string;
  size_bytes: number;
}

export interface RuntimeManifest {
  kind: "runtime";
  version: string;
  file: string;
  sha256: string;
  size_bytes: number;
  built_at: string;
  /** Digest of the files below; rebuilding the same code finds the ISO with this digest. */
  content_digest: string;
  files: RuntimeFile[];
}

export type ImageManifest = GoldenManifest | RuntimeManifest;

/** `<dir>/golden-<v>.qcow2` -> `<dir>/golden-<v>.json`; the one place that names a manifest. */
export function manifestPathFor(imagePath: string): string {
  const name = basename(imagePath);
  const dot = name.lastIndexOf(".");
  return join(dirname(imagePath), `${dot > 0 ? name.slice(0, dot) : name}.json`);
}

/** Written to a temporary file and renamed, so a manifest is either complete or absent. */
export async function writeManifest(path: string, manifest: ImageManifest): Promise<void> {
  const temporary = `${path}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644, flag: "wx" });
    await replaceFile(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readManifest(path: string): Promise<ImageManifest> {
  const value = JSON.parse(await readFile(path, "utf8")) as Partial<ImageManifest>;
  if ((value.kind !== "golden" && value.kind !== "runtime") || typeof value.sha256 !== "string" || typeof value.file !== "string") {
    throw new Error(`${path} is not an image manifest`);
  }
  return value as ImageManifest;
}

export type ImageCheck =
  | { ok: true; manifest: ImageManifest }
  | { ok: false; reason: string; fix: string };

/**
 * Whether an image is present and is the bytes its manifest describes. It
 * re-hashes the whole image, so it takes seconds on a golden image; doctor
 * calls it, a VM start does not.
 */
export async function verifyImage(imagePath: string): Promise<ImageCheck> {
  const fix = "invisible-dots image build";
  const manifestPath = manifestPathFor(imagePath);
  const info = await stat(imagePath).catch(() => undefined);
  if (!info?.isFile()) return { ok: false, reason: `${imagePath} does not exist`, fix };
  let manifest: ImageManifest;
  try {
    manifest = await readManifest(manifestPath);
  } catch (error) {
    return { ok: false, reason: `cannot read the manifest ${manifestPath}: ${(error as Error).message}`, fix };
  }
  if (manifest.file !== basename(imagePath)) {
    return { ok: false, reason: `${manifestPath} describes ${manifest.file}, not ${basename(imagePath)}`, fix };
  }
  if (manifest.size_bytes !== info.size) {
    return { ok: false, reason: `${imagePath} is ${info.size} bytes, its manifest says ${manifest.size_bytes}`, fix: `delete it and run ${fix}` };
  }
  const sha256 = await sha256File(imagePath);
  if (sha256 !== manifest.sha256) {
    return { ok: false, reason: `${imagePath} hashes to ${sha256}, its manifest says ${manifest.sha256}`, fix: `delete it and run ${fix}` };
  }
  return { ok: true, manifest };
}
