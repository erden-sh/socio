// Must stay first: see packages/foundation/src/no-vendor-telemetry.ts.
import '@socio/foundation/no-vendor-telemetry';
import { defineTool, type ToolDefinition } from '@copilotkit/runtime/v2';
import { z } from 'zod';

import { byDot } from '@socio/data/soft-delete';
import { toolError } from '@socio/foundation/http/tool-error';
import type { DotTurn } from '@socio/foundation/turns/turn';
import { APP_PORT_RANGE } from '@socio/shared/apps/app-types';

import { AppError, AppsService } from './service.js';

export const APP_TOOL_NAMES = [
    'app_register',
    'app_list',
    'app_logs',
    'app_unregister',
    'app_package',
    'app_promote',
    'app_update',
    'app_combine',
] as const;

const PACKAGE = `Package one of your registered mini apps into a versioned bundle (its source and bun.lock, no node_modules, .git or secrets), stored in the user's data space. This is the first step of promotion: a promoted app runs in the workspace app runtime instead of your computer, at the same address, and keeps running when your computer stops.
Write the server for the runtime first:
- Listen on the unix socket in $CB_SOCKET when it is set (Bun.serve({ unix: process.env.CB_SOCKET, fetch })), else on $PORT as now. The runtime gives it no port.
- Keep every bit of state in the data space through $CB_DATA_URL with $CB_DATA_TOKEN (on a 401, read the token again from the file named in $CB_DATA_TOKEN_FILE). Name datasets as in the manifest ("scratch" or an id): after promotion they map to wherever the user put the data. Its working directory is wiped on every restart; there is no shell.
- Outbound requests: only HTTPS to the hosts in the manifest's egress (Bun's fetch uses the HTTPS_PROXY the runtime sets). Nothing else is reachable.
- Settings go in the manifest's env as NAME: description (no secrets); the user fills in the values.
- Secrets (third-party API keys and the like) go in the manifest's secrets as { name, required, description }: a workspace admin sets their values in Settings and grants them, and the promoted app reads them at runtime with its data token (the SDK's secrets.get, or GET $CB_DATA_URL with /data replaced by /workload/secrets/<NAME>). Never ask for a secret's value, and never put one in code, env or data.
The manifest: entry (e.g. "server.ts"), description, datasets ([{ id: "scratch" or a dataset id, access: "read" | "write", tables?: [...] }]), egress (["api.example.com:443"]), routes (["/", "/api/"]), env, secrets. Dependencies must be in package.json with a bun.lock.`;

const PROMOTE = `Ask the user to promote a packaged mini app into the workspace: it then runs in the workspace app runtime (not your computer) at the same address, appears in their launcher, and keeps its data in their data space. For every dataset in the manifest, propose what happens to it: "move" (out of your scratch dataset into a new dataset of the user's; you keep read access unless dot_keeps_read is false), "share" (with a Space: give space; scratch data is moved first), or "keep" (stays where it is; the app reads or writes it there). Nothing moves without a choice. It waits for the user's approval, who may also choose on the Apps page; don't retry while it is pending.`;

const UPDATE = `Propose a new version of a promoted mini app: package it first with app_package, then call this with that version. The user approves the update with its diff (files, manifest, data); it rolls out and the previous version is kept for a rollback. Name a choice (move, share or keep) for each dataset the new version adds.`;

const COMBINE = `Start a new mini app from several of the user's apps: their packaged source is copied into your computer (each app in its own folder, with COMBINE.md describing their manifests) as a starting point. Then build the new app there and take it through app_register, app_package and app_promote like any other.`;

const LOGS = `Read why one of your mini apps failed in the workspace app runtime. Every build (unpacking a version, installing its dependencies) and every start of a version (crash restarts too) is an attempt with its own log and how it ended: exit code, signal, out of memory, health check (it never opened its socket), build failure. By default the newest attempt; or the newest of a version, or one attempt by its number. After a failed promotion or update, read the failed version's log before you change anything: it is that version's own output, not an older one's. Secrets are redacted. Only the app’s owner and workspace admins can read its logs; an admin names another person’s app by its id.`;

