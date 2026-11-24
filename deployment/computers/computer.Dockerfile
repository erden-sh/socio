# The pinned upstream computer image (company-brain-computer:b6932d3, built
# from agent-computer/Dockerfile at the revision in .docker/compose.computers.yml) with
# Socio's browser time limits (CB-125) and the Git CLI (CB-130). Build
# that image first.
ARG UPSTREAM_IMAGE=company-brain-computer:b6932d3
FROM ${UPSTREAM_IMAGE}
# Git for cloning (CB-130). ca-certificates is there already (curl), so https
# clones work; the --version run fails the build if git is not usable.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates util-linux \
 && rm -rf /var/lib/apt/lists/* \
 && git --version
RUN groupadd --gid 20000 socio-shared && command -v setpriv
COPY deployment/computers/principal-runtime.ts deployment/computers/principal-worker.ts /app/src/
COPY deployment/computers/isolate-computer.mjs /tmp/harden/isolate-computer.mjs
COPY deployment/computers/browser-guard.ts /app/src/browser-guard.ts
COPY deployment/computers/patch.mjs /tmp/harden/patch.mjs
COPY deployment/computers/harden-computer.mjs /tmp/harden/harden-computer.mjs
RUN bun /tmp/harden/harden-computer.mjs /app/src && bun /tmp/harden/isolate-computer.mjs /app/src && rm -r /tmp/harden
# The supervisor states its own healthcheck when it creates a computer; this is
# the same one, for the image run on its own.
HEALTHCHECK --interval=2s --timeout=3s --start-period=2s --retries=30 \
  CMD bun -e "const r = await fetch('http://localhost:4100/health'); const j = await r.json(); process.exit(r.ok && j.browserState !== 'stuck' ? 0 : 1)"
