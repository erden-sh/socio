#!/usr/bin/env bash
# Installs the copy's dependencies for CI (.github/workflows/ci.yml):
# `pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile` in the
# ci-box image on an internal Docker network (ci-sandbox), whose only way out
# is the egress proxy (egress-proxy.mjs), which allows registry.npmjs.org:443
# alone. The install container is on no other network; the proxy runs as
# nobody, with no capabilities. pnpm reads the branch's package files,
# pnpm-lock.yaml and .npmrc here, installs
# exactly the lockfile, and runs no scripts and no .pnpmfile hooks (CB-183).
# Its store is in the container's /tmp, outside the copy. Its output and the
# proxy's log are wrapped in ::stop-commands:: with a token from the
# runner's /dev/urandom. Trusted: under .github/, which coding sessions
# never push (CB-32).
set -euo pipefail
docker=${DOCKER:-docker}

"$docker" network create --internal ci-sandbox >/dev/null
"$docker" run -d --init --name ci-egress --network bridge --cap-drop ALL \
  --security-opt no-new-privileges --user 65534:65534 \
  -e EGRESS_ALLOW=registry.npmjs.org:443 ci-box node /ci/egress-proxy.mjs >/dev/null
"$docker" network connect ci-sandbox ci-egress

token=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
echo "::stop-commands::$token"
status=0
"$docker" run --rm --init --network ci-sandbox --cap-drop ALL \
  --security-opt no-new-privileges --user "$(id -u):65534" -e HOME=/tmp \
  -e HTTPS_PROXY=http://ci-egress:3128 -e npm_config_https_proxy=http://ci-egress:3128 \
  -e npm_config_update_notifier=false \
  -v "$RUNNER_TEMP/src":/w -w /w ci-box pnpm install --frozen-lockfile --ignore-scripts \
  --ignore-pnpmfile --store-dir /tmp/pnpm-store 2>&1 ||
  status=$?
"$docker" logs ci-egress 2>&1 || true
echo "::$token::"
"$docker" rm -f ci-egress >/dev/null
exit "$status"
