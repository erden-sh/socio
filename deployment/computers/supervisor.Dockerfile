# Source comes from the exact OpenBot revision in .docker/compose.computers.yml.
FROM oven/bun:1.3.14-alpine
WORKDIR /app
COPY --from=openbot supervisor/package.json supervisor/bun.lock ./
# BuildKit cache mount (CB-330): bun's global cache persists across builds,
# so repeat installs hardlink from cache instead of re-downloading.
# Requires the BuildKit builder (scripts/build-images.mjs).
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile
COPY --from=openbot supervisor/src ./src
COPY deployment/computers/resource-stats.mjs deployment/computers/resource-stats.d.mts ./src/
# A purged socio's computer, removed for good (POST /computers/:botId/destroy).
COPY deployment/computers/computer-destroy.mjs deployment/computers/computer-destroy.d.mts ./src/
# The coding sandboxes' fixed-spec API (CB-239), mounted by harden-supervisor.mjs.
COPY deployment/computers/coding-sandbox.mjs deployment/computers/coding-sandbox.d.mts ./src/
COPY deployment/computers/LICENSE.openbot ./LICENSE.openbot
# The disk usage proxy (CB-197) runs from this image as its own service.
COPY deployment/computers/disk-usage-proxy.mjs ./disk-usage-proxy.mjs
COPY deployment/computers/patch.mjs /tmp/harden/patch.mjs
COPY deployment/computers/harden-supervisor.mjs /tmp/harden/harden-supervisor.mjs
RUN bun /tmp/harden/harden-supervisor.mjs /app/src && rm -r /tmp/harden
EXPOSE 4300
CMD ["bun", "src/index.ts"]
