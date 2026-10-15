/**
 * The pinned inputs of the golden image: the Ubuntu cloud image
 * (virtualization/images/base.json) and the third-party software installed
 * into it (pins.json). Both are imported as JSON modules so a bundled CLI
 * carries them inside the bundle instead of looking for them on disk.
 */
import baseJson from "../../../virtualization/images/base.json" with { type: "json" };
import pinsJson from "../pins.json" with { type: "json" };

/** A file fetched from the network: the pinned SHA-256 decides, the published checksum list must agree. */
export interface PinnedDownload {
  version: string;
  url: string;
  /** The checksum list the project publishes next to the file; absent when it publishes none (the pinned sha256 is then the only record). */
  shasums_url?: string;
  /** The file's name in that list. */
  shasums_entry?: string;
  sha256: string;
}

export interface BaseImagePin {
  name: string;
  release: string;
  serial: string;
  url: string;
  sha256sums_url: string;
  sha256sums_entry: string;
  sha256: string;
  /** File name under the images directory (architecture section 3.2). */
  local_name: string;
}

/**
 * The Dot's browser is not here: the image installs the newest release of
 * invisible-playwright-mcp, resolved from the index at each build
 * (browser-release.ts), and no version of it is written in the repository.
 */
export interface GuestPins {
  uv: PinnedDownload;
  /** hev-socks5-tunnel, the static binary the guest routes the whole VM through when the Dot has a VM proxy. */
  tunnel: PinnedDownload;
  /**
   * The moment of the Ubuntu archive the packages come from (snapshot.ubuntu.com, `YYYYMMDDTHHMMSSZ`): apt resolves
   * apt_packages and their dependencies as the archive was then, so the same pins give the same packages on any day.
   */
  apt_snapshot: string;
  apt_packages: string[];
}

const SHA256 = /^[0-9a-f]{64}$/;
/**
 * Versions and package names end up in a shell file inside the builder VM
 * (pins.env), so they are restricted to characters that need no quoting
 * rather than escaped.
 */
const PLAIN_WORD = /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** A time of snapshot.ubuntu.com, as `apt-get --snapshot` takes it. */
const APT_SNAPSHOT = /^\d{8}T\d{6}Z$/;

function field(object: Record<string, unknown>, key: string, where: string): string {
  const value = object[key];
  if (typeof value !== "string" || value === "") throw new Error(`${where}: "${key}" must be a non-empty string`);
  return value;
}

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function https(url: string, where: string): string {
  if (!url.startsWith("https://")) throw new Error(`${where}: ${url} is not an https URL`);
  return url;
}

function sha256(value: string, where: string): string {
  if (!SHA256.test(value)) throw new Error(`${where}: "${value}" is not a lowercase hex SHA-256`);
  return value;
}

function plainWord(value: string, where: string): string {
  if (!PLAIN_WORD.test(value)) throw new Error(`${where}: "${value}" may only hold letters, digits, ".", "+", "_" and "-"`);
  return value;
}

function parseDownload(value: unknown, where: string): PinnedDownload {
  const o = asObject(value, where);
  const pin: PinnedDownload = {
    version: plainWord(field(o, "version", where), `${where}.version`),
    url: https(field(o, "url", where), `${where}.url`),
    sha256: sha256(field(o, "sha256", where), `${where}.sha256`),
    ...("shasums_url" in o
      ? { shasums_url: https(field(o, "shasums_url", where), `${where}.shasums_url`), shasums_entry: field(o, "shasums_entry", where) }
      : {}),
  };
  // The guest provisioner finds the tarball by its file name, which is the last URL segment.
  if (!FILE_NAME.test(downloadFileName(pin))) throw new Error(`${where}.url must end in a plain file name`);
  return pin;
}

/** The name a pinned download is stored under in the cache and on the builder seed. */
export function downloadFileName(pin: { url: string }): string {
  return new URL(pin.url).pathname.split("/").pop() ?? "";
}

export function parseBaseImagePin(value: unknown): BaseImagePin {
  const where = "virtualization/images/base.json";
  const o = asObject(value, where);
  const pin: BaseImagePin = {
    name: field(o, "name", where),
    release: field(o, "release", where),
    serial: plainWord(field(o, "serial", where), `${where} serial`),
    url: https(field(o, "url", where), `${where} url`),
    sha256sums_url: https(field(o, "sha256sums_url", where), `${where} sha256sums_url`),
    sha256sums_entry: field(o, "sha256sums_entry", where),
    sha256: sha256(field(o, "sha256", where), `${where} sha256`),
    local_name: field(o, "local_name", where),
  };
  if (!FILE_NAME.test(pin.local_name)) throw new Error(`${where}: local_name "${pin.local_name}" must be a plain file name`);
  return pin;
}

export function parseGuestPins(value: unknown): GuestPins {
  const where = "guest/image-builder/pins.json";
  const o = asObject(value, where);
  if ("python_packages" in o) throw new Error(`${where}: python_packages has no place here: the image installs the newest release of the Dot's browser (browser-release.ts)`);
  const apt = o.apt_packages;
  if (!Array.isArray(apt) || apt.length === 0) throw new Error(`${where}: apt_packages must be a non-empty array`);
  const snapshot = field(o, "apt_snapshot", where);
  if (!APT_SNAPSHOT.test(snapshot)) throw new Error(`${where}: apt_snapshot "${snapshot}" is not a snapshot time like 20261010T000000Z`);
  return {
    uv: parseDownload(o.uv, `${where} uv`),
    tunnel: parseDownload(o.tunnel, `${where} tunnel`),
    apt_snapshot: snapshot,
    apt_packages: apt.map((name, i) => plainWord(typeof name === "string" ? name : "", `${where} apt_packages[${i}]`)),
  };
}

/** The pins in this checkout, validated once at import so a bad edit fails every command that uses them. */
export const BASE_IMAGE: BaseImagePin = parseBaseImagePin(baseJson);
export const GUEST_PINS: GuestPins = parseGuestPins(pinsJson);
