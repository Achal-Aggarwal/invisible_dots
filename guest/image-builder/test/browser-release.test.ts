import { afterEach, describe, expect, it } from "vitest";
import { compareReleases, latestBrowserRelease } from "../src/browser-release.js";
import { startFakeHttp, type FakeHttp } from "./http-fixture.js";

let http: FakeHttp | undefined;
afterEach(async () => {
  await http?.close();
  http = undefined;
});

/** PyPI's JSON API for one project: what browser-release.ts reads of it. */
const project = (version: string, requires: string[] = []) => ({ body: JSON.stringify({ info: { version, requires_dist: requires } }) });

async function index(mcp: ReturnType<typeof project>, playwright: ReturnType<typeof project>): Promise<string> {
  http = await startFakeHttp({ "/pypi/invisible-playwright-mcp/json": mcp, "/pypi/invisible-playwright/json": playwright });
  return http.url("/pypi");
}

const DOWNLOAD = { attempts: 1, retryDelayMs: 0 };

describe("latestBrowserRelease", () => {
  it("is the newest server, the newest wrapper and the core that wrapper pins", async () => {
    const at = await index(
      project("0.72.2", ["invisible-playwright>=0.35.4", 'invisible-core>=34.31.0; extra == "test"']),
      project("0.35.8", ["invisible-core==47.39.0", "platformdirs>=4"]),
    );

    expect(await latestBrowserRelease({ index: at, download: DOWNLOAD })).toEqual({ mcp: "0.72.2", playwright: "0.35.8", core: "47.39.0" });
  });

  it("refuses a newest wrapper below the newest server's floor: a release published halfway", async () => {
    const at = await index(project("0.73.0", ["invisible-playwright>=0.36.0"]), project("0.35.8", ["invisible-core==47.39.0"]));

    await expect(latestBrowserRelease({ index: at, download: DOWNLOAD })).rejects.toThrow(
      /the newest invisible-playwright-mcp 0\.73\.0 needs invisible-playwright>=0\.36\.0, and the newest published is 0\.35\.8: the release is not complete/,
    );
  });

  it("refuses a wrapper that does not pin its core, since the image could not name its browser engine", async () => {
    const at = await index(project("0.72.2", ["invisible-playwright>=0.35.4"]), project("0.35.8", ["invisible-core>=47"]));

    await expect(latestBrowserRelease({ index: at, download: DOWNLOAD })).rejects.toThrow(/does not pin invisible-core to one version/);
  });

  it("says which project it could not read when the index does not answer", async () => {
    http = await startFakeHttp({});

    await expect(latestBrowserRelease({ index: http.url("/pypi"), download: DOWNLOAD })).rejects.toThrow(/cannot ask the package index for the newest invisible-playwright/);
  });
});

describe("compareReleases", () => {
  it("orders releases part by part, numerically", () => {
    expect(compareReleases("0.35.10", "0.35.9")).toBeGreaterThan(0);
    expect(compareReleases("0.35.4", "0.35.4")).toBe(0);
    expect(compareReleases("0.9.0", "0.35.0")).toBeLessThan(0);
  });
});
