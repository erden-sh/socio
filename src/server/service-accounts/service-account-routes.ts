import { Hono, type Context } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { requireAdmin } from '@socio/foundation/http/guards';
import { SERVICE_KEY_DAYS, SERVICE_ROLES, SERVICE_SCOPES } from '@socio/shared/service-accounts';

import { ServiceAccountError } from './contract.js';
import type { ServiceAccounts } from './service-accounts.js';

const name = z.string().trim().min(1).max(60);
const accountInput = z
    .object({
        name,
        role: z.enum(SERVICE_ROLES),
        description: z.string().trim().max(300).optional(),
    })
    .strict();
const keyInput = z
    .object({
        name: z.string().trim().min(1).max(60),
        scopes: z.array(z.enum(SERVICE_SCOPES)).min(1),
        days: z.union(SERVICE_KEY_DAYS.map((days) => z.literal(days))),
    })
    .strict();
const body = (c: Context<AppEnv>) => c.req.json().catch(() => null);

/**
 * Service accounts (CB-57). Admins manage them under Account → Service
 * accounts; a service key reaches none of this (its scopes don't list it),
 * except `GET /api/service/whoami`.
 */
export function serviceAccountRoutes(accounts: ServiceAccounts, audit?: (entry: ServiceKeyDeleted) => void) {
    const app = new Hono<AppEnv>();
    const fail = (c: Context<AppEnv>, error: unknown) => {
        if (error instanceof ServiceAccountError) {
            return c.json({ error: error.message }, error.status);
        }
        throw error;
    };
    // What a key is: its account and scopes (any key; 404 for people).
    app.get('/service/whoami', (c) => {
        const key = c.get('serviceKey');
        if (!key) {
            return c.json({ error: 'Not a service key.' }, 404);
        }
        const user = c.get('user');
        return c.json({
            account: { id: user.id, name: user.name, role: user.role },
            key: { id: key.keyId, name: key.name, scopes: key.scopes },
        });
    });
    app.use('/service-accounts', requireAdmin);
    app.use('/service-accounts/*', requireAdmin);
    app.get('/service-accounts', (c) => c.json(accounts.list()));
    app.post('/service-accounts', async (c) => {
        const parsed = accountInput.safeParse(await body(c));
        if (!parsed.success) {
            return c.json({ error: 'Give the account a name and a role (member or admin).' }, 400);
        }
        return c.json(accounts.create(parsed.data, c.get('user').id), 201);
    });
    app.patch('/service-accounts/:id', async (c) => {
        const parsed = accountInput
            .partial()
            .strict()
            .safeParse(await body(c));
        if (!parsed.success) {
            return c.json({ error: 'Invalid service account settings.' }, 400);
        }
        try {
            return c.json(accounts.update(c.req.param('id'), parsed.data));
        } catch (error) {
            return fail(c, error);
        }
    });
    // Disables the account and revokes its keys; what it did stays its own.
    app.delete('/service-accounts/:id', (c) => {
        try {
            return c.json(accounts.disable(c.req.param('id')));
        } catch (error) {
            return fail(c, error);
        }
    });
    app.post('/service-accounts/:id/keys', async (c) => {
        const parsed = keyInput.safeParse(await body(c));
        if (!parsed.success) {
            return c.json(
                {
                    error: `Name the key, pick at least one scope and a lifetime (${SERVICE_KEY_DAYS.join(', ')} days).`,
                },
                400,
            );
        }
        try {
            return c.json(accounts.createKey(c.req.param('id'), parsed.data, c.get('user').id), 201);
        } catch (error) {
            return fail(c, error);
        }
    });
    app.delete('/service-accounts/:id/keys/:keyId', (c) => {
        try {
            return c.json(accounts.revokeKey(c.req.param('id'), c.req.param('keyId')));
        } catch (error) {
            return fail(c, error);
        }
    });
    // Removes a revoked key for good (CB-360): 409 while it was never
    // revoked (expired or not; revoke it first), 404 for an unknown key.
    // The revoke above stays the only way to stop a key.
    app.delete('/service-accounts/:id/keys/:keyId/record', (c) => {
        try {
            const deleted = accounts.deleteRevokedKey(c.req.param('id'), c.req.param('keyId'));
            audit?.({
                actor: c.get('user').id,
                action: 'delete',
                targetKind: 'service_key',
                targetId: deleted.key.id,
                detail: `${deleted.account.name} / ${deleted.key.name} (${deleted.key.id})`,
            });
            return c.json(accounts.get(deleted.account.id));
        } catch (error) {
            return fail(c, error);
        }
    });
    return app;
}

/** The workspace audit line of a key removed for good: names and ids, never its hash or hint. */
export interface ServiceKeyDeleted {
    actor: string;
    action: 'delete';
    targetKind: 'service_key';
    targetId: string;
    detail: string;
}
