# Node is pinned to an exact version: a floating node:24 moved to 24.21,
# which refused a backup setting and broke scheduled backups (2026-10-12).
# Bump it on purpose, in every stage at once, and run the gate and the
# smokes on the new version first. Since CB-203 it is the latest LTS,
# 26.13.0, pinned by digest, the same as .github/ci/Dockerfile, .nvmrc,
# .node-version and package.json's engines (tests/ci-workflow.test.ts).
FROM node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9 AS build
# No install-time analytics either (Scarf, via CopilotKit); package.json
# also carries scarfSettings.enabled = false. Node 26 no longer ships
# corepack in the base image, so install it with npm first; pnpm then comes
# from corepack at the version and hash in package.json's packageManager
# (CB-183); .npmrc's engine-strict fails the install on a Node outside
# package.json's engines.
ENV DO_NOT_TRACK=1 SCARF_ANALYTICS=false COREPACK_HOME=/opt/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
# vendor/ holds the do-nothing stand-ins for CopilotKit's telemetry senders
# (@scarf/scarf, @segment/analytics-node). package.json links them with
# link: specs, so every stage that installs or copies node_modules copies
# vendor/ too; the root postinstall (vendor/check-stubs.cjs) fails the
# install if they are missing.
# Only the root's manifest: packages/client has no node_modules here and
# resolves from /app/node_modules, so what it imports is in this manifest too
# (packages/client/README.md, tests/integration/client-package.test.ts).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY vendor ./vendor
# patches/ holds the patch files pnpm-workspace.yaml's patchedDependencies
# lists. pnpm reads every one on each install, even for packages it doesn't
# install (today all are the native app's, which no image builds), so every
# stage that installs copies it.
COPY patches ./patches
# BuildKit cache mounts (CB-330): the pnpm store and corepack's cache persist
# across builds and stages, so the second pnpm install (and every later build)
# hardlinks from the cache instead of downloading. The store lives at pnpm's
# default for root (/root/.local/share/pnpm/store); COREPACK_HOME (/opt/corepack)
# holds the pnpm binary itself. Requires the BuildKit builder (scripts/build-images.mjs).
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    --mount=type=cache,target=/opt/corepack \
    npm install -g corepack && corepack enable pnpm && pnpm install --frozen-lockfile
COPY . .
# The commit the app reports with its version (CB-165): there is no .git
# here. scripts/build-images.mjs passes it.
ARG APP_COMMIT=
# The build puts the workspace packages inside dist/server
# (scripts/build-packages.mjs), so every stage below that copies dist/server
# has them, with no line of its own.
RUN pnpm run build

