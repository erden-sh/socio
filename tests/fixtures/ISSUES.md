# Issues

The tracker for Socio until the repo has a remote. One row per issue; details below the table. Status: `open`, `in progress`, `done`, `blocked` (waiting on a person or decision).

| ID    | Issue                                                                                      | Severity | Status      | Owner            |
| ----- | ------------------------------------------------------------------------------------------ | -------- | ----------- | ---------------- |
| CB-1  | Telegram link button was a tiny unlabeled footer icon                                      | medium   | done        | 380fb4c          |
| CB-2  | A Telegram photo failed every later turn of its conversation                               | high     | done        | 6c0edd3          |
| CB-3  | The model couldn't read images: `qwen38-flash` ran without `--vision`                      | medium   | done        | lead             |
| CB-4  | No way to see failed turns without querying the database                                   | high     | done        | 8262d4c, 43b1a8a |
| CB-5  | Failed turns: inconsistent errors; Telegram may go silent                                  | high     | done        | f237a97          |
| CB-6  | Smoke and exit tests leave conversations in production accounts                            | medium   | done        | bf83a8f, 88f742b |
| CB-7  | Attachments are stored as base64 inside run history, with no cap                           | low      | open        |                  |
| CB-8  | Telegram file downloads ignore `TELEGRAM_API_ROOT`, so they can't be tested                | low      | open        |                  |
| CB-9  | Self-signed certificate: every browser warns at brain.example.test                         | low      | open        | user (proxy)     |
| CB-10 | The release guide (HTML) is out of date                                                    | low      | in progress | lead             |
| CB-11 | M3.8: topic mention in the team group not yet verified live                                | medium   | done        | user             |
| CB-12 | Qwen tool-call arguments sometimes fail to parse; one turn hit 90 s                        | low      | open        |                  |
| CB-13 | An empty Telegram message (e.g. a sticker) made the model reject the turn                  | medium   | done        | lead             |
| CB-14 | Mentions in a forum's General topic became private per-user conversations                  | medium   | done        | lead             |
| CB-15 | A run stored past its RUN_ERROR made its conversation unreadable                           | medium   | done        | lead             |
| CB-16 | An untargeted app build landed on node-2; a stray `company-brain:c8b900c` may remain there | low      | open        |                  |
| CB-17 | Links in Space pages did nothing when clicked                                              | medium   | done        | lead             |

## CB-1 Telegram link button (done)

The only entry point was a 14 px paper-plane icon between the user name and "Switch user". Now a labeled **Telegram** sidebar item with the connection status.

## CB-2 Photos break a conversation (done)

The Telegram adapter turns photos into `image` content parts. A text-only model rejects them (`400 image input requires a supported vision checkpoint served with --vision`), and because history is replayed every turn, each later turn in that conversation failed too. Attachments the model can't take now become a text note before the model call (`MODEL_ACCEPTS_IMAGES`, default false), which also repaired the stuck thread. The transcript shows `[image: image/jpeg]` markers.

## CB-3 Vision for the local model (done)

`TensorFold/Qwen3.8-Flash-Next-MLX-4bit-MTP` is a vision-language checkpoint (Hugging Face pipeline `image-text-to-text`, tags `vision-language`, `mlx-vlm`, ships `preprocessor_config.json`). The `qwen38-flash` stack starts TensorFold without `--vision`. Enabling it means adding `--vision` to both ranks' `TF_ARGS` and restarting the production stack, then setting `MODEL_ACCEPTS_IMAGES=true` in the Socio stack. Unknowns: memory and throughput cost of the vision tower at TP=2, and whether TensorFold 0.6.5 supports this checkpoint's vision path. Needs the user's OK; test on a quiet window.

Done 2026-10-07: TensorFold 0.6.5 refused `--vision` with `--tp 2`; two-rank image input landed in PR #473 that morning, on the `python-0.6` branch (not in a release; 1.0 serves Flash Next one request at a time). Built `tensorfold:0.6.6-vision` from `python-0.6@ed78d6f` on both Homelab via `tensorfold-prep`, then updated `qwen38-flash` with `TF_IMAGE=tensorfold:0.6.6-vision` and `TF_EXTRA_ARGS=--vision` (~2.5 min downtime). Text, tool calls and an image request pass; decode 75 tok/s, as before. Rollback: `~/stacks/tensorfold/qwen38-flash.rollback.env`. The app sends images (`MODEL_ACCEPTS_IMAGES=true`) and keeps the 4 most recent per request (`MODEL_MAX_IMAGES`, TensorFold's `--vision-max-images` default).

## CB-4 Failed-turn visibility (done)

The only record of a failed turn was the `agent_runs` table and an unlabeled container log line. Now an admin-only **Runs** view (`GET /api/runs`: the latest 200 turns across users, filterable by status, with source, owner, conversation, Dot, duration and the RUN_ERROR text; no message content) and one `Turn: <status> run=… thread=… user=… source=… ms=…[ error=<code>]` log line per finished turn.

