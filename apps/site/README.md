# Socio's public site (`apps/site`)

The site at **https://socio.sh**: what Socio is, self-hosting, the hosted waitlist, support, and
the pages the app stores link to (privacy, terms, cookies, delete account).

**The brand, the socio characters and the legal text are not licensed for reuse.** They belong to
Ingenio Ventures Inc.; the code license grants no trademark rights. A fork must replace them.

## How it is built

- **Pages:** HTML rendered at build time from TypeScript (`src/build/`), no React and no
  framework. `layout.ts` is the shell (head tags, header with Sebas as the logo, footer, the cookie
  banner and dialog); `pages/` holds each page; `facts.ts` holds what the site states (the
  addresses, the governing law, the retention windows, the page list).
- **Styles:** Tailwind 4 (theme and utilities, prefixed `tw:`, no preflight) plus the site's own
  rules (`src/styles/components.css`), ported from the mockups. The tokens (`tokens.css`) are a
  copy of the web client's; `tests/tokens.test.ts` fails if they drift. Light and dark follow
  `prefers-color-scheme`; nothing is stored.
- **Script:** one module (`src/client/main.ts`), the cookie choice only (`consent.ts`). The pages
  work without it.
- **Art:** the eight characters come from `packages/client/src/locals/art` at build time, the
  cream tile behind sebas, manny, mingo and rulo stripped (`src/build/art.ts`). The favicon is
  Sebas.
- **Images:** the og cards and the apple-touch icon are committed in `public/`, rendered by
  `pnpm run og` (`scripts/render.mjs`, Playwright's Chromium, offline) after a build.
- **Files:** `/.well-known/security.txt` (its Expires is renewed when `tests/files.test.ts` says
  so), `robots.txt`, `sitemap.xml`, `llms.txt`, `llms-full.txt`, and `_headers` (the strict
  headers for the static assets, from `src/worker/headers.ts`).

`pnpm run build` writes `dist/` for production; `pnpm run build:staging` writes it for staging
(robots disallows all, every response says `noindex`). wrangler runs the right one per
environment (`[build]` in `wrangler.toml`).

## The Worker

`src/worker/index.ts`. Cloudflare serves `dist/` straight from the static assets; only the paths in
`run_worker_first` reach the Worker. Today that is `/forms`, which answers 503 with the addresses
to write to until the form handler lands. No logs, no storage, no account id: see the comments in
`wrangler.toml` and `tests/wrangler-config.test.ts`.

## What comes next

1. **Done:** the site, its pages, files, headers and tests.
2. Analytics: `posthog-js` bundled into the site's script, the proxy route in the Worker, the
   consent wiring (`ASK_ON_ARRIVAL` and `onChoice` in `consent.ts`).
3. Forms: the `/forms` handler, Turnstile (in `turnstileSlot`), D1, the rate limit, the honeypot
   check, the retention cron and the email notice.
4. The demo seed and real screenshots for the drawn app.
5. The handoff to the deploy pipeline (DNS, staging, D1, Turnstile, secrets, PostHog).

Nothing here deploys: the operator's IaC does.

## Commands

```
pnpm run build          # dist/ for production
pnpm run build:staging  # dist/ for staging
pnpm run og             # re-render public/og/*.png and the touch icon (after a build)
pnpm run dev            # build, then wrangler dev --local
pnpm test               # builds into a temp dir and checks it
```