# The production dependencies (no dev ones) for the app, browser and
# apps-runtime images, which copy node_modules from here: pnpm's store and
# caches and corepack's copy of pnpm stay behind in this stage. pnpm also
# installs DuckDB's musl binding (about 90 MB), which these Debian (glibc)
# images can't load; it goes here, links and all, before any image copies it.
FROM node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9 AS prod-deps
ENV DO_NOT_TRACK=1 SCARF_ANALYTICS=false COREPACK_HOME=/opt/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY vendor ./vendor
COPY patches ./patches
# The same cache mounts as the build stage: the pnpm store has the full
# install already, so --prod hardlinks from it in seconds.
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    --mount=type=cache,target=/opt/corepack \
    npm install -g corepack && corepack enable pnpm && pnpm install --frozen-lockfile --prod \
    && rm -rf node_modules/.pnpm/@duckdb+node-bindings-*-musl@* node_modules/.pnpm/*/node_modules/@duckdb/node-bindings-*-musl \
       node_modules/.pnpm/node_modules/@duckdb/node-bindings-*-musl \
    && rm -rf node_modules/.pnpm/mermaid@* node_modules/.pnpm/@mermaid-js+* \
       node_modules/.pnpm/streamdown@* node_modules/.pnpm/cytoscape@* \
       node_modules/.pnpm/cytoscape-cose-bilkent@* node_modules/.pnpm/cytoscape-fcose@* \
       node_modules/.pnpm/d3@* node_modules/.pnpm/@types+d3@* \
       node_modules/.pnpm/katex@* node_modules/.pnpm/@upsetjs+venn.js@* \
    && rm -rf node_modules/.pnpm/lucide-react@0.525.0* node_modules/.pnpm/lucide-react@0.542.0* \
       node_modules/.pnpm/lucide-react@1.61.0* node_modules/.pnpm/lucide@0.525.0* \
    && rm -rf node_modules/.pnpm/typescript@* node_modules/.pnpm/@typescript+typescript-linux-x64@*
# CB-331: the strips above remove client-only packages from the same
# layer as the install, so COPY --from=prod-deps never copies them. A
# later `rm` in the app stage would only add a whiteout layer, not
# shrink the image; pruning here reclaims ~200 MB for real.
# - mermaid/streamdown/cytoscape/d3/katex: transitive deps of CopilotKit's
#   chat renderer, bundled into dist/web/client/assets/ during the Vite
#   build. The server never imports them at runtime (verified: no
#   references in dist/server/).
# - lucide-react 0.525.0/0.542.0/1.61.0 + lucide 0.525.0: duplicate versions
#   pulled by CopilotKit (0.525.0), streamdown (0.542.0), fumadocs-ui
#   (1.61.0), and the stubbed-out web-inspector (lucide). At runtime all
#   externalized `from "lucide-react"` imports resolve to 1.48.0 (the
#   app's direct dep), so the older copies are dead weight.
# - typescript + @typescript/typescript-linux-x64 (34 MB): a peer dep of
#   react-router, drizzle-orm, tanstack/db, valibot. Not hoisted to the
#   app's node_modules (require.resolve('typescript') already fails in
#   the image), so nothing loads it at runtime. The Shiki grammar chunks
#   in dist/web/server/assets/ are from @shikijs/langs, not the compiler.
# Apples-to-apples on v0.30.0: 1732 MB -> 1495 MB (237 MB / 13.7% saved).

# The same without DuckDB (CB-186), for the browser and apps-runtime images:
# it is the analytics process's alone. The files are in node_modules/.pnpm
# (node_modules/@duckdb holds only links to them), and they go in this stage,
# so the images that copy from it never hold them; the build fails if any
# are left.
FROM prod-deps AS prod-deps-slim
RUN rm -rf node_modules/@duckdb node_modules/.pnpm/@duckdb+* node_modules/.pnpm/node_modules/@duckdb \
    && test -z "$(find node_modules -path '*@duckdb*' -print -quit)" \
    && ! node -e "require.resolve('@duckdb/node-api')" 2>/dev/null

# The restore drill's `litestream restore` (CB-111): the litestream
# service's own release (tests/restore-drill.test.ts keeps the two tags in
# step). The app only restores, into scratch files; the service alone
# replicates.
FROM litestream/litestream:0.5.17 AS litestream
FROM node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9 AS app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4310 DATABASE_PATH=/data/company-brain.sqlite \
    DO_NOT_TRACK=1 COPILOTKIT_TELEMETRY_DISABLED=true COPILOTKIT_TELEMETRY_SAMPLE_RATE=0
WORKDIR /app
# Socio's license and third-party notices travel with every image (CB-312).
COPY LICENSE THIRD_PARTY_NOTICES ./
LABEL org.opencontainers.image.title="Socio" \
      org.opencontainers.image.vendor="Ingenio Ventures Inc." \
      org.opencontainers.image.licenses="LicenseRef-Sustainable-Use-License" \
      org.opencontainers.image.source="https://github.com/erden-sh/socio"
COPY package.json ./
# node_modules links the telemetry stand-ins to ../vendor; copy it too.
COPY vendor ./vendor
COPY --from=prod-deps /app/node_modules ./node_modules
RUN node vendor/check-stubs.cjs && mkdir -p /data /backups && chown node:node /data /backups
# The Operations analytics store's DuckDB binding (CB-186): about 94 MB
# unpacked (2.0.0-r.1, linux-x64 glibc), the image's growth. It must load
# here, with no network, and the build fails past 120 MB so that growth is
# a decision. pnpm keeps the files in node_modules/.pnpm (node_modules/@duckdb
# holds only links), so the size is measured there, following the links.
RUN node -e "import('@duckdb/node-api').then(async ({ DuckDBInstance }) => (await DuckDBInstance.create(':memory:')).closeSync())" \
    && du -scLm node_modules/.pnpm/@duckdb+* | awk '$2 == "total" { print "DuckDB adds " $1 " MB"; if ($1 > 120) exit 1 }'
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY --from=build /app/dist ./dist
# Server-only help articles: never Vite inputs or public assets.
COPY --from=build /app/content/docs ./content/docs
# The pages' server build loads only production dependencies; with dev
# dependencies omitted above, an import of one fails the image here.
RUN node -e "import('./dist/web/server/index.js')"
USER node
EXPOSE 4310
# CB-318: a failed healthcheck captures the blocked thread's JavaScript
# stack (src/server/healthcheck.ts): SIGUSR1 opens Node's inspector on this
# container's own loopback at this port for a moment, and the stack goes to
# the data volume. Nothing listens until a check fails.
ENV REPORT_DIR=/data/reports \
    NODE_OPTIONS="--inspect-port=127.0.0.1:9339"
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "dist/server/server/healthcheck.js"]
CMD ["node", "dist/server/server/index.js"]

# The Operations analytics service (CB-186): the app image running its
# analytics process instead, which owns /data/analytics and reads the
# database read-only. The stack runs it as the one-replica socio-analytics
# with the data volume (docs/OPERATIONS-ANALYTICS.md); only the app calls it,
# with the shared secret (OPS_ANALYTICS_SECRET_FILE).
FROM app AS analytics
ENV OPS_ANALYTICS_MODE=service OPS_ANALYTICS_HOST=0.0.0.0 OPS_ANALYTICS_PORT=4340
EXPOSE 4340
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.OPS_ANALYTICS_PORT||4340)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/server/server/operations/analytics/analytics-main.js"]

# The updater sidecar (CB-259): the app image running the updater instead,
# opt-in, in a Portainer stack of its own so an
# app update never replaces it mid-way. Only the app calls it, with the
# shared token (UPDATER_TOKEN_FILE); it calls the Portainer stack API and
# the app's /healthz. /state keeps the update in progress.
FROM app AS updater
USER root
RUN mkdir -p /state && chown node:node /state && chmod 0700 /state
USER node
ENV UPDATER_HOST=0.0.0.0 UPDATER_PORT=4350 UPDATER_STATE_DIR=/state
EXPOSE 4350
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.UPDATER_PORT||4350)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/server/updater/index.js"]

# Node, the slim dependencies and Playwright's Chromium: the base of the app
# browser below. (It was also the standalone browser service, retired in
# CB-319: socios read pages with their computer's browser.)
FROM node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9 AS chromium
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DO_NOT_TRACK=1 COPILOTKIT_TELEMETRY_DISABLED=true COPILOTKIT_TELEMETRY_SAMPLE_RATE=0
WORKDIR /app
# Socio's license and third-party notices travel with every image (CB-312).
COPY LICENSE THIRD_PARTY_NOTICES ./
LABEL org.opencontainers.image.title="Socio" \
      org.opencontainers.image.vendor="Ingenio Ventures Inc." \
      org.opencontainers.image.licenses="LicenseRef-Sustainable-Use-License" \
      org.opencontainers.image.source="https://github.com/erden-sh/socio"
COPY package.json ./
COPY vendor ./vendor
# DuckDB is the analytics process's alone (CB-186): not in this image.
COPY --from=prod-deps-slim /app/node_modules ./node_modules
RUN node vendor/check-stubs.cjs && node node_modules/playwright/cli.js install --with-deps chromium \
    && chmod -R a+rX /ms-playwright
COPY --from=build /app/dist/server ./dist/server
USER node

# The app browser (CB-232; dark, not in the default stack): delegated
# app sessions, one worker process per person + socio + grant, each its own
# user (21000 + slot) running one Chromium with its sandbox on, locked to one
# app origin. The chromium stage's Node, dependencies and Chromium; only the
# users and the command differ. The router starts as root only so setpriv
# can hand node what it needs to run workers as their users and stop them
# (setuid, setgid, kill); workers get no capabilities and no new privileges.
# The stack drops every other capability and gives it the seccomp profile
# Chromium's sandbox needs (deployment/app-browser/seccomp.json); without a
# usable sandbox the router's self-test refuses to serve.
FROM chromium AS app-browser
USER root
RUN for slot in $(seq 0 64); do \
      groupadd --gid $((21000 + slot)) "appb$slot" \
      && useradd --uid $((21000 + slot)) --gid $((21000 + slot)) --no-create-home --home-dir /tmp \
         --shell /usr/sbin/nologin "appb$slot"; \
    done
ENV APP_BROWSER_HOST=0.0.0.0 APP_BROWSER_PORT=4360 APP_BROWSER_UID_BASE=21000
EXPOSE 4360
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.APP_BROWSER_PORT||4360)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["setpriv", "--reuid=node", "--regid=node", "--init-groups", "--inh-caps=-all,+setuid,+setgid,+kill", \
     "--ambient-caps=-all,+setuid,+setgid,+kill", "--", "node", "dist/server/app-browser/main.js"]

# coding-git (CB-239, CB-267): the coding gateway's push
# inspection and extraction service. git and the compiled service only (it
# loads Node's built-ins and its own modules, the @socio packages among them, inside
# dist/server; no dependencies), run as node,
# never root. No outside network and no GitHub credential: the app fetches
# from GitHub and streams packs here, and reads back what passed. Mirrors
# and spools live on its own volume. Only the app calls it, with a key
# derived from the secret the two share (a swarm secret, never baked in).
FROM node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9 AS coding-git
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
ENV CODING_GIT_DIR=/srv/coding-git CODING_GIT_PORT=4350 CODING_GIT_HOST=0.0.0.0
WORKDIR /app
# Socio's license and third-party notices travel with every image (CB-312).
COPY LICENSE THIRD_PARTY_NOTICES ./
LABEL org.opencontainers.image.title="Socio" \
      org.opencontainers.image.vendor="Ingenio Ventures Inc." \
      org.opencontainers.image.licenses="LicenseRef-Sustainable-Use-License" \
      org.opencontainers.image.source="https://github.com/erden-sh/socio"
COPY --from=build /app/package.json ./
COPY --from=build /app/dist/server ./dist/server
RUN mkdir -p /srv/coding-git && chown node:node /srv/coding-git && chmod 0700 /srv/coding-git
USER node
EXPOSE 4350
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.CODING_GIT_PORT||4350)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/server/coding-git/main.js"]

# The workspace app runtime: promoted mini apps, each its own Bun
# process under its own uid (setpriv: no capabilities, no new privileges),
# with prlimit limits and a memory watchdog, reachable only through the
# runtime's ingress, egress only through the apps' egress proxy (the same
# image, command egress-main.js). No shell for agents: nothing here takes
# commands but the app's token-authenticated API. The container starts as
# root only so setpriv can hand node what it needs to run apps as their own
# users and give them their directories (setuid, setgid, chown, kill); the
# stack drops every other capability. Nothing it holds is durable.
FROM oven/bun:1.3.14-slim AS bun
FROM node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9 AS apps-runtime
ENV NODE_ENV=production APPS_RUNTIME_HOST=0.0.0.0 APPS_RUNTIME_PORT=4330 APPS_RUNTIME_INGRESS_PORT=4331 \
    APPS_RUNTIME_DIR=/srv/apps APPS_RUNTIME_UID_BASE=20000 APPS_RUNTIME_GID=1000 APPS_RUNTIME_PRLIMIT=on \
    APPS_RUNTIME_COMMAND=bun \
    DO_NOT_TRACK=1 COPILOTKIT_TELEMETRY_DISABLED=true COPILOTKIT_TELEMETRY_SAMPLE_RATE=0
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
# Socio's license and third-party notices travel with every image (CB-312).
COPY LICENSE THIRD_PARTY_NOTICES ./
LABEL org.opencontainers.image.title="Socio" \
      org.opencontainers.image.vendor="Ingenio Ventures Inc." \
      org.opencontainers.image.licenses="LicenseRef-Sustainable-Use-License" \
      org.opencontainers.image.source="https://github.com/erden-sh/socio"
COPY package.json ./
COPY vendor ./vendor
# DuckDB is the analytics process's alone (CB-186): not in this image.
COPY --from=prod-deps-slim /app/node_modules ./node_modules
RUN node vendor/check-stubs.cjs && mkdir -p /srv/apps && chown node:node /srv/apps && chmod 0711 /srv/apps
COPY --from=build /app/dist/server ./dist/server
EXPOSE 4330 4331
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.APPS_RUNTIME_PORT||4330)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["setpriv", "--reuid=node", "--regid=node", "--init-groups", "--inh-caps=-all,+setuid,+setgid,+chown,+kill", \
     "--ambient-caps=-all,+setuid,+setgid,+chown,+kill", "--", "node", "dist/server/apps-runtime/index.js"]

# The social strategy plugin (docs/PLUGINS.md). It inherits this stage's
# node_modules (prod-deps-slim already has them) and copies the server
# build plus the planner's static UI. The default stack does not run it:
# an admin installs it, and the apps runtime starts this image as its own
# service. `FROM prod-deps-slim` keeps the Node pin on the stages above
# (tests/ci-workflow.test.ts).
FROM prod-deps-slim AS plugin-social-strategy
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 \
    DO_NOT_TRACK=1 COPILOTKIT_TELEMETRY_DISABLED=true COPILOTKIT_TELEMETRY_SAMPLE_RATE=0
WORKDIR /app
# Socio's license and third-party notices travel with every image (CB-312).
COPY LICENSE THIRD_PARTY_NOTICES ./
LABEL org.opencontainers.image.title="Socio" \
      org.opencontainers.image.vendor="Ingenio Ventures Inc." \
      org.opencontainers.image.licenses="LicenseRef-Sustainable-Use-License" \
      org.opencontainers.image.source="https://github.com/erden-sh/socio"
COPY --from=build /app/dist/server ./dist/server
# Built by scripts/build-planner-ui.mjs during `pnpm build`. Not part of tsc.
COPY --from=build /app/src/server/plugins/planner/ui ./dist/server/server/plugins/planner/ui
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/server/server/plugins/planner/main.js"]

# The coding sandboxes' egress proxy (CB-239): Node and the
# compiled server only, no dependencies (it imports Node's built-ins and
# four of Socio's own files, in dist/server). The computers stack runs it as coding-egress,
# connected by the supervisor to every coding sandbox's internal network;
# its only ways out are the gateway listener and the registries. No CONNECT.
FROM node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9 AS coding-egress
ENV NODE_ENV=production CODING_EGRESS_HOST=0.0.0.0 CODING_EGRESS_PORT=3128 CODING_EGRESS_DIAGNOSTICS_PORT=3129
WORKDIR /app
# Socio's license and third-party notices travel with every image (CB-312).
COPY LICENSE THIRD_PARTY_NOTICES ./
LABEL org.opencontainers.image.title="Socio" \
      org.opencontainers.image.vendor="Ingenio Ventures Inc." \
      org.opencontainers.image.licenses="LicenseRef-Sustainable-Use-License" \
      org.opencontainers.image.source="https://github.com/erden-sh/socio"
COPY package.json ./
COPY --from=build /app/dist/server ./dist/server
RUN node -e "import('./dist/server/coding-egress/proxy.js')"
USER node
EXPOSE 3128 3129
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.CODING_EGRESS_PORT||3128)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/server/coding-egress/main.js"]