## CB-5 Failed-turn behavior (done)

Within one conversation, two failures showed the generic "Socio could not complete this request" and the third showed the raw provider error. In Telegram the user had to ask "you there?", so a failed turn may post nothing. Wanted: one sanitized user-facing message per failure kind (with the raw error only in logs and the admin Runs view), and a Telegram reply on every failed turn.

Every failed turn now ends with exactly one `RUN_ERROR { message, code }`: a fixed message per kind (`model_rejected`, `model_unavailable`, `model_config`, `time_limit`, `stopped`, `failed`), the same in the app and Telegram; the sanitized provider text goes to the log (`Turn failed (run …): <kind>; <detail>`) and `agent_runs.errorDetail`, and Telegram posts the message itself on every failed turn.

## CB-6 Test data in production (done)

Verified live on 2026-10-07: `MOCK_USERS` adds `smoke-admin` and `smoke-member` on brain.example.test (the integration environment), the exit test passes there and deletes what it creates, and the seven earlier test conversations in alice's and bob's accounts were deleted with the user's OK.

`exit-test.mjs` and `ui-smoke.mjs --base https://brain.example.test` sign in as alice and bob and leave conversations ("Reply With Heron", "SQLite …") in their accounts. Wanted: tests against a deployment use dedicated users and clean up what they create. Existing leftovers are not deleted without the user's OK.

Done: away from loopback the scripts sign in as `smoke-admin`/`smoke-member` (appended to `MOCK_USERS`; or `--admin-user`/`--member-user`) and delete the conversations they created, with their task, through a new owner-only `DELETE /api/conversations/:id`. The existing leftovers in alice's and bob's accounts are untouched.

## CB-7 Attachment storage

Telegram photos (100–150 KB each, up to 5 per message, 8 MB cap per file) are stored base64 inside the `agent_runs` event JSON and replayed into every later turn's input. Consider storing them once, out of the run history, with a retention policy.

## CB-8 Telegram file download host

`@copilotkit/channels-telegram` downloads files from a fixed `https://api.telegram.org/file/bot…` URL, ignoring the `apiRoot` we pass, so the fake Telegram server can't cover inbound attachments.

## CB-9 Certificate

The proxy serves a self-signed certificate. Options: an internal CA trusted on the team's machines, or a real certificate for a public name.

## CB-10 Release guide

`company-brain-release-1.html` still says the proxy is pending, names Scratchpad as the only group, and uses an http URL.

## CB-11 Telegram topics live check (done)

Waiting on a mention of the bot in a the team group topic.

## CB-12 Model reliability

Logged `tool-args JSON parse failed (drain)` at 19:11 on 2026-10-07, and a 90-second turn limit hit at 19:09. Check how a malformed tool call surfaces to the user.

## CB-13 Empty messages (done)

On 2026-10-07 at 20:09 UTC a Telegram turn failed in 19 ms: its only user message had empty content (a sticker or an attachment that didn't come through), and the model rejected it. Empty user messages now reach the model as a short note.

## CB-14 General topic (done)

In a forum group, messages in General carry no topic ID, so the adapter keyed them per sender and each became a private conversation. The channel now records forum chats and maps General to one team conversation (`tg:<chat>:topic:general`, titled "Telegram General"), like any other topic. Conversations created before the change stay private.

## CB-15 Legacy run replay (done)

One run stored before CB-5 continued past its RUN_ERROR (a time-limit error followed by tool events); rebuilding its conversation threw `Cannot send event type 'TOOL_CALL_START'`, so the transcript returned 500. Stored runs are now cut at their first RUN_ERROR when replayed.

## CB-16 Stray app image

On 2026-10-07 at 20:43 UTC the app build went to node-2 (the Portainer agent routes an untargeted build to any node), so node-1 lacked `company-brain:c8b900c` and the service failed to start for about 2.5 minutes. `build-images.mjs` now sets `X-PortainerAgent-Target` (`BUILD_NODE`, default node-1). The image built on node-2 is unused; the agent did not honor the target header on image listing, so it was left in place. Remove it from Portainer's Images view for node-2.

## CB-17 Page links (done)

Space pages always render in the TipTap editor, which is `contentEditable`, and browsers don't follow links inside `contentEditable`. The link mark had `openOnClick: false`, and the editor's own click handler only acted on Cmd/Ctrl+click on a page link, so external links never opened and page links needed a modifier nobody knew about. The editor now follows links itself (`src/client/modules/pages/page-navigation.ts`, `followLink`): a plain click opens a page link in the app and an external http(s) or mailto link in a new tab without an opener; Cmd/Ctrl+click and middle-click open a new tab; Shift+click, Alt+click and drags still select text. Anything else (`javascript:`, `data:`, relative paths) is never followed. Chat replies use the same rules, and modified clicks on page links there now open a new tab instead of being captured. Browser check: `node scripts/ui-smoke.mjs --base http://127.0.0.1:<port> --scenario links` (loopback only; it creates pages).
