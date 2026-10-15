/**
 * The hashed lock of the engine's Python environment, builder/engine-requirements.lock: every package at an exact
 * version with the SHA-256 of its files, installed with `uv pip install --require-hashes`, so nothing is resolved
 * from the index at build time (architecture section 3.3). It is the dependencies of
 * invisible_engine_dots/pyproject.toml and what they need.
 *
 * The Dot's browser is not locked: the image installs the newest release (browser-release.ts).
 */

/** Package names as PEP 503 compares them, versions as the lock writes them. */
const REQUIREMENT = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([A-Za-z0-9][A-Za-z0-9.+_-]*) \\$/;
const HASH = /^ {4}--hash=sha256:[0-9a-f]{64}( \\)?$/;

/** A package name as PEP 503 compares it. */
export function normalizePackageName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/**
 * Parse and check a lock; returns every package and its exact version, by
 * normalized name. Refused: anything but comments, `name==version`
 * requirements and their `--hash=sha256:` lines; a requirement with no hash
 * (uv would refuse it in the guest, an hour later); a package listed twice.
 */
export function parseHashedLock(text: string, where: string): ReadonlyMap<string, string> {
  const packages = new Map<string, string>();
  const lines = text.split("\n");
  let current: string | undefined;
  let hashes = 0;
  const finish = (line: number) => {
    if (current !== undefined && hashes === 0) throw new Error(`${where}:${line}: ${current} has no --hash line`);
  };
  lines.forEach((raw, index) => {
    const line = index + 1;
    if (raw === "" || raw.startsWith("#")) return;
    const hash = HASH.exec(raw);
    if (hash) {
      if (current === undefined) throw new Error(`${where}:${line}: a hash line belongs to no requirement`);
      hashes++;
      // The last hash of a requirement has no continuation: the requirement is complete.
      if (!hash[1]) {
        finish(line);
        current = undefined;
      }
      return;
    }
    const requirement = REQUIREMENT.exec(raw);
    if (!requirement) throw new Error(`${where}:${line}: expected "name==version \\", a "--hash=sha256:" line or a comment, got: ${raw}`);
    if (current !== undefined) throw new Error(`${where}:${line}: ${current} ends without its hashes`);
    const name = normalizePackageName(requirement[1]!);
    if (packages.has(name)) throw new Error(`${where}:${line}: ${name} is listed twice`);
    packages.set(name, requirement[2]!);
    current = name;
    hashes = 0;
  });
  if (current !== undefined) throw new Error(`${where}: ${current} ends without its hashes`);
  return packages;
}
