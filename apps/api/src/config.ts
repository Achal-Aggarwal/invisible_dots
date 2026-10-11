/**
 * Process settings of the control plane: the listen address, the API token
 * and the master key (architecture sections 3.2 and 9.6). Both secrets live
 * in INVISIBLE_DOTS_HOME/config and are created at the first start, so a new
 * host needs no installer step before `invisible-dots server`.
 */
import { randomBytes } from "node:crypto";
import { MASTER_KEY_BYTES } from "@invisible-dots/database";
import { DEFAULT_LISTEN, ENV, readApiToken, readSecretFile, writeSecretFile, type HostPaths } from "@invisible-dots/shared";

/** A generated token: 32 random bytes as hex, so it survives copy and paste and any shell quoting. */
const GENERATED_TOKEN_BYTES = 32;

export interface ListenAddress {
  host: string;
  port: number;
}

/** What differs between the settings parseListen reads. */
export interface ListenSetting {
  /** The environment variable the value came from, named in the errors. */
  variable: string;
  /** The address shown as the example in the error: the setting's own default. */
  example: string;
  /** Whether port 0 (the system picks one) is refused, for a server whose address the person has to be told. */
  fixedPort: boolean;
}

export const API_LISTEN: ListenSetting = { variable: ENV.LISTEN, example: DEFAULT_LISTEN, fixedPort: false };

/** Parse `host:port`, `[v6]:port` or a bare port (which binds 127.0.0.1). */
export function parseListen(value: string = DEFAULT_LISTEN, setting: ListenSetting = API_LISTEN): ListenAddress {
  const text = value.trim();
  let host = "127.0.0.1";
  let portText = text;
  const v6 = /^\[([^\]]+)\]:(\d+)$/.exec(text);
  if (v6) {
    host = v6[1]!;
    portText = v6[2]!;
  } else if (text.includes(":")) {
    const at = text.lastIndexOf(":");
    host = text.slice(0, at);
    portText = text.slice(at + 1);
  }
  const port = Number(portText);
  if (!host || !/^\d+$/.test(portText) || port < 0 || port > 65535) {
    throw new Error(`${setting.variable} must look like "${setting.example}", got "${value}"`);
  }
  if (setting.fixedPort && port === 0) throw new Error(`${setting.variable} needs a fixed port, got "${value}"`);
  return { host, port };
}

export interface LoadedSecret<T> {
  value: T;
  /** Where it came from: a file path or an environment variable name. */
  origin: string;
  /** True when this call generated it and wrote the file. */
  created: boolean;
}

/**
 * The API token as readApiToken reads it (INVISIBLE_DOTS_TOKEN, else the
 * first line of `config/api.token`); the file is generated (0600) when it
 * does not exist yet.
 */
export async function loadOrCreateApiToken(
  paths: HostPaths,
  env: Record<string, string | undefined> = process.env,
): Promise<LoadedSecret<string>> {
  const existing = await readApiToken(env, paths);
  if (existing) return { ...existing, created: false };
  const path = paths.apiTokenPath;
  const token = randomBytes(GENERATED_TOKEN_BYTES).toString("hex");
  await writeSecretFile(path, `${token}\n`);
  return { value: token, origin: path, created: true };
}

/**
 * The master key that encrypts secrets in the database: `config/master.key`,
 * 32 raw bytes (64 hex characters are accepted too, so a key restored by
 * hand works). When the file does not exist a new key is generated but NOT
 * written: `created` tells the caller to check first that the database
 * holds nothing encrypted under a key that was lost, and only then to call
 * `saveMasterKey`. Writing it earlier would turn a missing key into a wrong
 * one that the next start accepts without a word.
 */
export async function loadOrGenerateMasterKey(paths: HostPaths): Promise<LoadedSecret<Buffer>> {
  const path = paths.masterKeyPath;
  const raw = await readSecretFile(path);
  if (raw === undefined) return { value: randomBytes(MASTER_KEY_BYTES), origin: path, created: true };
  if (raw.length === MASTER_KEY_BYTES) return { value: raw, origin: path, created: false };
  const hex = raw.toString("utf8").trim();
  if (new RegExp(`^[0-9a-fA-F]{${MASTER_KEY_BYTES * 2}}$`).test(hex)) return { value: Buffer.from(hex, "hex"), origin: path, created: false };
  throw new Error(`${path} must hold ${MASTER_KEY_BYTES} bytes (or ${MASTER_KEY_BYTES * 2} hexadecimal characters), found ${raw.length} bytes`);
}

/** Write a key from `loadOrGenerateMasterKey` (0600, atomically). */
export async function saveMasterKey(paths: HostPaths, key: Uint8Array): Promise<void> {
  await writeSecretFile(paths.masterKeyPath, key);
}
