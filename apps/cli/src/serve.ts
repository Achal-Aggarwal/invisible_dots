/**
 * `invisible-dots server`: the control plane and, next to it, the web client,
 * in the foreground until a stop signal. The order is the contract: the
 * signal handlers are installed as soon as the control plane listens (a
 * Ctrl+C while the web client is starting must still close the database),
 * and a stop closes the web client first, then the control plane.
 */
import type { ListenAddress, ListenSetting, StartServerOptions } from "@invisible-dots/api";
import { DEFAULT_WEB_LISTEN, ENV, type HostPaths, type Logger } from "@invisible-dots/shared";
import { locateWebBuild, type WebServer, type WebServerOptions } from "./web.js";

/** What `serve` needs from the packages that own the processes; tests pass fakes. */
export interface ServeDeps {
  startServer(options: StartServerOptions): Promise<{ url: string; paths: HostPaths; close(): Promise<void> }>;
  untilStopSignal(close: () => Promise<void>, logger: Logger, signals?: NodeJS.EventEmitter): Promise<void>;
  parseListen(value: string, setting: ListenSetting): ListenAddress;
  startWebServer(options: WebServerOptions): Promise<WebServer>;
}

export interface ServeOptions {
  env: Record<string, string | undefined>;
  logger: Logger;
  /** Serve the web client too (`--no-web` turns it off). */
  web: boolean;
  /** The repository (or install) root the web build is found under. */
  repoRoot: string;
  /** The process, or a stand-in in tests. */
  signals?: NodeJS.EventEmitter;
}

/** The web client's listen address: its own default shown in the error, and a port the person can be told. */
const WEB_LISTEN: ListenSetting = { variable: ENV.WEB_LISTEN, example: DEFAULT_WEB_LISTEN, fixedPort: true };

export async function serve(options: ServeOptions, deps: ServeDeps): Promise<void> {
  const { env, logger } = options;
  // Parsed before anything starts, so a bad INVISIBLE_DOTS_WEB_LISTEN fails the command at once.
  const webListen = options.web ? deps.parseListen(env[ENV.WEB_LISTEN]?.trim() || DEFAULT_WEB_LISTEN, WEB_LISTEN) : undefined;
  const server = await deps.startServer({ env, logger });
  logger.info(`API token in ${server.paths.apiTokenPath}; stop with Ctrl+C (Dots keep running)`);

  const starting = new AbortController();
  let web: Promise<WebServer | undefined> = Promise.resolve(undefined);
  const stopped = deps.untilStopSignal(
    async () => {
      starting.abort();
      try {
        await (await web)?.stop();
      } finally {
        await server.close();
      }
    },
    logger,
    options.signals,
  );

  if (webListen) {
    // Assigned in the same tick the handlers were installed, so a stop always finds the start it has to end.
    web = (async () => {
      try {
        const started = await deps.startWebServer({
          build: await locateWebBuild(options.repoRoot),
          listen: webListen,
          apiUrl: server.url,
          env,
          signal: starting.signal,
          onUnexpectedExit: (message) => logger.warn(`${message}; the control plane keeps running`),
        });
        logger.info(`web client at ${started.url}`);
        return started;
      } catch (error) {
        if (!starting.signal.aborted) logger.warn(`web client not started: ${(error as Error).message}; the control plane keeps running`);
        return undefined;
      }
    })();
  }
  await stopped;
}
