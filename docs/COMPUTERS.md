# A computer for each socio

Socio connects each specialist to its own container through [OpenBot](https://github.com/CopilotKit/OpenBot)'s computer service and supervisor. A socio's ID determines its computer and persistent volumes. Files and browser profiles survive stop/start; they are separate from Spaces pages and conversation history.

The app exposes selected computer tools to the same socio agent used by web chat, channels, scheduled work, and voice's compute delegation. Browser, workspace-file, and shell permissions are saved per socio and checked by the server. They start disabled. No action falls back to your host's shell or files when the computer service is unavailable.

## Start services for local development

Use a working Docker Engine with Compose v2 and BuildKit support for additional build contexts. Keep the application on Node.js 24 as described in [Setup](SETUP.md). Add two different random secrets of at least 24 characters to `.env` and set:

```dotenv
COMPUTER_SUPERVISOR_URL=http://127.0.0.1:4312
COMPUTER_SUPERVISOR_TOKEN=REPLACE_WITH_A_RANDOM_SECRET
COMPUTER_TOKEN=REPLACE_WITH_A_DIFFERENT_RANDOM_SECRET
COMPUTER_NAMESPACE=company-brain
```

Do not use the placeholder values. The supervisor token authorizes lifecycle requests. The computer token is a master used to derive a different credential for each socio; the master stays in the application and supervisor.

Build the images before starting the supervisor. The computer image is built on top of the upstream one, so build that first:

```sh
docker compose --env-file .env -f .docker/compose.computers.yml build computer-upstream
docker compose --env-file .env -f .docker/compose.computers.yml build computer-image computer-supervisor
docker compose --env-file .env -f .docker/compose.computers.yml up -d computer-supervisor
pnpm run dev
```

The computer-upstream and computer-image services are build targets, not shared computers to run. The supervisor creates a container when you start a socio's computer. In this local arrangement, each computer publishes a dynamic loopback port for the app to reach. Port 4312 is the loopback supervisor endpoint. The local control network uses a normal bridge so Docker can publish that port. The container-app overlay makes the control network internal and removes the host port; the app then connects through service DNS.

Open a socio's **Computer** panel, enable computer access and the capabilities you want, then choose **Start**. Check its status, navigate to a page, and refresh its screen. Only grant shell access when that socio needs to run commands.

## Run the application in containers

Configure the existing `SESSION_SECRET` as well as the computer secrets (the container signs in with Better Auth; see [Containers](SETUP.md#containers)). Use the overlay that connects the app to the supervisor and computer network:

```sh
docker compose --env-file .env -f .docker/compose.computers.yml build computer-upstream
docker compose --env-file .env -f .docker/compose.yml -f .docker/compose.computers.yml -f .docker/compose.computers-app.yml build computer-image computer-supervisor app
docker compose --env-file .env -f .docker/compose.yml -f .docker/compose.computers.yml -f .docker/compose.computers-app.yml up -d app computer-supervisor
```

Here, the app addresses computers by their container names. Computers have no published host ports. The supervisor lives on a separate control network, and only the supervisor and the read-only disk usage proxy mount the Docker socket. Neither the web app nor a socio's computer receives that socket. Changing the namespace changes which containers and volumes are selected; keep it stable and unique for each deployment.

## Disk usage (CB-197)

Operations → Health shows each running computer's disk usage: its workspace, browser profile and private volumes together, and its container's writable layer. The supervisor reads CPU and memory, but not disk: Docker sizes volumes only in `GET /system/df`, which walks every volume on the host and can take minutes, and the volumes' files belong to many users, so reading them directly would need a privileged helper. Instead a separate proxy, `computer-disk-usage` in `.docker/compose.computers.yml` (`disk-usage` in the Portainer stack), holds the Docker socket and can make only two fixed reads: `GET /v1.44/system/df?type=volume` and `GET /v1.44/containers/json?all=true&size=true` with the supervisor's labels as filters. It answers only with this namespace's computer volumes and containers, without paths, options or other volumes, and refuses every other request ([disk-usage-proxy.mjs](../deployment/computers/disk-usage-proxy.mjs)). It takes the supervisor token.

The app asks it every 15 minutes in the background, never during a resource sample, and records the last result with each sample for up to 45 minutes. Set `COMPUTER_DISK_USAGE_URL` (`http://127.0.0.1:4313` for a host-run app; the container overlay sets it). Without it, Health says disk usage is not set up; when the proxy or Docker fails, it says unavailable. A computer missing one of its three volumes, or one Docker could not size, shows no total rather than a partial one.

The same proxy answers the deployment's resource use (CB-321) on `GET /deployment/stats`: it lists containers by label (the stacks in `SOCIO_STACKS`, plugin services named `PLUGIN_NAME_PREFIX-<id>` with `socio.managed=plugin`, and this namespace's computers), reads `GET /containers/{id}/stats?stream=false` for each running one, and answers with numbers only: CPU, memory used and limit, restarts, the service and the node (`DISK_USAGE_NODE`). It never inspects a container, reads logs or execs. Operations → Health shows them under **Deployment services**, with each resource sample.

The proxy's own settings: `DISK_USAGE_LISTEN` (`host:port`, `0.0.0.0:4301`), `DISK_USAGE_TOKEN` (the supervisor token), `DISK_USAGE_NAMESPACE` (the computers' namespace), `DISK_USAGE_TIMEOUT_MS` (how long one read of the engine may take, 600000), `DISK_USAGE_NODE`, `SOCIO_STACKS`, `PLUGIN_NAME_PREFIX` and `DOCKER_SOCKET` (the engine's socket inside the container, `/var/run/docker.sock`). The compose file sets the token and namespace and mounts the host's socket at the default path; the others keep their defaults.

The same measurement also sizes each coding sandbox's workspace volume (CB-239), which the proxy passes through by the coding supervisor's own labels and name (`<namespace>-code-work-<key>`), with nothing else. With the `coding-sessions` flag on, the Computer panel's **Coding** tab lists the viewer's own coding sessions on that socio (admins see everyone's): status, repository, branch, age and the workspace's last measured disk, with **Stop**, which ends the session as `coding_stop` does. An admin's Stop of someone else's session is recorded with the admin's name.

```sh
docker compose --env-file .env -f .docker/compose.computers.yml up -d computer-disk-usage
```

## Use the computer

- **Browser:** navigate and inspect the current page, including screenshots and element snapshots. Browser profiles keep cookies and logins across container restarts.
- **Screenshots (CB-157):** a socio's `computer_screenshot` is a JPEG of the browser's 1280×800 view (quality 80), stored as an attachment of the chat, in the person's files under `attachments/<date>/`; its result names the image, never its bytes. A model that can see images gets it as an image, with the person's photos, within the model's image limit (only the newest), as [chat attachments](SETUP.md#chat-attachments) describes; a model without vision gets a note pointing it to `computer_snapshot`. The chat's steps and **Runs** show it as a thumbnail to people who can read the chat. A computer image from before CB-157 sends PNGs, which work the same, larger.
- **Take control:** pause agent input while you click, type, scroll, or press keys in the browser. Release control when done. The agent must obtain a fresh snapshot before resuming element actions.
- **Files:** list, read, and write text files in the socio's workspace. Paths must stay relative to that workspace. These files are not automatically added to Spaces pages.
- **Terminal:** run a bounded command inside that socio's container when shell access is enabled. Command output is displayed; execution does not run in the Socio server.
- **Activity:** inspect action names, who requested them, and success/failure. The audit record deliberately excludes typed values, file contents, and full commands.

Stop retains files and browser profiles. The app does not expose a destructive reset action. Stopping the supervisor does not stop its dynamically created computers; stop each socio's computer first if you want them all offline. Compose does not own those dynamically created containers or volumes. Do not delete named workspace/profile volumes as routine cleanup.

Revoking a capability cancels the application's active request and prevents subsequent actions. Cancellation cannot undo completed side effects, and an upstream browser operation may finish after the request is canceled. Stop the computer when you need to end all activity in its container. Activity keeps every record (the panel shows the latest 50); nothing is pruned.

The template uses standard Docker container isolation; containers share the host kernel. Shell access permits programs and network access inside the container and can read that socio's own browser profile. Run this on infrastructure appropriate for that trust level. `COMPUTER_RUNTIME=runsc` can select an already-installed gVisor runtime; the template does not install it or claim stronger isolation by default. It does not configure a restrictive network-egress policy.

## Data space files from a command (CB-361)

A shell command gets `CB_DATA_URL` and `CB_DATA_TOKEN` (when the operator configured the data API), and moves data space files with `Authorization: Bearer $CB_DATA_TOKEN`:

| Route                                    | What it does                                                                                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET $CB_DATA_URL/files?prefix=<prefix>` | Lists the files the token can read (JSON, full paths such as `dots/<id>/slide-01.png`).                                                              |
| `GET $CB_DATA_URL/files/raw?path=<path>` | Returns one file's bytes as `application/octet-stream`; its stored type is in `X-Media-Type`.                                                        |
| `PUT $CB_DATA_URL/files`                 | Saves `{ "path", "content", "encoding": "base64", "mediaType" }` (`utf8` for text), replacing a file at that path, up to the `files_put` size limit. |

A path that starts with neither `dots/` nor a granted folder is in the socio's own folder. A company socio's token reaches only its shared folder. `files_copy` names that folder `shared/<name>`, and the token names the same file `<name>`. The data space's shared folder is not the computer's own `shared/` directory. A read of `shared/<name>` that finds no file returns a 404 that names the path to use. For example, to build a PDF from copied slides, download each one with `curl -fsS -H "Authorization: Bearer $CB_DATA_TOKEN" -o slide-01.png "$CB_DATA_URL/files/raw?path=slide-01.png"`, assemble the PDF, then `PUT` it back base64-encoded.

## Shared data

A company socio's computer uses the socio's shared dataset and files, rather than a person's private data space. A command's data token can remove files in that shared area; job, personal and promoted-app tokens cannot use that deletion capability.

People who have used the socio can open **Data → Shared with socios** to download files, browse tables, and remove shared files, tables or individual rows. Each deletion asks for confirmation because it affects everyone using that socio. Deleted content is kept for recovery, and the audit records the person who removed it. The view shows the contributor and time when those were recorded; older records may have no contributor. Personal data is not included.

Admins see all company socios' shared areas and their sizes under **Operations → Knowledge**. **Settings → Limits → Socios’ shared areas** controls expiry after a chosen number of days without changes. Its default, `0`, keeps data until someone deletes it; `DATA_SHARED_RETENTION_DAYS` supplies a deployment default. File expiry uses each file's last change; dataset expiry uses the dataset's last change as a whole.

## Verify and troubleshoot

Create two socios and enable the capabilities being tested. Write a file in the first computer, then verify that the second cannot list it. Stop/start the first and verify the file persists. Test a browser session across a restart, takeover and handback, disabled permissions, and pause behavior. Confirm that computer tools fail clearly if the service is unavailable.

A configured endpoint is not evidence that Docker successfully provisioned a computer. An unavailable status can mean the Docker daemon is down, the image was not built, credentials differ, or the app cannot reach the returned computer address. Use the local arrangement for a host-run app and the app overlay for a container-run app. Do not substitute an arbitrary returned service URL or expose the computer API directly to the internet.

If the browser stops answering, a snapshot or screenshot fails after 20 s (other actions keep their 70 s) and the app asks the computer for its health. When the browser is stuck, the socio is told "The computer’s browser is stuck. Restart the computer…", and that computer's browser calls fail at once for a minute, or until it is stopped and started again; shell and file tools are not affected. Whoever can open the socio's **Computer** panel can restart it with **Stop computer**, then **Start computer**. The computer image itself replaces a browser that died or stopped answering, and cuts off a close after 10 s, so this should be rare.

The source revision and the patches (per-socio credentials, browser time limits, an init in each computer, the Git CLI) are documented in [deployment/computers](../deployment/computers/README.md). On a master-token or image change, the supervisor replaces owned computer containers on their next ensure request, retaining their profile and workspace volumes. This ends any in-flight activity; coordinate updates with active work.

Automated tests use controlled service fixtures for policy, request, and lifecycle behavior. Live Docker, model, channel and voice checks must be recorded separately from those tests.

## Private commands and files (CB-227)

The isolated computer image runs shell and file operations as a stable unprivileged Linux identity for the signed-in person. Each person has a private home; files are private by default. Use `shared/` explicitly for collaborative files. File-tool writes there grant the shared group access; shell-created files need deliberate group permissions. The legacy workspace is retained as this shared directory, so existing files remain available without copying them into anyone’s private home.

Mini apps and scheduled jobs run as separate identities, with private credentials and logs. For a development mini app, place source in `shared/<project>` and register a `start_command` relative to `shared/`. The platform starts it and supplies its credentials; a person’s shell cannot source the app’s private environment file. Use `app_logs` for its output. Packaged production apps retain their separate runtime. The platform tracks the process group it starts (`.socio/apps/<slug>.pid` in the app's home): a restart, a new registration or a repair stops that group, and anything of the app's identity still listening on its port, then waits for the port before it starts again. An app that stops answering, or keeps using a refused data token after it was renewed, is restarted with backoff (CB-291).

Upgrade both the supervisor and computer image before the application. An application connected to an older computer image refuses shell/file work rather than falling back to root. Computer replacement retains three volumes: browser profiles, the shared workspace, and private homes plus the UID registry. Back up and restore the entire private volume together; missing or stale identity mappings fail closed. Browser reset keeps private homes and the registry. Shell commands no longer have root privileges: install development dependencies in the private home or project rather than changing system packages.
