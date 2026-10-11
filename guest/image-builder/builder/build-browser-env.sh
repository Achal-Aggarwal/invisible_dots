#!/usr/bin/env bash
# Builds the Dot's browser (architecture sections 3.3 and 6): the Python environment of
# invisible-playwright-mcp from the hashed lock (as user dot), the command on dot's PATH, the browser
# engine the wrapper's seal expects. provision.sh runs it as root inside the golden image's builder VM, and the browser
# smoke runs it on a plain ubuntu:24.04 container, so both build the same thing. The Dot's browser is
# this server and nothing else (owner's rule).
#
#   build-browser-env.sh <lock> <environment directory>
#
# The command is linked into ~dot/.local/bin, which the units put on the PATH of dot-agentd and
# of the engine.
#
# The lock is a hashed list of every package at an exact version (uv pip install
# --require-hashes), so a file that changed on the index, or a dependency missing from the
# lock, fails the build instead of entering the image. The engine is fetched with the
# invisible-playwright of that environment, so the cached engine is the one the server's seal
# expects, in ~dot/.cache/invisible-playwright.
set -Eeuo pipefail

usage="usage: build-browser-env.sh <lock> <environment directory>"
lock="${1:?$usage}"
env_dir="${2:?$usage}"
bin_dir=/home/dot/.local/bin
[ -f "$lock" ] || { echo "build-browser-env: no lock at $lock" >&2; exit 1; }
id dot >/dev/null 2>&1 || { echo "build-browser-env: user dot does not exist" >&2; exit 1; }

as_dot() { sudo -u dot -H env PATH="/home/dot/.local/bin:/usr/local/bin:/usr/bin:/bin" "$@"; }

# dot reads the lock from a file of its own reach.
dot_lock="$(mktemp)"
trap 'rm -f "$dot_lock"' EXIT
install -m 0644 "$lock" "$dot_lock"

as_dot mkdir -p "$bin_dir" "$(dirname "$env_dir")"
as_dot uv venv --quiet --python /usr/bin/python3 "$env_dir"
# Wheels only, as for the engine: no build script of any package runs. --no-cache: the image does not need
# uv's download cache in dot's home.
as_dot uv pip install --no-cache --python "$env_dir/bin/python" --require-hashes --only-binary :all: -r "$dot_lock"
[ -x "$env_dir/bin/invisible-playwright" ] || { echo "build-browser-env: no invisible-playwright in $env_dir/bin" >&2; exit 1; }
[ -x "$env_dir/bin/invisible-playwright-mcp" ] || { echo "build-browser-env: no invisible-playwright-mcp in $env_dir/bin" >&2; exit 1; }
as_dot ln -sfn "$env_dir/bin/invisible-playwright-mcp" "$bin_dir/invisible-playwright-mcp"
as_dot "$env_dir/bin/invisible-playwright" fetch
as_dot sh -c 'command -v invisible-playwright-mcp' >/dev/null || { echo "build-browser-env: invisible-playwright-mcp is not on the PATH of dot" >&2; exit 1; }
