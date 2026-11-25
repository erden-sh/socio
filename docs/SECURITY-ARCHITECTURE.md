# Security architecture

[SECURITY.md](../SECURITY.md) is the security policy: reporting, scope, the trust model and the deployment requirements. This file is the as-built detail behind it: how each mechanism works and where it stops. Paths are relative to the repository root.

Where this file and the code disagree, the code is right and this file has a bug: report it.

## By design

- **Admins can read every chat.** The Operations transcript views let any workspace admin read any chat or room, read-only, and each read is recorded in an access log. This is intended workspace oversight, not a gap. See [Admin transcript access](#admin-transcript-access).

## Accounts and sessions

**Mock auth** (the default provider) lets anyone who reaches the app choose any configured user, admins included, with no password. It is for development on one machine:

- The server refuses to start with mock auth on a non-loopback `HOST`, or with an `APP_ORIGIN` other than `http://localhost`, `127.0.0.1` or `[::1]` (`src/server/auth/config.ts`). There is no override.
- Every API request and page render also checks the request (`packages/foundation/src/http/local-request.ts`): it must come from a loopback peer, name a loopback host (`localhost`, `*.localhost`, `127.x.x.x` or `[::1]`), and carry no proxy forwarding header (`Forwarded`, `X-Forwarded-*`, `X-Real-IP`, `Via`, CDN client-IP headers and the like). A same-host reverse proxy or tunnel connects from loopback but forwards a public host name, so it is refused (`packages/foundation/tests/auth-guards.test.ts`).
- **Limit:** an SSH forward to `localhost`, or anything else running on the machine, still reaches it as a local browser would. Never forward remote traffic to a mock-auth server.

**Better Auth** (`AUTH_PROVIDER=betterauth`, see [SETUP](SETUP.md#sign-in)) is sign-in inside the app, with no identity service of its own:

- **Methods.** Passkeys (WebAuthn bound to the `APP_ORIGIN` host and origin); email and password (scrypt, at least 10 characters); and OpenID Connect providers (authorization code with PKCE, `state` and `nonce`; ID tokens verified against the issuer's keys, with issuer, audience, expiry and nonce checks).
- **Invite-only by default.** An account exists only if an admin (or the server-side `auth` command) created it, or an OAuth identity matches an allow rule. Allow and admin rules count an email only when it is verified. Self-service sign-up (`AUTH_OPEN_SIGNUP=true`) is opt-in, and a sign-up can't choose its role or app user id.
- **Roles.** `admin` and `member`. One admin is the workspace owner. Other admins can't demote, deactivate or remove the owner, end the owner's sessions or devices, or change the owner's sign-in methods. The owner hands ownership to another active admin in person, with a typed confirmation and a step-up; that is audited and announced to every admin. Only the server's shell can deactivate the owner, and ownership then passes to the earliest-created active admin.
- **First admin.** `AUTH_FIRST_ADMIN_EMAIL` makes the first admin only while the workspace has no active admin, so it never re-promotes an account the admins demoted or deactivated. Linking an account to an existing app user id gives it that user's data, so link only addresses you have checked.
- **Sessions.** Sessions are stored in the database and carried in an HttpOnly, `SameSite=Strict` cookie, `Secure` over https. Web sessions last 7 days, renewed while in use. Mobile device sessions last 30 days, sliding at most once a day (`src/server/auth/devices.ts`). Signing out everywhere, a password change or reset, an admin's sign-out and deactivation end sessions at once. A deactivated person gets no new session by any route, and the service account keys they made are revoked. Accounts are deactivated, never deleted.
- **Requests.** The app's own checks (allowed origins, no cross-site or same-site requests, JSON bodies) apply to `/api/auth/*`, plus Better Auth's origin check. Only the OAuth callbacks and the email confirmation link skip the cross-site check; they verify their own state or token. Redirect targets must be on `APP_ORIGIN`. Sign-in endpoints are rate-limited per client address. Behind a proxy, `AUTH_TRUST_PROXY=true` and `TRUSTED_PROXY_SUBNETS` make the address the client's. Requests from `COMPUTERS_SUBNET` reach only the data API, the job API, `/healthz`, and the mini app and plugin actor routes.
- **Password links** (invites and resets) are single-use and expire: three days for links an admin makes, one hour for emailed resets. Without SMTP, only admins see them, and pass them on privately.
- **Sign-in links** go only to the Telegram account linked to the person's app user, never to an email address. They work once, for 15 minutes, and are stored hashed. The request always gets the same answer, so it reveals nothing about the account. Requests are limited per client address and per account. The link signs in only on a click, so link previews don't use it up. Anyone who controls a person's linked Telegram account can sign in as them: unlink Telegram accounts that change hands.
- **Outbound.** The server talks to each configured OAuth provider, to SMTP if set, and to the Telegram Bot API for sign-in links. Better Auth's telemetry is off.

### Cookie tossing

A page on any subdomain of the app's host (a mini app, or another site on a sibling name) can set a cookie for the app's host or a parent domain, and the browser then sends it to the app. A planted session cookie holding the attacker's own session would sign the victim in as the attacker (login CSRF). `SameSite` doesn't help, since a subdomain is the same site.

Better Auth names its secure cookies `__Secure-cb.<name>`, and a `__Secure-` cookie may carry a Domain. So over https, `src/server/auth/host-cookies.ts` wraps every place Better Auth reads or writes cookies:

- **Outgoing,** each `Set-Cookie` named `__Secure-cb.*` is renamed `__Host-cb.*`. Browsers accept a `__Host-` cookie only from the host itself, Secure, with `Path=/` and no Domain. A cookie that can't meet those rules keeps its name, and the server logs it once.
- **Incoming,** Better Auth sees only the `__Host-cb.*` cookies, renamed back. Every other cookie is dropped.

Over plain http (local development) cookies keep their names. The API also refuses `Sec-Fetch-Site: same-site` requests, so a sibling subdomain can't make credentialed requests.

### Tabs share sign-in state

Tabs of one browser tell each other when they sign in or out, over the `BroadcastChannel` `company-brain:auth` (`packages/client/src/shell/auth-channel.ts`).

- The message is the event name, `signed-in` or `signed-out`, and nothing else: no token, user id, name or email.
- Only pages of the app's own origin, in the same browser profile, can use the channel. Mini apps on other origins can't.
- A tab that hears a message doesn't trust it. It asks the server again with its own cookie and shows what the server says. A forged `signed-in` signs no one in; a forged `signed-out` shows sign-in until the server's answer brings the shell back.
- A tab that hears `signed-out`, or whose poll gets a 401, drops the shell and the user's data it holds. Signed out, a tab doesn't poll.

### Tabs share writes

After a write succeeds, a tab tells the other tabs what changed, over a second `BroadcastChannel`, `company-brain:changes` (`packages/client/src/lib/change-channel.ts`), so they refetch at once.

- A note is `{ topic, id?, spaceId? }`: a kind of item and ids taken from the request's path. Never a title, body, name, email, query string or anything a user typed. Tabs check every note they post or hear against that shape and drop anything else.
- The same origin and profile rule applies as for the sign-in channel.
- A note is neither data nor a permission. A tab that hears one asks the server with its own cookie. A forged note costs one extra request.

## Authorization

The server enforces the sharing model on every route, whatever the UI shows.

- **Chats.** A private chat is readable through ordinary routes by its owner only, and other people get "not found". Rooms are readable by their active members (`src/server/rooms/access.ts`). Workspace admins are the exception: see [Admin transcript access](#admin-transcript-access).
- **Spaces.** A Space open to the workspace is readable by every active person; a members-only Space by its members and editors. Workspace admins are editors of every Space. Page search and socios' Space reads use the same rule (`packages/shared/src/space-memory.ts`, `src/server/spaces/access.ts`), so a `pages:read` key or a socio searches only Spaces its holder may read.
- **Administration.** Spaces, socios, permissions, groups and global settings change only for admins. Socio tools act as the conversation's person and include no management operations.
- **Issues.** Issues, comments and attachments are readable by everyone signed in. Members file into triage and edit their own issue only while it is in triage. Attachments are limited by detected type (PNG, JPEG, GIF, WebP, PDF, plain text), size and count, and are served with their stored type, `nosniff` and a sandbox CSP, as downloads unless they are images.
- **Code execution.** Running code needs the `code:run` permission, which admins have and grant to others through groups. It is checked on every use, so a removal applies at once.

### Admin transcript access

The Operations transcript views give workspace admins read-only access to any chat, rooms included, bypassing the ordinary ownership check (`src/server/operations/transcripts.ts`). Opening a transcript records an access-log entry; paging through its history, grounding and room events is logged once per viewer and chat per 15 minutes. Deleted chats and running turns aren't shown. This is by design: the views are workspace oversight, and they don't notify the chat's owner. "Private" therefore means private from other members, not from admins.

## Learning

- Evidence comes from everyone's conversations, private ones included. Only admins see proposals and evidence.
- Transcripts are scrubbed of email addresses, phone numbers and secret-like strings before analysis, and proposals that still contain them are dropped. Nothing is delivered until an admin publishes it.
- Conversation text can try to steer a proposal (prompt injection). Admin review is the control: read the skill and its evidence before publishing.

## Telegram

- The bot answers only in groups listed in `TELEGRAM_ALLOWED_CHAT_IDS`, and in direct messages from linked accounts.
- Accounts link with a one-time code (single use, ten-minute expiry, stored hashed) redeemed from `/start` in a direct message. The binding uses the numeric Telegram user ID; display names and usernames are never proof of identity.
- Each turn runs as the linked sender.
- A forum topic bound to a room follows the room's membership and lifecycle: a topic whose room is archived or unbound runs nothing (`src/server/telegram/telegram-channel.ts`). An unconverted topic keeps the older team-conversation rule: every linked member who has spoken in the group can read it.
- Run one deployment per bot token. A linked Telegram account can receive sign-in links, so link only your own account.

## Integrations with outside services

### GitHub App

Coding sessions push branches and open draft pull requests through a GitHub App that an admin connects in Settings. The server stores the App's key sealed under the data key. For each push it mints an installation token for one repository, with only contents and pull-request write, and revokes it afterwards. Tokens travel only in `Authorization` headers, never in URLs, argv, git config, the database or logs. Redirects from GitHub are never followed. Nothing GitHub-related reaches a sandbox. The App must never be given the `workflows` permission.

### Bring-your-own ChatGPT plan

When an admin allows it, a person can connect their ChatGPT plan (`src/server/inference/chatgpt/`). The server then reaches `auth.openai.com` and `chatgpt.com` for that person only, with that person's token.

- The token opens the whole ChatGPT account, not only model calls. It is kept only in the person's encrypted connection record and in memory during a turn: never in logs, prompts, socios' tools or computers, sandboxes or the client.
- The ID token is read for the account id and plan, then dropped. Errors carry a code and a fixed message, never the provider's text.
- Refresh tokens rotate; disconnecting or deactivating the person revokes the refresh token and deletes the record.
- `CHATGPT_AUTH_ISSUER` and `CHATGPT_BASE_URL` exist for tests against a fake server, and the server warns when they are set.

### Domains

The optional domains module (admins only) manages proxy hosts and DNS records for the workspace's apps. Both paths start only from an admin's action:

- **The reverse proxy's API** (Nginx Proxy Manager, at `NPM_API_URL` on an internal network). The app signs in as a dedicated, non-administrator user that sees and manages only the items it created. Its login comes from a secret file. The session token is kept in memory only.
- **The DNS provider's API**, only while an operation runs: A records in one zone (`DOMAINS_ZONE`), with a token scoped to DNS edit on that zone. The module changes only records it created, plus the base names it is configured to own.

What goes out: host names, the target address (published in public DNS), the module's own credentials, and the DNS token to the proxy for certificate renewal. Nothing about the workspace's people. Every error, audit row (`domain_ops`) and log line passes a redactor for these credentials, bearer values and JWT-shaped strings. Requests have timeouts, follow no redirects and cap answers.

## CI runs untrusted code

Every branch GitHub Actions runs is treated as untrusted: coding sessions' branches are a coding agent's work, and a branch's tests, scripts and build can do anything. The threats: planted code sending the repository away from a runner with open internet; code escaping into the runner, where the job's token and the network are; and pull request text misleading reviewers or review bots.

- **What is trusted.** `.github/workflows/ci.yml` and `.github/ci/` (the CI image and its egress proxy). Coding sessions can't change `.github/`: the Git proxy (`coding-git`) refuses any push whose commits touch `.github/` or a `CODEOWNERS` file, and Socio's GitHub App has no `workflows` permission. Note that GitHub's `workflows` permission covers only `.github/workflows/`, so `.github/ci/` relies on the `coding-git` check alone. Everything else in a checkout is untrusted, people's branches included.
- **The runner runs nothing the branch controls.** On the runner itself: `actions/checkout` with `persist-credentials: false`; a `tar` copy of the checkout without `.git` into `$RUNNER_TEMP/src`; reading the feature-boundary baseline from the merge commit's first parent; building the CI image from `.github/ci`; and the `docker` commands written in the workflow. Containers mount only the copy, never the workspace, whose `.git` the checkout's post step uses on the runner.
- **Nothing to steal.** `permissions: contents: read` for the whole workflow; no secrets in any job; no `pull_request_target`; every action pinned by commit SHA. Pull requests from forks get the same read-only token and no secrets. Outside contributors' runs wait for a maintainer's approval (a repository setting).
- **The network.** `pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile` runs in a container on an internal Docker network whose only way out is `.github/ci/egress-proxy.mjs`, a CONNECT proxy that allows `registry.npmjs.org:443` and nothing else. That container runs pnpm, not the branch's code, though the branch's manifests, lockfile and `.npmrc` steer what pnpm downloads. Install scripts, format, lint, typecheck, tests and the build run in containers with `--network none`.
- **Containers.** They run as the runner's uid with the group `nogroup` (never the runner's own group, which may be `docker`), with every capability dropped, `no-new-privileges` and an init. The test step alone swaps Docker's default seccomp profile for `.github/ci/chromium-seccomp.json`, a copy of the app browser's profile, so the Chromium sandbox tests run. It allows user namespaces and everything else it doesn't list.
- **Workflow commands.** Everything the branch's code prints is wrapped in `::stop-commands::<token>`, with a fresh random token, so it can't issue workflow commands. Commit messages and pull request text written by `coding-git` have CI-skip directives broken, email addresses removed, closing keywords broken and mentions put in code spans.
- **The shared task cache.** Only a push to `main` writes the Turborepo cache, and it never reads it; pull requests read it and never save. Reads and writes use the split `actions/cache/restore` and `actions/cache/save` actions, pinned, with exact event conditions. The runner's `tar` never extracts anything a container shaped: `.github/ci/turbo-cache.sh` copies only regular files with cache-entry names from and to a directory no container mounts. Turborepo opens the inner tarballs only inside the sandbox. A poisoned entry could fake a pull request's green, but writing one takes a commit on `main`. No image build reads this cache. `tests/ci-workflow.test.ts` pins all of this.
- **The runners.** Blacksmith's single-use VMs (`blacksmith-4vcpu-ubuntu-2604`), a fresh one per job. `.github/ci/runner-check.sh` runs right after checkout in both CI jobs, before any container starts, and stops the job unless Docker is 26 or later (internal networks could leak DNS before that, CVE-2024-29018) and no container can reach a service on the host. Blacksmith's own services listen on the VM (its cache on the VM's private address, and its agent), so the check stops sshd, then `.github/ci/bridge-firewall.sh` drops every packet from Docker's bridges (`docker0`, `br-+`) to the host, IPv4 and IPv6, except replies to connections the host opened, and confirms those rules lead `INPUT`. After that, only those two services' ports may listen beyond loopback; anything else stops the job. On a GitHub-hosted runner the check stops sshd and requires that nothing listens beyond loopback, apart from the DHCP client. Never point this workflow at a runner that outlives its job.
- **Required check.** `check` must be a required status check on `main`; otherwise a failure is only a red mark. A draft pull request runs no job (its checks read as skipped); a draft can't be merged, and marking it ready for review runs both jobs.
- **Residual risk.** Trusted steps have the runner's open network. A compromised pinned image or runner image is out of scope. Blacksmith runs the VMs and the cache behind `actions/cache`, so its operators are trusted as GitHub's would be. Review bots can still be misled by pull request text, so their review is advice, never a gate. Merging is always a person's decision.

### Release images

`.github/workflows/release-images.yml` runs only on pushes of `v*` tags, never on pull requests. Each job asks for its own permissions: build jobs `packages: write`, verification `packages: read`, the release job `contents: write`. It uses only the job's `GITHUB_TOKEN`. Its only cache is Docker's layer cache in GHCR, which only this workflow writes.

### The CLA check

`.github/workflows/cla.yml` is the only workflow on `pull_request_target`, which runs with a write token on forks' pull requests. It runs the base branch's workflow and `contributor-assistant/github-action`, pinned by commit, and never checks out, caches or runs anything from the pull request. Its token has `actions`, `contents` and `pull-requests` write, to record signatures on the `cla-signatures` branch, comment on and lock pull requests, and rerun its own runs. It has no other secrets. Its own script reads only GitHub's API and fails pull requests whose commits have no linked GitHub account. `tests/cla-workflow.test.ts` keeps it from running pull request code or widening its token.

## Containers

[SECURITY.md](../SECURITY.md#isolation-containers-are-not-vms) states the policy: containers share the host kernel and are weaker than VMs. This section lists what each component actually gets.

| Component           | Boundary                                                                                                                                                                                                                                                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker control      | The computers' supervisor and its disk-usage proxy mount the raw Docker socket (`.docker/compose.computers.yml`). Their dropped capabilities don't restrict what they can ask Docker to do.                                                                                                                                                                            |
| Plugin socket proxy | The only plugin path to Docker (`src/apps-runtime/socket-proxy.ts`). Allows selected service, network, volume, image and plugin-secret routes, checks every body, and denies container create, exec, build and other engine routes. A privileged policy gateway, not a read-only proxy. No authentication of its own: it relies on its network placement.              |
| Plugin containers   | Image must be the digest the operator pinned; user `1000:1000`; read-only root; `CapabilityDrop: ["ALL"]`; `NoNewPrivileges`; constrained mounts; their own internal network. No custom runtime may be requested.                                                                                                                                                      |
| Coding sandboxes    | One fixed spec (`deployment/computers/coding-sandbox.mjs`): uid 1000, read-only root, no capabilities, `no-new-privileges`, CPU, memory and PID limits, one work volume and bounded tmpfs, no binds, devices or published ports. The supervisor inspects what it created and removes anything that differs. Runs under `runc` unless `COMPUTER_RUNTIME` names another. |
| Computers           | Separate Unix identities with private homes inside one shared container per socio. The dispatcher keeps `CHOWN`, `SETUID`, `SETGID` and `KILL`. Open internet and LAN access. Base image built from a pinned commit of upstream OpenBot.                                                                                                                               |
| Promoted apps       | Separate processes and UIDs inside one apps-runtime container. Optional `prlimit`; a main-process RSS watchdog rather than a per-app memory cgroup. Network confinement depends on the deployment.                                                                                                                                                                     |
| App browser         | Read-only root, bounded `/tmp`, capabilities dropped but for `SETUID`, `SETGID` and `KILL`, `no-new-privileges`, an internal network with no way out, and a custom seccomp profile.                                                                                                                                                                                    |

**Seccomp and user namespaces.** Coding sandboxes and plugins specify no seccomp profile, so they get the engine's default. The app browser's profile (`deployment/app-browser/seccomp.json`) is default-allow with a denylist, not Docker's default allowlist, so Chromium can create the user namespaces its sandbox needs; that gives it more kernel surface than the default. Socio doesn't require daemon-wide user-namespace remapping.

**Requested is not effective.** A spec asks the engine for settings; it doesn't prove the engine applied them. On Swarm, set `"no-new-privileges": true` in `/etc/docker/daemon.json` on every node, and check that the engine applies `security_opt` to services ([PLUGINS.md](PLUGINS.md), [deployment/actors/README.md](../deployment/actors/README.md)).

## Plugins and the socket proxy

Plugins are services an admin installs from a catalog ([PLUGINS.md](PLUGINS.md)). The apps runtime provisions them through Docker Swarm, but never holds the Docker socket: it talks to the socket proxy over an internal network (`src/apps-runtime/docker.ts`), and only the proxy opens `/var/run/docker.sock` (`src/apps-runtime/socket-proxy-main.ts`).

- **Routes.** The proxy allows engine API version 1.44 only, and only the plugin manager's routes: ping and version, service list, inspect, create, update and delete, task lists, internal plugin networks, plugin volumes, image pulls by pinned digest, and plugin identity secrets. Container routes, exec, build, swarm, nodes, system, events and every other API version are refused (`SOCKET_PROXY_ALLOWLIST`, `SOCKET_PROXY_DENIED`).
- **Bodies.** Every service create and update is checked field by field. Unknown fields, including fields that differ from a known one only by case, are refused, and the proxy forwards its re-serialized copy, never the raw bytes. Privileged mode, added capabilities, devices, host PID or IPC, bind mounts, sysctls, a custom runtime, `Command`/`Args` and `NODE_OPTIONS` are refused.
- **Images.** The image must be `name@sha256:…` and match the digest the operator pinned for that plugin (`SOCKET_PROXY_IMAGE_PINS`). A pin is the operator's choice, not the caller's.
- **Placement.** Constraints are the operator's (`SOCKET_PROXY_PLUGIN_CONSTRAINTS`). A caller can't steer a plugin onto another node.
- **Secrets.** The runtime may create and delete only plugin identity secrets with the plugin's name and labels, and a plugin service may mount only its own. Secrets can be looked up only by exact allowed name; there is no unfiltered list and no inspect by id.
- **Infrastructure services.** An update to the app or the apps runtime service may only add or remove an internal plugin network; every other field must match the engine's current spec.
- **Identity and data.** Each plugin gets its own identity secret and envelope key. Its access to Socio's data goes through the data API, limited to the datasets granted to it, including background datasets it can write without a person present. Requests a plugin receives carry identity headers that the proxy signed.
- **Limits.** The proxy is security-critical code: a parsing or validation bypass would turn permitted management operations into Docker authority over the host. Plugin containers run under the engine's default runtime unless the operator configures the daemon otherwise.

## Coding sessions

Off unless the `coding-sessions` feature is on; every session starts on the person's click.

- **Sandbox.** One container per session, from an image pinned by digest (OpenCode pinned by version and archive checksum), with the fixed spec in [Containers](#containers). The supervisor's API takes no container spec and runs only fixed commands; the prompt goes in on stdin.
- **Network.** Each session has its own internal network with loopback-only DNS. The sandbox reaches only the coding egress proxy, which forwards to the model and Git gateways with a signed stamp naming the sandbox, and to download-only (`GET`, `HEAD`) virtual hosts of the allowlisted package registries. No CONNECT, no DNS, no other host.
- **Gateways.** A separate listener that refuses connections from outside its subnet, then checks the stamp, a per-prompt token and the grant on every request. The model gateway forwards only function tools and known fields, binds the session to the model on its card, and keeps code on the operator's servers unless an admin allows an outside-provider model for that repository. The Git proxy allows only the session's own branch, inspects every pushed commit (identity, message text, protected paths, submodules, token shapes) before a write token exists, and opens draft pull requests only from Socio's own tool.
- **Runtime.** `runc` by default. Set `COMPUTER_RUNTIME=runsc` (gVisor) for a separate kernel boundary.

## Computers

Each socio can have a persistent computer: a container with a shell, files and a browser, created by the computers' supervisor from the OpenBot-based image (`deployment/computers/`).

- **Network.** Computers have open internet access, including to other hosts on the network they run on. There is no egress policy. Run the supervisor only where that is acceptable.
- **Principals.** Shell and file operations run under a stable Unix identity per person, app or job (`deployment/computers/principal-runtime.ts`), each with a private home (mode 0700) on a volume outside the shared workspace. The worker drops to that identity with `setpriv`, clearing supplementary groups, every capability and `no-new-privileges`. Every shell or file request must name a principal, which only the authenticated application gateway supplies (`deployment/computers/isolate-computer.mjs`). Browser operations take no principal, and the dispatcher that switches identities keeps the capabilities it needs to do so.
- **What stays shared.** A company socio's computer is shared by everyone who uses that socio. The shared folder (`shared/` in each home) is readable and writable by all of them. Processes under one identity can read each other's files and environment. All principals share the container's kernel, process table and network.
- **Data tokens.** Each command gets its own short-lived token, written to a file of its own that the command deletes before anything else runs, and revoked when the command returns. On a company socio, a command's token reaches only the socio's shared area (a shared dataset and the shared folder) and, read-only, Space-shared datasets the acting person granted; never the person's own datasets or folders. On a personal socio it reaches what the owner granted. Tokens are redacted from everything a computer sends back. The file tools refuse token files under `.socio/` and leave them out of listings.
- **Runtime.** `COMPUTER_RUNTIME=runsc` selects gVisor if it is installed. The default doesn't install it.

## Mini apps

A socio's mini app is code the socio wrote, running in its computer, so it is treated as untrusted content served on its own origin.

- **Origin isolation.** Each app has its own origin, `<APPS_LABEL_PREFIX><app>--<socio>.<APPS_HOST>`, never the app's. Socio's cookies are host-only and never sent there, and the API refuses its requests (Host and Origin checks, no CORS, `same-site` treated as cross-site). Requests under `APPS_HOST` are answered by the proxy alone, before any route.
- **Sessions.** The hand-off is a one-time code: 60 seconds, single use, bound to one app and one person. The session it opens is stored hashed, bound to that app, in a host-only cookie, for `APPS_SESSION_HOURS` (12). Each request checks the session, the app and the person's access again, so unsharing takes effect at once.
- **The proxy.** It forwards no cookies, drops `Set-Cookie` from the app, strips incoming forwarding and `X-CB-*` headers, and adds `X-CB-User`: an HMAC of the app and the user id, different in each app, never the user id, name or email. No `X-Forwarded-For`. Bodies are capped and streams time out. WebSocket upgrades need a session and the app's own `Origin`.
- **Headers.** `nosniff` always. HTML gets an extra `Content-Security-Policy: frame-ancestors 'none'`.
- **Data tokens.** An app's token is scoped to the owner, the socio and the datasets named at registration, and works on `/api/data` only. It lives in a file in the computer, so other code running there under the same identity can read it.

### Promoted apps

Promotion moves a mini app out of the socio's computer into the apps runtime. It doesn't make the code trusted.

- **Review.** Nothing is promoted or updated without the owner's choice or approval, unless they set that socio's policy to bypass. Every promotion, update, rollback, unpublish and delete is in the owner's data audit.
- **Bundles.** Source and lockfile only: dependency directories, `.git`, token files, `.env*`, `.npmrc`, key files, links and anything but regular files are refused. A bundle is sealed with its checksum and checked again before use. Dependencies are installed from the lockfile only, with lifecycle scripts off, through the egress proxy to the registry alone.
- **Processes.** In the supplied image, each app runs as its own UID (`setpriv`: no capabilities, no supplementary groups, `no_new_privs`), with file, process and core limits (`prlimit`), in a directory other apps' users can't enter, emptied on every restart. UID isolation (`APPS_RUNTIME_UID_BASE`) and `prlimit` (`APPS_RUNTIME_PRLIMIT=on`) are configuration (`src/apps-runtime/config.ts`): a runtime started without them runs every app as its own user, and says so in its log.
- **Memory.** A watchdog reads each app's main process RSS every 5 seconds and restarts the app above `APPS_RUNTIME_MEMORY_MB` (`src/apps-runtime/supervisor.ts`). It doesn't count child processes and allows bursts between samples. It is not a hard per-app memory limit.
- **Ingress.** An app listens on a unix socket only its process and the runtime can open. The runtime's ingress needs a key derived from `APPS_RUNTIME_TOKEN`, opens the socket without following links, and checks its owner, so one app can't pose as another.
- **Network.** In the supplied deployment, the runtime is on internal networks only. The apps' egress proxy opens CONNECT tunnels to each app's declared `host:port` entries, named in credentials the runtime signs, and only to public addresses (resolved and checked, then connected to the checked address). The runtime itself doesn't enforce the topology.
- **Data.** A promoted app's token reaches only the datasets in its grants, and lives in the app's memory. Unpublish and delete revoke it, and unpublish ends every session on the app's origin.

## Socio access to apps and the app browser

Off unless the `socio-actor-access` feature is on for the person. A socio that uses an app for a person is its own principal: never the person, never the app's owner. Operators' runbook: [deployment/actors/README.md](../deployment/actors/README.md).

- **Consent.** Every grant is the person's, on a card that shows platform facts (the app, its origin and owner, the level, the time) before the socio's words, which are shown as inert text. Read access may skip the card only if the person opts in for that socio, and never for an app that always asks. Writes and consequential actions always need the person's click. Grants are reused only in the conversation that asked, last at most 8 hours and idle out after 30 minutes. Delegated access is refused in Telegram groups and topics.
- **Credentials.** Opaque tokens stored by hash, or sealed and checked against their grant on every use. None is ever in a URL, page, model output, log or audit row; tool and computer output is redacted by token shape. Each use re-checks the grant, person, socio, app and feature flag, with a cache of at most 5 seconds, and open sockets are re-checked every 5 seconds.
- **The app browser.** Delegated browsing runs only in the `app-browser` service: one sandboxed Chromium process under its own user per person, socio and grant, locked to the app's origin by request routing and by an internal network with no way out and no name resolution. The worker adds the credential at the network layer with a per-context proof over the request; the router holds no credential.
- **The app's side.** The app gets a signed, 60-second, single-use actor envelope, verified by `@socio/app-sdk`. The data and approvals APIs grant the intersection of the app's rights and the actor's. Consequential actions need a per-action approval bound to a digest of the exact parameters, consumed once.
- **Audit.** `actor_audit` records both identities, the grant and a reason code for every deny, approval, revocation and write outcome, never tokens, bodies or parameters. The table refuses updates and deletes.
- **Limits.** An app that doesn't use the SDK can't be opened by socios. A malicious app can still use its own background rights. Until row ownership ships, everyone who can open an app sees the same rows through it, and so does a socio acting for them.

## Page rendering

The server renders pages with React Router inside the Hono app (`src/server/web`), after every API route.

- **CSP and the SSR nonce.** A rendered page gets `script-src 'self' 'nonce-<n>'`, with 16 random bytes per response, on React Router's inline handoff, its module bootstrap and React's streamed chunks. Files keep `script-src 'self'`. The policy also has `default-src 'self'`, `connect-src 'self'`, `img-src 'self' data:` and `frame-ancestors 'none'`.
- **Caching.** Pages and their data (`.data`) are `no-store`. Hashed files under `/assets/` are immutable.
- **The page guard.** Only GET and HEAD reach the renderer. A cross-site or same-site data request (`.data`) or route discovery (`/__manifest`) gets 403. A link from another site still opens the page: since the session cookie is `SameSite=Strict`, the guard answers with a page that reopens the same address from this site, so the cookie is sent.
- **Data in the page.** A page carries what the API returns to the same user, through the same functions (`src/server/live/views/`): never platform config, environment values or other users' data. `tests/integration/ssr-document.test.ts` renders as a member and checks the page holds nothing of an admin's, no secret and nothing deleted.
- **Who the page is for.** The renderer resolves the user as the API does. Mock auth from another machine is signed out, as on the API.
- **Client code imports server code as types only** (a lint rule), so page bundles hold no copy of the store.
- **Errors.** React Router runs in production mode, which keeps error messages out of the page; the server logs the error's name.

**Conditional polls.** Polled views answer with an `ETag` and `304 Not Modified` when nothing changed (`packages/foundation/src/http/conditional.ts`). The `304` comes after every check a `200` has. A tag is two hashes and carries no readable data. Responses stay `no-store`.

**Compression and BREACH.** The app gzips text responses from 1 kB (`packages/foundation/src/http/compression.ts`), but never `/api/auth/*`, event streams, stored files or HEAD and range requests. Session tokens are never in a compressed body, there is no CSRF token, the CSP nonce changes every response, and one-time secrets are new each time and under 1 kB. Text a teammate writes does share polled responses with a person's own private titles; reading them that way would also need long-term sight of the victim's encrypted traffic. That residual risk is accepted.

## Data at rest and backups

- **The data key.** Data space files, chat attachments and stored inference and integration credentials are sealed with AES-256-GCM under `DATA_ENCRYPTION_KEY`, with a derived key per purpose (HKDF). Files are bound to their owner and id, and every seal names its key by an authenticated id. Seals under the older `SESSION_SECRET`-derived key, or under `DATA_ENCRYPTION_KEY_PREVIOUS` during a rotation, stay readable and are resealed in the background. Without a data key, seals use the `SESSION_SECRET`-derived key and production warns.
- **Not sealed.** The SQLite database (conversations, pages, issues and their attachments, memories, settings, audit logs), datasets on disk and the search index. An edited page's old text can stay in the full-text index until its segments merge.
- **Object storage.** Any S3-compatible store gets sealed bytes under opaque keys, with SigV4-signed requests.
- **Backups.** The local backup volume holds the database and datasets in plaintext; files and objects stay sealed. The optional off-site copy (`BACKUP_S3_*`) seals the database and datasets under the data key before they leave (`src/server/backup/backup-offsite.ts`). Restoring needs the key the backup was sealed with, so keep the key apart from the backups.

## Logs

Logging rules differ by subsystem. Many paths log operation names and error classes, and several redact known secret shapes (the domains module, the ChatGPT connection, data tokens in computer output). It isn't universal:

- the plugin routes and the plugin service pass an error's message through the app-log redactor (`packages/foundation/src/apps/log-redact.ts`: known token shapes, `Bearer` and `Basic` credentials, passwords in URLs, `key=value` secrets) before they cut it to 300 characters and log it or return it to an admin (`src/server/plugins/routes.ts`, `src/server/plugins/service.ts`; `tests/plugin-error-redaction.test.ts`). Redaction catches only recognizable secrets;
- other paths keep error text from outside services or runtimes for operators to diagnose.

Treat server logs as sensitive. Page search keeps no query text; its daily rollup holds counts only.

## Push relay

Phones get notifications through Socio's push relay (`apps/push-relay`): a serverless worker with a small database. Ingenio Ventures runs one at `https://push.socio.sh` (and `push-staging.socio.sh`); a self-managed deployment can run its own copy. A workspace server pushes to it as to any Web Push service, and it forwards the push to the phone platform's push service. A phone has no other way to get a notification while the app isn't running.

- **It can't read a push.** The server encrypts each push for the phone's own keys (RFC 8291) and signs it with its VAPID key. A push too big for the platform's push service goes as a generic alert.
- **One server can't push as another.** A registration is bound at creation to the workspace's push key, and a push signed with another key gets 403. Changing or deleting a registration needs its secret, which the relay keeps only as a hash. Quotas cap what one server or caller can send.
- **What reaches it.** The phone's native push token, its platform, the app's bundle id and push environment, one registration per workspace and phone, and the workspace's push public key. From servers: the ciphertext, the time of each push, the server's address, and the VAPID subject, which is the workspace's https `APP_ORIGIN`. A phone's registrations share its native token, so the relay can tell which workspaces reach the same phone. No name, email, user id or message text.
- **What it keeps.** Registrations, with the date of their last refresh, dropped 60 days after it or at once on sign-out or wipe; per-minute write counts; the iOS push service's provider token. Nothing per push. The platform's request logs, traces, log export and preview URLs are off (`apps/push-relay/wrangler.toml`, pinned by `apps/push-relay/tests/wrangler-config.test.ts`), and client addresses are used only hashed, as rate-limit keys.
- **The platforms' push services.** Each gets the device's push token (and, on iOS, the bundle id), the ciphertext and the timing. On Android, the push library's automatic start is off until the person allows notifications.
- **Leaving it out.** A deployment that sets `PUSH_ENDPOINT_HOSTS` without the relay's hosts refuses phones' subscriptions. Browser Web Push is unaffected.
- **Keys.** The platforms' push credentials are the relay's secrets, never in the repository.

## Link domain

The links that open the app (the sign-in callback, sign-in codes, device pairing, invites, a workspace's link) are https links on `link.socio.sh` (`apps/link`; `link-staging.socio.sh` for development builds), a serverless worker that serves the app-association files and a static page for links no app opened. iOS universal links and Android App Links verify only against a domain that serves the association, which a workspace's own host can't do for every workspace.

- **What reaches it.** A request's path, which names the build, the link's kind and, for pairing, invites and workspace links, the workspace's host; plus the connecting address, the User-Agent and the time. The phone platforms' verifiers fetch the association files. A browser fetches a page only when no app opened the link; a verified link opens the app without a request.
- **Never a code or token.** Codes and invite tokens ride in the URL fragment, which browsers don't send, and links have no query. Each page's one inline script reads the fragment and only fills in the page; its CSP allows only its own script and style, by hash. `apps/link/tests/page-script.test.ts` checks the scripts make no request.
- **Per-host associations.** Each host's association files name only its own builds. The public debug key used by development builds is only ever on the staging host.
- **Nothing forwards by itself.** An invite's page shows the workspace's host and goes there only when the person taps.
- **Nothing kept.** The worker writes no logs, makes no requests and binds no storage. It holds no secret.
- **Choosing another host.** `AUTH_APP_LINK_HOST` and `AUTH_APP_LINK_HOST_DEV` point a workspace's links elsewhere.

## Mobile app

- **Local copy.** An encrypted SQLite database (SQLCipher, `apps/mobile/src/platform/sqlite.ts`). Its keys and the cookie jar are in secure storage, available after first unlock and never moved to another device (`apps/mobile/src/data/keys.ts`).
- **Lease.** A copy that hasn't reached its workspace locks after 30 days and is wiped 30 days after the lock (`apps/mobile/src/data/lease.ts`). A workspace's policy can set 1 to 365 days for the lock and 7 to 365 for the wipe. The device clock decides, and the app enforces it.
- **Revocation.** A person revokes a device from their devices list on the web, and an admin can do it from People (`src/server/auth/better-auth.ts`). Revoking ends the device's sessions. "Sign out this device" locks the copy and keeps unsent work; "Sign out and erase", or deactivating the person, makes the app wipe its copy at its next contact (`apps/mobile/src/data/revoked.ts`). Removing a push subscription only stops notifications.
- **Limits.** Erasure needs the app to run and reach the server. A device that stays offline, or that is rooted or tampered with, keeps its copy until the lease runs out on its own clock, or longer.

## Vendor telemetry

Socio sends no vendor telemetry.

- **CopilotKit.** Scarf (`@scarf/scarf`) and Segment (`@segment/analytics-node`) are replaced with do-nothing packages from `vendor/noop-scarf` and `vendor/noop-segment` (`link:` dependencies plus `pnpm.overrides`). The root postinstall (`vendor/check-stubs.cjs`) fails the install if either is missing or isn't the stand-in. CopilotKit's ingest endpoint is called with plain `fetch`, so the opt-out is the guard: `packages/foundation/src/no-vendor-telemetry.ts` sets `DO_NOT_TRACK=1` and `COPILOTKIT_TELEMETRY_DISABLED=true` before any CopilotKit package loads, and the images and compose files set the same.
- **In the browser.** Every CopilotKit provider gets `enableInspector: false`, and the builds alias the web inspector to a stub. The app imports only `@copilotkit/react-core/v2`, passes no cloud key and always uses its own runtime. The pages' CSP refuses requests to other sites anyway.
- **Turborepo** (development only) is run through `scripts/turbo.mjs`, which turns its telemetry and update check off. A bare `turbo` in a shell would still send telemetry.
- **Tests.** `tests/integration/telemetry.test.ts`, `tests/integration/turbo.test.ts` and `packages/client/tests/copilotkit-inspector.test.tsx` check all of this. The browser smoke test (`scripts/ui-smoke.mjs`) fails on any request to a host other than the app and loopback.
