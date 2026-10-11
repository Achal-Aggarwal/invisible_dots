/**
 * The real host commands: the doctor, setup, image build and server of
 * architecture section 11, wired to the real machine. Everything decided
 * here comes from the package that owns it: QEMU discovery, the accelerator
 * and the doctor report from the vm-manager, image verification and building
 * from the image builder (the doctor's image rows through the API), the
 * control plane from the API, paths from shared. This file only connects
 * them; it holds no platform branch (those are in setup/install.ts and the
 * vm-manager's accelerator-access.ts).
 *
 * cli.ts imports this module only when a host command runs, so the API
 * client commands never load QEMU discovery, the image builder or the
 * database.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createImageChecks, parseListen, serverLogger, startServer, untilStopSignal } from "@invisible-dots/api";
import {
  buildGoldenImage,
  buildRuntimeIso,
  defaultRuntimeInputs,
  fetchVerified,
  type ProcessRunner,
} from "@invisible-dots/image-builder";
import { allowlistedEnvironment, currentUserSid, hostPaths, type DoctorCheck } from "@invisible-dots/shared";
import {
  accelerator,
  findQemu,
  firstLine,
  hostAccessDeps,
  hostDoctorDeps,
  NodeCommandRunner,
  openRouterCheck,
  runProcess,
  startProcess,
  type DoctorDeps,
} from "@invisible-dots/vm-manager";
import windowsQemuPinJson from "../../../virtualization/qemu/windows.json" with { type: "json" };
import { connectApi } from "./api-client.js";
import type { CliIo, HostCommands, ImageBuildOptions } from "./cli.js";
import { doctorCommand } from "./doctor/command.js";
import { EXIT } from "./exit.js";
import { runSetupAll } from "./setup/all.js";
import { buildAgent, buildWeb, type BuildDeps } from "./setup/build.js";
import { currentUserIsRoot, type InstallDeps } from "./setup/install.js";
import { parseWindowsQemuPin } from "./setup/qemu-pin.js";
import { serve } from "./serve.js";
import { prepareHost, runSetup, type SetupDeps } from "./setup/setup.js";
import { locateWebBuild, startWebServer } from "./web.js";

/**
 * Whether the running server holds an OpenRouter key. The key lives in the
 * database, and the embedded PGlite database belongs to the one server
 * process that has it open (a second opener would corrupt it), so doctor
 * asks the server instead of reading the database.
 */
async function openRouterKey(env: Record<string, string | undefined>, fetchImpl?: typeof fetch): Promise<DoctorCheck> {
  const base = { id: "openrouter", label: "OpenRouter key" } as const;
  let health: unknown;
  try {
    health = await (await connectApi(env, fetchImpl)).health();
  } catch (error) {
    return {
      ...base,
      status: "failed",
      detail: `cannot tell while the server is not reachable (${firstLine((error as Error).message)})`,
      fix: "start it with: invisible-dots server, then run invisible-dots doctor again",
    };
  }
  const configured = (health as { openrouter_configured?: unknown }).openrouter_configured;
  if (typeof configured === "boolean") return openRouterCheck(configured);
  return { ...base, status: "failed", detail: "the server's /api/health does not report openrouter_configured", fix: "update the server" };
}

function doctorDeps(io: CliIo): DoctorDeps {
  const paths = hostPaths(io.env);
  return {
    ...hostDoctorDeps({ env: io.env, home: paths.home, images: createImageChecks(paths), openRouterKey: () => openRouterKey(io.env, io.fetch) }),
    webBuild: () => locateWebBuild(REPO_ROOT),
  };
}

function setupDeps(io: CliIo): SetupDeps {
  return { doctor: doctorDeps(io), install: installDeps(io), out: io.stdout };
}

function buildDeps(io: CliIo): BuildDeps {
  return {
    run: runProcess,
    env: io.env,
    repoRoot: REPO_ROOT,
    node: process.execPath,
    webBuilt: async () => (await locateWebBuild(REPO_ROOT)).missing === undefined,
  };
}

