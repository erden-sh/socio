# Turning on socio access to apps and coding sessions (CB-232, CB-239)

For operators. Everything here ships dark: the images aren't built by a plain `build-images` run, the app browser is in an overlay the default stack doesn't include, `coding-egress` has no replicas, and the three flags are off. The Docker commands below run on a swarm manager. The stack files and overlays named here ship with the self-hosting guide, which is coming.

| Feature                                 | Flag                 | Runs on                                                                               |
| --------------------------------------- | -------------------- | ------------------------------------------------------------------------------------- |
| Socios use apps for a person (CB-232)   | `socio-actor-access` | the app, the `app-browser` service, the app's internal apps listener                  |
| Coding sessions (CB-239)                | `coding-sessions`    | the app's gateway listener, `coding-git`, the supervisor's sandboxes, `coding-egress` |
| Repository extraction for apps (CB-267) | `repo-extraction`    | the app, `coding-git`                                                                 |

`coding-sessions` and `repo-extraction` need `socio-actor-access` on as well.

## 1. Prerequisites

- **A release with socio access to apps (CB-232) and coding sandboxes (CB-239)** (after v0.23.0; the Unreleased notes list them). Its migrations are expand-only.
- **The actor-access contract.** Each runtime records the contract it enforces (`ACTOR_ACCESS_CONTRACT`, 2, in `runtime_contracts`). While any live runtime records an older one, or none (every release before socio access), no grant or credential is issued, and the apps proxy refuses socio credentials and every `/api/apps/actor/*` call. With `start-first` the old task overlaps the new one: wait until it has exited before trying anything. Nothing needs doing; issuance resumes on its own.
- **Deploy order for plugins.** A release that gives socios access to plugins (CB-232) must update the app (`company-brain`) before the apps runtime (`company-brain-apps`). The new runtime ingress passes a plugin only identity headers the proxy signed (`x-cb-runtime-sig`), so a runtime updated first would drop every identity header an older app sends to plugins. Plugin services created before that release get their envelope key (`CB_ACTOR_KEY`, `CB_APP_ID=plugin:<id>`) only when they are provisioned again: enable the plugin, change its settings, or reinstall it. Until then their socio sessions and person envelopes fail closed.
- **`SESSION_SECRET`** (the stack's `company_brain_session_secret`, already mounted as `SESSION_SECRET_FILE`). Context keys derive from it, so both runtimes share them. Without it the `app_*` tools are not offered.
- **The engine**, checked on the swarm node before the flags go on: Chromium's sandbox under `deployment/app-browser/seccomp.json`, whether the engine applies `security_opt` to swarm services, Docker's embedded DNS on internal networks, and Playwright's `routeWebSocket` headers. `no-new-privileges` for swarm services comes from `"no-new-privileges": true` in `/etc/docker/daemon.json`, as for plugins.

## 2. Images

All opt-in: built only when named.

```sh
node scripts/build-images.mjs --only app-browser,coding-egress,coding-git,socio-coding
```

| `--only`        | Source                                                | Tags                                                                     | Run by                                                                               |
| --------------- | ----------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `app-browser`   | `Dockerfile` target `app-browser`                     | `company-brain-app-browser:<git-sha>`, `:latest` (and the release tag)   | `app-browser.overlay.yml`, `APP_BROWSER_IMAGE_TAG`                                   |
| `coding-egress` | `Dockerfile` target `coding-egress`                   | `company-brain-coding-egress:<git-sha>`, `:latest` (and the release tag) | `company-brain-computers.yml`, `CODING_EGRESS_IMAGE_TAG`                             |
| `coding-git`    | `Dockerfile` target `coding-git`                      | `company-brain-coding-git:<git-sha>`, `:latest` (and the release tag)    | `coding.overlay.yml`, `CODING_GIT_IMAGE_TAG`; `.docker/compose.yml` profile `coding` |
| `socio-coding`  | `deployment/coding/coding.Dockerfile`, `opencode.pin` | `socio-coding:<OpenCode version>`, `:<git-sha>`, `:latest`               | the supervisor, by local image ID (`CODING_SANDBOX_IMAGE`)                           |

`socio-coding` refuses to build without a well-formed, committed `deployment/coding/opencode.pin` for `coding.Dockerfile`'s version ([coding notes](../coding/README.md#pinning-opencode)). The pin is **OpenCode 2.2.0**, not the 2.1.4 the sandbox was first written against: 2.1.4 is a tag with no published GitHub release (its archive URL answers 404), and 2.2.0 is the latest published 2.x release (owner's choice, 2026-10-28). Its release notes change nothing in `opencode run` that the sandbox uses (`--standalone` is now accepted anywhere); the owner's live check still runs it against the gateway first.

