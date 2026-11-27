# Security policy

Socio is self-hosted software published by Ingenio Ventures Inc. It runs AI agents ("socios") that read your workspace, call tools, browse the web and run code. It has not had an independent security audit. Read this policy before you deploy it, and especially before you let it run code you don't trust.

This file is the policy: how to report a problem, and what Socio does and doesn't protect against. [docs/SECURITY-ARCHITECTURE.md](docs/SECURITY-ARCHITECTURE.md) describes the as-built mechanisms in detail.

## Report a vulnerability

Report suspected vulnerabilities privately, by either route:

- GitHub private vulnerability reporting on [erden-sh/socio](https://github.com/erden-sh/socio/security) (Security → Report a vulnerability);
- email to <security@ingenioventures.com>.

Don't report them in public issues, pull requests or discussions.

Please include:

- the version or commit (a running server reports its version at `/healthz`);
- the component (server, web client, mobile app, push relay, link Worker, CI, deployment files);
- the deployment shape that matters (auth provider, which optional services are on, the container runtime);
- the steps to reproduce, what you expected and what happened;
- the impact as you understand it, and any proof of concept.

Leave out real credentials, private URLs and other people's personal data. If you need to show them, describe them instead.

Test only against your own deployment. Don't test against shared services that Ingenio Ventures runs for everyone, namely `push.socio.sh`, `link.socio.sh`, `socio.sh` and their staging hosts, beyond ordinary use; don't load-test them; and never access, change or keep data in a workspace that isn't yours. If you find a flaw in a shared service, stop at the smallest demonstration and report it.

There is no bug bounty.

## Scope

In scope, as found in this repository:

- the server (API, page rendering, auth, socios and their tools, the data API, plugins and the apps runtime);
- the web client;
- the mobile app;
- the push relay (`apps/push-relay`) and the link Worker (`apps/link`);
- the CI workflows under `.github/`;
- the deployment files (Dockerfiles, compose files, and the files under `deployment/`).

A safeguard this policy or the architecture document describes that doesn't hold is in scope, even if exploiting it needs a particular configuration.

Out of scope:

- deployments that contradict the [deployment requirements](#deployment-requirements) below, for example mock auth reachable from other machines;
- defects in third-party services and software (identity providers, model providers, Docker, the kernel, the platforms' push services), unless Socio uses them unsafely;
- social engineering of maintainers or users;
- denial of service, including volume-based attacks on the shared services.

## Trust model

Socio has one tenant per deployment: a workspace. Everyone in it shares one server, one database and one set of containers. People, socios and apps inside a deployment are not isolated tenants from each other in the way separate deployments are.

- **Host operator.** Whoever runs the server, its database, its Docker hosts and its secrets can read and change everything, including encrypted data, because the server holds the keys. Nothing in Socio protects a workspace from its host operator.
- **Workspace owner.** One admin is the owner. Other admins can't demote, deactivate or remove the owner or take away their sign-in. Ownership changes only by the owner's explicit, audited action, or from the server's shell.
- **Admins.** Admins manage people, roles, groups, Spaces, socios, plugins, integrations and platform settings. **Admins can read any chat**, including private chats and rooms, through the read-only transcript views under Operations. Each such read is recorded in an access log. Admins also review learning proposals, which draw evidence from everyone's conversations, private ones included.
- **Members.** A private chat is readable through ordinary routes by its owner alone. Rooms, team topics and Spaces are shared by membership. Issues are readable by everyone signed in. The server enforces these rules on every route, whatever the UI shows.
- **Socios.** A socio acts for the person in the conversation, with that person's permissions narrowed by what the socio was granted. A shared (company) socio is used by many people, and its computer and its shared folder are shared among them. Socio tools include no account or permission management.
- **Plugins and apps.** An installed plugin runs as its own service with its own identity and secrets, and can act in the background on the datasets granted to it, without a person present. A promoted app is code a socio wrote. Installing a plugin or promoting an app is a decision to trust that code with what it is given.

"Private" in Socio means private from other members. It does not mean hidden from workspace admins, who can read it through audited views, or from the host operator, who can read everything.

## AI and untrusted-code risks

Socios read content they don't control: repositories, web pages, uploaded files and attachments, email and chat messages, tool and command output, and plugins' answers. Any of it can carry instructions (prompt injection). Expect that a socio can be steered by what it reads. That can lead to:

- running shell commands or code, on its computer or in a coding sandbox;
- using credentials the socio, the person or a plugin can reach;
- destructive or unwanted writes to pages, datasets, issues or repositories;
- wording an approval request so that it looks harmless.

**Approvals.** Many consequential actions ask the person first. Approvals have limits:

- people approve what they are shown, and a misleading but accurate request still gets approved;
- a person can set a socio's policy to skip approvals for some actions;
- an approved command can start processes that keep running after the turn ends, on a computer that persists;
- read access can be granted without a per-request prompt.

**Exfiltration.** Socio's computers have internet access, and can reach other hosts on the network they run on. Anything a socio, its computer, an app or a plugin can read, it can send somewhere. Scopes, grants and egress allowlists limit which data and which destinations each component can reach. They don't stop misuse of data that is legitimately readable through an allowed path: an allowed destination can still receive it.

**Guidance.**

- Grant computers, code execution (`code:run`), plugins and datasets deliberately, to the people and socios who need them.
- Review a socio's pull requests, promoted apps and learned skills as you would a stranger's.
- Keep secrets that socios don't need out of their reach.
- Treat a computer that ran untrusted content as possibly compromised, and recreate it.

## Isolation: containers are not VMs

Socio runs untrusted code in Linux containers. Containers are a real boundary, and Socio hardens them, but they are weaker than virtual machines that each run their own kernel.

### What Socio does

- **Separate Unix identities.** Workloads run as unprivileged users. A computer runs each person's, app's and job's commands under a Unix identity of its own, with a private home. Promoted apps each get their own UID in the supplied image.
- **Read-only roots.** Coding sandboxes, plugin containers and the app browser have read-only root filesystems with small writable areas.
- **Dropped capabilities and no new privileges.** Sandboxes and plugins drop every Linux capability and set `no-new-privileges`. The few components that keep some capabilities (the apps runtime, the computer's command dispatcher, the app browser) hold only what they need to switch users.
- **Internal networks and egress proxies.** In the supplied deployment files, coding sandboxes, plugins, promoted apps and the app browser sit on internal Docker networks. Their only way out is a proxy that allows named destinations, or no way out at all. Computers are the exception: they have open network access.
- **Resource limits.** Coding sandboxes have CPU, memory and process limits. Promoted apps have process limits and a memory watchdog.
- **Optional gVisor.** `COMPUTER_RUNTIME=runsc` runs computers and coding sandboxes under gVisor, if the operator has installed it.

### Inherent weaknesses

- **One shared host kernel.** Under the default runtime (`runc`), every container makes system calls directly into the host's kernel. A reachable kernel vulnerability can cross every container boundary at once. Dropped capabilities, `no-new-privileges` and read-only roots narrow that surface; they don't remove it. Chromium's sandbox, in the app browser, also uses user namespaces, which widens the kernel surface it reaches.
- **Runtime and container escapes.** Bugs in Docker, containerd, runc or the kernel's namespace and mount handling have let containers reach the host before, and will again. Without a separate guest kernel, nothing contains such a failure.
- **The rootful Docker daemon.** The Docker daemon runs as root, and anything that can tell it what to run can take over the host. Two components hold the raw Docker socket: the computers' supervisor and its disk-usage proxy. Their own container restrictions don't limit what they can ask Docker to do. Plugins reach Docker only through Socio's socket proxy. The socket proxy is not read-only: it is a privileged policy gateway that creates and updates services, networks, volumes and secrets after checking each request against its rules. A flaw in those rules would turn it into host-level authority.
- **Promoted apps share one container.** All promoted apps run as separate processes and UIDs inside one apps-runtime container, not one container each. They share its kernel namespaces, its resources and its network position. The memory watchdog checks each app's main process every few seconds; it is not a hard per-app memory limit, and it doesn't count child processes.
- **Computer principals share a container.** The Unix identities inside one computer are useful boundaries, not separate machines. They share the computer's kernel, process table, network and the explicitly shared folder. The dispatcher that switches between them keeps privileges.
- **Side channels and contention.** Co-located workloads share CPU caches, scheduling, memory bandwidth, disk and network. A hostile workload can try to infer what its neighbors do, or slow them down.

### Operator guidance

- **For hostile code, use a stronger runtime.** Run computers and coding sandboxes under gVisor (`runsc`) or a VM-backed runtime such as Kata Containers, if you expect them to run code you don't trust, including whatever a prompt injection could make a socio run.
- **Dedicate the Docker host.** Keep Socio's Docker host or Swarm nodes for Socio. Don't run it next to databases, CI runners, secrets stores or other valuable workloads, and don't share its Docker daemon with anything else.
- **Isolate the network.** Put the hosts where a compromised container can't reach sensitive internal services. Computers can reach the LAN.
- **Patch.** Keep the kernel, Docker and the runtimes up to date. Container isolation is only as strong as those.

## Deployment requirements

[docs/SETUP.md](docs/SETUP.md) covers installation and hardening. A deployment that other machines reach must meet these requirements:

- **Real auth and HTTPS.** Use Better Auth (`AUTH_PROVIDER=betterauth`) behind HTTPS, with an https `APP_ORIGIN`. Behind a reverse proxy, set the trusted-proxy settings so that rate limits see clients' addresses.
- **Mock auth only on loopback.** Mock auth, the default, lets anyone who reaches the app sign in as any user, admins included, with no password. The server refuses to start it on a non-loopback `HOST` or `APP_ORIGIN`. It also refuses requests unless they come from a loopback peer, name a loopback host (`localhost`, `127.x.x.x`, `[::1]`) and carry no proxy forwarding headers, so a same-host reverse proxy or tunnel that forwards a public host name is refused. An SSH forward to `localhost` still reaches it, as anything that runs on the machine can. Never forward remote traffic to a mock-auth server.
- **Docker control stays private.** Never publish the Docker socket, the computers' supervisor, the disk-usage proxy, the socket proxy or the apps runtime's API. They listen on loopback or internal networks; keep it that way. The socket proxy has no authentication of its own and relies on network placement.
- **Network topology.** Keep the internal networks that the compose files and stack define internal. The app browser and the egress proxies must not be reachable from outside, and the app browser must have no route out. Set `no-new-privileges` daemon-wide on Swarm nodes, as [docs/PLUGINS.md](docs/PLUGINS.md) describes, and check that the engine applies the security options you asked for.
- **Mini app hosts.** Serve mini apps on their own host names under `APPS_HOST`, never on the app's own origin.
- **Secrets.** Set `DATA_ENCRYPTION_KEY`, keep it apart from backups, and give secrets as files (the `*_FILE` settings or Docker secrets) where the setting allows it.
- **Required CI checks.** If you run CI for your own fork, make the `check` job and the CLA check required status checks on `main`.

## Data and credentials

**Encrypted by Socio**, with AES-256-GCM under the data key (`DATA_ENCRYPTION_KEY`, with a separate derived key per purpose):

- data space files and chat attachments;
- stored inference credentials, such as backend API keys and people's connected subscription tokens;
- integration credentials the app stores, such as the GitHub App's key;
- objects in S3-compatible storage, which sees only sealed bytes under opaque names;
- the off-site backup copy.

Without a data key, Socio falls back to a key derived from `SESSION_SECRET`, and production warns. Rotating `SESSION_SECRET` then makes those files and credentials unreadable.

**Not encrypted by Socio:** the SQLite database (conversations, pages, issues and their attachments, memories, settings and audit logs), datasets on disk, the search index, and the local backup volume. Use disk encryption and file permissions for these.

Encryption at rest protects against stolen disks and backups. It doesn't protect against the running server, which holds the keys, or against the host operator.

**Sessions.** Web sessions last 7 days and mobile device sessions 30, both renewed while in use. Cookies are HttpOnly, `SameSite=Strict` and, over HTTPS, `__Host-` prefixed. Signing out everywhere, changing a password, an admin's sign-out and deactivation end sessions at once. Accounts are deactivated, never deleted.

**Credentials for socios.** Data tokens that computers, apps and jobs use are short-lived, scoped and revocable, and are redacted from what computers send back to the model. A token inside a computer can be read by other processes running under the same Unix identity.

**Backups.** The local backup volume holds the database and datasets in plaintext, so protect it like the live data. The off-site copy is sealed under the data key. Restoring needs the key the backup was sealed with.

**Logs and audit.** Many paths keep message contents, prompts and tokens out of logs, and several redact known secret shapes. Error text from plugins is redacted for known secret shapes before it is logged or returned. That isn't a universal guarantee: other paths log error text from the apps runtime and outside services, cut short, and redaction catches only recognizable secrets. Treat server logs as sensitive, restrict who reads them, and set their retention yourself. Audit records (admin transcript reads, data access, socio actions on apps, domain operations) are kept in the database.

**Retention.** Deleted items can remain in backups, and the search index can keep an edited page's old text until it compacts.

## Mobile and external services

**Offline copies.** The mobile app keeps an encrypted copy (SQLCipher) of what the person can see. Its keys are in the device's secure storage, available only after the first unlock and never moved to another device. A copy that hasn't reached its workspace locks after 30 days and is wiped 30 days after that. A workspace can set its own periods, from 1 to 365 days for the lock and 7 to 365 for the wipe. The device's clock decides, and only the app can carry out a lock or wipe, so a device kept offline, tampered with or rooted can keep its copy.

**A lost device.** Revoke it: on the web, in the person's devices list, or an admin can do it from People. Revoking ends that device's sessions at once. "Sign out and erase" also tells the app to wipe its copy the next time it reaches the workspace. Removing a device's push subscription only stops notifications; the device stays signed in.

**Push relay.** Phones get notifications through a push relay (`apps/push-relay`), which hands them to the phone platforms' push services. Ingenio Ventures runs one at `push.socio.sh` for hosted workspaces and for self-managed ones that use it; a self-managed deployment can run its own copy from this repository instead. The relay can't read a notification, since the server encrypts each one for the phone's own keys. It does learn:

- the phone's push token, platform and app build;
- each workspace's push public key, and the workspace server's address and origin;
- when each notification is sent;
- which workspaces reach the same phone.

The platforms' push services see the push token, the ciphertext and the timing. A workspace can leave the relay out (`PUSH_ENDPOINT_HOSTS`); its phones then get no notifications.

**Cloud connection.** A deployment can hold an identity at Socio's cloud services, which Ingenio Ventures runs (`cloud.socio.sh`; docs/specs/CLOUD-SERVICES-PROTOCOL.md). It enrolls only with a single-use enrollment token its provisioning gives it (`SOCIO_CLOUD_ENROLLMENT_TOKEN`); without one, and without a stored identity, the server calls none of these services. The private key never leaves the server: it is sealed under the data key, and the server signs short-lived assertions for access tokens, which stay in memory, one per service. The issuer learns:

- the deployment's public key and id, and the terms it accepted;
- once a day, the running version, the app's origin and a fingerprint (a hash of the origin and a random id the server made);
- when the deployment asks for a token, and for which service.

Ingenio can revoke a deployment; the server then stops calling and tells its admins. `SOCIO_CLOUD=off` stops every call, whatever is stored.

**AI reply reports.** While a workspace's admins turn on **Share AI reply reports with Ingenio** (off by default; it is offered only when the cloud connection grants `reports:write`), a person who gives a socio's reply a thumbs-down may report it. They pick a reason, may add a note, and confirm each time on a screen that says what goes, and that another person's message goes too when the reply answered someone else. The report goes to `reports.socio.sh` and holds only:

- the reply's text and when it was written, and the person's message it answered (text only; attachments as `[attachment: …]`), each cut to the collector's caps, marked when that message is another person's. Both come from what the reacting person can see: in a room, what its history shows them. A note the server wrote, such as an approval's continuation that may quote an action's private result, is never sent; and a report that would carry another person's message goes only when the person's confirmation said so;
- the reason, the note, when it was reported, the model's id, where it was given (web or the app) and the app's version;
- two per-deployment hashes (HMAC-SHA256 under a key that never leaves the server): one of the conversation, to group reports on one thread, and one of the socio. Neither can be turned back into an id.

Nothing is added from anyone's account: not the person's name, email or user id, the conversation's or message's ids, the rest of the conversation, tool calls, files, or the workspace's origin; the deployment id travels in the access token. The texts themselves go as written, so a name, an email address or another detail someone typed into the reply, the answered message or the note goes with them; the confirmation and the admins' setting say so. Only credentials are taken out: both texts and the note go through Socio's token redaction and a pass for keys with a known shape, bearer credentials, URL credentials and the values of credential keys (`password`, `token`, `client_secret` and the like, a quoted value whole, in JSON, `key=value` or `key: value`) before they are queued. Ingenio keeps a report for one year, then deletes it. In the workspace, a report waits in an outbox, its body sealed under the data key; once it is sent or has failed, the body is cleared and the row is deleted after 30 days. Removing the thumbs-down before the report goes withdraws it; a sent report stays at Ingenio for its year. Turning sharing off drops every report not yet sent. Who turned sharing on, when, and the version of the text they agreed to are in the workspace audit; only admins can change it, and Ingenio never turns it on for a workspace.

**Link domain.** The links that open the app (sign-in, device pairing, invites) use `link.socio.sh` (`apps/link`), which serves the app-association files and a static fallback page. Codes and tokens travel in the URL fragment, which browsers don't send. The service can still see a link's path, which for some links names the workspace host, plus the connecting address, the User-Agent and the time, whenever a link opens in a browser rather than the app. It keeps no logs or storage of its own. A workspace can point its links at its own host (`AUTH_APP_LINK_HOST`).

**Other outside services** are the ones you configure: identity providers, model providers, SMTP, Telegram, GitHub, DNS and others. Each receives what its integration needs, as the architecture document describes.

## Supply chain, CI and telemetry

**Dependencies and images.**

- Installs use the committed `pnpm-lock.yaml` with `--frozen-lockfile`.
- GitHub Actions are pinned by commit SHA.
- The Node base images are pinned by digest, and release images are published to GHCR, where deployments can pin them by digest.
- Some helper images are pinned by tag only: `litestream/litestream` and `oven/bun` in `Dockerfile`, and `oven/bun` in `deployment/computers/supervisor.Dockerfile`.
- The CI image installs Corepack without a version (the pnpm it then installs is hash-checked).
- Images install Debian packages without versions.
- The computer images are built from a pinned commit of the upstream OpenBot repository, fetched at build time.

A pin fixes which artifact you get; it doesn't make that artifact trustworthy.

**CI for a public repository.** `.github/workflows/ci.yml` treats every branch as untrusted, people's and socios' alike:

- its token is read-only (`contents: read`) and is not kept in the checkout;
- no job has secrets;
- the branch's code runs only in containers with every capability dropped, with no network (or, for the package install, only the npm registry through a proxy);
- pull requests from forks get the read-only token and no secrets, as GitHub provides;
- workflow runs from outside contributors wait for a maintainer's approval, a repository setting.

`release-images.yml` runs only on release tags, which only maintainers push.

### The CLA check

`.github/workflows/cla.yml` is the one workflow triggered by `pull_request_target`, so it runs with a write token on forks' pull requests. It runs the base branch's workflow and a pinned third-party action, and never checks out or runs the pull request's code. It has no secrets beyond its own token, which can write the signatures file, comment on and lock pull requests, and rerun its own runs (`actions`, `contents` and `pull-requests` write).

### Telemetry

Socio sends no vendor telemetry. The analytics senders of its dependencies (CopilotKit's, and Turborepo's in development) are replaced with do-nothing packages or switched off, and tests check this. See [Vendor telemetry](docs/SECURITY-ARCHITECTURE.md#vendor-telemetry).

## Further detail

[docs/SECURITY-ARCHITECTURE.md](docs/SECURITY-ARCHITECTURE.md) covers the CI sandbox, plugins and the socket proxy, coding sandboxes, computers, mini apps and promoted apps, the app browser, page rendering and CSP, live updates between tabs, the domains integration, and the push relay and link Worker, with known limitations for each.
