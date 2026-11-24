#!/usr/bin/env bash
# Runs a command in CI's no-network box (.github/workflows/ci.yml): the
# ci-box image, `--network none`, no capabilities, no new privileges, an
# init, the runner's uid with the neutral group nogroup (never the
# runner's, which may be docker), and only the copy of the checkout
# ($RUNNER_TEMP/src) mounted. The branch's code runs here, so its output
# can't issue workflow commands: it is wrapped in ::stop-commands:: with a
# token from the runner's /dev/urandom, never from branch content.
# BOX_SECCOMP_PROFILE, set only by the workflow's test step, replaces Docker's
# default seccomp profile: Chromium's sandbox needs user namespaces, which the
# default refuses without CAP_SYS_ADMIN (src/app-browser/deploy-spec.ts).
# Trusted: under .github/, which coding sessions never push (CB-32).
set -euo pipefail

token=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
echo "::stop-commands::$token"
status=0
seccomp=()
if [ -n "${BOX_SECCOMP_PROFILE:-}" ]; then
  seccomp=(--security-opt "seccomp=$BOX_SECCOMP_PROFILE")
fi
"${DOCKER:-docker}" run --rm --init --network none --cap-drop ALL \
  --security-opt no-new-privileges "${seccomp[@]}" --user "$(id -u):65534" \
  -e HOME=/tmp -e CI=true -v "$RUNNER_TEMP/src":/w -w /w ci-box "$@" 2>&1 ||
  status=$?
echo "::$token::"
exit "$status"
