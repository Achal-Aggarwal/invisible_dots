# dot-agentd

The computer daemon that runs inside every Dot's VM (see `docs/architecture.md`,
sections 4 and 5.2). It serves:

- TCP `0.0.0.0:1024`, for the host, which reaches it through QEMU's
  `hostfwd` port forward (architecture sections 3.4 and 5.1): every request
  needs `Authorization: Bearer <token>`, with the token read from
  `/etc/invisible-dots/config.json`. `/v1/agent/*` is reverse proxied to the
  agent's unix socket, with streaming responses (SSE) flushed chunk by chunk.
  The daemon refuses to start without a token, since the port is always open.
  It binds every interface because the forward targets the guest's
  DHCP-assigned user-network address; nothing outside the host's forward can
  reach that interface.
- `/run/invisible-dots/agentd.sock` (mode 0660; its directory, setgid to the
  engine's group, admits only `dotagentd`, the user the daemon runs as, and
  `dotengine`), for the engine: the
  same routes, no token, no `/v1/agent` proxy and no `POST /v1/system/poweroff`
  (powering the VM off is the control plane's decision), plus `POST /v1/proc`,
  the process route the engine runs the model's commands through.

## Who it runs as

The daemon has a user of its own (`dotagentd`, architecture 4.1), and starts
everything it does for the model as `dot`: every command (`POST /v1/exec`, the
process route), every file operation of the file routes of both listeners (the
thread that serves a request has dot's file-system user and groups, so what it
opens or creates is dot's and is checked as dot's; the TCP listener's home
confinement is decided on top of that), a pseudo-terminal (opened as dot, so dot
owns it) and the screenshot. The environment of those programs is the daemon's
with `HOME`, `USER`, `LOGNAME` and `SHELL` of dot's account and the Dot's `PATH` (`~/.local/bin` and the system's).

That takes `CAP_SETUID`, `CAP_SETGID` (change to dot) and `CAP_KILL` (end a
process group of dot's), which the unit gives as `AmbientCapabilities`. At start
the daemon checks it holds them (unless the work runs as its own user), and
empties its ambient capability set in every thread whatever `--run-as` says, so
no program it starts holds them: with the set left full, a command of the model
would keep `CAP_SETUID` across exec. Emptying a set that holds something needs a
binary built without cgo (the build below), and the daemon refuses to start
otherwise. `--run-as` names the user; `--run-as=` (empty; the variable cannot be
empty), or the daemon's own user named, leaves the work with the daemon's own
uid, which is for tests and development: the daemon warns of it in its log,
because it is the arrangement that let the model read the token.

The programs the daemon starts as itself are named by path (`/bin/bash`,
`/usr/bin/import`, `/usr/bin/sudo`), and the unit gives it a `PATH` with no
directory of dot's: a name looked up in a directory the model can write would run
the model's program with the daemon's privileges. The `PATH` of the model's
commands (dot's `~/.local/bin` first) is built by the daemon, not inherited.

`dot-agentd relay [--socket P] [--cwd DIR] [--tty] [--env NAME=VALUE]...
[--env-from NAME]... -- PROGRAM [ARGS...]` is the client of `POST /v1/proc`: it
runs the program as `dot` (the daemon changes to that user for it), copies its own stdin, stdout and stderr through, and
exits with the program's code (128 + the signal number for a signal).
`--env-from NAME` adds to the program's environment the variable `NAME` of the
relay's own environment (exit 2 when it is not set): a secret goes this way,
because a command line is readable by every user of the machine in `/proc` and
an environment only by its owner.

## Build

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -buildvcs=false -ldflags="-s -w" -o bin/dot-agentd ./cmd/dot-agentd
```

The result is a static linux/amd64 binary with no dependencies outside the
Go standard library, and the same bytes from the same source with the Go that
`go.mod`'s `toolchain` names: no checkout path, commit or "modified" mark is
stamped into it. This is the one build: `agentdBuildCommand()` of the image
builder, CI and the smoke run it with these flags. The unix-only pieces (socket umask, process groups,
`statfs`) sit behind build tags, so `go vet ./...` also works on other systems.

## Test

```sh
go vet ./... && go test -count=1 ./...
```

The exec and screenshot tests need a unix system with `bash`; on Windows they
are compiled out or skipped. The tests that run work as another user take root and
a build without cgo, so they carry the build tag `privileged`
(`CGO_ENABLED=0 go test -tags privileged ./internal/agentd`, as root); the smoke's
`run.sh` runs them in a root container and fails on a skipped one.

## Configuration

Every flag has an environment variable; a flag on the command line wins.

| flag | variable | default |
|---|---|---|
| `--config` | `INVISIBLE_DOTS_GUEST_CONFIG` | `/etc/invisible-dots/config.json` |
| `--home` | `DOT_HOME` | `/home/dot` |
| `--run-dir` | `INVISIBLE_DOTS_RUN_DIR` | `/run/invisible-dots` |
| `--agentd-socket` | `INVISIBLE_DOTS_AGENTD_SOCKET` | `<run-dir>/agentd.sock` |
| `--agent-socket` | `INVISIBLE_DOTS_AGENT_SOCKET` | `/run/invisible-dots-agent/agent.sock` (the engine's directory) |
| `--listen` | `INVISIBLE_DOTS_AGENTD_LISTEN` | `0.0.0.0:1024`; an IP literal and a port, e.g. `127.0.0.1:18024` for development outside a VM |
| `--display` | `INVISIBLE_DOTS_DISPLAY` | `:0` |
| `--import-bin` | `INVISIBLE_DOTS_IMPORT_BIN` | `/usr/bin/import` |
| `--run-as` | `INVISIBLE_DOTS_RUN_AS` | `dot`; `--run-as=` runs the model's work as the daemon's own user |
| `--log-level` | `INVISIBLE_DOTS_LOG_LEVEL` | `info` |

The token is always required: there is no mode that serves the remote routes
without it.

## Guest packages it relies on

- `bash`, for `POST /v1/exec` (`bash -lc <command>`).
- `sudo` and systemd, for `POST /v1/system/poweroff`: it runs
  `/usr/bin/sudo -n /usr/bin/systemctl poweroff`, which the seed allows the user `dotagentd` (the
  one the daemon runs as) without a password, and which is the only command that
  user may run as root; `dot`, the model's user, has no sudo rule.
- `imagemagick`, for `GET /v1/screenshot`: it runs
  `/usr/bin/import -window root -display :0 png:-` against the Xvfb display.

## Route details beyond the contract

- `GET /v1/proof?nonce=<hex>`: the one route served without the token, on the
  TCP listener only. It answers `{ "proof": HMAC-SHA256(token, "invisible-dots
  guest proof v1\n" + nonce) }` in hex; a nonce that is not 32 to 128
  lowercase hex characters is a `400 invalid_nonce`. The host asks it before
  it sends the token to a port (architecture section 5.1), and the answer
  says nothing about the token to whoever asks.

- `GET /v1/health`: when the agent does not answer within 2 s, `agent` is
  `{ "status": "down", "error": "<why>" }`. The guest's readiness checks
  (filesystem writable, network reachable, browser layer installed) are in the
  agent's own `/health` answer, passed through here untouched: the agent is the
  process that writes the state, reaches OpenRouter and starts the browser.
- `POST /v1/exec`: `timeout_ms` defaults to 120000 and may not exceed one hour.
  The command runs in its own process group, and a timeout or a disconnected
  caller kills the whole group. The answer adds `stdout_truncated` and
  `stderr_truncated`. Background children that keep stdout open are not
  waited for longer than 2 s after bash exits.
- `POST /v1/proc` (local socket only): the request asks to switch to
  `dots-proc/1`; after `101` the connection carries frames of one type byte, a
  big-endian uint32 length and the payload (`frames.go`). The program runs
  without a shell in its own process group, or as the session leader of a new
  pseudo-terminal when `tty` is given; the caller going away kills the group.
  After the program exits, output still held open by a child it left behind is
  read for at most 2 s.
- File paths: relative paths and `~/...` resolve against home, absolute paths
  are used as they are, a NUL byte is refused. On the TCP listener (the host's
  door) the three file routes are limited to home: the path is resolved with
  every symbolic link followed (a link whose target does not exist yet too, to where the
  target would be), and one whose real location is not under the
  real home (`/proc/<pid>/environ` included) is a `403 outside_home`; a link in
  home that leads out of it lists as `other`. The engine's socket is not limited. `PUT` creates parent directories
  and replaces the file atomically, keeping an existing file's mode; a symbolic link at the
  path itself (inside home, dangling or not) is replaced by the file, as a rename does it, and
  what it pointed to is left alone.
  `GET /v1/files/list` without `path` lists home.
- `POST /v1/system/poweroff`: starts the poweroff command without waiting for
  it and answers `202 { "status": "powering_off" }`; a command that cannot be
  started is a `500 poweroff_failed`. The host sees the rest as QEMU exiting
  once the guest is off (architecture section 3.4).
- Errors are `{ "error": <code>, "message": <text> }`.
