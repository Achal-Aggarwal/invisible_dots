import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeIso } from "@invisible-dots/iso";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILDER_BROWSER_BUILD, BUILDER_ENGINE_BUILD, BUILDER_ENGINE_LOCK, BUILDER_PROVISION, BUILDER_PYTHON_LOCK, BUILDER_USER_DATA, defaultAssetRoot, readGuestAsset } from "../src/assets.js";
import { GUEST_PINS } from "../src/pins.js";
import { parsePythonLock } from "../src/python-lock.js";
import { SEED_VOLUME_ID } from "@invisible-dots/vm-manager";
import { builderMetaData, builderSeedEntries, pinsEnv } from "../src/seed.js";

const pythonLock = await readGuestAsset(defaultAssetRoot(), BUILDER_PYTHON_LOCK);
const python = parsePythonLock(pythonLock.toString("utf8"));

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "idots-seed-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("pins.env", () => {
  it("carries every value provision.sh reads, single-quoted", async () => {
    const text = pinsEnv(GUEST_PINS, python);
    expect(text).toContain(`UV_VERSION='${GUEST_PINS.uv.version}'\n`);
    expect(text).toContain("UV_TARBALL='uv-x86_64-unknown-linux-gnu.tar.gz'\n");
    // The two Python versions come from the lock, the one place they are written.
    expect(text).toContain(`MCP_VERSION='${python.mcpVersion}'\n`);
    expect(text).toContain(`PLAYWRIGHT_VERSION='${python.playwrightVersion}'\n`);
    expect(text).toContain("PYTHON_LOCK='mcp-requirements.lock'\n");
    expect(text).toContain("ENGINE_LOCK='engine-requirements.lock'\n");
    expect(text).toContain("ENGINE_BUILD='build-engine-env.sh'\n");
    expect(text).toContain("BROWSER_BUILD='build-browser-env.sh'\n");
    expect(text).toContain(`APT_SNAPSHOT='${GUEST_PINS.apt_snapshot}'\n`);
    expect(text).toContain(`APT_PACKAGES='${GUEST_PINS.apt_packages.join(" ")}'\n`);

    const provision = (await readGuestAsset(defaultAssetRoot(), BUILDER_PROVISION)).toString("utf8");
    for (const variable of text.split("\n").filter(Boolean).map((line) => line.split("=")[0]!)) {
      expect(provision).toContain(`$${variable}`);
    }
  });

  it("refuses a value that could break out of the quotes", () => {
    expect(() => pinsEnv({ ...GUEST_PINS, apt_packages: ["xvfb", "it's"] }, python)).toThrow(/APT_PACKAGES/);
  });
});

describe("the builder seed", () => {
  it("holds the NoCloud files, the provisioner, its pins, the Python lock, the pinned downloads, the engine's lock with the script that builds its environment, and the script that builds the browser", async () => {
    const uvTarball = join(dir, "uv.tar.gz");
    await writeFile(uvTarball, "uv bytes");
    const tunnelBinary = join(dir, "hev");
    await writeFile(tunnelBinary, "hev bytes");
    const engineLock = await readGuestAsset(defaultAssetRoot(), BUILDER_ENGINE_LOCK);
    const engineBuild = await readGuestAsset(defaultAssetRoot(), BUILDER_ENGINE_BUILD);
    const browserBuild = await readGuestAsset(defaultAssetRoot(), BUILDER_BROWSER_BUILD);
    const userData = await readGuestAsset(defaultAssetRoot(), BUILDER_USER_DATA);
    const provision = await readGuestAsset(defaultAssetRoot(), BUILDER_PROVISION);
    const entries = builderSeedEntries({
      version: "20261002120000-abc",
      pins: GUEST_PINS,
      userData,
      provision,
      pythonLock,
      python,
      uvTarball,
      tunnelBinary,
      engineLock,
      engineBuild,
      browserBuild,
    });

    expect(entries.map((entry) => entry.path)).toEqual([
      "user-data",
      "meta-data",
      "provision.sh",
      "pins.env",
      "mcp-requirements.lock",
      "uv-x86_64-unknown-linux-gnu.tar.gz",
      "hev-socks5-tunnel-linux-x86_64",
      "engine-requirements.lock",
      "build-engine-env.sh",
      "build-browser-env.sh",
    ]);
    expect(entries[0]).toEqual({ path: "user-data", data: userData });
    expect(entries[4]).toEqual({ path: "mcp-requirements.lock", data: pythonLock });
    expect(entries[5]).toEqual({ path: entries[5]!.path, file: uvTarball });
    expect(entries[6]).toEqual({ path: "hev-socks5-tunnel-linux-x86_64", file: tunnelBinary });
    expect(entries[7]).toEqual({ path: "engine-requirements.lock", data: engineLock });
    expect(entries[8]).toEqual({ path: "build-engine-env.sh", data: engineBuild });
    expect(entries[9]).toEqual({ path: "build-browser-env.sh", data: browserBuild });

    // The real writer accepts it under the label NoCloud looks for.
    const summary = await writeIso(join(dir, "seed.iso"), entries, { volumeId: SEED_VOLUME_ID });
    expect(summary.files).toBe(10);
    const image = await readFile(join(dir, "seed.iso"));
    // Primary volume descriptor at sector 16: the label at offset 40.
    expect(image.toString("latin1", 16 * 2048 + 40, 16 * 2048 + 46)).toBe("cidata");
  });

  it("gives every build its own instance id, so cloud-init runs as on a first boot", () => {
    expect(builderMetaData("v1")).toBe("instance-id: idots-golden-v1\nlocal-hostname: idots-golden-builder\n");
    expect(builderMetaData("v1")).not.toBe(builderMetaData("v2"));
  });

  it("user-data mounts that same seed by label and runs the provisioner, failing loudly", async () => {
    const userData = (await readGuestAsset(defaultAssetRoot(), BUILDER_USER_DATA)).toString("utf8");
    expect(userData.startsWith("#cloud-config\n")).toBe(true);
    expect(userData).toContain(`mount -o ro LABEL=${SEED_VOLUME_ID} /mnt/idots-build && bash /mnt/idots-build/provision.sh`);
    expect(userData).toContain("IDOTS-BUILD-RESULT: failed");
  });
});