**Pinning the sandbox image.** The image is built on the swarm node and never pushed, so it has no repository digest. The build prints its local image ID: `socio-coding: set CODING_SANDBOX_IMAGE=sha256:<64 hex> on the supervisor`. Set exactly that on the supervisor (`company-brain-computers` stack env). The supervisor accepts `name@sha256:<digest>` or a bare `sha256:<64 hex>` image ID and nothing else, resolves the ID locally, refuses to create a sandbox if the image it finds isn't that one, and stays off while the value is empty or a tag. Rebuilding gives a new ID: update the setting with it, deliberately.

## 3. Secrets

Each is 24+ random characters. Create them straight from a CSPRNG into the swarm, never echoed or pasted into stack env, for example:

```sh
openssl rand -hex 32 | tr -d '\n' | docker secret create <name> -
```

| Secret                               | Who reads it                                                      | Notes                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `company_brain_session_secret`       | app (`SESSION_SECRET_FILE`)                                       | exists                                                                                               |
| `company_brain_app_browser_secret`   | app and `app-browser` (`APP_BROWSER_SECRET_FILE`), uid 1000, 0400 | its own value, never `BROWSER_SECRET`'s                                                              |
| `company_brain_coding_egress_secret` | app (`CODING_EGRESS_SECRET_FILE`) and `coding-egress`             | `CODING_EGRESS_SECRET`: the gateway stamp and sandbox credential keys; the supervisor never holds it |
| `company_brain_coding_git_secret`    | app (`CODING_GIT_SECRET_FILE`) and `coding-git`, uid 1000, 0400   | `CODING_GIT_SECRET`; `coding.overlay.yml` names it                                                   |

**The GitHub App.** Coding sessions and extraction use the App connected in Settings → General → GitHub App → Connect GitHub, which makes it with contents and pull requests only, or `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` (or `_FILE`; their `DISPATCH_GITHUB_*` names are read for one release after CB-325). Install it on every repository listed in Settings → Coding; the gateway mints only `contents` and `pull_requests` tokens, never `workflows`, and refuses an installation on another account than the repository's owner.

## 4. Networks

| Network                                   | Made by                       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `company-brain_app_browser`               | the overlay                   | Internal, not attachable; the app (alias `company-brain-apps-internal`) and `app-browser` only. Fixed subnet `${APP_BROWSER_SUBNET:-10.212.0.0/24}`; the app's `APPS_INTERNAL_SUBNET` is the same variable, so they can't drift, and `APPS_INTERNAL_PORT` is 4312. Choose another private /24 if the node already uses that one. A stack network's subnet can't change in place: deploy without the overlay (pruned) first.                                                                                                                                                             |
| `company-brain-coding-gateway`            | the operator, once (external) | `overlay`, `internal`, with a fixed subnet you choose (a free private /24 outside `10.212.0.0/24` and `10.213.0.0/16`): `docker network create --driver overlay --internal --subnet <cidr> company-brain-coding-gateway`. Set that subnet as `CODING_GATEWAY_SUBNET` in both stacks' env: `coding.overlay.yml` makes it the app's `GATEWAY_SUBNET` (the gateway listener, `GATEWAY_PORT` 4340, drops every other source, and every connection without it) and the computers stack makes it `coding-egress`'s `CODING_EGRESS_DIAGNOSTICS_SUBNET` (its diagnostics port, 3129, likewise). |
| `company-brain-computers_coding_outbound` | the computers stack           | `coding-egress`'s route to the registries.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `company-brain-code-<session>`            | the supervisor                | One internal bridge per sandbox, a /28 of `CODING_SANDBOX_SUBNETS` (`10.213.0.0/16`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## 5. Stack changes

**The app browser (`company-brain` stack + `app-browser.overlay.yml`).**

