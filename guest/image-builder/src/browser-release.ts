/**
 * The Dot's browser is the newest published invisible-playwright-mcp (owner's rule): no version of it is written in
 * this repository. When a golden image is built, the newest release is asked of the package index, and the three
 * versions that make it up are what the image installs, what its inputs digest covers (a new release is a new image,
 * never an old image reused or downloaded under the same name) and what its manifest records.
 *
 * The three: invisible-playwright-mcp, the newest; invisible-playwright, the newest, which has to satisfy the
 * server's floor; invisible-core, the one that invisible-playwright pins exactly, with the browser engine it seals.
 * The other packages of the server's environment are what these three require, resolved by uv inside the builder.
 */
import { fetchTextWithRetries, type FetchVerifiedOptions } from "./download.js";

export const MCP_PACKAGE = "invisible-playwright-mcp";
export const PLAYWRIGHT_PACKAGE = "invisible-playwright";
export const CORE_PACKAGE = "invisible-core";

/** Where the versions are asked: PyPI's JSON API, one document per project. */
export const PACKAGE_INDEX = "https://pypi.org/pypi";

export interface BrowserRelease {
  /** invisible-playwright-mcp, the server the engine runs. */
  mcp: string;
  /** invisible-playwright, the wrapper the server drives the browser with. */
  playwright: string;
  /** invisible-core, which the wrapper pins and which seals the browser engine. */
  core: string;
}

/** What pins.env carries without quoting, inside the builder VM's shell. */
const VERSION = /^[0-9][0-9A-Za-z.+_-]*$/;

interface Project {
  version: string;
  requires: readonly string[];
}

async function project(index: string, name: string, download: FetchVerifiedOptions): Promise<Project> {
  const url = `${index}/${name}/json`;
  let info: { version?: unknown; requires_dist?: unknown };
  try {
    info = (JSON.parse(await fetchTextWithRetries(url, download)) as { info?: typeof info }).info ?? {};
  } catch (error) {
    throw new Error(`cannot ask the package index for the newest ${name} (${url}): ${(error as Error).message}`, { cause: error });
  }
  const version = info.version;
  if (typeof version !== "string" || !VERSION.test(version)) throw new Error(`${url}: the newest ${name} has no usable version (${String(version)})`);
  const requires = Array.isArray(info.requires_dist) ? info.requires_dist.filter((r): r is string => typeof r === "string") : [];
  return { version, requires };
}

/** The requirement of `project` on `dependency` that is always installed (no `extra ==` marker), as written. */
function requirementOn(project: Project, dependency: string, of: string): string {
  const name = new RegExp(`^${dependency.replace(/[-_.]/g, "[-_.]")}(?![-_.A-Za-z0-9])`, "i");
  const found = project.requires.find((r) => name.test(r) && !/extra\s*==/.test(r));
  if (!found) throw new Error(`${of} ${project.version} does not require ${dependency}`);
  return found;
}

/** Version order as PEP 440 orders plain releases: part by part, numerically. */
export function compareReleases(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
}

/**
 * The newest release of the Dot's browser, read from the index. Refused, with the reason: a newest wrapper below the
 * newest server's floor (a release published halfway), a wrapper that does not pin its core exactly.
 */
export async function latestBrowserRelease(options: { index?: string; download?: FetchVerifiedOptions } = {}): Promise<BrowserRelease> {
  const index = options.index ?? PACKAGE_INDEX;
  const download = options.download ?? {};
  const [mcp, playwright] = await Promise.all([project(index, MCP_PACKAGE, download), project(index, PLAYWRIGHT_PACKAGE, download)]);

  const floor = /\s*>=\s*([0-9][0-9A-Za-z.+_-]*)/.exec(requirementOn(mcp, PLAYWRIGHT_PACKAGE, MCP_PACKAGE))?.[1];
  if (floor && compareReleases(playwright.version, floor) < 0) {
    throw new Error(
      `the newest ${MCP_PACKAGE} ${mcp.version} needs ${PLAYWRIGHT_PACKAGE}>=${floor}, and the newest published is ${playwright.version}: ` +
        "the release is not complete on the index yet; build again once it is",
    );
  }
  const core = /\s*==\s*([0-9][0-9A-Za-z.+_-]*)\s*(?:;|$)/.exec(requirementOn(playwright, CORE_PACKAGE, PLAYWRIGHT_PACKAGE))?.[1];
  if (!core || !VERSION.test(core)) {
    throw new Error(`${PLAYWRIGHT_PACKAGE} ${playwright.version} does not pin ${CORE_PACKAGE} to one version, so the image cannot name its browser engine`);
  }
  return { mcp: mcp.version, playwright: playwright.version, core };
}
