#!/bin/sh
# Runs the apps runtime's start path (scripts/apps-runtime-caps.mjs) as
# production does (CB-148): in the apps runtime image, started as root and
# handed to node (uid 1000) by setpriv with only CHOWN, KILL, SETGID and
# SETUID, every other capability dropped, no network. It uses this
# checkout's build (pnpm run build first), mounted over the image's.
#
#   scripts/apps-runtime-caps.sh [image]     (company-brain-apps:latest)
#
# With SRC (v<N>/ sources) and MANIFESTS (their manifests by version) it
# runs those apps; VERSIONS, START, ROLLBACK, PATHS and SWAP_ONLY as in
# the .mjs.
# Apps with dependencies need NODE_MODULES, a node_modules directory the
# install copies (there is no registry without a network).
set -eu
image=${1:-company-brain-apps:latest}
root=$(cd "$(dirname "$0")/.." && pwd)
set -- --rm --name "cb-apps-caps-$$" --network none \
  --cap-drop ALL --cap-add CHOWN --cap-add KILL --cap-add SETGID --cap-add SETUID \
  -v "$root/dist/server:/app/dist/server:ro" \
  -v "$root/scripts/apps-runtime-caps.mjs:/caps.mjs:ro" \
  -e VERSIONS="${VERSIONS:-}" -e START="${START:-}" -e ROLLBACK="${ROLLBACK:-}" \
  -e PATHS="${PATHS:-}" -e SWAP_ONLY="${SWAP_ONLY:-}" -e APPS_RUNTIME_START_SECONDS=20
if [ -n "${SRC:-}" ]; then
  set -- "$@" -v "$SRC:/caps/src:ro" -v "$MANIFESTS:/caps/manifests.json:ro" \
    -e SRC=/caps/src -e MANIFESTS=/caps/manifests.json
fi
if [ -n "${NODE_MODULES:-}" ]; then
  # The install waits for its proxy to take connections: a stand-in on
  # loopback does (the copy reaches nothing).
  set -- "$@" -v "$NODE_MODULES:/caps/node_modules:ro" \
    -e APPS_RUNTIME_INSTALL="cp -r /caps/node_modules ." \
    -e APPS_RUNTIME_EGRESS_PROXY=http://127.0.0.1:3128 -e STAND_IN_PROXY=1
fi
exec docker run "$@" "$image" \
  setpriv --reuid=node --regid=node --init-groups \
  --inh-caps=-all,+setuid,+setgid,+chown,+kill \
  --ambient-caps=-all,+setuid,+setgid,+chown,+kill \
  -- node /caps.mjs
