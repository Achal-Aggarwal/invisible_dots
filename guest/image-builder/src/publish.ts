/**
 * What every way of getting an image shares (the golden image built or downloaded, the runtime ISO): which version
 * a build makes, or that an image of these inputs is there already, and how a finished image takes its name.
 */
import { chmod, mkdir, stat } from "node:fs/promises";
import { basename } from "node:path";
import { replaceFile, type ImageKind } from "@invisible-dots/shared";
import { manifestPathFor, writeManifest, type ImageManifest } from "./manifest.js";
import { checkVersion, findImageByDigest, versionFor } from "./versions.js";

export interface ImageTarget {
  version: string;
  image: string;
  manifest: string;
  /** True when the image is there already, complete with its manifest: there is nothing to build. */
  existing: boolean;
}

export interface ResolveImageOptions {
  kind: ImageKind;
  imagesDir: string;
  /** The digest of the image's inputs. */
  digest: string;
  /** An explicit version, used as given; undefined is `<UTC time>-<digest>`, or the image that has this digest. */
  version: string | undefined;
  now: () => Date;
  /** The path of the image of a version. */
  imagePath: (version: string) => string;
  log: (line: string) => void;
}

async function present(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined)) !== undefined;
}

/**
 * The image a build makes: with no explicit version, the image of the images directory that has these inputs if
 * there is one, otherwise a new version. An image file without its manifest is one no build finished (the manifest
 * is written first), and is refused rather than built over.
 */
export async function resolveImageVersion(options: ResolveImageOptions): Promise<ImageTarget> {
  await mkdir(options.imagesDir, { recursive: true });
  let version: string;
  if (options.version === undefined) {
    const found = await findImageByDigest(options.imagesDir, options.kind, options.digest);
    if (found) {
      options.log(`${basename(found.path)} already holds these inputs; nothing to do`);
      return { version: found.version, image: found.path, manifest: manifestPathFor(found.path), existing: true };
    }
    version = versionFor(options.now(), options.digest);
  } else {
    version = checkVersion(options.version);
  }
  const image = options.imagePath(version);
  const manifest = manifestPathFor(image);
  if (await present(image)) {
    if (await present(manifest)) {
      options.log(`${basename(image)} already exists; nothing to do`);
      return { version, image, manifest, existing: true };
    }
    throw new Error(`${image} exists without its manifest ${manifest}: it is not one this builder finished; remove it by hand`);
  }
  return { version, image, manifest, existing: false };
}

/**
 * Puts a finished image (`partial`, on the same filesystem) under its name. The manifest goes first: the control
 * plane picks images by file name, so the image must never appear before the record that describes it. The image is
 * read-only from then on: immutable once a VM uses it (architecture section 3.3).
 */
export async function publishImage(partial: string, image: string, manifestPath: string, manifest: ImageManifest): Promise<void> {
  await writeManifest(manifestPath, manifest);
  await replaceFile(partial, image);
  await chmod(image, 0o444);
}
