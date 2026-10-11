/**
 * The golden image built once by CI and downloaded, instead of an hour of
 * provisioning on every host (architecture section 3.3). A release of the
 * repository named `golden-<inputs digest>` holds it: the digest is the one
 * `buildGoldenImage` computes from the pinned inputs of this checkout, so a
 * host only ever takes the image of exactly its own inputs, and builds it
 * itself when no such release exists (a changed pin, a fork, no network).
 *
 * The release holds `release.json` (this file's `PrebuiltRelease`), the
 * image's manifest, and the image in parts, because a release asset is at
 * most 2 GiB. Each part is checked against its SHA-256 as it is downloaded,
 * and the whole image against the manifest's SHA-256 and size once it is put
 * together, before it is written under its final name.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { DownloadError, fetchTextWithRetries, fetchVerified, type FetchVerifiedOptions } from "./download.js";
import type { GoldenManifest } from "./manifest.js";
import { publishImage } from "./publish.js";
import { checkVersion } from "./versions.js";

/** Where the releases of the repository are downloaded from. */
export const PREBUILT_RELEASES = "https://github.com/feder-cr/invisible_dots/releases/download";

/** The tag of the release that holds the golden image of these inputs. */
export function prebuiltTag(digest: string): string {
  return `golden-${digest}`;
}

export interface PrebuiltPart {
  name: string;
  size: number;
  sha256: string;
}

/** `release.json` of a prebuilt golden image. */
export interface PrebuiltRelease {
  inputs_digest: string;
  /** The asset that is the image's manifest, `golden-<version>.json`. */
  manifest: string;
  /** The image, in order. */
  parts: PrebuiltPart[];
}

const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function parsePrebuiltRelease(value: unknown, digest: string): PrebuiltRelease {
  const o = value as Partial<PrebuiltRelease> | null;
  if (typeof o !== "object" || o === null) throw new Error("release.json is not an object");
  if (o.inputs_digest !== digest) throw new Error(`release.json is for the inputs ${String(o.inputs_digest)}, not ${digest}`);
  if (typeof o.manifest !== "string" || !/^golden-[A-Za-z0-9._-]+\.json$/.test(o.manifest)) throw new Error("release.json names no golden manifest");
  if (!Array.isArray(o.parts) || o.parts.length === 0) throw new Error("release.json lists no part of the image");
  const parts = o.parts.map((part, i) => {
    if (typeof part?.name !== "string" || !ASSET_NAME.test(part.name)) throw new Error(`release.json part ${i} has no plain name`);
    if (!Number.isSafeInteger(part.size) || part.size <= 0) throw new Error(`release.json part ${i} has no size`);
    if (typeof part.sha256 !== "string" || !SHA256.test(part.sha256)) throw new Error(`release.json part ${i} has no SHA-256`);
    return { name: part.name, size: part.size, sha256: part.sha256 };
  });
  return { inputs_digest: digest, manifest: o.manifest, parts };
}

export interface PullOptions {
  /** Base URL of the releases, `PREBUILT_RELEASES` by default. */
  releases: string;
  digest: string;
  imagesDir: string;
  /** The final path of an image of a given version. */
  imagePath: (version: string) => string;
  manifestPath: (image: string) => string;
  download: FetchVerifiedOptions;
  log: (line: string) => void;
}

export interface PulledImage {
  version: string;
  image: string;
  manifest: string;
}

/**
 * Downloads the prebuilt golden image of `digest`. Undefined when there is none, or it cannot be reached: the
 * caller then builds the image itself. A release that is there but does not check out (a part, the whole image or
 * the manifest that is not what it says) is an error, not a reason to build quietly.
 */
export async function pullPrebuiltGolden(options: PullOptions): Promise<PulledImage | undefined> {
  const { log } = options;
  const base = `${options.releases.replace(/\/+$/, "")}/${prebuiltTag(options.digest)}`;
  let release: PrebuiltRelease;
  let manifest: GoldenManifest;
  try {
    release = parsePrebuiltRelease(JSON.parse(await fetchTextWithRetries(`${base}/release.json`, options.download)), options.digest);
    manifest = JSON.parse(await fetchTextWithRetries(`${base}/${release.manifest}`, options.download)) as GoldenManifest;
  } catch (error) {
    const reason = error instanceof DownloadError && error.status === 404 ? "none is published" : (error as Error).message;
    log(`no prebuilt golden image for these inputs (${reason}); building it here`);
    return undefined;
  }
  if (manifest.kind !== "golden" || manifest.inputs_digest !== options.digest) {
    throw new Error(`${base}/${release.manifest} is not the golden manifest of the inputs ${options.digest}`);
  }
  const version = checkVersion(manifest.version);
  const image = options.imagePath(version);
  if (manifest.file !== `golden-${version}.qcow2`) throw new Error(`${base}/${release.manifest} names the image ${manifest.file}`);
  const total = release.parts.reduce((sum, part) => sum + part.size, 0);
  if (total !== manifest.size_bytes) throw new Error(`the parts of ${base} add up to ${total} bytes, the manifest says ${manifest.size_bytes}`);

  log(`downloading the prebuilt golden image ${version} (${(total / 2 ** 30).toFixed(1)} GiB in ${release.parts.length} parts)`);
  // Kept between runs until the image is complete, so an interrupted download resumes part by part.
  const workDir = join(options.imagesDir, `.golden-pull-${options.digest}`);
  await mkdir(workDir, { recursive: true });
  const parts: string[] = [];
  for (const part of release.parts) {
    const dest = join(workDir, part.name);
    await fetchVerified({ url: `${base}/${part.name}`, sha256: part.sha256 }, dest, options.download);
    parts.push(dest);
  }

  const partial = `${image}.part`;
  await rm(partial, { force: true });
  const out = await open(partial, "wx", 0o644);
  const hash = createHash("sha256");
  try {
    for (const path of parts) {
      for await (const chunk of createReadStream(path)) {
        hash.update(chunk as Buffer);
        await out.write(chunk as Buffer);
      }
    }
    await out.sync();
  } finally {
    await out.close();
  }
  const sha256 = hash.digest("hex");
  if (sha256 !== manifest.sha256) {
    await rm(partial, { force: true });
    throw new Error(`the prebuilt golden image hashes to ${sha256}, its manifest says ${manifest.sha256}`);
  }
  const manifestPath = options.manifestPath(image);
  // Published as a built image is: the manifest first, the image read-only.
  await publishImage(partial, image, manifestPath, manifest);
  await rm(workDir, { recursive: true, force: true });
  log(`done: ${image} (sha256 ${sha256})`);
  return { version, image, manifest: manifestPath };
}
