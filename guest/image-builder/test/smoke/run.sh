#!/usr/bin/env bash
# The engine smoke's entry point: builds dot-agentd from a source tree in
# golang:1.26.8, starts ubuntu:24.04 with the tree mounted, builds the engine's
# environment there as provision.sh does (builder/build-engine-env.sh on the
# hashed lock), stages the engine's source as the runtime ISO does, and runs
# the checks of smoke.sh against a Dot.
#
#   run.sh                       the repository this script lives in
#   run.sh <directory>           another checkout
#   run.sh --archive <tar file>  the tar of `git archive <commit>`: the tree
#                                exactly as committed, without the working
#                                tree's untracked files
#   run.sh --suite browser ...   the browser smoke (browser/smoke.sh: the real
#                                invisible-playwright-mcp and Firefox) instead
#                                of the engine smoke (smoke.sh); the other
#                                arguments are the same
#
# Needs only docker. Runs from Linux (plain paths) and from WSL. Nothing is
# kept between runs: the tree is mounted read-only, everything built goes to
# a docker volume made for this run, and the volume and the container are
# removed on exit, whatever the outcome.
#
# Exit status: 0 only when every check passed. A failed check, a skipped
# check, or a run that never reached the summary line exits 1.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
tree_dir=$(cd "$HERE/../../../.." && pwd)
archive=""
usage="usage: run.sh [--suite engine|browser] [<directory> | --archive <tar file>]"
suite=engine
if [ "${1:-}" = "--suite" ]; then
  [ $# -ge 2 ] || { echo "$usage" >&2; exit 2; }
  suite=$2
  case "$suite" in engine|browser) ;; *) echo "$usage" >&2; exit 2 ;; esac
  shift 2
fi
case "${1:-}" in
  "") ;;
  --archive)
    [ $# -eq 2 ] || { echo "$usage" >&2; exit 2; }
    archive=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
    [ -f "$archive" ] || { echo "run.sh: no such file: $2" >&2; exit 2; }
    ;;
  -*) echo "$usage" >&2; exit 2 ;;
  *)
    [ $# -eq 1 ] || { echo "$usage" >&2; exit 2; }
    tree_dir=$(cd "$1" && pwd)
    ;;
esac

run_id="idots-smoke-$$-$(date +%s)"
log=$(mktemp)
cleanup() {
  docker rm -f "$run_id" >/dev/null 2>&1 || true
  docker volume rm "$run_id" >/dev/null 2>&1 || true
  rm -f "$log"
}
trap cleanup EXIT

docker volume create "$run_id" >/dev/null

# Where the tree is inside the containers. A checkout is mounted read-only; an
# archive is unpacked into this run's volume.
tree_mount=()
if [ -n "$archive" ]; then
  tree=/work/tree
  docker run --rm -v "$run_id":/work -v "$archive":/src.tar:ro ubuntu:24.04 \
    bash -c 'mkdir /work/tree && tar -xf /src.tar -C /work/tree'
else
  tree=/tree
  tree_mount=(-v "$tree_dir":/tree:ro)
fi

# The tests of dot-agentd that need to become another user (the tag `privileged`: they run the model's commands,
# files and terminals as a user the test is not), which take root and a build without cgo: this container is
# root's, as the guest's daemon is not, so they run here, and a skipped one fails the run like a failed one.
# --init: a process the tests kill is a zombie until its parent reaps it, and the tests ask whether it is gone.
if ! privileged=$(docker run --rm --init -v "$run_id":/work "${tree_mount[@]}" \
  -e CGO_ENABLED=0 -e GOCACHE=/work/gocache -e GOTOOLCHAIN=local -e GOFLAGS=-buildvcs=false \
  -w "$tree/guest/dot-agentd" golang:1.26.8 \
  go test -count=1 -v -tags privileged ./... 2>&1) || printf '%s\n' "$privileged" | grep -q -e '--- SKIP'; then
  printf '%s\n' "$privileged" | grep -v -e '^=== ' | tail -40 >&2
  echo "run.sh: dot-agentd's privileged tests did not pass, or one was skipped" >&2
  exit 1
fi

# dot-agentd for the guest, with the one build (guest/dot-agentd/README.md) and the Go
# go.mod's toolchain names. GOTOOLCHAIN=local: the image's Go is the one that
# builds, nothing is downloaded.
docker run --rm -v "$run_id":/work "${tree_mount[@]}" \
  -e CGO_ENABLED=0 -e GOOS=linux -e GOARCH=amd64 \
  -e GOCACHE=/work/gocache -e GOTOOLCHAIN=local \
  -w "$tree/guest/dot-agentd" golang:1.26.8 \
  go build -trimpath -buildvcs=false -ldflags="-s -w" -o /work/dot-agentd ./cmd/dot-agentd

# The checks of the tree under test, in a clean Ubuntu. PIN_REMOVALS reaches
# smoke.sh only when it is set here (see the top of smoke.sh).
pin_env=()
if [ -n "${PIN_REMOVALS+set}" ]; then pin_env=(-e PIN_REMOVALS); fi
set +e
# --shm-size: Firefox keeps its shared memory in /dev/shm, and docker's 64 MB default is too small for it
# (a VM's is half its RAM). NET_ADMIN: nft checks a ruleset against the kernel (the VM proxy's firewall), as the
# guest's root does.
docker run --rm --name "$run_id" --shm-size=1g --cap-add NET_ADMIN -v "$run_id":/work "${tree_mount[@]}" \
  -e TREE="$tree" -e AGENTD_BIN=/work/dot-agentd -e SMOKE_SUITE="$suite" "${pin_env[@]}" \
  ubuntu:24.04 bash "$tree/guest/image-builder/test/smoke/prepare-engine.sh" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
set -e

# The container's exit status says whether smoke.sh was satisfied; the summary
# line says it ran to its end. Both must agree, and a run that checked nothing
# is not a pass.
summary=$(grep -E '^SMOKE: [0-9]+ passed, [0-9]+ failed, [0-9]+ skipped$' "$log" | tail -1 || true)
if [ "$status" -eq 0 ] && printf '%s\n' "$summary" | grep -Eq '^SMOKE: [1-9][0-9]* passed, 0 failed, 0 skipped$'; then
  echo "$summary"
  exit 0
fi
echo "run.sh: the smoke did not pass (container exit status $status)" >&2
echo "${summary:-SMOKE: no summary line, the run did not reach its end}"
exit 1
