#!/usr/bin/env bash
# Builds the Dot's browser (architecture sections 3.3 and 6): the Python environment of invisible-playwright-mcp
# (as user dot), the command on dot's PATH, the browser engine the wrapper's seal expects. provision.sh runs it as
# root inside the golden image's builder VM, and the browser smoke runs it on a plain ubuntu:24.04 container, so both
# build the same thing. The Dot's browser is this server and nothing else (owner's rule).
#
#   build-browser-env.sh <environment directory> [<requirement>...]
#
# The requirements are what to install; with none, the newest invisible-playwright-mcp and what it needs. The golden
# image passes the release it resolved from the index (browser-release.ts), so the image is what its digest names;
# the browser smoke installs the newest. No version of the browser is written in the repository (owner's rule).
#
# The command is linked into ~dot/.local/bin, where the model's commands find it; the engine's unit names it by that
# path (INVISIBLE_DOTS_MCP_COMMAND), starts it as dot, and reads what it serves from it when it starts. The engine is
# fetched with the invisible-playwright of that environment, so the cached engine is the one the server's seal
# expects, in ~dot/.cache/invisible-playwright.
set -Eeuo pipefail

usage="usage: build-browser-env.sh <environment directory> [<requirement>...]"
env_dir="${1:?$usage}"
shift
requirements=("$@")
[ "${#requirements[@]}" -gt 0 ] || requirements=(invisible-playwright-mcp)
bin_dir=/home/dot/.local/bin
other_browsers="$(dirname "${BASH_SOURCE[0]}")/other-browsers.txt"
[ -f "$other_browsers" ] || { echo "build-browser-env: no $other_browsers" >&2; exit 1; }
id dot >/dev/null 2>&1 || { echo "build-browser-env: user dot does not exist" >&2; exit 1; }

as_dot() { sudo -u dot -H env PATH="/home/dot/.local/bin:/usr/local/bin:/usr/bin:/bin" "$@"; }

as_dot mkdir -p "$bin_dir" "$(dirname "$env_dir")"
as_dot uv venv --quiet --python /usr/bin/python3 "$env_dir"
# Wheels only, as for the engine: no build script of any package runs. --no-cache: the image does not need uv's
# download cache in dot's home.
as_dot uv pip install --no-cache --python "$env_dir/bin/python" --only-binary :all: "${requirements[@]}"
# What was installed, not what was asked for: no package of it may be another browser.
installed="$(as_dot uv pip freeze --python "$env_dir/bin/python" | sed -n 's/^\([A-Za-z0-9._-]*\)==.*/\1/p' | tr 'A-Z_.' 'a-z--')"
refused=""
while read -r name; do
  case "$name" in ''|'#'*) continue ;; esac
  refused="$refused$(printf '%s\n' "$installed" | grep -E "^${name}(-.*)?$" || true)"
done < "$other_browsers"
[ -z "$refused" ] || { echo "build-browser-env: another browser would enter the image (owner's rule): $refused" >&2; exit 1; }
[ -x "$env_dir/bin/invisible-playwright" ] || { echo "build-browser-env: no invisible-playwright in $env_dir/bin" >&2; exit 1; }
[ -x "$env_dir/bin/invisible-playwright-mcp" ] || { echo "build-browser-env: no invisible-playwright-mcp in $env_dir/bin" >&2; exit 1; }
as_dot ln -sfn "$env_dir/bin/invisible-playwright-mcp" "$bin_dir/invisible-playwright-mcp"
as_dot "$env_dir/bin/invisible-playwright" fetch
as_dot sh -c 'command -v invisible-playwright-mcp' >/dev/null || { echo "build-browser-env: invisible-playwright-mcp is not on the PATH of dot" >&2; exit 1; }
