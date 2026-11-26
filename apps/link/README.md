# Socio's link domain

A Cloudflare Worker for `link.socio.sh` (and `link-staging.socio.sh`), the host of every link that
opens the Socio app (the app's README, "Getting in"). The links and
their kinds are `@socio/shared/device-sign-in`'s (`appLink`, `parseAppLink`). Nothing in this
repository deploys it: the operator's IaC does. SECURITY.md, "Link domain (the mobile app)",
says what it sees and keeps.

## Hosts

Each host serves only the variants whose builds use it (`src/apps.ts`, `HOST_VARIANTS`, as the
mobile app's `apps/mobile/plugins/app-links.ts` picks hosts):

| Host                    | Variants            | Android keys                                                |
| ----------------------- | ------------------- | ----------------------------------------------------------- |
| `link.socio.sh`         | production, preview | the Play signing key's and the preview keystore's (private) |
| `link-staging.socio.sh` | development         | the public React Native debug key                           |

The public debug key never appears on `link.socio.sh`: anyone can sign an APK with it and the
development package, and an APK picks its own `pathPrefix`, so on a shared host it could take
production links. `/dev/…` answers 404 on `link.socio.sh`, `/app/…` and `/preview/…` answer 404 on
staging, and any other host answers 404 to everything. A server makes development links only on
staging's host or a bench tunnel ("The server's settings", below).

`wrangler.toml` has one environment per host: `staging` (Worker `socio-link-staging`) on
`link-staging.socio.sh` and `production` (Worker `socio-link`) on `link.socio.sh`, each a Worker
custom domain. Both run the same code; each Worker only ever sees its own host.

## What it serves

- `/.well-known/apple-app-site-association`: `applinks` with each of the host's variants' app ids
  claiming only its own path prefix (`/app/*`, `/preview/*`, `/dev/*`), and `webcredentials` with
  the same app ids, which the sign-in sheet's https callback needs.
- `/.well-known/assetlinks.json`: each variant's package and signing key fingerprints. Android
  keeps a variant to its own path through the app's intent filter (`pathPrefix`).
- A static page for each link, `/<variant path>/<kind>…`, which a browser shows when no app took
  the link. No page links to itself (iOS keeps a same-host link in Safari), and no custom-scheme
  URL carries anything, since a scheme isn't verified:
    - `cb` (the sheet's callback): "Go back to the Socio app and choose Continue again". No button,
      never the code.
    - `c`: the sign-in code, to type into the app.
    - `d` (Add a device): "open this link from your camera or a message so it opens in the app", or
      reinstall Socio and scan the code again, or get the app. Never the pairing code.
    - `i` (an invite): the workspace host, and "Set your password" on the web, only on a tap.
    - `w` (the workspace): an "Open the Socio app" link to the variant's bare scheme (`socio://`),
      which opens the app as it is.
- Anything else: a plain 404 page. GET and HEAD only.

The Worker sees paths only. Codes and invite tokens ride in the fragment, which no request carries;
each page's one inline script reads it and only fills in the page (`src/page-script.ts`). The pages
load nothing else, and their CSP allows only their own script and style, by hash. No logs: Workers
Logs, traces and Logpush are off (`wrangler.toml`), and the Worker writes no log line and keeps
nothing. Production paths refuse a workspace host with a port, as the production app does.

## Placeholders the owner fills in

In `src/apps.ts`, each pinned by `tests/apps.test.ts`:

- `APPLE_TEAM_ID`: the team id that signs the three iOS apps.
- The production Android fingerprint: the Play app signing key's SHA-256 (Play Console, App signing).

Filled in: the preview Android fingerprints, Socio Preview's Play app signing keys (Play Console,
Deep links; never the upload key). Preview APKs installed outside Play are signed with the public
debug key, so their links don't verify on `link.socio.sh`, by design.

Development uses the React Native template's public debug key, which every `expo prebuild` writes.
`STORE_LINKS` in `src/pages.ts` is empty until the launch; the pages then say to ask the admin.

## Running it locally

From `apps/link`, with the repository's install. Local mode only: no Cloudflare account and no
`wrangler login`. The script sets `WRANGLER_SEND_METRICS=false`, `DO_NOT_TRACK=1` and
`WRANGLER_HIDE_BANNER=true`.

```sh
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8791   # the bench: prints https://<random>.trycloudflare.com
pnpm run dev --port 8791 --inspector-port 9291 --var DEV_LINK_HOST:<random>.trycloudflare.com
```

The Worker answers only its known hosts and `DEV_LINK_HOST`, served as development. Pass it with
`--var` only, never in `wrangler.toml`; it can't make a known host serve development. Locally,
send the host you want as the `Host` header (`curl -H 'Host: link.socio.sh' http://127.0.0.1:8791/…`).
A development build made with `SOCIO_LINK_HOST=<tunnel host>` verifies its links against the
tunnel (`?mode=developer` on iOS). Stop the tunnel when the run ends.

### The server's settings

A workspace server puts its links on the link domain with these settings (`.env.example`,
`src/server/auth/settings.ts`):

- `AUTH_APP_LINK_HOST`: the production and preview builds' links, `link.socio.sh` by default.
- `AUTH_APP_LINK_HOST_DEV`: the development build's links (`/dev/…`), `link-staging.socio.sh` by
  default. It must not be the production host (`link.socio.sh` or `AUTH_APP_LINK_HOST`): the server
  refuses to start, since that host answers `/dev/…` with a 404.
- `AUTH_APP_PREVIEW_LINKS`: `true` makes the links the server starts on its own (Add a device's QR
  code) for the preview build (`/preview/…`) instead of production's (`/app/…`); an
  operator's test setting. Off by default.
- `AUTH_APP_DEV_LINKS`: `true` lets Add a device make links for the development build too, on
  `AUTH_APP_LINK_HOST_DEV`. Local testing only: the server refuses to start with it under
  `NODE_ENV=production`. Off by default; the bench's fake servers turn it on with `--dev-links`
  (`apps/mobile/e2e/servers.mjs`).

Either host is a host name with an optional port; a `:443` is dropped, since links are https. Links a
build asks for itself (the sign-in sheet's callback, a sign-in code's link) carry that build's path,
on its variant's host.

On the bench, with this Worker behind a tunnel, the server sets `AUTH_APP_LINK_HOST_DEV` to the tunnel
host (`<random>.trycloudflare.com`) and, for Add a device, `AUTH_APP_DEV_LINKS=true`. A development
build made with `SOCIO_LINK_HOST=<tunnel host>` then opens every link the server makes for it.
Production servers set none of these.

## Deploying (the operator's IaC)

Nothing here deploys; the deploy pipeline does. Always with `--env staging` or
`--env production`, staging first, with `WRANGLER_SEND_METRICS=false DO_NOT_TRACK=1`. Deploying
attaches each environment's custom domain, with its DNS record and certificate, on the socio.sh zone.
The account comes from `CLOUDFLARE_ACCOUNT_ID` in the deploy pipeline's environment, never from the file. The
deployed Workers have no secret, no variable and no binding. Production can go up with the production Android
placeholder above still in place: until the owner fills it in (a reviewed change to `src/apps.ts`
and `tests/apps.test.ts`, then a redeploy), the production build's Android links don't
verify. The Apple team id is already filled in.

Checking a deploy (a generic User-Agent, nothing about anyone):

```sh
for host in link-staging.socio.sh link.socio.sh; do
  for file in apple-app-site-association assetlinks.json; do
    curl -sS -o /dev/null -w "$host $file %{http_code} %{content_type}\n" -A 'research-script/0.1' "https://$host/.well-known/$file"
  done
done
for url in https://link.socio.sh/dev/cb https://link-staging.socio.sh/app/cb https://link-staging.socio.sh/dev/cb https://link.socio.sh/app/cb; do
  curl -sS -o /dev/null -w "$url %{http_code}\n" -A 'research-script/0.1' "$url"
done   # 404, 404, then 200, 200
```

Each association file answers 200 with `application/json`, and names only that host's builds:
staging's the development app ids and the debug key, production's the production and preview ones.
