import { describe, expect, it } from "vitest";
import { parseHashedLock } from "../src/python-lock.js";

const HASH_A = `--hash=sha256:${"a".repeat(64)}`;
const HASH_B = `--hash=sha256:${"b".repeat(64)}`;

function lock(...entries: string[]): string {
  return ["# header", ...entries, ""].join("\n");
}
const pkg = (name: string, version: string, hashes: string[] = [HASH_A]) =>
  [`${name}==${version} \\`, ...hashes.map((hash, i) => `    ${hash}${i < hashes.length - 1 ? " \\" : ""}`)].join("\n");

describe("parseHashedLock", () => {
  it("reads every package at its exact version, names compared as PEP 503 normalizes them", () => {
    const packages = parseHashedLock(lock(pkg("idna", "3.20"), pkg("Typing_Extensions", "4.16.0", [HASH_A, HASH_B])), "engine.lock");
    expect([...packages]).toEqual([
      ["idna", "3.20"],
      ["typing-extensions", "4.16.0"],
    ]);
  });

  it("refuses a requirement without a hash, which --require-hashes would refuse inside the builder VM", () => {
    expect(() => parseHashedLock(lock("idna==3.20"), "engine.lock")).toThrow(/expected/);
    expect(() => parseHashedLock(lock("idna==3.20 \\"), "engine.lock")).toThrow(/idna ends without its hashes/);
  });

  it("refuses anything that is not a pinned requirement: ranges, URLs, editable installs", () => {
    for (const line of ["idna>=3 \\", "-e ./local", "idna @ https://example.invalid/idna.whl \\"]) {
      expect(() => parseHashedLock(lock(line, `    ${HASH_A}`), "engine.lock")).toThrow(/expected/);
    }
  });

  it("names the file it was given in every refusal", () => {
    expect(() => parseHashedLock(lock("idna==3.20"), "engine.lock")).toThrow(/^engine\.lock:2: expected/);
    expect(() => parseHashedLock(lock(pkg("idna", "3.20"), pkg("IDNA", "3.21")), "engine.lock")).toThrow(/engine\.lock:4: idna is listed twice/);
    expect(() => parseHashedLock(lock("idna==3.20 \\"), "engine.lock")).toThrow(/engine\.lock: idna ends without its hashes/);
  });
});
