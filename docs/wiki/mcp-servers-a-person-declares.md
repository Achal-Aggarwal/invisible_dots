---
title: "MCP servers a person declares"
description: "A Dot uses the MCP servers its person declares or approves, each behind its own permission, run as the Dot's user, with secrets kept out of the config; how NanoClaw, Hermes, OpenClaw and others let an agent add one."
parent: "Studies"
nav_order: 8
---

# MCP servers a person declares

Until October 2026 a Dot had one MCP server, its browser's, and no way to use
another. The question was whether a Dot could install an application and then
use its MCP server, and what the standard way to let it do so is.

## How other hosts do it

| Host | Who declares a server | Where it is declared | Permission | Secrets |
|---|---|---|---|---|
| Claude Code | the person (`claude mcp add`, `.mcp.json`) | settings files | rules per server or tool (`mcp__<server>`), asks by default | `env` in the file, or the shell's |
| Codex | the person | `[mcp_servers]` in `config.toml`, with `startup_timeout_sec` and `tool_timeout_sec` | approval policy | `env` in the file |
| nanobot (the engine's base) | the person | its config's `mcpServers` | none | `env` in the file |

All three have the person declare a server, offer its tools as
`<prefix><server><separator><tool>`, and start it as a child process of the
host or reach it by URL.

The agents that live on a computer of their own are closer to a Dot, and they
differ on whether the agent may add a server itself (their source, October 2026):

| Host | The agent adds a server | Who approves | Usable | Secrets |
|---|---|---|---|---|
| NanoClaw | yes, `add_mcp_server` (any command or URL) | always an admin, on an approval card | after its container restarts | never in the agent: a credential gateway injects them |
| Hermes Agent | from a curated catalog only, `manage_connections` | a card; with no card, nobody | at once | entered on the card |
| OpenClaw | no; a plugin from the official catalog may bring one (owner-only) | the owner | at the next step | env, secret references, OAuth |
| nanobot | no | the person activates it | after a reload | `${VAR}`, OAuth |
| Goose | enables only extensions already configured | an allowlist | at once | its config |

Hermes also shows what goes wrong: in June 2026 entries planted in its
`config.yaml` ran shell scripts that installed SSH keys, and it now refuses
entries of that shape.

## What a Dot does

- **The person declares a server, or approves one the Dot adds.** A server is
  a `command` (with `args` and `env`) or a `url` (with `headers`), in the Dot's
  settings or YAML. The Dot installs its program as it installs anything (from
  GitHub with `uv tool install git+https://...`, from npm once it installed
  Node.js), then asks with `add_mcp_server`, as NanoClaw's agents do, under the
  permission `mcp.servers.add`, which asks by default. The person reads the
  whole entry on the approval: what it runs or where it is, the secrets they will
  set, and why. The host checks that approval again before it writes the server
  and uses it up, so one approval adds one server once; the server starts at
  once, with no restart. A stdio server runs as the
  Dot's user, with what running a command already gives it, so what the Dot gains
  are tools, each still asking. Only the person changes or removes a server.
- **One permission per server**, `mcp.<server>`, asked by default and weighed
  as high a risk as running commands: what a server's tools do is the server's
  to say.
- **It runs as the Dot's user.** A command is started through `dot-agentd
  relay`, as `dot`, in its home, like every program of the model.
- **Secrets are set apart** from the config, write-only, as Claude Code and
  Codex do not do: `secrets: [NAME]` in the entry, the value set in the
  settings or with `invisible-dots secret mcp`. It reaches the server as an
  environment variable through the relay's own environment, never a command
  line, or as a header; it is masked in the Dot's conversation files.
- **It starts when declared, and again when it can.** A server that failed
  (its program missing, it exited) is started again when the next message or
  task begins, and the turn waits for it, up to `startup_timeout_s` (60 s by
  default, Codex's `startup_timeout_sec`). One that timed out, or lacks a
  secret, waits for its settings to change, so it never holds up every turn.
- **The model is told why.** The prompt carries each server's `initialize`
  instructions, or why it is not connected, quoting what it wrote on its
  standard error. The settings and `invisible-dots mcp` show the same.

## Measured

A live Dot (`z-ai/glm-5.3-flash`) was given two servers, `npx -y
@modelcontextprotocol/server-everything` on a computer with no Node.js, and
`uvx mcp-server-time`, then asked to use the first one's `echo` tool and the
second one's time in Tokyo.

| Task | What the Dot did | Calls | Cost |
|---|---|---|---|
| 1 | Read why `everything` was not connected (`exec: "npx": executable file not found in $PATH`), ran `sudo dot-install npm`, checked `npx`, answered the time from `mcp_time_get_current_time`, and said the server would be started again at the next message | 4 | $0.0028 |
| 2 | `mcp_everything_echo`: `Echo: dots-mcp-ok` | 1 | $0.0013 |

The acceptance run on a real VM has a step for the same path (`uvx
mcp-server-time`: its tool asks, is approved always and runs as `dot`; a second
server waits for its secret, set through the command line), and the scan of
every log, row and disk file for the secret after it. It passes its 16 steps.

## Limits

- An HTTP server is reached with a header secret; its OAuth flow is not
  supported (the engine's MCP client left OAuth out).
- The permission is per server, not per tool.
- A server's resources and prompts are offered as tools, as nanobot offers
  them.

## Sources

- [Claude Code: MCP](https://docs.anthropic.com/en/docs/claude-code/mcp).
- [Codex: configuration, `mcp_servers`](https://github.com/openai/codex/blob/main/docs/config.md).
- [nanobot](https://github.com/HKUDS/nanobot): `nanobot/agent/tools/mcp.py`.
- The architecture, [sections 7 and 8.3](https://github.com/feder-cr/invisible_dots/blob/main/docs/architecture.md).