const REGISTER = `Publish a small web app you run in your computer, so the user can open it from Socio (Apps). The platform serves it on its own address behind the user's sign-in: only them, until they share it with a Space. It is ephemeral: it runs only while your computer runs it, so keep anything that matters in the data space.
How:
1. Write a Bun server in an explicit shared/ project folder in your computer, e.g. shared/tracker/server.ts with Bun.serve({ hostname: '0.0.0.0', port: Number(process.env.PORT), fetch(req) { … } }). Ports ${APP_PORT_RANGE.min} to ${APP_PORT_RANGE.max}; bind 0.0.0.0, not localhost.
2. Call app_register with its name and port (and the datasets it reads or writes). It may wait for the user's approval; don't retry while it is pending.
3. Pass start_command (e.g. "cd tracker && bun run server.ts"). The platform starts it under its own app identity, with its own private credentials and logs; its working directory is shared/, so omit that prefix in start_command. Never source its env file in your personal shell: that file belongs only to the app. To change or restart an ephemeral app, register the same name and port again with its start_command, or use Start on its card: the platform stops its previous process first and waits for the port. It also restarts the app by itself when it stops answering, with a growing wait between tries. Use app_logs to inspect its output.
Rules: call the data API from the server only (Authorization: Bearer $CB_DATA_TOKEN; GET $CB_DATA_URL/datasets, POST $CB_DATA_URL/datasets/<id>/query {"sql"}, POST …/tables/<table>/rows {"rows"}), never from the browser, and never print the token. On a 401, read CB_DATA_TOKEN again from the env file named in $CB_APP_ENV_FILE and retry once: the platform renews the token there. An app that doesn't is restarted with a new token. Requests reach the app without cookies (the platform signs people in); X-CB-User is an opaque id per person and app, X-CB-Access is owner or space. Use relative URLs. Never put personal data in URLs.`;

/**
 * `app_register`, `app_list`, `app_unregister`, for the turn's Dot
 * acting for its user: the user owns the apps it registers.
 */
