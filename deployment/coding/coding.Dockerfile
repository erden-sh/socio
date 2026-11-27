# The coding sandbox image, socio-coding (CB-239): OpenCode at
# a pinned version and checksum, Codex and Claude Code (CB-326) and
# Gemini CLI at pinned versions and checksums, Grok Build
# compiled from its source at a pinned commit, Git, Node 26 with pnpm, and
# Python 3. The
# computer supervisor runs one container from it per coding session, pinned
# by its local image ID (CODING_SANDBOX_IMAGE=sha256:…, printed by the
# build) or a repository digest, as uid 1000 with a
# read-only root, no capabilities and no network but the coding egress proxy.
#
# Build it with `node scripts/build-images.mjs --only socio-coding`, which
# passes OPENCODE_VERSION and OPENCODE_SHA256 from deployment/coding/
# opencode.pin, CODEX_*, CLAUDE_CODE_* and GEMINI_CLI_* from codex.pin,
# claude-code.pin and gemini-cli.pin, and GROK_VERSION, GROK_TAG,
# GROK_COMMIT and GROK_SOURCE_REV from grok.pin, and refuses without
# well-formed pins for this file's versions and URLs. By hand, from the
# repository root:
#   docker build -f deployment/coding/coding.Dockerfile \
#     --build-arg OPENCODE_SHA256=<sha256 of the release archive> \
#     --build-arg CODEX_SHA512=<sha512 from codex.pin> \
#     --build-arg CLAUDE_CODE_SHA512=<sha512 from claude-code.pin> \
#     --build-arg GEMINI_CLI_SHA512=<sha512 from gemini-cli.pin> \
#     --build-arg GROK_COMMIT=<commit from grok.pin> \
#     --build-arg GROK_SOURCE_REV=<source_rev from grok.pin> -t socio-coding .
# The build fails without the checksums and Grok Build's commit. The pins are
# taken from the official releases and source (deployment/coding/README.md,
# "Pinning OpenCode", "Pinning Codex and Claude Code" and "Pinning Gemini CLI
# and Grok Build"); the owner's live check (CB-239) of each version's
# flags and config precedence still comes before CODING_SANDBOX_IMAGE is set.

# Grok Build (CB-326; from source by the owner's decision of
# 2026-11-01): xAI's Apache-2.0 source, github.com/xai-org/grok-build, at
# the pinned commit, never xAI's downloadable binary (it comes with no
# checksum). The repository publishes no release tags yet; when grok.pin
# names one (GROK_TAG), the build also checks that it names the commit.
ARG GROK_VERSION=1.0.45
ARG GROK_REPOSITORY=https://github.com/xai-org/grok-build

