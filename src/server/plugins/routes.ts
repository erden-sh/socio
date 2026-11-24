import { Hono, type Context } from 'hono';

import { redactAppLog } from '@socio/foundation/apps/log-redact';
import { DataError } from '@socio/foundation/dataspace/data-error';
import type { AppEnv } from '@socio/foundation/http/app-env';
import { requireAdmin } from '@socio/foundation/http/guards';
import type { PluginBindingChoices } from '@socio/shared/plugins/bindings';
import { pluginBackupStatuses, pluginStorageWarnings } from '@socio/shared/plugins/plugin-backup';
import { PluginSpecError } from '@socio/shared/plugins/plugin-service';
import {
    PLUGIN_UPDATE_ACK_MAX,
    pluginUpdateAdditionLabel,
    type PluginUpdateAck,
} from '@socio/shared/plugins/plugin-update';
import { pluginAudience, pluginMode, type PluginManifest } from '@socio/shared/plugins/plugins';

import type { ActorActionsShape, ActorCall } from '../actors/contract.js';
import type { AuditShape } from '../workspace/contract.js';

import type { InstalledPlugin } from './contract.js';
import { PluginError, type PluginService } from './service.js';

/**
 * What the plugin routes are given besides the service: the socio-access
 * calls they share with apps, actors' `ActorActions` (the continuation
 * over socio access's own app view), which the module reads from its
 * services.
 */
export type PluginRoutesActions = Pick<ActorActionsShape, 'accessContinuationCall' | 'approvalCall' | 'consumeCall'>;

/**
 * `/api/plugins`. Installing and managing plugins is for admins. Opening
 * one (`launch`) and its data routes are for the people its install's
 * audience names (CB-254), and for the plugin's own service; its
 * socio-access calls (`actor`) for its own service only (CB-232).
 */
/**
 * An update's acknowledgment (CB-531), when shaped right: the review's two
 * revisions and the keys of the additions it listed. Anything else is none.
 */
function updateAck(value: unknown): PluginUpdateAck | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    const { from, to, additions } = value as Record<string, unknown>;
    if (
        typeof from !== 'string' ||
        typeof to !== 'string' ||
        !Array.isArray(additions) ||
        additions.length > PLUGIN_UPDATE_ACK_MAX ||
        !additions.every((item) => typeof item === 'string')
    ) {
        return undefined;
    }
    return { from, to, additions: additions as string[] };
}

/**
 * An installed plugin's backup status (CB-458), for a plugin that keeps
 * state on its own volumes: what its snapshots say once the backups are
 * wired, else its manifest's.
 */
function backupOf(row: InstalledPlugin, plugins: Pick<PluginService, 'backups'>) {
    const [manifest] = pluginBackupStatuses([row]);
    if (!manifest) {
        return {};
    }
    const status = plugins.backups?.status(row.id) ?? manifest;
    const { id: _id, name: _name, ...backup } = status;
    return { backup };
}

/** A plugin's own reason for a snapshot (`socio.backup.request`): 1 to 200 characters, no control characters. */
function requestReason(value: unknown) {
    if (typeof value !== 'string') {
        return undefined;
    }
    // oxlint-disable-next-line no-control-regex -- control characters are what it strips
    const reason = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    return reason && reason.length <= 200 ? reason : undefined;
}

/** The sensitive scopes a request says the admin reviewed (`acknowledged`), strings only. */
function acknowledgedScopes(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 8) : [];
}

const BINDINGS_SHAPE =
    'bindings: an object of need names, each "new", { "datasetId": "…" }, or null (a read need left unbound).';

/** An install's or a rebind's choices (CB-451), or null when they aren't shaped right. */
function parseBindingChoices(value: unknown): PluginBindingChoices | null {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 32) {
        return null;
    }
    const out: PluginBindingChoices = {};
    for (const [need, choice] of Object.entries(value)) {
        if (choice === null || choice === 'new') {
            out[need] = choice;
        } else if (
            choice &&
            typeof choice === 'object' &&
            Object.keys(choice).length === 1 &&
            typeof (choice as { datasetId?: unknown }).datasetId === 'string' &&
            (choice as { datasetId: string }).datasetId.length <= 100
        ) {
            out[need] = { datasetId: (choice as { datasetId: string }).datasetId };
        } else {
            return null;
        }
    }
    return out;
}

