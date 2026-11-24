#!/usr/bin/env bash
# Runs a group of scripts/turbo.mjs in the no-network box, and decides here,
# on the runner, what it may do with the shared cache. Only a push to main
# writes, and it never reads (the box's cache directory is also empty then:
# nothing restores into it), so main always does real work and a result can't
# launder itself into a later run. Everything else reads and never writes, and
# ci.yml has no step that could save what it left behind.
# SECURITY.md ("CI runs untrusted code") has the threat model.
# Trusted: under .github/, which coding sessions never push (CB-32).
set -euo pipefail

case "${GITHUB_EVENT_NAME:-}:${GITHUB_REF:-}" in
  push:refs/heads/main) cache=local:w ;;
  *) cache=local:r ;;
esac

group=$1
shift
# Streamed, so a run the job's timeout kills still shows how far it got.
exec bash "$(dirname "$0")/box.sh" node scripts/turbo.mjs "$group" "--cache=$cache" --cache-dir=.turbo-ci \
  --log-order=stream "$@"
