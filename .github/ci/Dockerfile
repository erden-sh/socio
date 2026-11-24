# CI's image (.github/workflows/ci.yml), built with .github/ci as its only
# context: the Node the app ships with (the Dockerfile's
# node:26.13.0-bookworm-slim, pinned by digest), git for the tests, Go so a
# test can decode forwarded Docker bodies with encoding/json, jq for the
# tests, pnpm, and the egress proxy.
# Every branch's code runs in it with `--network none`; the install runs in
# it behind the proxy. Trusted: under .github/, which
# coding sessions never push (CB-32).
FROM node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9
RUN apt-get update && apt-get install -y --no-install-recommends git golang-go curl jq && rm -rf /var/lib/apt/lists/*
# pnpm (CB-183): corepack's, at the version and hash in package.json's
# packageManager (tests/ci-workflow.test.ts keeps the two in step), fetched
# here while the image builds, into a COREPACK_HOME every user can read. The
# containers never download it: a branch that asks for another pnpm fails.
# Node 26 dropped corepack from the base image, so install it with npm first.
ENV COREPACK_HOME=/opt/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN npm install -g corepack && corepack enable pnpm \
  && corepack install --global pnpm@10.15.0+sha512.486ebc259d3e999a4e8691ce03b5cac4a71cbeca39372a9b762cb500cfdf0873e2cb16abe3d951b1ee2cf012503f027b98b6584e4df22524e0c7450d9ec7aa7b \
  && chmod -R a+rX /opt/corepack
ENV COREPACK_ENABLE_NETWORK=0
COPY egress-proxy.mjs /ci/egress-proxy.mjs
# Chromium for the UI smoke (CB-316): the same browser the app's chromium
# stage ships (Dockerfile AS chromium), baked here while the image builds,
# so ui-smoke.mjs runs in the no-network box. Pinned to the playwright the
# lockfile names (tests/ci-workflow.test.ts checks the count of FROM lines,
# not this). PLAYWRIGHT_BROWSERS_PATH is world-readable so user 65534 finds it.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm install -g playwright@1.63.0 \
  && node /usr/local/lib/node_modules/playwright/cli.js install --with-deps chromium \
  && chmod -R a+rX /ms-playwright \
  && npm uninstall -g playwright \
  && rm -rf /root/.npm /tmp/*
