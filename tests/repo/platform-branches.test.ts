/**
 * Architecture section 1.1: Linux and Windows run the same code path, and
 * every difference lives in one named function. This test reads every
 * product source file (TypeScript and JavaScript, the build scripts, the
 * guest's shell scripts and dot-agentd's Go) and fails when a platform check
 * appears anywhere else, so a new branch cannot creep in unnoticed: it has
 * to be added here, next to the function that owns it and the row of
 * section 1.1 that allows it.
 *
 * Tests may still look at the platform they run on; only product code is
 * held to the list.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

/**
 * Product source roots: everything that ships, never the tests.
 * invisible_engine_dots/ is not one of them: the nanobot fork there is Python, tested by
 * its own pytest run, and keeps upstream's platform branches (Windows, macOS) until
 * its second cut; it is exempt from section 1.1 by the owner's decision;
 * architecture section 2 says so.
 */
const SOURCE_ROOTS = ["apps", "packages", "guest"];
/** Built output and tests; `bin` holds dot-agentd's built binary, not sources. */
const SKIP_DIRS = new Set(["node_modules", "dist", ".next", "test", "tests", "bin"]);
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".sh", ".go"];

/**
 * What a platform check looks like in any of those languages: Node's
 * platform and OS probes, a POSIX-only call, the Windows path module, a
 * platform name as a string, Go's GOOS and build constraints. Another file
 * name suffix that selects a platform (`_windows.go`, `_linux.go`) is
 * caught by FILE_NAME_CHECK below.
 */
const PLATFORM_CHECK =
  /process\.platform|os\.platform|\bplatform\(\)|platform\s*[!=]==|os\.type\(|\btype\(\)\s*[!=]==|\bgetuid\b|\bgeteuid\b|path\.win32|\bwin32\.|\bEOL\b|Windows_NT|["'](win32|linux|darwin)["']|runtime\.GOOS|^\/\/go:build|^\/\/ \+build/;
const FILE_NAME_CHECK = /_(windows|linux|darwin|unix|other|posix)(_test)?\.go$/;

/**
 * Every allowed occurrence, by file, with the function (and row of section
 * 1.1) that owns it. The lines are compared exactly, so moving a check
 * outside its function changes a line and fails here.
 */
const ALLOWED: Record<string, { owner: string; lines: string[] }> = {
  "apps/vm-manager/src/host.ts": {
    owner: "accelerator(): -accel kvm or whpx",
    lines: [
      "export function accelerator(platform: NodeJS.Platform = process.platform): Accelerator {",
      'case "linux":',
      'case "win32":',
    ],
  },
  "apps/cli/src/setup/install.ts": {
    owner:
      "installHostPrerequisites() and setupRefusal(): how setup enables the accelerator and installs QEMU, and that setup refuses root where there is one",
    lines: [
      "return process.getuid?.() === 0;",
      'if (deps.platform === "linux" && deps.isRoot) {',
      'if (deps.platform === "linux") return installOnLinux(request, deps);',
      'if (deps.platform === "win32") return installOnWindows(request, deps);',
      "const elevatedDir = win32.join(programData, `invisible-dots-setup-${deps.uniqueName()}`);",
      "const path = win32.join(work, installerFileName(pin));",
      "const text = await deps.readText(win32.join(elevatedDir, ELEVATED_RESULT_FILE)).catch(() => undefined);",
    ],
  },
  "apps/vm-manager/src/accelerator-access.ts": {
    owner:
      "checkAcceleratorAccess() and hostAccessDeps(): how doctor (the CLI's and the API's) and setup read the accelerator's host side, /dev/kvm or the HypervisorPlatform feature, and the one place that hands this host's platform to it",
    lines: [
      "platform: process.platform,",
      'if (deps.platform === "linux") return checkKvmDevice(deps);',
      'if (deps.platform === "win32") return checkHypervisorPlatform(deps);',
    ],
  },
  "guest/image-builder/src/runtime.ts": {
    owner:
      "agentdBuildCommand(): the guest's platform, the same on both hosts (not a branch): dot-agentd is built for linux/amd64 wherever the host runs",
    lines: ['const AGENTD_BUILD_ENV = { CGO_ENABLED: "0", GOOS: "linux", GOARCH: "amd64" } as const;'],
  },
  "packages/shared/src/files.ts": {
    owner: "permissionBitsEnforced() and restrictToOwner(): a private file is chmod 0600 on Linux and an owner-only ACL on Windows",
    lines: [
      "export function permissionBitsEnforced(platform: NodeJS.Platform = process.platform): boolean {",
      'return platform !== "win32";',
    ],
  },
  "packages/shared/src/sockets.ts": {
    owner: "testSocketPath(): test support, a named pipe where Node cannot serve a unix socket",
    lines: [
      "export function testSocketPath(name: string, platform: NodeJS.Platform = process.platform): string {",
      'if (platform === "win32") return `${NAMED_PIPE_PREFIX}idots-${safe}-${unique}`;',
    ],
  },
  // dot-agentd ships for linux/amd64 only. These build constraints let its
  // package compile and its tests run on a Windows development host; no
  // shipped binary contains the !unix side.
  // The account the model's work runs as: the user lookup, the thread's file-system identity and the daemon's
  // capabilities are Linux calls (passwd, setfsuid, prctl).
  "guest/dot-agentd/internal/agentd/account_linux.go": { owner: "LookupAccount(), actAs() and the capability calls on the guest", lines: ["//go:build linux"] },
  "guest/dot-agentd/internal/agentd/account_other.go": { owner: "test-host compile stub of LookupAccount() and actAs()", lines: ["//go:build !linux"] },
  "guest/dot-agentd/internal/agentd/exec_other.go": { owner: "test-host compile stub of setProcessGroup", lines: ["//go:build !unix"] },
  "guest/dot-agentd/internal/agentd/exec_unix.go": { owner: "setProcessGroup on the guest", lines: ["//go:build unix"] },
  "guest/dot-agentd/internal/agentd/listen_other.go": { owner: "test-host compile stub of listenUnixPrivate", lines: ["//go:build !unix"] },
  "guest/dot-agentd/internal/agentd/listen_unix.go": { owner: "listenUnixPrivate on the guest", lines: ["//go:build unix"] },
  "guest/dot-agentd/internal/agentd/platform_other.go": {
    owner: "test-host compile stub of diskUsage",
    lines: ["//go:build !unix", 'return 0, 0, errors.New("disk usage is not implemented on " + runtime.GOOS)'],
  },
  "guest/dot-agentd/internal/agentd/platform_unix.go": { owner: "diskUsage on the guest", lines: ["//go:build unix"] },
  // Pseudo-terminals are Linux ioctls, so the process route builds on linux only.
  "guest/dot-agentd/internal/agentd/proc_linux.go": { owner: "the process route and its relay on the guest", lines: ["//go:build linux"] },
  "guest/dot-agentd/internal/agentd/proc_other.go": { owner: "test-host compile stub of the process route", lines: ["//go:build !linux"] },
};

function isSource(name: string): boolean {
  if (!SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext))) return false;
  return !name.endsWith(".d.ts") && !/\.test\.(tsx?|mjs|js)$/.test(name) && !name.endsWith("_test.go");
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...sourceFiles(path));
    } else if (isSource(name)) {
      out.push(path);
    }
  }
  return out;
}

