# Socio's push relay

A Cloudflare Worker with D1 that takes Web Push from Socio servers and sends it on to APNs and FCM,
so the Socio app gets notifications without running in the background. It never decrypts: the server
encrypts each push for the phone's own keys (RFC 8291), and the phone decrypts it. WebCrypto and
fetch only, no runtime dependency, no Effect, no `nodejs_compat`.

It runs on Ingenio Ventures' Cloudflare account, on Workers Paid. Nothing in this repository deploys
it: the operator's IaC does.

| Worker               | Host                                                        | For                                                       |
| -------------------- | ----------------------------------------------------------- | --------------------------------------------------------- |
| `socio-push-staging` | `https://push-staging.socio.sh`                             | internal test builds                                      |
| `socio-push`         | `https://push.socio.sh`                                     | every build that ships, TestFlight and internal tests too |
| (local)              | `127.0.0.1:8787`, or a quick tunnel's `*.trycloudflare.com` | `wrangler dev` on a developer's machine                   |

Each host is a Worker custom domain on the socio.sh zone (Ingenio Ventures' account, bought
2026-11-10): `routes = [{ pattern = "…", custom_domain = true }]` in `wrangler.toml`, so Cloudflare
makes the DNS record and the certificate on deploy. `workers_dev` is off in both environments, so
the custom domain is each Worker's only host: a push's VAPID `aud` must equal the one `RELAY_ORIGIN`,
and the servers allow exact host names only. The hosts are the ones the servers allow:
`DEFAULT_PUSH_HOSTS` in `src/server/notifications/contract.ts` names exactly these two, and
`tests/wrangler-config.test.ts` fails if `wrangler.toml` and that list drift apart.

## The API

`src/relay.ts`'s header has every answer. In short:

- **For the app** (no cookie, no account; the app picks the registration's id and secret and stores
  them first, so a retry finds the same registration):
    - `POST /v1/registrations` `{id, secret, platform, nativeToken, bundleId, apnsEnv, vapidKey}`: 201
      or 200 (a retry) with `{endpoint}`; 403 another secret; 409 another key, platform, bundle id
      or APNs host (never rebound); 400 anything invalid; 429 with Retry-After.
    - `PUT /v1/registrations/:id` `{secret, nativeToken?}`: the daily refresh. 204, 403, 410 unknown.
    - `DELETE /v1/registrations/:id` `{secret}`: 204, 403, 410 unknown.
- **For Socio servers**, as a Web Push service (RFC 8030, 8291, 8292), at the `endpoint`:
    - `POST /v1/push/:id` with an `aes128gcm` body and `Authorization: vapid t=…, k=…` (`aud` must be
      `RELAY_ORIGIN`): 201 forwarded (whole, or as the generic "Open the app" alert when it doesn't
      fit); 401 bad VAPID; 403 not the key the registration is bound to; 410 the registration or the
      phone's token is gone; 415; 429 and 503 with Retry-After.
- Nothing answers 404, and only a registration that is really gone answers 410: a Socio server
  deletes its subscription on either.

Quotas, per minute and per Cloudflare location (`src/quotas.ts`, the `[[ratelimits]]` in
`wrangler.toml`): 30 pushes per registration, 600 per workspace's VAPID key, 10,000 for everyone;
20 registration calls per client address, 600 for everyone. Registration writes also share a D1
write budget across every location (`REGISTRATION_WRITE_BUDGET`, 50 rows a minute;
`src/write-budget.ts`).

## What it keeps

- **D1** (`migrations/`): one row per phone and workspace: platform, native token, bundle id, APNs
  environment, the bound VAPID key, a SHA-256 of the registration's secret (never the secret), when it
  was made and the UTC date it was last refreshed (a date, not a time). Rows not refreshed in 60 days
  are dropped by the daily cron. Nothing is written per push.
- A per-minute count of rows written, for the write budget, kept up to about 25 hours: the daily
  03:17 UTC cleanup deletes the counts older than an hour.
- The APNs provider token (a JWT naming the key id and team id, valid an hour), shared between
  isolates so Apple isn't asked for a new one more than every 50 minutes. Never the private key.
- **No logs.** Workers Logs, invocation logs, traces, Logpush, Tail Workers and preview URLs are off in
  every environment (`wrangler.toml`; `tests/wrangler-config.test.ts`). They would record each
  request's URL, which holds the registration id, and its headers, which hold the client's address.
  The Worker's own log lines name an event and never an IP, id, token, key or secret. The client
  address is used only hashed, as a rate limiter's key.

What the relay learns anyway (SECURITY.md, "Push relay"): native tokens, when pushes happen, which
servers push (each push's VAPID subject is the workspace's origin; a placeholder is a later
change), and, because a phone's registrations share its native token, which workspaces reach the
same phone.

## Running it locally

From `apps/push-relay`, with the repository's install. Wrangler runs in local mode only (Miniflare and
workerd): local D1 under `.wrangler/` (git-ignored), local rate limiters, no Cloudflare account and no
`wrangler login`. The scripts set `WRANGLER_SEND_METRICS=false`, `DO_NOT_TRACK=1` and
`WRANGLER_HIDE_BANNER=true` (the banner checks npm for a newer wrangler).

