# Coding sandboxes and their egress (CB-239)

Built dark: nothing here runs until an operator builds the images, sets `CODING_SANDBOX_IMAGE` on the supervisor and scales up `coding-egress`, and the app side (the coding gateway, `coding-git` and coding sessions) ships behind the `coding-sessions` flag.

## Pieces

| Piece                    | Where                                                                                                  | Does                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `socio-coding` image     | [coding.Dockerfile](coding.Dockerfile)                                                                 | OpenCode (pinned version and archive checksum), Codex, Claude Code and Gemini CLI (pinned npm tarballs and SHA-512, CB-326) and Grok Build (compiled from its source at a pinned commit), Git, Node 26 with pnpm, Python 3; the managed OpenCode, Gemini CLI, Git, npm and pip configuration, root-owned; the helper scripts; runs as uid 1000 |
| Supervisor's sandbox API | [../computers/coding-sandbox.mjs](../computers/coding-sandbox.mjs), mounted by `harden-supervisor.mjs` | One container and one internal network per coding session, from a spec fixed in code; inspect-after-create; detached execs from a fixed set; the start-up egress self-test                                                                                                                                                                     |
| Coding egress proxy      | `src/coding-egress/` (image stage `coding-egress` in the root `Dockerfile`)                            | The sandboxes' only way out: the gateway route with a signed sandbox stamp, read-only registry virtual hosts, no CONNECT                                                                                                                                                                                                                       |
| Egress probe             | [egress-probe.mjs](egress-probe.mjs)                                                                   | Run by the self-test in a canary sandbox: no outside name may resolve, no outside address or host port may answer, and the proxy must not tunnel                                                                                                                                                                                               |

## Building the image

```sh
node scripts/build-images.mjs --only socio-coding,coding-egress
```

`socio-coding` is opt-in (never built by a plain run). The script sends a context of HEAD's `package.json` and `deployment/coding/` (all `coding.Dockerfile` copies), passes `OPENCODE_VERSION` and `OPENCODE_SHA256` from HEAD's `opencode.pin`, `CODEX_*`, `CLAUDE_CODE_*` and `GEMINI_CLI_*` (version, URL, SHA-512) from `codex.pin`, `claude-code.pin` and `gemini-cli.pin`, and `GROK_VERSION`, `GROK_TAG`, `GROK_COMMIT` and `GROK_SOURCE_REV` from `grok.pin`, and tags `socio-coding:<OpenCode version>` (as `.docker/compose.computers.yml`), `socio-coding:<git-sha>` and `:latest`. It refuses before sending anything when a pin is missing, malformed, or for another version, asset, URL or repository than `coding.Dockerfile`'s defaults. By hand, from the repository root:

```sh
docker build -f deployment/coding/coding.Dockerfile \
  --build-arg OPENCODE_VERSION=<version> --build-arg OPENCODE_SHA256=<sha256> \
  --build-arg CODEX_SHA512=<sha512> --build-arg CLAUDE_CODE_SHA512=<sha512> \
  --build-arg GEMINI_CLI_SHA512=<sha512> \
  --build-arg GROK_COMMIT=<commit> --build-arg GROK_SOURCE_REV=<source_rev> -t socio-coding .
```