# The grok-build stage compiles it with the toolchain its source pins
# (rust-toolchain.toml: Rust 1.94.0; protoc from its bin/protoc manifest,
# 29.3, by that manifest's SHA-256) and hands the final stage one binary.
# Rust's image, by digest: rust:1.94.0-bookworm (the same Debian as Node's,
# so the glibc build runs there).
FROM rust:1.94.0-bookworm@sha256:365468470075493dc4583f47387001854321c5a8583ea9604b297e67f01c5a4f AS grok-build
ARG GROK_VERSION
ARG GROK_REPOSITORY
ARG GROK_TAG=
ARG GROK_COMMIT=
ARG GROK_SOURCE_REV=
ARG PROTOC_VERSION=29.3
ARG PROTOC_SHA256=3e866620c5be27664f3d2fa2d656b5f3e09b5152b42f1bedbf427b333e90021a
# A release build of its source otherwise downloads ripgrep, unchecked, to
# embed it (xai-grok-tools' and xai-grok-shell's build.rs): this stage
# fetches the same release, checks it against the SHA-256 ripgrep publishes
# and hands it over with GROK_*_BUNDLE_RG_PATH.
ARG RIPGREP_VERSION=15.0.0
ARG RIPGREP_SHA256=253ad0fd5fef0d64cba56c70dccdacc1916d4ed70ad057cc525fcdb0c3bbd2a7
# The image's toolchain, not rust-toolchain.toml's channel plus components
# (which would make rustup download rustfmt and clippy); the same version.
ENV DEBIAN_FRONTEND=noninteractive RUSTUP_TOOLCHAIN=1.94.0 CARGO_TERM_COLOR=never CARGO_INCREMENTAL=0
RUN echo "$GROK_COMMIT" | grep -Eqx '[0-9a-f]{40}' \
      || { echo "Set GROK_COMMIT (grok.pin's commit, 40 hex digits)." >&2; exit 1; } \
 && echo "$GROK_SOURCE_REV" | grep -Eqx '[0-9a-f]{40}' \
      || { echo "Set GROK_SOURCE_REV (grok.pin's source_rev, 40 hex digits)." >&2; exit 1; } \
 && apt-get update \
 && apt-get install -y --no-install-recommends cmake unzip \
 && rm -rf /var/lib/apt/lists/* \
 && rustc --version | grep -q '^rustc 1\.94\.0 '
RUN curl -fsSL "https://github.com/protocolbuffers/protobuf/releases/download/v${PROTOC_VERSION}/protoc-${PROTOC_VERSION}-linux-x86_64.zip" -o /tmp/protoc.zip \
 && echo "$PROTOC_SHA256  /tmp/protoc.zip" | sha256sum -c - \
 && mkdir -p /opt/protoc && unzip -q /tmp/protoc.zip -d /opt/protoc && rm /tmp/protoc.zip \
 && curl -fsSL "https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/ripgrep-${RIPGREP_VERSION}-x86_64-unknown-linux-musl.tar.gz" -o /tmp/rg.tgz \
 && echo "$RIPGREP_SHA256  /tmp/rg.tgz" | sha256sum -c - \
 && mkdir -p /opt/rg \
 && tar -xzf /tmp/rg.tgz -C /opt/rg --strip-components=1 "ripgrep-${RIPGREP_VERSION}-x86_64-unknown-linux-musl/rg" \
 && rm /tmp/rg.tgz
# The source, fetched by its commit id (and checked), with its SOURCE_REV
# and its lockstepped version (crates/codegen/xai-grok-version) checked too.
WORKDIR /src/grok-build
RUN git init -q . && git remote add origin "$GROK_REPOSITORY" \
 && if [ -n "$GROK_TAG" ]; then \
      git fetch -q --depth 1 origin "refs/tags/$GROK_TAG:refs/tags/$GROK_TAG" \
      && test "$(git rev-parse "refs/tags/$GROK_TAG^{commit}")" = "$GROK_COMMIT" \
      || { echo "The tag $GROK_TAG doesn't name $GROK_COMMIT." >&2; exit 1; }; \
    fi \
 && git fetch -q --depth 1 origin "$GROK_COMMIT" && git checkout -q --detach FETCH_HEAD \
 && test "$(git rev-parse HEAD)" = "$GROK_COMMIT" \
 && { test "$(cat SOURCE_REV)" = "$GROK_SOURCE_REV" \
      || { echo "SOURCE_REV isn't grok.pin's source_rev." >&2; exit 1; }; } \
 && { grep -qx "version = \"$GROK_VERSION\"" crates/codegen/xai-grok-version/Cargo.toml \
      || { echo "The source isn't Grok Build $GROK_VERSION." >&2; exit 1; }; }
# Dependencies by Cargo.lock's checksums (crates.io) and revisions (git),
# then an offline build: Cargo fetches nothing more while it compiles. The
# release-dist profile is the one xAI ships. GROK_VERSION (an ARG, so in the
# environment) is unset for the compile: the binary is then a source build
# (its version is the crate's, the same number), which also clears its
# baked telemetry sinks. Debug info is stripped.
# BuildKit cache mounts (CB-330): the cargo registry, git checkouts and
# the target directory persist across builds, so a repeat build of the same
# commit skips the fetch (the biggest download) and reuses compiled
# artifacts. Requires the BuildKit builder (scripts/build-images.mjs).
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    cargo fetch --locked
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/grok-build/target \
    env -u GROK_VERSION PROTOC=/opt/protoc/bin/protoc \
      GROK_TOOLS_BUNDLE_RG_PATH=/opt/rg/rg GROK_SHELL_BUNDLE_RG_PATH=/opt/rg/rg \
    cargo build --frozen --profile release-dist -p xai-grok-pager-bin --bin xai-grok-pager \
 && mkdir -p /out && strip -o /out/grok target/release-dist/xai-grok-pager

# CB-326 step 7: the session-host entry lives in the app source tree
# (src/server/coding/host/session-host.ts) and compiles to
# dist/server/server/coding/host/session-host.js. The coding image doesn't
# carry the app's dist/ or node_modules, so a build stage compiles the
# entry and a deps stage installs its runtime node_modules (effect,
# @effect/platform-node, and the vendored @t3tools/* + effect-codex-app-server
# link: packages whose exports point at .ts files, so the entry runs under
# `node --import tsx`). The vendored packages ship TypeScript source, so tsx
# (a devDependency) is installed explicitly here, not moved to app
# dependencies — the app image ships compiled JS and does not need it.
# BuildKit cache mounts (CB-330) persist the pnpm store + corepack + tsc's
# buildInfo across builds. Requires the BuildKit builder.
FROM node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9 AS host-build
ENV DO_NOT_TRACK=1 SCARF_ANALYTICS=false COREPACK_HOME=/opt/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY vendor ./vendor
# The patch files pnpm-workspace.yaml's patchedDependencies lists: pnpm reads each on every
# install, even for packages it doesn't install (the Dockerfile's note).
COPY patches ./patches
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    --mount=type=cache,target=/opt/corepack,sharing=locked \
    npm install -g corepack && corepack enable pnpm && pnpm install --frozen-lockfile
# The server build reads the whole src/ tree (tsconfig.server.json includes
# src/server, …) and the declarations of every workspace package the server
# imports (@socio/shared, @socio/foundation, @socio/data and @socio/i18n;
# scripts/workspace-packages.mjs), so the packages build first; only the host/ entry + its two
# siblings are copied to the final image (none of them imports a package at run
# time), but the compile needs the full server inputs.
COPY tsconfig.json tsconfig.server.json ./
COPY src ./src
COPY packages/shared ./packages/shared
COPY packages/foundation ./packages/foundation
COPY packages/data ./packages/data
COPY packages/i18n ./packages/i18n
RUN --mount=type=cache,target=/app/.tsbuildinfo \
    pnpm exec tsc -p packages/shared/tsconfig.json \
 && pnpm exec tsc -p packages/foundation/tsconfig.build.json \
 && pnpm exec tsc -p packages/data/tsconfig.build.json \
 && pnpm exec tsc -p packages/i18n/tsconfig.build.json \
 && pnpm exec tsc -p tsconfig.server.json

# The runtime node_modules for the entry: prod deps bring effect,
# @effect/platform-node, @effect/platform-node-shared and the vendored
# link: packages (which resolve into vendor/t3code/). tsx is a devDependency,
# so it is NOT brought in by the --prod install; it is installed in its own
# stage (tsx-deps, below) and copied into the final image's node_modules as a
# sibling, which avoids touching pnpm's symlinked node_modules structure
# (merging into it with `cp` fails: pnpm may already symlink node_modules/tsx,
# and `cp -a src dst` then copies *into* the symlink rather than replacing it).
FROM node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9 AS host-deps
ENV DO_NOT_TRACK=1 SCARF_ANALYTICS=false COREPACK_HOME=/opt/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY vendor ./vendor
COPY patches ./patches
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    --mount=type=cache,target=/opt/corepack,sharing=locked \
    npm install -g corepack && corepack enable pnpm \
 && pnpm install --frozen-lockfile --prod \
 && rm -rf node_modules/.pnpm/@duckdb+node-bindings-*-musl@* \
       node_modules/.pnpm/*/node_modules/@duckdb/node-bindings-*-musl