export function pluginRoutes(plugins: PluginService, actions: PluginRoutesActions, audit?: Pick<AuditShape, 'audit'>) {
    const app = new Hono<AppEnv>();
    // Everything but launch, data and actor is the admin's.
    app.use('/plugins', requireAdmin);
    app.use('/plugins/*', async (c, next) => {
        const rest = c.req.path.split('/').slice(4);
        if (rest[0] === 'launch' || rest[0] === 'data' || rest[0] === 'actor') {
            return next();
        }
        // A plugin's own backup request (CB-458): its identity and proof, checked at the edge and below.
        if (rest[0] === 'backup' && rest[1] === 'request' && rest.length === 2) {
            return next();
        }
        return requireAdmin(c, next);
    });

    // ---- socio access: calls from the plugin's service (CB-232) -----------
    // A service plugin's consequential actions take the same consume-once
    // approvals as an app's, and its queued work the same continuations,
    // for audience `plugin:<id>`. The caller is the plugin's own service,
    // by the service token and the proof of its id (app.ts, the same check
    // as its data routes); the request's `x-cb-obo` must open for this
    // plugin; the grant comes from it, never from the body.
    const pluginCaller = (c: Context<AppEnv>): { status: 401 | 403; call?: undefined } | { call: ActorCall } => {
        const id = c.req.param('id') ?? '';
        if (c.get('pluginService')?.pluginId !== id) {
            return { status: 401 };
        }
        const access = plugins.actors;
        // Nothing on behalf of anyone while an older runtime is live.
        if (!access || !access.actors.issuable()) {
            return { status: 403 };
        }
        const audience = pluginAudience(id);
        const obo = access.actors.credentials.openObo(c.req.header('x-cb-obo'), audience);
        if (!obo) {
            return { status: 403 };
        }
        return {
            call: {
                audience,
                obo,
                personSession: async (hash) => !!(await plugins.sessionByHash(id, hash)),
                mintPersonObo: (sessionHash, requestId, ttlMs) => access.mintObo(id, { sessionHash }, requestId, ttlMs),
            },
        };
    };
    const actorRefused = (c: Context<AppEnv>, status: 401 | 403) =>
        status === 401
            ? c.json({ error: 'The plugin service was refused.' }, 401)
            : c.json(
                  {
                      error: 'Send the plugin’s service token, its proof and the request’s x-cb-obo.',
                  },
                  403,
              );
    app.post('/plugins/:id/actor/continuations', async (c) => {
        const found = pluginCaller(c);
        if (!found.call) {
            return actorRefused(c, found.status);
        }
        return actions.accessContinuationCall(c, found.call);
    });
    app.post('/plugins/:id/actor/approvals', async (c) => {
        const found = pluginCaller(c);
        if (!found.call) {
            return actorRefused(c, found.status);
        }
        return actions.approvalCall(c, found.call);
    });
    app.post('/plugins/:id/actor/approvals/:approval/consume', async (c) => {
        const found = pluginCaller(c);
        if (!found.call) {
            return actorRefused(c, found.status);
        }
        return actions.consumeCall(c, found.call, c.req.param('approval'));
    });
    app.all('/plugins/:id/actor/*', (c) => c.json({ error: 'Not found.' }, 404));
    const fail = (error: unknown) => {
        if (error instanceof PluginError) {
            return { error: error.message, status: error.status, ...error.detail };
        }
        // The data space's refusals of a binding (CB-451), with their own status.
        if (error instanceof DataError) {
            return { error: error.message, status: error.status };
        }
        if (error instanceof PluginSpecError) {
            return { error: error.message, status: 400 as const };
        }
        // The apps runtime's errors (apps/runtime-client.ts) carry a status:
        // a refusal (4xx, such as the socket proxy's) says why as a 409, an
        // unavailable runtime as a 503. Both messages are the runtime's own
        // short sentences. Anything else, a runtime 500 included (status
        // 502), stays in the server log.
        const status = error instanceof Error ? (error as { status?: unknown }).status : undefined;
        if (error instanceof Error && typeof status === 'number' && status >= 400 && status < 500) {
            return { error: redactAppLog(error.message).slice(0, 300), status: 409 as const };
        }
        if (error instanceof Error && status === 503) {
            return { error: redactAppLog(error.message).slice(0, 300), status: 503 as const };
        }
        console.error(
            'Plugin request failed:',
            error instanceof Error ? redactAppLog(error.message).slice(0, 300) : 'unknown',
        );
        return { error: 'The plugin could not be updated. The server log has the details.', status: 502 as const };
    };
    const run = async (work: () => Promise<unknown>): Promise<{ body: unknown; status: number }> => {
        try {
            return { body: (await work()) ?? { ok: true }, status: 200 };
        } catch (error) {
            const { status, ...body } = fail(error);
            return { body, status };
        }
    };

    app.get('/plugins', async (c) => {
        const installed = plugins.list();
        const known = new Set(installed.map((row) => row.id));
        const catalog = await Promise.all(
            plugins.catalogEntries().map(async (manifest) => ({
                id: manifest.id,
                name: manifest.name,
                version: manifest.version,
                author: manifest.author,
                description: manifest.description,
                display: manifest.display,
                mode: pluginMode(manifest),
                audience: manifest.audience ?? 'admins',
                permissions: manifest.permissions,
                // A sensitive scope, shown beside the permissions.
                openAnyHttps: manifest.bridge?.openAnyHttps === true,
                icon: manifest.icon ?? '',
                installed: known.has(manifest.id),
                // CB-458: state on the plugin's own volumes, shown before install.
                ...(pluginMode(manifest) === 'service' && pluginStorageWarnings(manifest.service).length
                    ? { storageWarnings: pluginStorageWarnings(manifest.service) }
                    : {}),
            })),
        );
        const rows = await Promise.all(
            installed.map(async (row) => {
                const status = await plugins.status(row.id).catch(() => undefined);
                const update = plugins.updateReview(row.id);
                return {
                    id: row.id,
                    name: row.manifest.name,
                    description: row.manifest.description,
                    author: row.manifest.author,
                    version: row.version,
                    permissions: row.permissions,
                    openAnyHttps: row.manifest.bridge?.openAnyHttps === true,
                    icon: row.manifest.icon ?? '',
                    enabled: row.enabled,
                    display: row.display,
                    mode: row.mode,
                    audience: row.audience,
                    replicas: row.replicas,
                    running: status?.running ?? 0,
                    state: status?.state ?? (row.enabled ? 'starting' : 'stopped'),
                    origin: row.mode === 'bundled' ? '' : (plugins.origin(row.id) ?? ''),
                    config: row.config,
                    configFields: row.manifest.config ?? {},
                    // The hosts its service may reach, a url setting's included (CB-441).
                    ...(row.mode === 'service' ? { egress: plugins.egress(row) } : {}),
                    // Whether its own volumes are backed up (CB-458); only plugins with state.
                    ...backupOf(row, plugins),
                    // The catalog's newer manifest **Update** adopts (CB-370), and
                    // what it adds for the admin to review and acknowledge (CB-531).
                    ...(update ? { update } : {}),
                };
            }),
        );
        return c.json({ catalog, installed: rows });
    });

    app.post('/plugins/:id/install', async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as {
            config?: Record<string, string>;
            bindings?: unknown;
            acknowledged?: unknown;
        };
        const bindings = body.bindings === undefined ? undefined : parseBindingChoices(body.bindings);
        if (bindings === null) {
            return c.json({ error: BINDINGS_SHAPE }, 400);
        }
        const result = await run(() =>
            plugins.install(c.req.param('id'), body.config ?? {}, {
                ...(bindings ? { bindings } : {}),
                acknowledged: acknowledgedScopes(body.acknowledged),
                by: c.get('user').id,
            }),
        );
        return c.json(result.body, result.status as 200);
    });

    // CB-451: a plugin's dataset needs, their bindings and what each could
    // bind to (installed, or the catalog's manifest before install).
    app.get('/plugins/:id/bindings', async (c) => {
        const result = await run(async () => plugins.bindingPlan(c.req.param('id')));
        return c.json(result.body, result.status as 200);
    });

    // CB-451: rebind one need (`new`, `{ datasetId }`) or unbind a read need (`null`).
    app.put('/plugins/:id/bindings/:need', async (c) => {
        const body = (await c.req.json().catch(() => null)) as { choice?: unknown } | null;
        const choices = body && 'choice' in body ? parseBindingChoices({ need: body.choice }) : null;
        if (!choices) {
            return c.json({ error: 'Send { "choice": "new" | { "datasetId": "…" } | null }.' }, 400);
        }
        const result = await run(async () =>
            plugins.bindNeed(c.req.param('id'), c.req.param('need'), choices.need!, c.get('user').id),
        );
        return c.json(result.body, result.status as 200);
    });

    app.post('/plugins/:id/enable', async (c) => {
        const result = await run(() => plugins.setEnabled(c.req.param('id'), true, c.get('user').id));
        return c.json(result.body, result.status as 200);
    });

    app.post('/plugins/:id/disable', async (c) => {
        const result = await run(() => plugins.setEnabled(c.req.param('id'), false, c.get('user').id));
        return c.json(result.body, result.status as 200);
    });

    // No route sets a plugin's replicas (CB-396): the count is the
    // operator's, from the manifest's `service.replicas` at install.
    // `PluginService.scale` stays for provisioning.

    app.put('/plugins/:id/config', async (c) => {
        const body = (await c.req.json().catch(() => null)) as {
            config?: Record<string, string>;
        } | null;
        // Stored now; a service plugin's service gets them once the saves
        // settle (CB-398 follow-up), or at `/apply`.
        const result = await run(() => plugins.configure(c.req.param('id'), body?.config ?? {}, { apply: 'later' }));
        return c.json(result.body, result.status as 200);
    });

    // The settings page leaving, or **Apply now**: the service gets its stored settings now.
    app.post('/plugins/:id/apply', async (c) => {
        const result = await run(async () => {
            await plugins.applySettings(c.req.param('id'));
            return { ok: true, applied: true };
        });
        return c.json(result.body, result.status as 200);
    });

    app.put('/plugins/:id/audience', async (c) => {
        const body = (await c.req.json().catch(() => null)) as {
            audience?: unknown;
        } | null;
        const result = await run(() =>
            plugins.setAudience(c.req.param('id'), body?.audience as 'admins' | 'members', c.get('user').id),
        );
        return c.json(result.body, result.status as 200);
    });

    // CB-370: adopt the catalog's current manifest in place (a new version,
    // image, webhooks), keeping the plugin's data, config and identity. In
    // the workspace audit with both versions and the public paths, which an
    // update may widen.
    app.post('/plugins/:id/update', async (c) => {
        const id = c.req.param('id');
        const by = c.get('user').id;
        const body = (await c.req.json().catch(() => ({}))) as { acknowledged?: unknown };
        const result = await run(async () => {
            const acknowledged = updateAck(body.acknowledged);
            const updated = await plugins.updateFromCatalog(id, by, acknowledged ? { acknowledged } : {});
            if (updated.changed) {
                const paths = (manifest: PluginManifest | undefined) =>
                    (manifest?.webhooks ?? []).map((hook) => `${hook.method ?? 'POST'} ${hook.path}`).join(', ') ||
                    'none';
                audit?.audit({
                    actor: by,
                    action: 'update',
                    targetKind: 'plugin',
                    targetId: id,
                    // The webhooks: at most 10 paths a side. CB-531: the additions the
                    // admin acknowledged, by key and in the words the review showed.
                    detail: `from ${updated.from} to ${updated.to}; webhooks ${paths(updated.previous)} -> ${paths(updated.manifest)}; acknowledged ${
                        updated.acknowledged?.length
                            ? updated.acknowledged
                                  .map((addition) => `${addition.key} (${pluginUpdateAdditionLabel(addition)})`)
                                  .join('; ')
                            : 'nothing (it adds nothing)'
                    }; revision ${updated.revision}`,
                });
            }
            return { changed: updated.changed, from: updated.from, version: updated.to };
        });
        return c.json(result.body, result.status as 200);
    });

    // CB-458 step 5: a plugin's backup status and its stored snapshots, for its page.
    app.get('/plugins/:id/backups', (c) => {
        const row = plugins.get(c.req.param('id'));
        const { backup } = row ? (backupOf(row, plugins) as { backup?: unknown }) : {};
        if (!row || !backup) {
            return c.json({ error: 'That plugin keeps no data of its own.' }, 404);
        }
        return c.json({ backup, history: plugins.backups?.history(row.id) ?? [] });
    });

    // CB-458 step 5: **Back up now**, in the background; the page shows it running, then its result.
    app.post('/plugins/:id/backup', (c) => {
        const id = c.req.param('id');
        const host = plugins.backups;
        if (!host) {
            return c.json({ error: 'Plugin backups aren’t set up on this server.' }, 409);
        }
        const started = host.backUpNow(id);
        if (!started.ok) {
            return c.json({ error: started.error }, started.status);
        }
        if (!started.coalesced) {
            audit?.audit({
                actor: c.get('user').id,
                action: 'backup',
                targetKind: 'plugin',
                targetId: id,
                detail: 'snapshot of its own storage, outside the scheduled runs',
            });
        }
        return c.json({ coalesced: started.coalesced, backup: host.status(id) }, 202);
    });

    // CB-458 step 5: the plugin's own request (`socio.backup.request`), by
    // its identity token and proof only (`mountPluginBackupRequests`): joined
    // to a snapshot already under way, else at most one an hour and four a day.
    app.post('/plugins/:id/backup/request', async (c) => {
        const id = c.req.param('id');
        const caller = c.get('pluginService');
        if (caller?.pluginId !== id || !caller.identity) {
            return c.json({ error: 'Send the plugin’s own identity token and its proof.' }, 401);
        }
        const body = (await c.req.json().catch(() => null)) as { reason?: unknown } | null;
        const reason = requestReason(body?.reason);
        if (!reason) {
            return c.json({ error: 'Send { "reason": "…" }, 1 to 200 characters.' }, 400);
        }
        const host = plugins.backups;
        if (!host) {
            return c.json({ error: 'Plugin backups aren’t set up on this server.' }, 409);
        }
        const asked = host.request(id, reason);
        if (!asked.ok) {
            if (asked.status === 429) {
                c.header('Retry-After', String(asked.retryAfterSeconds));
            }
            return c.json({ error: asked.error }, asked.status);
        }
        return c.json({ accepted: true, coalesced: asked.coalesced }, 202);
    });

    // A new identity token for the plugin's service now.
    app.post('/plugins/:id/identity', async (c) => {
        const result = await run(() => plugins.rotateIdentity(c.req.param('id')));
        return c.json(result.body, result.status as 200);
    });

    app.delete('/plugins/:id', async (c) => {
        const result = await run(async () => {
            await plugins.uninstall(c.req.param('id'), c.get('user').id);
            return { ok: true, dataKept: true };
        });
        return c.json(result.body, result.status as 200);
    });

    app.post('/plugins/:id/launch', async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as { next?: string };
        const result = await run(async () => ({
            url: await plugins.launch(c.req.param('id'), c.get('user').id, body.next ?? '/'),
        }));
        return c.json(result.body, result.status as 200);
    });

    app.all('/plugins/:id/data', (c) => c.json({ error: 'Not found.' }, 404));
    app.all('/plugins/:id/data/*', async (c) => {
        const id = c.req.param('id');
        // The plugin's own service passed its proof (app.ts); a person must be
        // in the install's audience. Someone outside it learns nothing more
        // than a 404 would tell them.
        if (!c.get('pluginService') && !plugins.mayUse(plugins.get(id), c.get('user'))) {
            return c.json({ error: 'You can’t use this plugin.' }, 403);
        }
        const data = plugins.dataApp(id);
        if (!data) {
            return c.json({ error: 'That plugin has no data here.' }, 404);
        }
        const url = new URL(c.req.url);
        const prefix = `/api/plugins/${id}/data`;
        const path = `${url.pathname.slice(prefix.length) || '/'}${url.search}`;
        // Node 26's undici reads every property of the RequestInit (second arg),
        // and the `duplex` getter on a Request (c.req.raw is Hono's Request$1)
        // fails a brand check ("Illegal invocation"). Pass a plain init object
        // built from the raw request's parts instead (CB-203, Node 26).
        const init: RequestInit & { duplex?: 'half' } = {
            method: c.req.raw.method,
            headers: c.req.raw.headers,
        };
        if (c.req.raw.body) {
            init.body = c.req.raw.body;
            init.duplex = 'half';
        }
        const forwarded = new Request(new URL(path, 'http://plugin'), init);
        return data.fetch(forwarded, { user: c.get('user') });
    });

    return app;
}
