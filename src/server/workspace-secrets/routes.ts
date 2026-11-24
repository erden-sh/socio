import { Hono, type Context } from 'hono';
import { ZodError } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { RateLimits } from '@socio/foundation/http/rate-limits';
import { isAdmin } from '@socio/shared/roles';
import {
    pluginWorkloadKey,
    SECRET_NAMES_PER_READ,
    SECRET_READS_PER_MINUTE,
    type SecretHistory,
    type SecretReadFlagView,
    type WorkloadSecret,
    type WorkspaceSecretsState,
    type WorkspaceSecretView,
} from '@socio/shared/workspace-secrets';

import type { WorkspaceSecretsAdminShape } from './contract.js';
import { SecretError } from './service.js';

const fail = (c: Context<AppEnv>, error: unknown) => {
    if (error instanceof SecretError) {
        return c.json({ error: error.message }, error.status);
    }
    if (error instanceof ZodError) {
        return c.json({ error: error.issues[0]?.message ?? 'Invalid request.' }, 400);
    }
    throw error;
};
const body = async (c: Context<AppEnv>) => {
    try {
        return (await c.req.json()) as unknown;
    } catch {
        throw new SecretError('Send JSON.', 400);
    }
};

/**
 * Socio Secrets:
 *
 * - `/api/workspace-secrets…`: write-only management for workspace admins,
 *   signed in (no service keys or data tokens). Nothing returns a value.
 * - `/api/workload/secrets…`: a workspace app's reads with its own data
 *   token, or a service plugin's with its own identity token and proof
 *   (app.ts lets both reach `/api/workload/*`), rate-limited per workload,
 *   `Cache-Control: no-store`, every read and refusal audited.
 */