function installDeps(io: CliIo): InstallDeps {
  const log = (line: string) => io.stdout(`${line}\n`);
  return {
    ...hostAccessDeps(io.env),
    log,
    readText: (path) => readFile(path, "utf8"),
    isRoot: currentUserIsRoot(),
    windowsQemuPin: () => parseWindowsQemuPin(windowsQemuPinJson),
    userSid: () => currentUserSid(io.env),
    uniqueName: () => randomBytes(16).toString("hex"),
    makeTempDir: () => mkdtemp(join(tmpdir(), "invisible-dots-setup-")),
    removeDir: (path) => rm(path, { recursive: true, force: true }),
    download: async (pin, dest) => {
      await fetchVerified({ url: pin.url, sha256: pin.sha256 }, dest, { log, ...(io.fetch ? { fetch: io.fetch } : {}) });
    },
  };
}

/** The image builder's process boundary: the host's one runner, the same one the vm-manager uses for qemu-img. */
const commands = new NodeCommandRunner();
const processRunner: ProcessRunner = {
  run: (command, args, options) => commands.run(command, args, options),
  spawn: (command, args, options) => startProcess(command, args, { cwd: options.cwd, env: allowlistedEnvironment(process.env) }),
};

/**
 * The repository root. apps/cli/src/host.ts and the bundle
 * apps/cli/dist/invisible-dots.mjs sit at the same depth, so this holds for
 * both. The image builder's own default would point inside apps/cli once
 * bundled, so its guest files are named here (the engine's source is named by
 * defaultRuntimeInputs, from this same root).
 */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const IMAGE_BUILDER_DIR = join(REPO_ROOT, "guest", "image-builder");

/**
 * The runtime ISO first: it takes seconds and fails at once when the agent
 * bundle or dot-agentd has not been built, before an hour of golden image
 * provisioning.
 */
async function imageBuild(io: CliIo, options: ImageBuildOptions = { download: true, compress: false }): Promise<number> {
  const log = (line: string) => io.stdout(`${line}\n`);
  const paths = hostPaths(io.env);
  const runtime = await buildRuntimeIso({ paths, log, assetRoot: IMAGE_BUILDER_DIR, inputs: defaultRuntimeInputs(REPO_ROOT) });
  log(`${runtime.created ? "built" : "already built"}: ${runtime.iso}`);
  const qemu = await findQemu(io.env);
  const golden = await buildGoldenImage({
    qemu,
    accelerator: accelerator(),
    runner: processRunner,
    paths,
    assetRoot: IMAGE_BUILDER_DIR,
    log,
    ...(options.download ? {} : { prebuilt: false as const }),
    ...(options.compress ? { compress: true } : {}),
    ...(io.fetch ? { fetch: io.fetch } : {}),
    ...(io.signal ? { signal: io.signal } : {}),
  });
  log(`${golden.created ? "ready" : "already there"}: ${golden.image}`);
  return EXIT.ok;
}

export function realHostCommands(): HostCommands {
  return {
    doctor: (options, io) => doctorCommand(doctorDeps(io), options, io.stdout),
    setup: (io) => runSetup(setupDeps(io)),
    setupAll: (io) => {
      const builds = buildDeps(io);
      return runSetupAll({
        out: io.stdout,
        agent: () => buildAgent(builds),
        host: () => prepareHost(setupDeps(io)),
        web: () => buildWeb(builds),
        images: () => imageBuild(io),
        env: io.env,
        ...(io.signal ? { signal: io.signal } : {}),
      });
    },
    imageBuild,
    server: async (io, options) => {
      await serve(
        { env: io.env, logger: serverLogger(io.env), web: options.web, repoRoot: REPO_ROOT },
        { startServer, untilStopSignal, parseListen, startWebServer },
      );
      return EXIT.ok;
    },
  };
}
