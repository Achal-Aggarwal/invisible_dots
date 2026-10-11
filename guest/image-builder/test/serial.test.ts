import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildVerdict, followSerialLog, installedComponents } from "../src/serial.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "idots-serial-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("buildVerdict", () => {
  it("is ok only when the provisioner said so", () => {
    expect(buildVerdict("[  1.0] kernel\r\nidots-build: x\r\nIDOTS-BUILD-RESULT: ok\r\n")).toEqual({ ok: true });
  });

  it("passes the provisioner's reason on", () => {
    expect(buildVerdict("IDOTS-BUILD-RESULT: failed at line 40: apt-get install\n")).toEqual({ ok: false, reason: "failed at line 40: apt-get install" });
  });

  it("treats a console without a verdict as a failure", () => {
    expect(buildVerdict("[  1.0] reboot: Power down\n")).toMatchObject({ ok: false, reason: expect.stringMatching(/no result/) });
  });

  it("finds the marker after kernel noise on the same line", () => {
    expect(buildVerdict("[ 99.1] audit: x\rIDOTS-BUILD-RESULT: ok\n")).toEqual({ ok: true });
  });
});

describe("installedComponents", () => {
  it("collects name=value pairs and sanitizes them", () => {
    const text = [
      "IDOTS-BUILD-COMPONENT: node=v24.21.0",
      "IDOTS-BUILD-COMPONENT: browser-engine=firefox 151.0 \u001b[0m",
      "IDOTS-BUILD-COMPONENT: Bad Name=x",
      "noise",
    ].join("\n");
    expect(installedComponents(text)).toEqual({ node: "v24.21.0", "browser-engine": "firefox 151.0 ?[0m" });
  });
});

describe("followSerialLog", () => {
  it("reports nothing and stops cleanly while the file does not exist", async () => {
    const seen: string[] = [];
    const follower = followSerialLog(join(dir, "serial.log"), (step) => seen.push(step), 10);
    await follower.stop();
    expect(seen).toEqual([]);
    expect(follower.tail(1)).toEqual([]);
  });

  it("reports progress lines as they are appended, from a file that appears after it started", async () => {
    const path = join(dir, "serial.log");
    const seen: string[] = [];
    let progressed = () => {};
    const progress = () => new Promise<void>((resolve) => (progressed = resolve));
    const follower = followSerialLog(
      path,
      (step) => {
        seen.push(step);
        progressed();
      },
      10,
    );
    const first = progress();
    await appendFile(path, "booting\r\nidots-build: installing packages\r\nidots-bu");
    await first;
    // The half line is held back until its end arrives.
    expect(seen).toEqual(["installing packages"]);
    await appendFile(path, "ild: installing Node 24\nIDOTS-BUILD-RESULT: ok");
    await follower.stop();
    expect(seen).toEqual(["installing packages", "installing Node 24"]);
    expect(follower.tail(2)).toEqual(["idots-build: installing Node 24", "IDOTS-BUILD-RESULT: ok"]);
    await follower.stop();
  });
});