```sh
pnpm run migrate:local          # wrangler d1 migrations apply DB --local, once
pnpm run dev --test-scheduled   # http://127.0.0.1:8787, RELAY_ORIGIN http://127.0.0.1:8787
```

- Another port: `pnpm run dev --port 8137 --inspector-port 9237 --var RELAY_ORIGIN:http://127.0.0.1:8137`.
  `RELAY_ORIGIN` must be the origin the servers push to, or every push is a 401 (`aud`).
- `--test-scheduled` adds `GET /__scheduled?cron=17+3+*+*+*`, which runs the daily task.
- `staging` and `production` run locally too (`pnpm run dev --env staging`), which shows the
  environment parses; local mode ignores the custom-domain route. Their `RELAY_ORIGIN` is the real
  host, so a local push only passes VAPID with `--var RELAY_ORIGIN:http://127.0.0.1:8787`.
- Without provider keys, registrations work and a push answers 503 ("fcm not configured"). For real
  sends, put the keys in a git-ignored `.dev.vars` (made-up or test keys only, never the owner's in a
  shared place, deleted afterwards). Put JSON values in single quotes; dotenv mangles escaped quotes
  inside double quotes:

    ```sh
    APNS_KEY_P8="-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----"
    APNS_KEY_ID=…
    APNS_TEAM_ID=…
    FCM_SERVICE_ACCOUNT_JSON='{"type":"service_account",…}'
    ```

- Harmless on a machine behind a proxy: "Proxy environment variables detected" (loopback is in `NO_PROXY`), and
  "ENOSPC: System limit for number of file watchers reached" (wrangler then doesn't reload on a config
  change; `CLOUDFLARE_DISABLE_CONFIG_WATCHING=true` skips the watcher).
- wrangler dev prints each request's method, path and status on its own console. That is local only.

Checked on 2026-11-10 against `wrangler dev --local`: a registration 201, its retry 200,
another secret 403, a refresh 204, a push with no VAPID 401, a push with no FCM keys 503
(Retry-After 30), `GET /` 400, a delete 204, a push after it 410, and the scheduled task.

### Behind a quick tunnel (the test bench)

A Cloudflare quick tunnel gives the local relay an https origin a phone and a local Socio server can
reach. It needs no account; only encrypted pushes cross it. Stop it when the run ends.

```sh
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8787   # prints https://<random>.trycloudflare.com
pnpm run dev --var RELAY_ORIGIN:https://<random>.trycloudflare.com
```

- The local Socio server: `PUSH_ENDPOINT_HOSTS=<random>.trycloudflare.com,*.googleapis.com,*.notify.windows.com,*.push.apple.com,*.push.services.mozilla.com`
  (setting it replaces the defaults).
- The app: a build with `SOCIO_RELAY_ORIGIN=https://<random>.trycloudflare.com` (apps/mobile/README.md).
  A new tunnel is a new origin, so it needs a new build.

## Deploying (the operator's IaC)

`wrangler.toml`'s top level is for local development only; always deploy with `--env staging` or
`--env production`, staging first, and production only after end-to-end pushes work on staging.
The socio.sh zone must be active on the account (it is, since 2026-11-10): deploying attaches each
environment's custom domain, with its DNS record and certificate. The deploy pipeline fills in what
is marked `deploy:`:

- the account (`CLOUDFLARE_ACCOUNT_ID` in its environment, never in the file);
- each environment's D1 database id, made and migrated (`wrangler d1 migrations apply DB --remote --env …`)
  before the first deploy;
- rate limiter namespace ids unique in the account, if 2001-2005 and 3001-3005 are taken;
- the secrets, as Worker secrets set by the deploy pipeline, never by hand: `APNS_KEY_P8`, `APNS_KEY_ID`,
  `APNS_TEAM_ID`, `FCM_SERVICE_ACCOUNT_JSON`. They stay in this Worker, apart from the directory's.

Cost on Workers Paid: a push takes about 0.5 ms of CPU, with about 3 ms once an hour per isolate for
the FCM assertion (measured locally); `limits.cpu_ms = 50` bounds a runaway request. Each
push, registration, refresh and delete is one request, and each push reads one D1 row. At the global
quota a single location could pass 14 million pushes a day, so the operator watches the request count
and CPU time in the dashboard's metrics (which stay on; only logs are off).

## Should the host ever change again

The relay's origin is built into the app (`SOCIO_RELAY_ORIGIN`, `https://push.socio.sh` for store and
TestFlight builds) and is in every subscription's endpoint, so moving it to another host costs:

1. **A new app build** with the new `SOCIO_RELAY_ORIGIN`, through the stores.
2. **Every phone registering again** against the new origin (the app does it on the new build's first
   run): a new registration and a new subscription per workspace. Phones still on the old build keep
   using the old host.
3. **Every server allowing both hosts:** the new host joins `DEFAULT_PUSH_HOSTS` (a server release)
   and, where a deployment sets it, `PUSH_ENDPOINT_HOSTS`, before the new build ships. The old host
   stays in both until phones have moved: a host that leaves the list deletes every subscription on
   it at the next send.

The old Worker keeps running on the old host, with its own `RELAY_ORIGIN` and D1, until phones have
moved: one Worker can't serve both hosts, because a push's VAPID `aud` must equal its single
`RELAY_ORIGIN` (accepting two would be a code change). It can go once nothing has registered or
refreshed on it for 60 days.