export function workspaceSecretRoutes(
    secrets: WorkspaceSecretsAdminShape,
    limits = new RateLimits(SECRET_READS_PER_MINUTE, 60_000),
) {
    const app = new Hono<AppEnv>();

    // ---- admins ---------------------------------------------------------
    const admin = async (c: Context<AppEnv>, next: () => Promise<void>) => {
        c.header('Cache-Control', 'no-store');
        if (c.get('dataToken') || c.get('serviceKey') || c.get('pluginService') || !isAdmin(c.get('user'))) {
            return c.json({ error: 'Only a workspace admin can manage secrets.' }, 403);
        }
        await next();
    };
    app.use('/workspace-secrets', admin);
    app.use('/workspace-secrets/*', admin);
    const actor = (c: Context<AppEnv>) => c.get('user').id;
    app.get('/workspace-secrets', (c) => c.json<WorkspaceSecretsState>(secrets.state()));
    app.post('/workspace-secrets', async (c) => {
        try {
            return c.json<WorkspaceSecretView>(await secrets.create(actor(c), (await body(c)) as never), 201);
        } catch (error) {
            return fail(c, error);
        }
    });
    // A secret's history, deleted ones too: names, versions and counts
    // from the audit lines, a page of events (`?before=`, `?limit=`).
    app.get('/workspace-secrets/:id/history', (c) => {
        const whole = (raw: string | undefined) => (raw && /^\d{1,15}$/.test(raw) ? Number(raw) : undefined);
        try {
            return c.json<SecretHistory>(
                secrets.history(c.req.param('id'), {
                    before: whole(c.req.query('before')),
                    limit: whole(c.req.query('limit')),
                }),
            );
        } catch (error) {
            return fail(c, error);
        }
    });
    app.post('/workspace-secrets/flags/:flagId/dismiss', async (c) => {
        try {
            return c.json<SecretReadFlagView>(await secrets.dismissFlag(actor(c), c.req.param('flagId')));
        } catch (error) {
            return fail(c, error);
        }
    });
    app.get('/workspace-secrets/:id', (c) => {
        try {
            return c.json<WorkspaceSecretView>(secrets.get(c.req.param('id')));
        } catch (error) {
            return fail(c, error);
        }
    });
    app.patch('/workspace-secrets/:id', async (c) => {
        try {
            return c.json<WorkspaceSecretView>(
                await secrets.describe(actor(c), c.req.param('id'), (await body(c)) as never),
            );
        } catch (error) {
            return fail(c, error);
        }
    });
    // "Replace": a new version. The value goes in, never back out.
    app.post('/workspace-secrets/:id/versions', async (c) => {
        try {
            return c.json<WorkspaceSecretView>(
                await secrets.replace(actor(c), c.req.param('id'), (await body(c)) as never),
            );
        } catch (error) {
            return fail(c, error);
        }
    });
    app.delete('/workspace-secrets/:id', async (c) => {
        try {
            await secrets.remove(actor(c), c.req.param('id'));
            return c.json({ ok: true });
        } catch (error) {
            return fail(c, error);
        }
    });
    app.put('/workspace-secrets/:id/grants/:appId', async (c) => {
        try {
            return c.json<WorkspaceSecretView>(await secrets.grant(actor(c), c.req.param('id'), c.req.param('appId')));
        } catch (error) {
            return fail(c, error);
        }
    });
    app.delete('/workspace-secrets/:id/grants/:appId', async (c) => {
        try {
            return c.json<WorkspaceSecretView>(await secrets.revoke(actor(c), c.req.param('id'), c.req.param('appId')));
        } catch (error) {
            return fail(c, error);
        }
    });

    // ---- workloads ------------------------------------------------------
    /**
     * The workload a request is from, by key: the workspace app its data
     * token was issued to (promoted apps only), or the plugin its identity
     * token names (`plugin:<id>`; never the shared service token).
     */
    const workload = (c: Context<AppEnv>) => {
        const plugin = c.get('pluginService');
        if (plugin) {
            return plugin.identity ? pluginWorkloadKey(plugin.pluginId) : undefined;
        }
        const token = c.get('dataToken');
        return token && token.purpose === 'app' && token.appId ? token.appId : undefined;
    };
    /** The identity version a plugin called with (a stale one is noted). */
    const identityOf = (c: Context<AppEnv>) => c.get('pluginService')?.identityVersion;
    const refusedToken = (c: Context<AppEnv>) =>
        c.json(
            {
                error: 'Send a workspace app’s data token (promoted apps only), or a plugin’s identity token and proof.',
            },
            401,
        );
    const tooMany = (c: Context<AppEnv>) => {
        c.header('Retry-After', '60');
        return c.json({ error: 'Too many secret reads for this workload. Try again in a minute.' }, 429);
    };
    const version = (c: Context<AppEnv>) => {
        const raw = c.req.query('version');
        if (raw === undefined) {
            return undefined;
        }
        return /^[1-9]\d{0,8}$/.test(raw) ? Number(raw) : Number.NaN;
    };
    app.use('/workload/*', async (c, next) => {
        c.header('Cache-Control', 'no-store');
        c.header('X-Content-Type-Options', 'nosniff');
        await next();
    });
    app.get('/workload/secrets/:name', (c) => {
        const appId = workload(c);
        if (!appId) {
            return refusedToken(c);
        }
        if (!limits.take(appId)) {
            return tooMany(c);
        }
        const wanted = version(c);
        if (Number.isNaN(wanted)) {
            return c.json({ error: 'version is a positive whole number.' }, 400);
        }
        const outcome = secrets.read(appId, c.req.param('name'), wanted, identityOf(c));
        return outcome.ok ? c.json<WorkloadSecret>(outcome.secret) : c.json({ error: outcome.error }, outcome.status);
    });
    // Several at once, all or nothing: a refusal names the refused, never a value.
    app.get('/workload/secrets', (c) => {
        const appId = workload(c);
        if (!appId) {
            return refusedToken(c);
        }
        const names = [
            ...new Set(
                (c.req.query('names') ?? '')
                    .split(',')
                    .map((name) => name.trim())
                    .filter(Boolean),
            ),
        ];
        if (!names.length || names.length > SECRET_NAMES_PER_READ) {
            return c.json({ error: `Name 1 to ${SECRET_NAMES_PER_READ} secrets in names=A,B.` }, 400);
        }
        for (const _ of names) {
            if (!limits.take(appId)) {
                return tooMany(c);
            }
        }
        // Every name is checked (refusals audited) before any value is opened.
        const denied = names
            .filter((name) => !secrets.check(appId, name, identityOf(c)).ok)
            .map((name) => name.slice(0, 64));
        if (denied.length) {
            return c.json({ error: `Not readable by this workload: ${denied.join(', ')}.`, denied }, 403);
        }
        const found: Record<string, WorkloadSecret> = {};
        for (const name of names) {
            const outcome = secrets.read(appId, name, undefined, identityOf(c));
            if (!outcome.ok) {
                return c.json({ error: outcome.error, denied: [name] }, outcome.status);
            }
            found[name] = outcome.secret;
        }
        return c.json<{ secrets: Record<string, WorkloadSecret> }>({ secrets: found });
    });
    return app;
}