const isComment = (line: string) =>
  line.startsWith("*") || line.startsWith("/*") || (line.startsWith("//") && !line.startsWith("//go:build") && !line.startsWith("// +build")) || line.startsWith("#");

function platformChecks(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const root of SOURCE_ROOTS) {
    for (const file of sourceFiles(join(repo, root))) {
      const name = relative(repo, file).split(sep).join("/");
      const lines = readFileSync(file, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => PLATFORM_CHECK.test(line) && !isComment(line));
      if (lines.length > 0 || FILE_NAME_CHECK.test(name)) found.set(name, lines);
    }
  }
  return found;
}

describe("platform branches (architecture section 1.1)", () => {
  it("exist only in the functions section 1.1 lists", () => {
    const found = Object.fromEntries([...platformChecks()].sort(([a], [b]) => a.localeCompare(b)));
    const allowed = Object.fromEntries(
      Object.entries(ALLOWED)
        .map(([file, { lines }]) => [file, lines] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    expect(found).toEqual(allowed);
  });

  it("reads the product sources it claims to, so an empty result cannot pass", () => {
    const all = SOURCE_ROOTS.flatMap((root) => sourceFiles(join(repo, root)).map((f) => relative(repo, f).split(sep).join("/")));
    expect(all.length).toBeGreaterThan(100);
    expect(all.filter((file) => file.startsWith("invisible_engine_dots/"))).toEqual([]);
    for (const expected of [
      "apps/vm-manager/src/host.ts",
      "apps/cli/scripts/build.mjs",
      "guest/image-builder/builder/provision.sh",
      "guest/dot-agentd/internal/agentd/server.go",
    ]) {
      expect(all).toContain(expected);
    }
  });

  it("catches the checks it is meant to catch", () => {
    for (const line of [
      'if (os.type() === "Windows_NT") {',
      "const root = process.getuid?.() === 0;",
      "const p = path.win32.join(a, b);",
      'if runtime.GOOS == "windows" {',
      "//go:build windows",
      'if (process.platform === "darwin") {',
    ]) {
      expect(PLATFORM_CHECK.test(line), line).toBe(true);
    }
    expect(FILE_NAME_CHECK.test("guest/dot-agentd/internal/agentd/files_windows.go")).toBe(true);
  });

  it("names a row of the contract for every owner", () => {
    const contract = readFileSync(join(repo, "docs/architecture.md"), "utf8");
    for (const file of Object.keys(ALLOWED)) expect(contract).toContain(`\`${file}\``);
  });
});
