#!/usr/bin/env bash
# Runs the model-free UI smoke against a local server in CI's no-network
# box (.github/workflows/ci.yml). Starts the scripted fake model and a
# built server with mock auth on a throwaway database, waits for the
# server to listen, runs the scenarios that need no live model, and tears
# both down. The fake model is loopback only; nothing leaves the box.
#
# The scenarios are the model-free subset of scripts/ui-smoke.mjs (CB-316):
# shell, tabs, routes, issues, notifications, releases, whats-new,
# operations, ops-activity and operations-knowledge. Each creates at most a
# little (a conversation, an issue, a page) and cleans up after itself.
# releases checks /releases loads every release as it scrolls (#94) and
# that /releases/<tag> deep links open the release; whats-new checks Home
# shows the five most recent releases (CB-333) while the header's list
# loads them all, and that at 360 px the phone header (the title, one
# status indicator and its ⋯ menu) leaves the chat title its room.
#
# Trusted: under .github/, which coding sessions never push (CB-32). The
# smoke script itself (scripts/ui-smoke.mjs) is branch code and runs in the
# same no-network container; this wrapper only orchestrates processes.
set -euo pipefail

port=4398
base="http://127.0.0.1:${port}"
model_port=4513
model_base="http://127.0.0.1:${model_port}/v1"
db="$(mktemp -d)/brain.sqlite"

# The scripted fake model (tests/fixtures/serve-fake-model.ts): loopback,
# no key checked. Started from source with tsx (a dev dependency).
node --import tsx tests/fixtures/serve-fake-model.ts "$model_port" &
model_pid=$!

# The built server: mock auth (alice and bob), the fake model as its
# backend, a throwaway database, Telegram off, no APP_ORIGIN (loopback
# only). SESSION_SECRET is fixed so sign-ins survive across the run.
HOST=127.0.0.1 \
PORT="$port" \
DATABASE_PATH="$db" \
AUTH_PROVIDER=mock \
APP_ORIGIN='' \
SESSION_SECRET='ci-ui-smoke-session-secret-0123456789' \
OPENAI_BASE_URL="$model_base" \
OPENAI_MODEL=fake-model \
OPENAI_API_KEY=unused \
TELEGRAM_BOT_TOKEN='' \
PUSH_ENDPOINT_HOSTS=push.invalid \
node dist/server/server/index.js &
server_pid=$!

cleanup() {
    kill "$server_pid" 2>/dev/null || true
    kill "$model_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
    wait "$model_pid" 2>/dev/null || true
    rm -f "$db" "${db}-wal" "${db}-shm" 2>/dev/null || true
}
trap cleanup EXIT

# Wait for the server to listen (the fake model starts at once).
deadline=$((SECONDS + 30))
until curl -sf "$base/api/auth/session" >/dev/null 2>&1; do
    if [ $SECONDS -ge $deadline ]; then
        echo 'The server did not start in time.' >&2
        exit 1
    fi
    sleep 0.2
done

# The model-free scenarios. Each is a separate invocation so a failure in
# one is reported on its own and the rest still run; the loop fails at the
# end if any did.
scenarios=(shell tabs routes issues notifications releases whats-new operations ops-activity operations-knowledge)
failed=0
for s in "${scenarios[@]}"; do
    echo "::group::ui-smoke: $s"
    if ! node scripts/ui-smoke.mjs --base "$base" --scenario "$s"; then
        echo "::error::ui-smoke scenario $s failed"
        failed=1
    fi
    echo "::endgroup::"
done

exit "$failed"
