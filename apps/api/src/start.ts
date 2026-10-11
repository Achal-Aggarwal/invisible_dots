/**
 * The control plane as one process (architecture section 2): the database,
 * the vm-manager, the scheduler and the HTTP API, composed in the order a
 * first start needs. `invisible-dots server` calls `startServer` and waits
 * with `untilStopSignal`; tests call `startServer` and close the handle
 * themselves.
 */
import { fileURLToPath } from "node:url";
import {
  ChannelHub,
  TelegramChannelType,
  WhatsAppChannelType,
  whatsappClientDir,
  whatsappClientProblem,
  type ChannelType,
} from "@invisible-dots/channels";
import type { Database } from "@invisible-dots/database";
import type { HostFacts } from "@invisible-dots/sdk/types";
import { Scheduler, type ComputerDriver, type SchedulerOptions } from "@invisible-dots/scheduler";
import { ensureDir, ENV, errorMessage, hostPaths, type HostPaths, type Logger, prefixedStderrLogger } from "@invisible-dots/shared";
import { hostDoctorDeps, openRouterCheck, runDoctor, type DoctorDeps } from "@invisible-dots/vm-manager";
import { loadOrCreateApiToken, loadOrGenerateMasterKey, parseListen, saveMasterKey, type ListenAddress } from "./config.js";
import { assertNothingEncrypted, openControlPlaneDatabase } from "./database.js";
import { createImageChecks } from "./doctor.js";
import { acquireServerLock } from "./lock.js";
import { API_VERSION, buildServer, type FastifyInstance } from "./server.js";
import { createVmDriver } from "./vm-driver.js";

export interface StartServerOptions {
  /** Where every setting is read from; default `process.env`. */
  env?: Record<string, string | undefined>;
  /** Overrides INVISIBLE_DOTS_LISTEN; port 0 picks a free port (tests). */
  listen?: string;
  logger?: Logger;
  /** The VM layer; default the real one over QEMU. Tests pass a fake. */
  driver?: ComputerDriver;
  /** Replaces single dependencies of the host report (QEMU discovery, the runner, the disk, the images); the OpenRouter row always asks the Scheduler. Tests pass fakes. */
  doctor?: Partial<DoctorDeps>;
  /** Passed through to the Scheduler (timers, lifecycle and dispatcher tuning). */
  scheduler?: Omit<SchedulerOptions, "db" | "driver" | "logger">;
  /** The kinds of messaging channel this server can run; default Telegram, and WhatsApp when INVISIBLE_DOTS_WHATSAPP=1. Tests pass fakes. */
  channelTypes?: readonly ChannelType[];
  /** Where the opt-in WhatsApp client is installed; default `optional/whatsapp` of the repository. Tests point it at a folder of their own. */
  whatsappClientDir?: string;
}

/** The logger of the `invisible-dots` process: lines on stderr prefixed with its name, debug lines when INVISIBLE_DOTS_DEBUG=1. */
export function serverLogger(env: Record<string, string | undefined> = process.env): Logger {
  return prefixedStderrLogger("invisible-dots", env.INVISIBLE_DOTS_DEBUG === "1");
}

export interface RunningServer {
  /** The base URL clients use, e.g. http://127.0.0.1:8787. */
  url: string;
  address: ListenAddress;
  token: string;
  paths: HostPaths;
  /** "pglite" or "pg", as the database adapter reports it. */
  database: string;
  /** Secrets this start created because they did not exist yet. */
  created: { apiToken: boolean; masterKey: boolean };
  app: FastifyInstance;
  scheduler: Scheduler;
  /** The messaging channels of the Dots: pairing, and the messages between a chat and its Dot. */
  channels: ChannelHub;
  db: Database;
  /** Stop the API, the channels, the scheduler and the database. VMs keep running. Idempotent. */
  close(): Promise<void>;
}

/**
 * Where the opt-in WhatsApp client is installed, under the repository root. apps/api/src/start.ts and the command
 * bundle apps/cli/dist/invisible-dots.mjs sit at the same depth, so the root is the same for both.
 */
const DEFAULT_CLIENT_DIR = whatsappClientDir(fileURLToPath(new URL("../../../", import.meta.url)));

/**
 * The channels a server runs when it is not told otherwise. WhatsApp is opt-in twice: its adapter is an unofficial
 * client that WhatsApp can answer with a ban of the linked account, so a server that was not asked for it neither
 * loads nor offers it; and its client library is not part of the default install (it is GPL-3.0 through libsignal),
 * so it is installed by the person who turns WhatsApp on.
 */
export function defaultChannelTypes(env: Record<string, string | undefined>, clientDir: string = DEFAULT_CLIENT_DIR): ChannelType[] {
  return [new TelegramChannelType(), ...(env[ENV.WHATSAPP] === "1" ? [new WhatsAppChannelType({ baileys: { clientDir } })] : [])];
}

/**
 * Start the control plane and resolve once the API listens. Every resource
 * taken before a failure is released again, so a failed start leaves no
 * lock, open database or listening socket behind.
 */
