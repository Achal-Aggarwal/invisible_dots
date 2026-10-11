/**
 * The web client as a child of `invisible-dots server` (architecture section
 * 9.7): the built Next standalone server, started on its own loopback port and
 * stopped with the control plane. The web client is a companion, never a
 * dependency: when it cannot start, the control plane and the command line go
 * on without it, and the server says why.
 */
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { abortableSleep, allowlistedEnvironment, BASE_CHILD_ENV_VARS, ENV } from "@invisible-dots/shared";
import { startProcess, WEB_BUILD_COMMAND, type StartedProcess, type StartProcessOptions, type WebBuild } from "@invisible-dots/vm-manager";

/**
 * Where `npm run build --workspace @invisible-dots/web` leaves the server
 * (apps/web/scripts/standalone.mjs writes it there: Next puts the standalone
 * tree under .next/standalone and the app at its own path inside it, because
 * the workspace root is the tracing root) and the static files it serves.
 */
const ENTRY = ["apps", "web", ".next", "standalone", "apps", "web", "server.js"] as const;
const STATIC = ["apps", "web", ".next", "standalone", "apps", "web", ".next", "static"] as const;

/** The script `npm run build --workspace @invisible-dots/web` runs, which `setup --all` runs with node itself. */
export function webBuildScript(repoRoot: string): string {
  return join(repoRoot, "apps", "web", "scripts", "build.mjs");
}

export async function locateWebBuild(repoRoot: string): Promise<WebBuild> {
  const entry = join(repoRoot, ...ENTRY);
  for (const path of [entry, join(repoRoot, ...STATIC)]) {
    if (!(await stat(path).catch(() => undefined))) return { entry, missing: path };
  }
  return { entry, missing: undefined };
}

export class WebStartError extends Error {}

export interface WebServer {
  /** The address the person opens, e.g. http://127.0.0.1:3000. */
  url: string;
  /** Stop the child; resolves once it has exited. Idempotent. */
  stop(): Promise<void>;
}

export interface WebServerOptions {
  build: WebBuild;
  /** A fixed port: the person has to know where to go (parseListen refuses port 0 for this setting). */
  listen: { host: string; port: number };
  /** The control plane's address, where the web server's proxy sends `/api`. */
  apiUrl: string;
  /** The server's own environment: only what the web server needs is passed on. */
  env: Record<string, string | undefined>;
  /** Called once if the child exits while the server runs on. */
  onUnexpectedExit: (message: string) => void;
  /** Ends the wait for the child to answer, e.g. on Ctrl+C during startup. */
  signal?: AbortSignal;
  start?: (command: string, args: readonly string[], options: StartProcessOptions) => StartedProcess;
  /** How long the child gets to answer its first request. */
  readyTimeoutMs?: number;
  /** How long the child gets to exit after SIGTERM before it is killed. */
  stopTimeoutMs?: number;
}

const READY_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;
const READY_POLL_MS = 100;

/**
 * The environment of the web server. Not the server's own: it may hold
 * DATABASE_URL with its password. The web server gets what it reads: where
 * to listen (Next's PORT and HOSTNAME), where the API is, which data
 * directory holds `api.token` (read on every request, so a rotated token
 * takes effect), the API token itself only when the server was given it that
 * way, and the extra host names its Host check allows. `parentPid` is the
 * server's own pid: the web server exits when that process is gone, so a
 * `kill -9` of the server does not leave it holding the port.
 */
export function webEnvironment(options: Pick<WebServerOptions, "env" | "listen" | "apiUrl"> & { parentPid: number }): Record<string, string> {
  const { env, listen, apiUrl, parentPid } = options;
  return {
    ...allowlistedEnvironment(env, [...BASE_CHILD_ENV_VARS, ENV.HOME, ENV.TOKEN, ENV.WEB_ALLOWED_HOSTS]),
    [ENV.URL]: apiUrl,
    [ENV.WEB_PARENT_PID]: String(parentPid),
    PORT: String(listen.port),
    HOSTNAME: listen.host,
  };
}

function urlOf(listen: { host: string; port: number }): string {
  return `http://${listen.host.includes(":") ? `[${listen.host}]` : listen.host}:${listen.port}`;
}

/** Whether anything answers HTTP at `url`. */
function answers(url: string): Promise<boolean> {
  return fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2000) }).then(
    (response) => response.body?.cancel().then(() => true, () => true) ?? true,
    () => false,
  );
}

/**
 * Start the web server and resolve once it answers a request. Throws
 * WebStartError, with the child already gone, when the build is incomplete,
 * the child exits first (a port in use ends here), it does not answer in time
 * or `signal` aborts.
 */
export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
  const { build, listen } = options;
  if (build.missing) {
    throw new WebStartError(`the web client is not built (${build.missing} does not exist); build it with: ${WEB_BUILD_COMMAND}`);
  }
  if (options.signal?.aborted) throw new WebStartError("stopped before the web client started");
  const url = urlOf(listen);
  // Something else answering there would make the wait below succeed for the wrong server.
  if (await answers(url)) {
    throw new WebStartError(`${url} is already in use; free the port or set ${ENV.WEB_LISTEN} to another host:port`);
  }
  // The server script chdirs into its own directory, so that is where it starts: never the server's directory.
  const env = webEnvironment({ ...options, parentPid: process.pid });
  const child = (options.start ?? startProcess)(process.execPath, [build.entry], { cwd: dirname(build.entry), env });

  let exited = false;
  let started = false;
  let stopping = false;
  let exitText = "";
  const exit = new Promise<void>((resolve) => {
    child.onExit((code, signal, error) => {
      exited = true;
      const why = error?.message ?? (code === null ? `signal ${signal}` : `exit code ${code}`);
      exitText = `the web server exited (${why})${child.stderrTail().trim() ? `: ${child.stderrTail().trim().split(/\r?\n/).slice(-3).join(" | ")}` : ""}`;
      if (started && !stopping) options.onUnexpectedExit(exitText);
      resolve();
    });
  });
  // The server's own hard exit (a second Ctrl+C) must not leave the child holding the port.
  const killAtExit = () => child.kill("SIGKILL");
  process.on("exit", killAtExit);

  const stop = async () => {
    if (stopping) return exit;
    stopping = true;
    process.off("exit", killAtExit);
    child.kill("SIGTERM");
    const grace = setTimeout(() => child.kill("SIGKILL"), options.stopTimeoutMs ?? STOP_TIMEOUT_MS);
    await exit;
    clearTimeout(grace);
  };

  const deadline = Date.now() + (options.readyTimeoutMs ?? READY_TIMEOUT_MS);
  try {
    for (;;) {
      if (options.signal?.aborted) throw new WebStartError("stopped while the web client was starting");
      if (exited) throw new WebStartError(exitText);
      if (Date.now() > deadline) throw new WebStartError(`the web server did not answer at ${url} within ${(options.readyTimeoutMs ?? READY_TIMEOUT_MS) / 1000} s`);
      if ((await answers(url)) && !exited) {
        started = true;
        return { url, stop };
      }
      await abortableSleep(READY_POLL_MS, options.signal);
    }
  } catch (error) {
    await stop();
    throw error;
  }
}
