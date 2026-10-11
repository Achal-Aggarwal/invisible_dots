/**
 * The host's GuestClient against the real dot-agentd, not a stand-in: the daemon built with the image builder's one
 * build, run as its README's development mode describes (`--run-as=`: the model's work as the daemon's own user;
 * `--listen 127.0.0.1:0`), with a guest config holding the Dot's token, and a stand-in for the engine on the unix
 * socket the daemon proxies `/v1/agent` to. What the two sides each test alone with a fake of the other, this tests
 * across the seam: the proof, the token, the routes, the bodies, and an event stream passed on as it is written.
 *
 * Linux only (vitest.config.ts leaves `*.linux.test.ts` out elsewhere): the daemon is a Linux program, its exec route
 * runs /bin/bash and the engine's socket is a unix socket. It needs Go, which CI's node job sets up from go.mod.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, get, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AGENTD_ROUTES, GUEST_UNPROVEN, type OutboundEvent } from "@invisible-dots/shared";
import { agentdBuildCommand } from "@invisible-dots/image-builder";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GuestClient, GuestRequestError } from "../src/index.js";

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const TOKEN = "integration-token-0123456789";

let dir: string;
let home: string;
let daemon: ChildProcess | undefined;
let agent: Server | undefined;
let port: number;
/** What reached the stand-in engine through the daemon's proxy, as `METHOD /path?query`. */
const agentSeen: string[] = [];
/** The open event streams the stand-in holds, to write the next event into. */
const streams: ServerResponse[] = [];

function event(seq: number): OutboundEvent {
  return { seq, id: `evt_${seq}`, type: "automation.next_run", ts: "2026-10-11T10:00:00.000Z", data: { next_run_at_ms: seq } };
}

function sse(res: ServerResponse, seq: number): void {
  res.write(`id: ${seq}\ndata: ${JSON.stringify(event(seq))}\n\n`);
}

/** The engine's side of the proxy: /health, and /events/stream, which sends one event and keeps the stream open. */
function startAgent(socket: string): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://agent");
    agentSeen.push(`${req.method} ${url.pathname}${url.search}`);
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", state: "idle", openrouter_configured: true, browser: { identities: 0, open: 0 }, checks: {} }));
      return;
    }
    if (url.pathname === "/events/stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      sse(res, Number(url.searchParams.get("after") ?? 0) + 1);
      streams.push(res);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not_found" }));
  });
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(socket, () => done(server));
  });
}

/** Starts the daemon and answers the TCP port it listens on, from its log line `listening on="tcp 127.0.0.1:<port>"`. */
function startDaemon(binary: string, args: string[]): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
  return new Promise((done, fail) => {
    let log = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      log += chunk;
      const listening = /listening on="tcp 127\.0\.0\.1:(\d+)"/.exec(log);
      if (listening) done({ child, port: Number(listening[1]) });
    });
    child.once("error", fail);
    child.once("exit", (code, signal) => fail(new Error(`dot-agentd exited (${code ?? signal}) before it listened:\n${log}`)));
  });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "idots-agentd-"));
  home = join(dir, "home");
  await mkdir(home);
  const binary = join(dir, "dot-agentd");
  const build = agentdBuildCommand(REPO, binary);
  await promisify(execFile)(build.command, build.args, { env: { ...process.env, ...build.env } });
  const config = join(dir, "config.json");
  await writeFile(config, JSON.stringify({ dotId: "dot_integration", token: TOKEN }), { mode: 0o600 });
  const agentSocket = join(dir, "agent.sock");
  agent = await startAgent(agentSocket);
  const started = await startDaemon(binary, [
    "--config", config,
    "--home", home,
    "--run-dir", join(dir, "run"),
    "--agent-socket", agentSocket,
    "--listen", "127.0.0.1:0",
    "--run-as=",
  ]);
  daemon = started.child;
  port = started.port;
  // The build: a cold Go cache compiles the standard library for linux/amd64 first, and a host whose Go is older
  // than go.mod's toolchain downloads that one.
}, 600_000);

afterAll(async () => {
  for (const res of streams) res.destroy();
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    const exited = new Promise((done) => daemon!.once("exit", done));
    daemon.kill("SIGTERM");
    await exited;
  }
  await new Promise<void>((done) => (agent ? agent.close(() => done()) : done()));
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("GuestClient against dot-agentd", () => {
  it("is given the proof of the token before it sends the token", async () => {
    await expect(new GuestClient(port, TOKEN).prove()).resolves.toBeUndefined();
    const impostor = new GuestClient(port, "another-dot-token");
    await expect(impostor.health()).rejects.toMatchObject({ code: GUEST_UNPROVEN });
  });

  it("is refused without the token: 401 with the Bearer challenge", async () => {
    const answer = await new Promise<{ status: number; challenge: string | undefined; body: string }>((done, fail) => {
      get({ host: "127.0.0.1", port, path: AGENTD_ROUTES.health }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => done({ status: res.statusCode ?? 0, challenge: res.headers["www-authenticate"], body }));
      }).once("error", fail);
    });
    expect(answer.status).toBe(401);
    expect(answer.challenge).toBe('Bearer realm="dot-agentd"');
    expect(JSON.parse(answer.body)).toMatchObject({ error: "unauthorized" });
  });

  it("reads health with the engine's own answer passed through", async () => {
    const health = await new GuestClient(port, TOKEN).health();
    expect(health).toMatchObject({ agentd: "ok", agent: { status: "ok", state: "idle", openrouter_configured: true } });
    expect(agentSeen).toContain("GET /health");
  });

  it("runs a command in home and reads its exit code and both streams", async () => {
    const client = new GuestClient(port, TOKEN);
    expect(await client.exec({ command: "printf out; printf err >&2; exit 3" })).toMatchObject({ exit_code: 3, stdout: "out", stderr: "err", timed_out: false });
    expect((await client.exec({ command: "pwd" })).stdout.trim()).toBe(await realpath(home));
  });

  it("writes, reads and lists a file under home, and refuses one outside it", async () => {
    const client = new GuestClient(port, TOKEN);
    await client.writeFile("notes/hello.txt", "hello from the host");
    expect((await client.readFile("~/notes/hello.txt")).toString("utf8")).toBe("hello from the host");
    const listing = await client.listFiles("notes");
    expect(listing.entries).toEqual([expect.objectContaining({ name: "hello.txt", type: "file", size: 19 })]);
    const outside = await client.readFile("/etc/hostname").catch((error: unknown) => error);
    expect(outside).toBeInstanceOf(GuestRequestError);
    expect(outside).toMatchObject({ status: 403, code: "outside_home" });
  });

  it("proxies the engine's routes, and its event stream as it is written", async () => {
    const client = new GuestClient(port, TOKEN);
    expect(await client.agentHealth()).toMatchObject({ status: "ok", state: "idle" });
    const controller = new AbortController();
    const got: number[] = [];
    for await (const evt of client.events({ after: 4, signal: controller.signal })) {
      got.push(evt.seq);
      // The first event arrived while the engine still holds the stream open: the proxy did not wait for its end.
      // The next one is written only now.
      if (got.length === 1) sse(streams.at(-1)!, 6);
      else controller.abort();
    }
    expect(got).toEqual([5, 6]);
    expect(agentSeen).toContain("GET /events/stream?after=4");
  });
});