export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const env = options.env ?? process.env;
  const debug = env.INVISIBLE_DOTS_DEBUG === "1";
  const logger = options.logger ?? serverLogger(env);
  const paths = hostPaths(env);
  const listen = parseListen(options.listen ?? (env[ENV.LISTEN] || undefined));

  const cleanup: (() => Promise<unknown>)[] = [];
  const unwind = async () => {
    for (const step of cleanup.splice(0).reverse()) {
      await step().catch((error) => logger.error("cleanup step failed", { error: errorMessage(error) }));
    }
  };

  try {
    const lock = await acquireServerLock(paths);
    cleanup.push(() => lock.release());
    await ensureDir(paths.logsDir, 0o700);

    const [token, masterKey] = await Promise.all([loadOrCreateApiToken(paths, env), loadOrGenerateMasterKey(paths)]);
    if (token.created) logger.info("created the API token", { path: token.origin });

    const db = await openControlPlaneDatabase({ env, masterKey: masterKey.value, logger });
    cleanup.push(() => db.close());
    if (masterKey.created) {
      // Only an empty database may get a new key; see loadOrGenerateMasterKey.
      await assertNothingEncrypted(db, masterKey.origin);
      await saveMasterKey(paths, masterKey.value);
      logger.info("created the master key", { path: masterKey.origin });
    }

    const driver = options.driver ?? createVmDriver({ env, paths, logger: prefixedStderrLogger("vm-manager", debug) });
    const scheduler = new Scheduler({
      ...options.scheduler,
      db,
      driver,
      logger: options.logger ?? prefixedStderrLogger("scheduler", debug),
    });
    cleanup.push(() => scheduler.close());
    const clientDir = options.whatsappClientDir ?? DEFAULT_CLIENT_DIR;
    const clientProblem = !options.channelTypes && env[ENV.WHATSAPP] === "1" ? whatsappClientProblem(clientDir) : null;
    if (clientProblem) logger.warn(`${ENV.WHATSAPP}=1 is set. ${clientProblem.message}`);
    // Next to the Scheduler, using only what it offers; registered after it, so it stops first.
    const channels = new ChannelHub({
      db,
      host: scheduler,
      types: options.channelTypes ?? defaultChannelTypes(env, clientDir),
      logger: options.logger ?? prefixedStderrLogger("channels", debug),
    });
    cleanup.push(() => channels.close());
    const doctorDeps: DoctorDeps = {
      ...hostDoctorDeps({
        env,
        home: paths.home,
        images: createImageChecks(paths),
        openRouterKey: async () => openRouterCheck((await scheduler.health()).openrouter_configured),
      }),
      ...options.doctor,
    };
    const facts: HostFacts = { database_kind: db.kind, data_dir: paths.home, logs_dir: paths.logsDir };
    const app = buildServer({ scheduler, channels, doctor: () => runDoctor(doctorDeps), host: facts, token: token.value, logger });
    cleanup.push(() => app.close());

    await scheduler.start();
    await channels.start();
    await app.listen({ host: listen.host, port: listen.port });
    const bound = app.server.address();
    const address: ListenAddress = typeof bound === "object" && bound ? { host: listen.host, port: bound.port } : listen;
    const host = address.host.includes(":") ? `[${address.host}]` : address.host;
    const url = `http://${host}:${address.port}`;
    logger.info(`invisible-dots server ${API_VERSION} listening`, { url, home: paths.home, database: db.kind });

    let closing: Promise<void> | null = null;
    return {
      url,
      address,
      token: token.value,
      paths,
      database: db.kind,
      created: { apiToken: token.created, masterKey: masterKey.created },
      app,
      scheduler,
      channels,
      db,
      close: () => (closing ??= unwind()),
    };
  } catch (error) {
    await unwind();
    throw error;
  }
}

/**
 * Every way the person or the system asks a foreground server to stop:
 * Ctrl+C, a service manager, a closed terminal (SIGHUP; Node raises it on
 * Windows too when the console window is closed, a few seconds before
 * Windows ends the process) and Ctrl+Break on Windows (SIGBREAK). All take
 * the same clean path, which closes the embedded database and releases the
 * lock. They are event names Node accepts on both hosts; one that a host
 * never raises simply never fires.
 */
export const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const;

/**
 * Resolve once `close` has finished after the first stop signal; a second
 * signal exits at once. `signals` is the process, or a stand-in in tests.
 */
export function untilStopSignal(close: () => Promise<void>, logger: Logger, signals: NodeJS.EventEmitter = process): Promise<void> {
  return new Promise<void>((resolve) => {
    let stopping = false;
    const onSignal = (signal: NodeJS.Signals) => {
      if (stopping) {
        logger.warn(`second ${signal}, exiting without waiting`);
        process.exit(1);
      }
      stopping = true;
      logger.info(`${signal} received, shutting down (VMs keep running)`);
      void close().finally(() => {
        for (const name of STOP_SIGNALS) signals.off(name, onSignal);
        logger.info("stopped");
        resolve();
      });
    };
    for (const name of STOP_SIGNALS) signals.on(name, onSignal);
  });
}