export function appTools(apps: AppsService, turn: DotTurn): ToolDefinition[] {
    if (!apps.enabled) {
        return [];
    }
    const attempt = async (work: () => unknown) => {
        turn.check();
        try {
            return await work();
        } catch (error) {
            if (error instanceof AppError) {
                return toolError(error);
            }
            throw error;
        }
    };
    /** A Space by name or id, for share choices. */
    const spaceOf = (ref: string | undefined) => {
        if (!ref) {
            return undefined;
        }
        const wanted = ref.trim().toLowerCase();
        // Spaces this socio may name in its chat (CB-181).
        const spaces = apps.socioSpaces(turn.threadId, turn.dot.id);
        return (
            spaces.find((space) => space.id === ref.trim()) ??
            spaces.find((space) => space.name.toLowerCase() === wanted)
        )?.id;
    };
    const choiceOf = (input: {
        id: string;
        choice: 'move' | 'share' | 'keep';
        space?: string;
        name?: string;
        dot_keeps_read?: boolean;
    }) => ({
        ref: input.id,
        choice: input.choice,
        ...(input.space ? { spaceId: spaceOf(input.space) ?? input.space } : {}),
        ...(input.name ? { name: input.name } : {}),
        ...(input.dot_keeps_read === undefined ? {} : { dotReads: input.dot_keeps_read }),
    });
    /** Any app by its id, if its logs are the turn's user's to read (CB-175). */
    const readable = (name: string) => {
        const ref = name.trim().toLowerCase();
        if (!apps.get(ref)) {
            throw new AppError(`No app "${name}" of yours on this socio; app_list shows them.`, 404);
        }
        return apps.logsOf(ref, turn.userId);
    };
    const find = (ref: string) => {
        const wanted = ref.trim().toLowerCase();
        const mine = apps.forDot(turn.userId, turn.dot.id);
        const app =
            mine.find((item) => item.id === wanted) ??
            mine.find((item) => item.slug === wanted) ??
            mine.find((item) => item.name.toLowerCase() === wanted);
        if (!app) {
            throw new AppError(`No app "${ref}" of yours on this socio; app_list shows them.`, 404);
        }
        return app;
    };
    return [
        defineTool({
            name: 'app_register',
            description: REGISTER,
            parameters: z.object({
                name: z.string().min(1).max(60).describe('A short name; it becomes part of the address.'),
                port: z
                    .number()
                    .int()
                    .min(APP_PORT_RANGE.min)
                    .max(APP_PORT_RANGE.max)
                    .describe('The port the server listens on in your computer.'),
                description: z.string().max(500).optional(),
                datasets: z
                    .array(z.string().max(100))
                    .max(20)
                    .optional()
                    .describe(
                        'Dataset ids or names (from data_list) the app may use; your scratch dataset is always included.',
                    ),
                start_command: z
                    .string()
                    .max(500)
                    .optional()
                    .describe(
                        'Optional: one shell line, run from your workspace after the env file is sourced, e.g. "cd tracker && bun run server.ts". The platform runs it in the background.',
                    ),
                public: z.boolean().optional().describe('Not available yet: every app needs sign-in.'),
            }),
            execute: (input) =>
                attempt(async () => {
                    const outcome = await apps.requestRegister(
                        turn.userId,
                        turn.dot.id,
                        {
                            name: input.name,
                            port: input.port,
                            description: input.description ?? '',
                            datasets: input.datasets ?? [],
                            startCommand: input.start_command ?? null,
                            public: input.public,
                        },
                        turn.threadId,
                    );
                    return outcome;
                }),
        }),
        defineTool({
            name: 'app_list',
            description:
                'Your mini apps on this socio for this user: address, status (ephemeral, packaged, promoted, unpublished), versions, port, datasets, whether it runs and answers, the private app identity, and app_logs for its output.',
            parameters: z.object({}),
            execute: () =>
                attempt(async () => {
                    const views = await apps.listFor(turn.userId);
                    return {
                        apps: views
                            .filter((view) => view.dotId === turn.dot.id && view.owner)
                            .map((view) => {
                                return {
                                    id: view.id,
                                    name: view.name,
                                    url: view.url,
                                    status: view.status,
                                    ...(view.versions?.length
                                        ? {
                                              versions: view.versions.map((version) => ({
                                                  version: version.version,
                                                  files: version.files,
                                                  createdAt: new Date(version.createdAt).toISOString(),
                                              })),
                                              liveVersion: view.liveVersion ?? null,
                                              previousVersion: view.previousVersion ?? null,
                                          }
                                        : {}),
                                    ...(view.runtime ? { runtime: view.runtime } : {}),
                                    port: view.port,
                                    datasets: view.datasetNames,
                                    // A Space everyone in this chat may read, or none (CB-181).
                                    sharedWithSpace:
                                        view.sharedSpaceId &&
                                        apps
                                            .socioSpaces(turn.threadId, turn.dot.id)
                                            .some((space) => space.id === view.sharedSpaceId)
                                            ? (view.sharedSpaceName ?? null)
                                            : null,
                                    startCommand: view.startCommand,
                                    computer: view.computer,
                                    answering: view.answering,
                                    identity: 'private app principal',
                                    logs: 'app_logs',
                                };
                            }),
                    };
                }),
        }),
        defineTool({
            name: 'app_logs',
            description: LOGS,
            parameters: z.object({
                app: z.string().min(1).max(100).describe('Its id or name.'),
                version: z.number().int().min(1).optional().describe('The newest attempt of this version.'),
                attempt: z
                    .number()
                    .int()
                    .min(1)
                    .optional()
                    .describe('One attempt by its number (from the list it returns).'),
                lines: z
                    .number()
                    .int()
                    .min(1)
                    .max(400)
                    .optional()
                    .describe('How many of its last lines; 100 by default.'),
            }),
            execute: (input) =>
                attempt(async () => {
                    // Your own apps on this socio by id, slug or name; any other app by
                    // its id, for its owner and workspace admins only (CB-175).
                    const ref = input.app.trim().toLowerCase();
                    const app =
                        apps
                            .forDot(turn.userId, turn.dot.id)
                            .find((item) => item.id === ref || item.slug === ref || item.name.toLowerCase() === ref) ??
                        readable(input.app);
                    const result = await apps.promotions.diagnostics(app, {
                        version: input.version,
                        attempt: input.attempt,
                        tail: input.lines ?? 100,
                    });
                    if (
                        !result.attempt &&
                        !result.attempts.length &&
                        !AppsService.inRuntime(app) &&
                        input.version === undefined &&
                        input.attempt === undefined
                    ) {
                        return {
                            app: app.id,
                            attempt: null,
                            attempts: [],
                            runtimeLog: await apps.computerLog(app.id, turn.userId, input.lines),
                        };
                    }
                    const at = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
                    const found = result.attempt;
                    return {
                        app: app.name,
                        status: app.status,
                        liveVersion: app.liveVersion,
                        ...(found
                            ? {
                                  attempt: {
                                      attempt: found.attempt,
                                      version: found.version,
                                      kind: found.kind,
                                      state: found.state,
                                      exit: found.reason
                                          ? {
                                                reason: found.reason,
                                                code: found.exitCode,
                                                signal: found.signal,
                                                message: found.message,
                                            }
                                          : null,
                                      startedAt: at(found.startedAt),
                                      upAt: at(found.upAt),
                                      endedAt: at(found.endedAt),
                                      earlierLinesNotShown: found.dropped,
                                      log: found.lines,
                                  },
                              }
                            : {
                                  attempt: null,
                                  note: result.note,
                                  ...(result.runtimeLog ? { runtimeLog: result.runtimeLog } : {}),
                              }),
                        attempts: result.attempts.slice(0, 15).map((item) => ({
                            attempt: item.attempt,
                            version: item.version,
                            kind: item.kind,
                            state: item.state,
                            reason: item.reason,
                            startedAt: at(item.startedAt),
                        })),
                    };
                }),
        }),
        defineTool({
            name: 'app_unregister',
            description:
                'Unregister one of your mini apps: its address stops working, sessions end and its data token is revoked. Stop its server yourself (e.g. pkill -f server.ts) if it should stop running too.',
            parameters: z.object({
                app: z.string().min(1).max(100).describe('Its id or name.'),
            }),
            execute: (input) =>
                attempt(async () => {
                    const app = find(input.app);
                    await apps.unregister(app.id, turn.userId, byDot(turn.dot.id));
                    return { ok: true, unregistered: app.name };
                }),
        }),
        defineTool({
            name: 'app_package',
            description: PACKAGE,
            parameters: z.object({
                app: z.string().min(1).max(100).describe('Its id or name.'),
                dir: z.string().min(1).max(200).describe('Its directory in your workspace, e.g. "tracker".'),
                files: z
                    .array(z.string().min(1).max(200))
                    .max(50)
                    .optional()
                    .describe(
                        'Globs inside dir to include (e.g. ["src/**", "*.ts"]); all files by default. The entry, package.json and bun.lock always go.',
                    ),
                manifest: z
                    .object({
                        entry: z.string().min(1).max(200),
                        description: z.string().max(500).optional(),
                        routes: z.array(z.string().max(200)).max(20).optional(),
                        datasets: z
                            .array(
                                z.object({
                                    id: z.string().min(1).max(100),
                                    access: z.enum(['read', 'write']),
                                    tables: z.array(z.string().max(63)).max(50).optional(),
                                }),
                            )
                            .max(20)
                            .optional(),
                        egress: z.array(z.string().max(270)).max(20).optional(),
                        env: z.record(z.string().max(64), z.string().max(300)).optional(),
                        secrets: z
                            .array(
                                z.object({
                                    name: z.string().max(64),
                                    required: z.boolean().optional(),
                                    description: z.string().max(300).optional(),
                                }),
                            )
                            .max(50)
                            .optional()
                            .describe('Socio Secrets it reads at runtime, by UPPER_CASE name; never their values.'),
                    })
                    .describe('What the bundle is and needs.'),
            }),
            execute: (input) =>
                attempt(() =>
                    apps.promotions.package(
                        turn.userId,
                        turn.dot.id,
                        {
                            app: input.app,
                            dir: input.dir,
                            files: input.files,
                            manifest: input.manifest,
                        },
                        turn.signal,
                    ),
                ),
        }),
        defineTool({
            name: 'app_promote',
            description: PROMOTE,
            parameters: z.object({
                app: z.string().min(1).max(100),
                version: z.number().int().min(1).optional().describe('The packaged version; the newest by default.'),
                datasets: z
                    .array(
                        z.object({
                            id: z.string().min(1).max(100).describe('As in the manifest: "scratch" or a dataset id.'),
                            choice: z.enum(['move', 'share', 'keep']),
                            space: z.string().max(100).optional().describe('For share: the Space’s name or id.'),
                            name: z.string().max(80).optional().describe('For move: the new dataset’s name.'),
                            dot_keeps_read: z.boolean().optional(),
                        }),
                    )
                    .max(20),
                env: z
                    .record(z.string().max(64), z.string().max(300))
                    .optional()
                    .describe('Values for the manifest’s env settings, if the user gave them.'),
            }),
            execute: (input) =>
                attempt(() =>
                    apps.promotions.requestPromote(
                        turn.userId,
                        turn.dot.id,
                        {
                            app: input.app,
                            version: input.version ?? 0,
                            datasets: input.datasets.map(choiceOf),
                            env: input.env ?? {},
                        },
                        turn.threadId,
                    ),
                ),
        }),
        defineTool({
            name: 'app_update',
            description: UPDATE,
            parameters: z.object({
                app: z.string().min(1).max(100),
                version: z.number().int().min(1).optional(),
                datasets: z
                    .array(
                        z.object({
                            id: z.string().min(1).max(100),
                            choice: z.enum(['move', 'share', 'keep']),
                            space: z.string().max(100).optional(),
                            name: z.string().max(80).optional(),
                            dot_keeps_read: z.boolean().optional(),
                        }),
                    )
                    .max(20)
                    .optional(),
            }),
            execute: (input) =>
                attempt(() =>
                    apps.promotions.requestUpdate(
                        turn.userId,
                        turn.dot.id,
                        {
                            app: input.app,
                            version: input.version,
                            datasets: (input.datasets ?? []).map(choiceOf),
                        },
                        turn.threadId,
                    ),
                ),
        }),
        defineTool({
            name: 'app_combine',
            description: COMBINE,
            parameters: z.object({
                apps: z
                    .array(z.string().min(1).max(100))
                    .min(2)
                    .max(6)
                    .describe('The apps to start from (ids or names; the user’s own).'),
                name: z.string().min(1).max(60).describe('The new app’s name.'),
                dir: z
                    .string()
                    .max(200)
                    .optional()
                    .describe('Where to put it in your workspace; combined/<name> by default.'),
            }),
            execute: (input) => attempt(() => apps.promotions.combine(turn.userId, turn.dot.id, input, turn.signal)),
        }),
    ];
}