# tsx standalone (the entry runs `node --import tsx …` to load the vendored
# .ts packages). tsx is a devDependency, so it is not in the --prod install
# above, and `pnpm add` after a --prod install fails
# (ERR_PNPM_INCLUDED_DEPS_CONFLICT: dev into a prod modules dir). This stage
# installs tsx with npm in isolation — a throwaway package.json keeps npm off
# the app's manifest (catalog: is a pnpm protocol npm can't read). The final
# stage copies tsx + its deps (esbuild, @esbuild) into the socio node_modules
# as siblings, so the entry resolves `tsx` from its own location (ESM
# `--import tsx` resolves from node_modules up the entry's path, like every
# ESM import; it does NOT use NODE_PATH). The build and run platforms match
# (both linux-x64 on the same Debian base), so @esbuild's platform binary is
# correct.
FROM node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9 AS tsx-deps
RUN mkdir -p /opt/tsx && printf '{"name":"tsx","private":true}\n' > /opt/tsx/package.json \
 && cd /opt/tsx && npm install --no-save tsx@4.23.15 \
 && test -f /opt/tsx/node_modules/tsx/dist/loader.mjs

# Node is the project's pinned LTS, by digest (tests/ci-workflow.test.ts).
FROM node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9
ARG OPENCODE_VERSION=2.2.0
ARG OPENCODE_SHA256=
ARG OPENCODE_URL=https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-x64.tar.gz
# Codex and Claude Code (CB-326): each one linux-x64 platform tarball
# from the npm registry, the binary the package's launcher or install script
# would pick, checked against the pinned SHA-512 and unpacked without running
# any package script.
ARG CODEX_VERSION=0.166.0
ARG CODEX_SHA512=
ARG CODEX_URL=https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_VERSION}-linux-x64.tgz
ARG CLAUDE_CODE_VERSION=2.1.309
ARG CLAUDE_CODE_SHA512=
ARG CLAUDE_CODE_URL=https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-${CLAUDE_CODE_VERSION}.tgz
# Gemini CLI (CB-326): the npm tarball, whose bundle/ is the whole CLI
# (no dependencies), checked against the pinned SHA-512 and unpacked without
# npm, so no package script runs and the optional node-pty stays out.
ARG GEMINI_CLI_VERSION=0.66.0
ARG GEMINI_CLI_SHA512=
ARG GEMINI_CLI_URL=https://registry.npmjs.org/@google/gemini-cli/-/gemini-cli-${GEMINI_CLI_VERSION}.tgz
# Grok Build (CB-326): the binary the grok-build stage compiled.
ARG GROK_VERSION
ENV DEBIAN_FRONTEND=noninteractive DO_NOT_TRACK=1 COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    GEMINI_CLI_NO_RELAUNCH=true GEMINI_TELEMETRY_ENABLED=false GROK_DISABLE_AUTOUPDATER=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git python3 python3-pip python3-venv coreutils \
 && rm -rf /var/lib/apt/lists/* \
 && git --version && python3 --version
# OpenCode: the release archive, checked against the pinned checksum.
RUN test -n "$OPENCODE_SHA256" || { echo "Set OPENCODE_SHA256 (the pinned OpenCode archive's checksum)." >&2; exit 1; } \
 && curl -fsSL "$OPENCODE_URL" -o /tmp/opencode.tar.gz \
 && echo "$OPENCODE_SHA256  /tmp/opencode.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/opencode.tar.gz -C /usr/local/bin opencode \
 && chown root:root /usr/local/bin/opencode && chmod 0755 /usr/local/bin/opencode \
 && rm /tmp/opencode.tar.gz \
 && OPENCODE_DISABLE_AUTOUPDATE=1 opencode --version
# Codex: the static binary and the ripgrep it ships, root-owned, read-only;
# its Linux sandbox helper, code-mode host and voice runtime stay out (its
# own sandbox is off: the container is the boundary).
RUN test -n "$CODEX_SHA512" || { echo "Set CODEX_SHA512 (the pinned Codex tarball's checksum)." >&2; exit 1; } \
 && curl -fsSL "$CODEX_URL" -o /tmp/codex.tgz \
 && echo "$CODEX_SHA512  /tmp/codex.tgz" | sha512sum -c - \
 && mkdir -p /opt/codex \
 && tar -xzf /tmp/codex.tgz -C /opt/codex --strip-components=4 \
      package/vendor/x86_64-unknown-linux-musl/bin/codex package/vendor/x86_64-unknown-linux-musl/codex-path/rg \
 && chown -R root:root /opt/codex && chmod 0755 /opt/codex /opt/codex/codex /opt/codex/rg \
 && ln -s /opt/codex/codex /usr/local/bin/codex && ln -s /opt/codex/rg /usr/local/bin/rg \
 && rm /tmp/codex.tgz \
 && HOME=/tmp/codex-version codex --version && rm -rf /tmp/codex-version
# Claude Code: its native binary, root-owned, read-only.
RUN test -n "$CLAUDE_CODE_SHA512" || { echo "Set CLAUDE_CODE_SHA512 (the pinned Claude Code tarball's checksum)." >&2; exit 1; } \
 && curl -fsSL "$CLAUDE_CODE_URL" -o /tmp/claude-code.tgz \
 && echo "$CLAUDE_CODE_SHA512  /tmp/claude-code.tgz" | sha512sum -c - \
 && tar -xzf /tmp/claude-code.tgz -C /usr/local/bin --strip-components=1 package/claude \
 && chown root:root /usr/local/bin/claude && chmod 0755 /usr/local/bin/claude \
 && rm /tmp/claude-code.tgz \
 && HOME=/tmp/claude-version claude --version && rm -rf /tmp/claude-version
# Gemini CLI: its bundle and package.json (an ES module package), root-owned,
# read-only; `gemini` runs bundle/gemini.js with the image's Node.
RUN test -n "$GEMINI_CLI_SHA512" || { echo "Set GEMINI_CLI_SHA512 (the pinned Gemini CLI tarball's checksum)." >&2; exit 1; } \
 && curl -fsSL "$GEMINI_CLI_URL" -o /tmp/gemini-cli.tgz \
 && echo "$GEMINI_CLI_SHA512  /tmp/gemini-cli.tgz" | sha512sum -c - \
 && mkdir -p /opt/gemini-cli \
 && tar -xzf /tmp/gemini-cli.tgz -C /opt/gemini-cli --strip-components=1 --no-same-owner \
      package/bundle package/package.json package/LICENSE \
 && chown -R root:root /opt/gemini-cli && chmod -R a+rX,go-w /opt/gemini-cli && chmod 0755 /opt/gemini-cli/bundle/gemini.js \
 && ln -s /opt/gemini-cli/bundle/gemini.js /usr/local/bin/gemini \
 && rm /tmp/gemini-cli.tgz \
 && HOME=/tmp/gemini-version gemini --version && rm -rf /tmp/gemini-version
# Grok Build: the binary compiled from source above, root-owned, read-only.
COPY --from=grok-build /out/grok /usr/local/bin/grok
RUN chown root:root /usr/local/bin/grok && chmod 0755 /usr/local/bin/grok \
 && HOME=/tmp/grok-version grok --version </dev/null | grep -F "$GROK_VERSION" \
 && rm -rf /tmp/grok-version
# pnpm from corepack at the project's pinned version, fetched now: at run
# time corepack may not download (COREPACK_ENABLE_NETWORK=0 in the sandbox).
# Node 26 dropped corepack from the base image, so install it with npm first.
COPY package.json /tmp/socio-package.json
# BuildKit cache mount (CB-330): corepack's cache (the pnpm binary it
# downloads) persists across builds. Requires the BuildKit builder
# (scripts/build-images.mjs).
# `sharing=locked` on every /opt/corepack mount: the stages build in
# parallel, and with a shared cache this step's `chmod -R` walked into
# another stage's corepack temp directory just as it was renamed away
# ("chmod: cannot access .../corepack-29-.../dist/...", the v0.41.0 build).
RUN --mount=type=cache,target=/opt/corepack,sharing=locked \
    npm install -g corepack && corepack enable pnpm \
 && corepack install -g "$(node -p "require('/tmp/socio-package.json').packageManager")" \
 && chmod -R a+rX /opt/corepack && rm /tmp/socio-package.json && pnpm --version
# The managed configuration, root-owned and read-only for the agent. It is
# convenience: the network is the enforcement.
COPY deployment/coding/opencode.json /etc/socio/opencode.json
COPY deployment/coding/gitconfig /etc/gitconfig
COPY deployment/coding/npmrc /usr/local/etc/npmrc
COPY deployment/coding/pip.conf /etc/pip.conf
# Gemini CLI's system settings file, which wins over every user and project
# settings file (CB-326).
COPY deployment/coding/gemini-settings.json /etc/gemini-cli/settings.json
COPY deployment/coding/write-token deployment/coding/with-token deployment/coding/grok-socio \
     deployment/coding/git-credential-socio deployment/coding/setup \
     deployment/coding/egress-probe.mjs /usr/local/lib/socio/
# CB-326 step 7: the session-host entry and its runtime. The entry
# (session-host.js) and its two siblings (gatewayAuth.js, providerHost.js)
# are the only files copied from the build stage — the entry's runtime
# closure is just those three plus the external packages in node_modules.
# The vendored @t3tools/* and effect-codex-app-server are link: deps whose
# node_modules entries are symlinks into vendor/t3code/ (which ships .ts
# source), so both node_modules and the vendor tree are copied. tsx and its
# deps (esbuild, @esbuild) are copied in as siblings below (from tsx-deps)
# so `node --import tsx` resolves it from the entry's own node_modules path.
COPY --from=host-build /app/dist/server/server/coding/host/session-host.js \
     /app/dist/server/server/coding/host/gatewayAuth.js \
     /app/dist/server/server/coding/host/providerHost.js \
     /usr/local/lib/socio/
COPY --from=host-deps /app/node_modules /usr/local/lib/socio/node_modules
COPY --from=host-deps /app/vendor/t3code /usr/local/lib/socio/vendor/t3code
# A package.json declaring "type":"module" at the entry's directory so Node
# treats the compiled .js entry as ESM. Without it Node defaults to CJS
# (no package.json above /usr/local/lib/socio/), and the entry's
# `import '@t3tools/.../server/driver'` hits tsx's CJS resolver, which
# doesn't honor the package's `exports` map (import condition only) and
# throws ERR_PACKAGE_PATH_NOT_EXPORTED. In dev the root package.json's
# "type":"module" covers this; the image carries only the entry, not the
# root package.json.
RUN printf '{"type":"module"}\n' > /usr/local/lib/socio/package.json
# tsx + its deps (esbuild, @esbuild) as siblings in the socio node_modules,
# so `node --import tsx` resolves tsx from the entry's own node_modules.
# Copied after host-deps' node_modules so these land as real dirs, not into
# any pnpm symlink. tsx/esbuild/@esbuild aren't in the --prod install, so
# there's no existing entry to collide with.
COPY --from=tsx-deps /opt/tsx/node_modules/tsx /usr/local/lib/socio/node_modules/tsx
COPY --from=tsx-deps /opt/tsx/node_modules/esbuild /usr/local/lib/socio/node_modules/esbuild
COPY --from=tsx-deps /opt/tsx/node_modules/@esbuild /usr/local/lib/socio/node_modules/@esbuild
# /work is the workspace volume's mount point (a new volume copies this
# directory's owner); /run/socio is a tmpfs at run time (mode 0700, uid 1000).
RUN chown -R root:root /etc/socio /etc/gitconfig /usr/local/etc/npmrc /etc/pip.conf /etc/gemini-cli /usr/local/lib/socio \
 && chmod 0644 /etc/socio/opencode.json /etc/gitconfig /usr/local/etc/npmrc /etc/pip.conf /etc/gemini-cli/settings.json \
      /usr/local/lib/socio/egress-probe.mjs \
 && chmod 0755 /etc/gemini-cli /usr/local/lib/socio /usr/local/lib/socio/write-token /usr/local/lib/socio/with-token \
      /usr/local/lib/socio/grok-socio \
      /usr/local/lib/socio/git-credential-socio /usr/local/lib/socio/setup \
 && test "$(id -u node)" = 1000 \
 && mkdir -p /work /run/socio && chown 1000:1000 /work /run/socio && chmod 0700 /run/socio
# No setuid or setgid binaries: no-new-privileges already stops them; this
# leaves nothing to stop.
RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} + \
 && test -z "$(find / -xdev -perm /6000 -type f -print -quit)"
USER 1000:1000
WORKDIR /work
ENV HOME=/tmp/home OPENCODE_CONFIG=/etc/socio/opencode.json SOCIO_GATEWAY_TOKEN_FILE=/run/socio/token
CMD ["sleep", "infinity"]
