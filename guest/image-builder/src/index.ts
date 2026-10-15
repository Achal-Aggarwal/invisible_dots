/**
 * `invisible-dots image build` (architecture sections 3.3 and 11): the golden
 * image and the runtime ISO, built on the host from public sources.
 *
 * The caller supplies the host: the QEMU programs from the vm-manager's
 * discovery, its `accelerator()`, and a process runner that can also spawn
 * the long-running builder VM (the CLI adapts its own process.ts to it).
 * The QEMU path rules and the image file names come from the vm-manager and
 * shared, as for the Dots. Nothing here decides anything per operating
 * system.
 */
export { defaultAssetRoot, GUEST_ASSETS, GUEST_UNITS } from "./assets.js";
export { checksumFromSums, DownloadError, fetchVerified, sha256File, type Fetch, type FetchVerifiedOptions, type VerifiedFile } from "./download.js";
export { buildGoldenImage, GOLDEN_DEFAULTS, GoldenBuildError, type GoldenBuildOptions, type GoldenBuildResult } from "./golden.js";
export {
  manifestPathFor,
  readManifest,
  verifyImage,
  type GoldenManifest,
  type ImageCheck,
  type ImageManifest,
  type RuntimeManifest,
} from "./manifest.js";
export { BASE_IMAGE, GUEST_PINS, type BaseImagePin, type GuestPins, type PinnedDownload } from "./pins.js";
export { normalizePackageName, parseHashedLock } from "./python-lock.js";
export { latestBrowserRelease, type BrowserRelease } from "./browser-release.js";
export type { ProcessRunner, RunningProcess } from "./process.js";
export { builderQemuArgs, type Accelerator, type QemuPrograms } from "./qemu.js";
export {
  AGENTD_BUILD_SHELL,
  agentdBuildCommand,
  assertLinuxAmd64Elf,
  type BuildCommand,
  buildRuntimeIso,
  defaultRuntimeInputs,
  type RuntimeBuildOptions,
  type RuntimeBuildResult,
  type RuntimeInputs,
} from "./runtime.js";
export { PREBUILT_RELEASES, parsePrebuiltRelease, prebuiltTag, pullPrebuiltGolden, type PrebuiltPart, type PrebuiltRelease } from "./prebuilt.js";