The build fails without `OPENCODE_SHA256`, `CODEX_SHA512`, `CLAUDE_CODE_SHA512`, `GEMINI_CLI_SHA512`, `GROK_COMMIT` or `GROK_SOURCE_REV`. It downloads from GitHub (OpenCode; Grok Build's source, protoc and ripgrep), the npm registry, crates.io and Debian on the build host, and nothing from `x.ai`. Compiling Grok Build (a multi-stage build, Rust 1.94.0) takes a while and several GB of memory on the build node; the image gets only its binary. The owner's live checks below (security review, "Before building", item 3: that release's `opencode run` flags and config precedence) come before `CODING_SANDBOX_IMAGE` is set on the supervisor.

### Pinning the image

`CODING_SANDBOX_IMAGE` takes a repository digest (`name@sha256:<64 hex>`) or a local image ID (`sha256:<64 hex>`); a tag, or anything else, keeps sandboxes off. The image is built on the swarm node and never pushed, so it has no repository digest: use its image ID, which `scripts/build-images.mjs --only socio-coding` prints at the end of the build (`socio-coding: set CODING_SANDBOX_IMAGE=sha256:… on the supervisor`; `docker image inspect socio-coding:<version> --format '{{.Id}}'` shows the same). The supervisor resolves it locally and refuses to create a sandbox when the image it finds isn't exactly that ID. A rebuild makes a new ID; the supervisor keeps using the old image until the setting is changed. Turning the features on is in [the actors runbook](../actors/README.md).

### Pinning OpenCode

`opencode.pin` is `key=value` lines (`#` comments allowed), every key required once, read by `scripts/lib/opencode-pin.mjs` and checked by `tests/integration/build-images.test.ts`:

```plain
version=<x.y.z, coding.Dockerfile's OPENCODE_VERSION default>
asset=opencode-linux-x64.tar.gz
sha256=<64 lowercase hex: the archive's SHA-256>
url=https://github.com/anomalyco/opencode/releases/download/v<version>/<asset>
fetched=<YYYY-MM-DD>
verified=<one line: how the checksum was checked>
```

**The pin is OpenCode 2.2.0** (owner's choice, 2026-10-28). The sandbox was first written against 2.1.4, but `v2.1.4` is only a tag in anomalyco/opencode (commit `68bc26b`, "release: v2.1.4"): GitHub has no published release for it (`GET /repos/anomalyco/opencode/releases/tags/v2.1.4` answers 404) and its archive URL answers 404 too. `v2.2.0` is the latest published 2.x release (2026-10-27). Its checksum is the release asset's `digest`, checked against `sha256sum` of the downloaded archive, whose listing is one regular file, `opencode` (0755, root), never run. Its release notes change nothing the sandbox uses in `opencode run` (`--standalone` is now accepted anywhere in the command, and `--format json` reports server connection errors as JSON); the owner's live check (below) still runs it against the gateway before `CODING_SANDBOX_IMAGE` is set.

To pin or re-pin, with no credentials and a generic User-Agent (`research-script/0.1`; never a personal address):

1. Confirm the repository is OpenCode's own: `GET https://api.github.com/repos/anomalyco/opencode` (homepage `opencode.ai`, not a fork); `https://api.github.com/repos/sst/opencode` redirects to the same repository id.
2. Read the release: `GET https://api.github.com/repos/anomalyco/opencode/releases/tags/v<version>` (`Accept: application/vnd.github+json`), the `opencode-linux-x64.tar.gz` asset's `digest` (`sha256:…`). No release or no asset: stop; don't pick another one.
3. Download the archive into a new empty directory (`mktemp -d`), compare `sha256sum` with the digest, and list it without running anything from it: `tar -tzvf` must show one regular file, `opencode`, at the top level (no other members, links, absolute or `..` paths). Delete the download.
4. Write `opencode.pin`, set `OPENCODE_VERSION` in `coding.Dockerfile` (and the default in `.docker/compose.computers.yml`) if the version changed, run `pnpm exec vitest run tests/integration/build-images.test.ts`, commit, then build.

### Pinning Codex and Claude Code

CB-326. `codex.pin` and `claude-code.pin` each name one **linux-x64 platform tarball** on the npm registry: the binary the package's launcher (`@openai/codex`) or install script (`@anthropic-ai/claude-code`) would pick on this image. The Dockerfile downloads it, checks its SHA-512 and unpacks only the binary (Codex also its bundled `rg`), so no package script runs. `scripts/lib/npm-pin.mjs` reads them; `tests/integration/build-images.test.ts` checks them against `coding.Dockerfile`'s `CODEX_*` and `CLAUDE_CODE_*` defaults:

```plain
version=<x.y.z>
package=<the platform package>@<version>
url=https://registry.npmjs.org/<scope>/<name>/-/<file>.tgz
sha512=<128 lowercase hex: the tarball's SHA-512>
integrity=sha512-<base64>   (the registry's dist.integrity: the same digest)
fetched=<YYYY-MM-DD>
verified=<one line>
```

**The pins are Codex 0.166.0** (npm `latest` on 2026-11-01) **and Claude Code 2.1.309**. Claude Code's pin follows npm's **`stable`** dist-tag, not `latest` (owner decision, 2026-11-01): on 2026-11-01 `stable` was 2.1.309 and `latest` 2.1.316. To pin or re-pin, with no credentials and a generic User-Agent (`research-script/0.1`; never a personal address):

1. `GET https://registry.npmjs.org/@openai%2fcodex/latest` (Claude Code: `@anthropic-ai%2fclaude-code/stable`, never `latest`): the version, and its `optionalDependencies`' linux-x64 entry (`@openai/codex@<version>-linux-x64`, `@anthropic-ai/claude-code-linux-x64@<version>`).
2. `GET` that platform package's version document: `dist.tarball` and `dist.integrity`.
3. Download the tarball into a new empty directory, check that the base64 SHA-512 equals `dist.integrity`, and list it without running anything: Codex's binary is `package/vendor/x86_64-unknown-linux-musl/bin/codex` (and `codex-path/rg`), Claude Code's `package/claude`. Delete the download.
4. Write the pin, set the `ARG …_VERSION` default in `coding.Dockerfile` if the version changed, run `pnpm exec vitest run tests/integration/build-images.test.ts`, commit, then build.

### Pinning Gemini CLI and Grok Build

CB-326.

- **Gemini CLI** (`gemini-cli.pin`): the same pin format and checks as Codex's and Claude Code's (`scripts/lib/npm-pin.mjs`, `GEMINI_CLI_*` in `coding.Dockerfile`). `@google/gemini-cli` is one platform-independent tarball whose `bundle/` is the whole CLI. Its `package.json` has no dependencies and no scripts; its optional dependencies (`node-pty` for an interactive shell, `keytar`) are left out. The Dockerfile unpacks `package/bundle`, `package/package.json` and `package/LICENSE` into `/opt/gemini-cli` and links `gemini` to `bundle/gemini.js`, run by the image's Node.
- **Grok Build** (`grok.pin`): xAI's official coding agent (`grok`, docs at docs.x.ai/build) is **built from its Apache-2.0 source**, github.com/xai-org/grok-build (owner decision, 2026-11-01). xAI's downloadable binary (`https://x.ai/cli/grok-<version>-linux-x86_64`) comes with no checksum, so it isn't used. `coding.Dockerfile`'s `grok-build` stage (`rust:1.94.0-bookworm` by digest, the toolchain the source's `rust-toolchain.toml` pins) fetches the pinned commit by its id and checks it, checks the tree's `SOURCE_REV` and that `crates/codegen/xai-grok-version` is the pinned version, fetches protoc 29.3 (the version and SHA-256 of the source's own `bin/protoc` manifest) and ripgrep 15.0.0 (checked against ripgrep's published SHA-256; the source's release build would otherwise download it unchecked to embed it), fetches the dependencies by `Cargo.lock` (`cargo fetch --locked`), compiles offline (`cargo build --frozen --profile release-dist -p xai-grok-pager-bin`) and strips the binary. The final stage copies only that binary to `/usr/local/bin/grok` and checks `grok --version`. `GROK_VERSION` is unset for the compile, so the binary is a source build, which also clears its baked telemetry sinks.

`grok.pin` is `key=value` lines (`#` comments allowed), read by `scripts/lib/grok-pin.mjs` and checked by `tests/integration/build-images.test.ts` against `coding.Dockerfile`'s `GROK_VERSION` and `GROK_REPOSITORY` defaults:

```plain
version=<x.y.z: crates/codegen/xai-grok-version's version at the commit>
repository=https://github.com/xai-org/grok-build
tag=<release tag>   (optional: the build checks it names the commit)
commit=<40 lowercase hex: the source commit>
source_rev=<40 lowercase hex: the tree's SOURCE_REV, the xAI monorepo commit it was synced from>
fetched=<YYYY-MM-DD>
verified=<one line>
```

**The pins are Gemini CLI 0.66.0** (npm `latest` on 2026-11-01; `preview` was 0.67.0-preview.0) **and Grok Build 1.0.45, commit `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`** (the head of `main` on 2026-11-01, synced 2026-09-29). The repository publishes **no release tags or releases** (it's a periodic sync of xAI's monorepo), so the pin is the commit and has no `tag`. Its source is behind xAI's downloadable binary, which was 1.0.70 on 2026-11-01. To pin or re-pin, with no credentials and a generic User-Agent (`research-script/0.1`; never a personal address):

1. Gemini CLI: `GET https://registry.npmjs.org/@google%2fgemini-cli`: `dist-tags.latest`, and that version's `dist.tarball` and `dist.integrity`; check it still has no `dependencies` and no `scripts`. Grok Build: `GET https://api.github.com/repos/xai-org/grok-build/tags` (and `/releases`): use the newest release tag's commit if there is one, else `GET .../branches/main` for the head commit.
2. Gemini CLI: download into a new empty directory, check that the base64 SHA-512 equals `dist.integrity`, and list it (`tar -tzvf`: regular files under `package/` only, no links, absolute or `..` paths). Grok Build: download that commit's source archive into a new empty directory and read, never build or run, it: `crates/codegen/xai-grok-version/Cargo.toml`'s `version`, `SOURCE_REV`, `LICENSE` (Apache-2.0), `rust-toolchain.toml` (if the Rust version changed, update the `grok-build` stage's image, by digest, and `RUSTUP_TOOLCHAIN`), `bin/protoc` (protoc's version and linux-x86_64 SHA-256: `PROTOC_*`), the `RG_VER` in `crates/codegen/xai-grok-tools/build.rs` and `crates/codegen/xai-grok-shell/build.rs` (`RIPGREP_*`, from ripgrep's published `.sha256`), and any new network fetch in a `build.rs`. Delete the download.
3. Write the pin, set the `ARG GROK_VERSION` default (or `ARG GEMINI_CLI_VERSION`) in `coding.Dockerfile` if the version changed, run `pnpm exec vitest run tests/integration/build-images.test.ts tests/coding-sandbox-image.test.ts`, commit, then build.

## The supervisor's API

All routes sit behind the supervisor's `SUPERVISOR_TOKEN`. Requests carry no image, mount, capability, network or command: any unknown field is refused.

| Route                                      | Body                                                                                                                                                | Answer                                                                                                      |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `POST /sandboxes`                          | `{ sessionId, volumeKey, cpus?, memoryBytes?, pids? }` (numbers clamped to the ceilings)                                                            | `201 { sessionId, state: "network-ready", subnet, proxyAddress }`; `200` with the same for a retry          |
| `POST /sandboxes/:sessionId/start`         | `{ proxyUser, proxyPassword }`: the proxy credential Socio signs for that `subnet` (`signEgressCredential`, packages/foundation/src/actors/keys.ts) | `200 { state: "running" }`, or `500 { fields }` when the inspected container differed and was removed       |
| `POST /sandboxes/:sessionId/exec`          | `{ runId, kind, params, wait? }`, kinds `token`, `setup`, `prompt`, `status`, `diff`, `changes`                                                     | `202` running or `200` ended: `{ runId, state, exitCode?, stdout, stderr, truncated, startedAt, endedAt? }` |
| `GET /sandboxes/:sessionId/exec/:runId`    | `?wait=<seconds ≤ 60>`                                                                                                                              | the run (any runtime may collect it)                                                                        |
| `DELETE /sandboxes/:sessionId/exec/:runId` |                                                                                                                                                     | forgets an ended run                                                                                        |
| `DELETE /sandboxes/:sessionId`             |                                                                                                                                                     | removes the container and its network; the workspace volume stays                                           |
| `DELETE /workspaces/:volumeKey`            |                                                                                                                                                     | removes a workspace volume no sandbox uses (deactivation, socio deletion, repository removal)               |
| `GET /sandboxes`                           |                                                                                                                                                     | `{ sandboxes: [{ sessionId, state }] }`, for the leader's orphan reaper                                     |
| `GET` or `POST /sandboxes/self-test`       |                                                                                                                                                     | `{ ok, mode, checkedAt, failures }`; `POST` runs it again                                                   |

Two steps because the proxy credential names the network's subnet (CB-239), which only exists once the network does, and only Socio and the proxy hold `CODING_EGRESS_SECRET`.

Execs: `prompt` runs the session's coding agent, named by its `harness` parameter (`opencode`, the default, `codex` or `claude-code`, `gemini-cli` or `grok`, CB-326), with the prompt on stdin. OpenCode: `opencode run --standalone --format json --session <id> --model socio/<model> --auto`. Codex: `with-token SOCIO_GATEWAY_TOKEN codex exec --json --dangerously-bypass-approvals-and-sandbox --model <model> -c …`, whose `-c` overrides make the gateway (`http://gateway.socio.internal/v1`, the Responses API, the token as its key) its only model provider, and `resume <thread>` for later prompts. Claude Code: `with-token ANTHROPIC_AUTH_TOKEN claude -p --output-format stream-json --verbose --model <model> --permission-mode bypassPermissions --strict-mcp-config --disallowedTools WebFetch WebSearch`, with `ANTHROPIC_BASE_URL=http://gateway.socio.internal`, the session's model for every model role, telemetry, error reports, the auto-updater, experimental betas and other non-essential traffic off, and `--resume <id>` for later prompts. Gemini CLI: `with-token GEMINI_API_KEY gemini --output-format stream-json --model <model> --approval-mode yolo --allowed-mcp-server-names socio-none`, with `GOOGLE_GEMINI_BASE_URL=http://gateway.socio.internal` (its `gateway` auth: the Gemini API at that base, the token as `x-goog-api-key`), `SOCIO_GEMINI_MODEL=<model>`, `GEMINI_CLI_TRUST_WORKSPACE=true`, no self-relaunch and no telemetry, and `--resume <id>` for later prompts; it reads the prompt from stdin because stdin isn't a terminal. Its root-owned system settings file ([gemini-settings.json](gemini-settings.json), `/etc/gemini-cli/settings.json`), which wins over the agent's and the repository's settings files, turns off usage statistics, telemetry, auto-updates, checkpointing, MCP servers, extensions, folder trust (so `yolo` stands; the container is the boundary), the repository's `.env` files and the `google_web_search` and `web_fetch` tools (provider-side), and points `model.name` and every helper model alias (chat compression, loop detection, the edit fixer, the router's classifier…) at `$SOCIO_GEMINI_MODEL`, since the gateway serves only the session's model. Grok Build: `with-token SOCIO_GATEWAY_TOKEN grok-socio <model> --output-format streaming-json --prompt-file /dev/stdin --model socio --yolo --disable-web-search --no-auto-update`, with `GROK_HOME=/tmp/home/.grok`, `GROK_DISABLE_AUTOUPDATER=1`, `GROK_MEMORY=0` and `GROK_FEEDBACK_ENABLED=false`, and `--resume <id>` for later prompts. [grok-socio](grok-socio) (root-owned) checks the model name and writes `$GROK_HOME/config.toml` afresh before each run, replacing whatever the agent left there: one model, `socio`, whose id is the session's model, at `http://gateway.socio.internal/v1` on the Responses API with its key from `SOCIO_GATEWAY_TOKEN`, and update checks, telemetry, feedback and memory off (Grok Build takes a custom endpoint only from its config file, not its `GROK_CONFIG` overlay). Headless Grok Build doesn't read piped stdin as its prompt, hence `--prompt-file /dev/stdin`. `with-token` reads `/run/socio/token` into the one variable the agent takes its key from, so the token is never in argv or the exec's environment. Every agent also gets the socio's commit identity in the environment (`<name> (Socio)`, its noreply address). `token` writes the prompt's `cbgw_` to `/run/socio/token`; `setup` clones or fetches through the Git proxy and checks out the session branch after replacing the workspace's `.git/config` and removing its hooks; `status`, `diff` and `changes` run Git with hooks, fsmonitor, pagers and external diff drivers off. Every exec is wrapped in `timeout`. Exec output (the last 4 MB of a prompt's stdout) is kept in the supervisor's memory until collected or for an hour after the run ends: a supervisor restart loses it, and Socio then reports the run as lost.

Settings (supervisor environment, each a ceiling on what Socio may ask): `CODING_SANDBOX_IMAGE`, `CODING_SANDBOX_SUBNETS` (a private range carved into /28s, default `10.213.0.0/16`), `CODING_SANDBOX_MAX` (8), `CODING_SANDBOX_MAX_CPUS` (2), `CODING_SANDBOX_MAX_MEMORY_BYTES` (4 GiB), `CODING_SANDBOX_MAX_PIDS` (512), `CODING_PROMPT_MAX_SECONDS` (1200), `CODING_EGRESS_MODE` (`virtual-hosts`), and `COMPUTER_RUNTIME`, which applies to sandboxes too.

## The egress proxy

Environment: `CODING_EGRESS_SECRET` (or `_FILE`), `CODING_GATEWAY_UPSTREAM` (the app's internal gateway listener, `http://host:4340`), `CODING_EGRESS_MODE`, ports `CODING_EGRESS_PORT` (3128) and `CODING_EGRESS_DIAGNOSTICS_PORT` (3129). Its container carries the label `socio.coding-egress=<namespace>`, which is how the supervisor finds it.

- Every request needs the sandbox's credential (`Proxy-Authorization: Basic`), from an address inside the credential's subnet.
- `http://gateway.socio.internal/…` (GET, HEAD, POST) goes to the gateway listener with every client `x-cb-*`, forwarding and cookie header removed and `x-cb-sandbox` added. The stamp's path is the exact request-target forwarded, query included (`/git/o/r.git/info/refs?service=git-upload-pack`).
- `http://<name>.registry.socio.internal/…` serves the credential's registries (`allow` entries `name=host`; default `npm=registry.npmjs.org pypi=pypi.org pypi-files=files.pythonhosted.org`, `src/coding-egress/registries.ts`). GET and HEAD only, no request body, public addresses only, over TLS to the real host. Only `accept`, `accept-encoding`, the conditional and range headers and a fixed `User-Agent` are sent on. JSON and HTML answers have `https://<registry host>` links rewritten to the virtual hosts.
- CONNECT is refused for every host; everything else is a 403, logged as the sandbox id and `host:port` and counted. `GET /denials/<sandboxId>` on the diagnostics port, with `Authorization: Bearer <diagnosticsToken(CODING_EGRESS_SECRET)>`, returns the counts for `coding_status` and the first-denial audit rows.

## Registry fallback

The read-only virtual hosts are the mechanism built. If the live checks below show npm, pnpm or pip can't work with them, the owner may switch to a TLS-intercepting proxy that stays download-only. The switch is `CODING_EGRESS_MODE=intercept` on both the supervisor and the proxy. It is not built: today both refuse to start sandboxes (supervisor) or to start at all (proxy) with that value, rather than quietly accepting CONNECT. Building it means:

1. A CA whose key only the proxy holds (a new secret), its certificate installed root-owned in the `socio-coding` image (`/usr/local/share/ca-certificates`, `NODE_EXTRA_CA_CERTS`, pip's `cert`, npm's `cafile`), and npm and pip pointed back at the registries' own `https://` names.
2. CONNECT accepted only for the credential's registry hosts on 443 and always terminated in the proxy, never tunnelled; inside, the same rules as the virtual hosts: GET and HEAD only, the same short header list, public addresses only.
3. The self-test reporting `mode: "intercept"`, and the same tests as `tests/coding-egress-proxy.test.ts` against the intercepting path.

## Live checks (owner-run, CB-239)

Not runnable in the test suite, which starts no containers. They are still needed after the pin, before `CODING_SANDBOX_IMAGE` is set:

- The self-test passes on the target engine: Docker's embedded resolver forwards no outside names on the internal network with `dns` pointing nowhere, the network gets no IPv6, and `com.docker.network.bridge.inhibit_ipv4` leaves the host unreachable from the sandbox.
- `opencode run --standalone` reads its message from stdin when none is given, honors `OPENCODE_CONFIG_CONTENT` and `{file:/run/socio/token}`, and uses `HTTP_PROXY`.
- Codex 0.166.0 (CB-326): `codex exec --json … -` and `codex exec … resume <id> -` read the prompt from stdin; the `-c` overrides take effect over a config.toml under `HOME` (`model_providers.socio.*`, `web_search="disabled"`, `check_for_update_on_startup=false`, `analytics.enabled=false`); it reaches only `gateway.socio.internal` through `HTTP_PROXY`; its requests pass the gateway's Responses rules (function and custom tools only); the `--json` event names match `codex.ts`.
- Claude Code 2.1.309 (CB-326): `claude -p` reads the prompt from stdin; `ANTHROPIC_BASE_URL` plus `ANTHROPIC_AUTH_TOKEN` send `Authorization: Bearer` to `/v1/messages`; it reaches nothing else with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (watch the proxy's denials); it tolerates the gateway's 404 for `/v1/messages/count_tokens`; its requests pass the gateway's Messages rules (no server tools, no refused betas); the stream-json message shapes match `claude-code.ts`; `--resume <id>` continues.
- Gemini CLI 0.66.0 (CB-326): `gemini --output-format stream-json` with stdin not a terminal reads the prompt from stdin; with `GOOGLE_GEMINI_BASE_URL` it picks its `gateway` auth with no settings file naming one, and sends `x-goog-api-key` with `GEMINI_API_KEY` to `/v1beta/models/<model>:streamGenerateContent?alt=sse` through `HTTP_PROXY` (an `http://` base is accepted: its code only checks it is a URL, though its docs say HTTPS unless localhost); it accepts a model name that isn't a Gemini model (`--model`); the system settings file wins over `~/.gemini/settings.json` and the repository's `.gemini/settings.json`, and `$SOCIO_GEMINI_MODEL` expands inside it, so no request names another model (chat compression, loop detection: watch the gateway's 404s); `admin.mcp.enabled=false` from a settings file, or else `--allowed-mcp-server-names socio-none`, keeps a repository's MCP servers from starting; it tolerates the gateway's 404 for `:countTokens` (used only for images and PDFs, with a local estimate as its fallback); it reaches nothing else (watch the proxy's denials: Clearcut usage logging, update checks); its requests pass the gateway's Gemini rules (function declarations only, inline images only); the stream-json event shapes match `gemini-cli.ts`; `--resume <uuid>` continues the session under `HOME`.
- Grok Build 1.0.45, built from source (CB-326): `--prompt-file /dev/stdin` reads the prompt from stdin; it reads the custom model from `$GROK_HOME/config.toml` (`[model.socio]` with `base_url`, `api_backend = "responses"`, `env_key`) and sends `Authorization: Bearer` with the token to `/v1/responses` through `HTTP_PROXY` to a plain `http://` base; `-m socio` resolves to the session's model id; with `--disable-web-search`, `features.telemetry = "off"`, `features.remote_fetch = false` and no login it calls no xAI host (watch the proxy's denials: model catalog, session service, trace uploads, update checks); its requests pass the gateway's Responses rules (stateless: no `previous_response_id`, no stored items); the `streaming-json` event shapes match `grok.ts` and its session ids are UUIDs; `--resume <id>` continues the session under `GROK_HOME`; the binary built from source (glibc, Debian bookworm) runs on the image's base as uid 1000.
- npm, pnpm and pip install real lockfiles through the virtual hosts; `npm publish` and `twine upload` fail.
- An exec with stdin closes stdin when the supervisor ends its half of the hijacked stream.
