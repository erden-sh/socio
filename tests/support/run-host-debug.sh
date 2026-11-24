#!/bin/sh
# Manual debug harness: pipes turn_start then sleeps for events before close.
set -eu
TOK="$(mktemp -d)"
echo 'cbgw_test_token_0123456789' > "$TOK/token"
rm -f "$TOK/pipe"; mkfifo "$TOK/pipe"
# Open the fifo for writing on fd 3 so the entry doesn't see EOF immediately.
exec 3>"$TOK/pipe"
SOCIO_HOST_TOKEN_FILE="$TOK/token" \
  SOCIO_HOST_CODEX_BIN="tests/support/fake-codex-bin.sh" \
  SOCIO_HOST_CWD="$TOK" \
  SOCIO_HOST_STATE_DIR="$TOK/state" \
  timeout 8 node --import tsx src/server/coding/host/session-host.ts sess-1 codex gpt-5 \
  < "$TOK/pipe" >"$TOK/out" 2>"$TOK/err" &
PID=$!
sleep 1
echo '{"op":"turn_start","payload":{"message":"hi"}}' >&3
sleep 3
echo '{"op":"close"}' >&3
exec 3>&-
wait "$PID" || true
echo "=== STDOUT ==="
cat "$TOK/out"
echo "=== STDERR ==="
cat "$TOK/err"
rm -rf "$TOK"