1. Copy `deployment/app-browser/seccomp.json` to the swarm node the service is pinned to (the one labeled `socio=true`) and set stack env `APP_BROWSER_SECCOMP_PROFILE` to its absolute path, `APP_BROWSER_IMAGE_TAG` to the build, and optionally `APP_BROWSER_MAX` (8) and `APP_BROWSER_SUBNET`.
2. Copy the secrets entry from the overlay's header into the app service's `secrets:` in `company-brain.yml` (the overlay can't add it without dropping the others).
3. Deploy the stack with the overlay: `docker stack deploy -c company-brain.yml -c app-browser.overlay.yml company-brain`. A tool that takes one stack file needs the two merged first (`docker stack config --skip-interpolation -c company-brain.yml -c app-browser.overlay.yml`, a client-side command).

The app then has `APP_BROWSER_URL`, starts its internal apps listener on 4312, and takes connections from `APPS_INTERNAL_SUBNET` only. Without `APPS_INTERNAL_SUBNET` it refuses every connection (and logs it once), so the overlay must set it. The public apps host never takes socio credentials in production; `APPS_SOCIO_ON_PUBLIC_HOST=1` lets it, for development only, and is ignored when `NODE_ENV=production`.

**Coding (`company-brain-computers` stack, and the app with `coding.overlay.yml`).**

1. Computers stack: set `CODING_EGRESS_IMAGE_TAG` and `CODING_GATEWAY_SUBNET` (the coding-gateway network's subnet; `coding-egress` gets it as `CODING_EGRESS_DIAGNOSTICS_SUBNET`), scale `coding-egress` to 1 in the stack file, and leave `CODING_SANDBOX_IMAGE` empty until the owner's live checks pass.
2. App stack: create `company_brain_coding_git_secret`, copy the two secrets entries from `coding.overlay.yml`'s header into the app's `secrets:` in `company-brain.yml`, set stack env `CODING_GATEWAY_SUBNET` (the same value) and `CODING_GIT_IMAGE_TAG`, and deploy `company-brain.yml` merged with `coding.overlay.yml` as for the app browser. The app then joins `company-brain-coding-gateway`, serves the gateway listener on 4340 to that subnet alone, reads a session's refused hosts at `CODING_EGRESS_DIAGNOSTICS_URL` (`http://company-brain-coding-egress:3129`), and reaches `coding-git` at `CODING_GIT_URL` on an internal network shared with it alone.
3. Settings → Coding → Sandboxes (admins, with `coding-sessions` on for them): the package registries a new sandbox may read, over `CODING_EGRESS_ALLOW` (npm and PyPI by default), and how long unused workspaces are kept, over `CODING_WORKSPACE_RETENTION_DAYS` (14). The values are read when each sandbox starts; the egress proxy serves exactly the registries named in that sandbox's signed credential, so nothing on the proxy changes with them.

**Local development (Compose).** `docker compose -f .docker/compose.yml --profile app-browser up` with `APP_BROWSER_URL=http://app-browser:4360` and `APP_BROWSER_SECRET` in `.env`; `app-browser-link` has subnet `${APP_BROWSER_SUBNET:-10.212.1.0/24}` (another default than the swarm's) and the app's `APPS_INTERNAL_SUBNET` the same. `--profile coding` adds `coding-git` (set `CODING_GIT_SECRET` and `CODING_GIT_URL=http://coding-git:4350`). With `.docker/compose.computers.yml` and `.docker/compose.computers-app.yml`: `coding-egress` (profile `coding`, `CODING_EGRESS_SECRET`), the `coding-image` build (profile `build-computers`, `OPENCODE_SHA256`), and the app's `CODING_EGRESS_SECRET`; the `coding-gateway` network has the fixed subnet `${CODING_GATEWAY_SUBNET:-10.214.0.0/24}`, which is also the app's `GATEWAY_SUBNET` and the proxy's diagnostics subnet, and the app reads denials at `http://coding-egress:3129`. A host-run app beside a local supervisor (also 4312) needs another `APPS_INTERNAL_PORT`, and `APPS_INTERNAL_SUBNET=127.0.0.0/8` if its app browser connects over loopback.

## 6. Verify

- **App browser start-up self-test.** The router launches Chromium in a reserved slot and requires its renderers sandboxed (seccomp-bpf in their own user namespace); otherwise it logs `App browser: Chromium’s sandbox is not available here (check the seccomp profile); refusing to start.` and exits. A healthy task (`/healthz`, 60 s start period) has passed it. Inspect the task's container: `HostConfig.SecurityOpt` must hold `no-new-privileges` and the seccomp profile, `CapDrop` `ALL`, `CapAdd` `SETUID`, `SETGID`, `KILL`. If the engine dropped `security_opt` for the swarm service, the self-test fails closed: never work around it with `SYS_ADMIN`, `privileged` or `--no-sandbox` (the spec tests refuse them).
- **The internal apps listener** closes, unanswered, any connection from outside `APPS_INTERNAL_SUBNET`, and every connection while it is unset.
- **Coding sandbox egress self-test.** Once `CODING_SANDBOX_IMAGE` is set (and `coding-egress` runs), the supervisor runs a canary sandbox at start and logs `coding-sandbox: egress self-test passed`, or `… FAILED, no sandboxes will be created: …`; `GET /sandboxes/self-test` (supervisor token) answers `{ ok, mode, checkedAt, failures }`, `POST` reruns it. Without the image it logs `coding-sandbox: off (CODING_SANDBOX_IMAGE is not set)`.
- **The owner's live checks** ([coding notes](../coding/README.md#live-checks-owner-run-cb-239-133)): OpenCode's pinned version against the gateway, clone, push and draft PR on a scratch repository, registries through the virtual hosts, an extraction. They come before `CODING_SANDBOX_IMAGE` is set.

## 7. The flags

`socio-actor-access`, `coding-sessions`, `repo-extraction`. They are `dev` flags, so only a deployment marked internal (`SOCIO_DEPLOYMENT_KIND=internal`) can have them on; a customer deployment never does (CB-503). There, admins switch them on Settings → In development, for everyone or for some roles and people, or `FEATURE_FLAGS` sets this server's default (e.g. `socio-actor-access=on`). Prefer a rule for one person first, not `FEATURE_FLAGS`, which is everyone. Turning a flag off for a person, or for everyone, ends those people's grants within a minute (revoked `feature_off`) and stops their use within 5 seconds.

## 8. Still missing

- **Coding sessions are built**, dark. A run's gateway credential works only while that run runs and its session lasts (the `prompt-run` liveness check coding sessions register).
- **Plugins**: socios use installed plugins through the same grants; service plugins have no WebSocket path for people or socios yet.
- **Repository extraction** reaches no app yet: an app is eligible only when its audience answers `accepts(…, 'repo-extract')` (from the manifest), and the delivery route (`GET /api/apps/actor/extractions/:id`) isn't built.
- **The Computer panel** doesn't list sandboxes yet.

## 9. Rollback and turning off

1. Turn the flags off (Settings → Features). Grants end within a minute; nothing else needs to happen for the features to stop.
2. App browser: redeploy `company-brain` without the overlay, pruned (`docker stack deploy --prune`), and remove the copied secrets entry. The app loses `APP_BROWSER_URL`, so the tools aren't offered and the internal listener doesn't start.
3. Coding: empty `CODING_SANDBOX_IMAGE` (no sandboxes), `coding-egress` back to `replicas: 0`, and redeploy `company-brain` without `coding.overlay.yml` (pruned), removing the copied secrets entries: the app loses `CODING_EGRESS_SECRET` (no gateway listener) and `coding-git`.
4. Rolling the release back: the migrations are expand-only. While an older runtime is alive nothing is issued and the apps proxy refuses socio credentials, so a rollback can't leave a grant usable at a runtime that doesn't enforce it.

## 10. Personal plans for coding (CB-239)

Settings → Coding → Personal plans (over `CODING_PERSONAL_PLANS`, off by default) lets people run their own coding sessions on the ChatGPT plan they connected under Account → Inference (the operator must also allow the ChatGPT kind under Settings → Platform). Only for the person's own session in their private chat, never in a room, never for anyone else's work. The session's card says it runs on the person's plan; the gateway holds the plan's sign-in and the sandbox only its `cbgw_`. In the sandbox, OpenCode talks to the gateway's Responses route through the managed config's `socio-responses` provider (`@ai-sdk/openai`); the live check confirms the pinned OpenCode has it bundled.
