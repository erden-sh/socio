#!/bin/sh
# A stand-in for the `codex` binary used by the session-host test: ignores the
# `app-server` and `-c` args the entry appends, and runs the fake JSON-RPC peer.
exec node --import tsx "$(dirname "$0")/fake-codex-peer.ts" "$@"
