import { Hono } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { requireOperator } from '@socio/foundation/http/guards';

import type { WorkspaceAuditEntry } from '../workspace/contract.js';

import { UpdatesError, type UpdatesShape } from './contract.js';

const STATUS: Record<UpdatesError['code'], 400 | 404 | 409 | 503> = {
    invalid: 400,
    no_feed: 400,
    not_configured: 503,
    no_backups: 503,
    unknown_release: 404,
    not_newer: 400,
    confirm_required: 409,
    busy: 409,
    updater_unavailable: 503,
};

const feedInput = z
    .object({
        kind: z.enum(['github', 'ghcr']),
        repository: z.string().trim().min(3).max(300),
    })
    .strict();

const settingsInput = z
    .object({
        feed: feedInput.nullable().optional(),
        checkHours: z.number().int().optional(),
        autoApply: z.boolean().optional(),
        /** Days behind the newest release before the card warns; 0: never (CB-323). */
        staleDays: z.number().int().optional(),
        token: z.string().max(1000).nullable().optional(),
        /** Back to the environment's settings (the saved token goes too). */
        reset: z.literal(true).optional(),
    })
    .strict();

const applyInput = z
    .object({
        tag: z.string().max(40),
        /** The operator read and did every Upgrading step up to `tag`. */
        confirmUpgrading: z.boolean().optional(),
    })
    .strict();

/**
 * `/api/updates`, operators only (403 for admins and members, CB-259):
 * `GET /updates` (the running build, the feed's newer releases with their
 * notes and Upgrading steps, the updater's state), `PUT /updates/settings`
 * (feed, read token, check interval, automatic updates, staleness window),
 * `POST /updates/check` (check now) and `POST /updates/apply { tag }`
 * (202: back up, then hand the update to the updater; the page polls).
 */
export function updateRoutes(updates: UpdatesShape, audit: (entry: WorkspaceAuditEntry) => void = () => {}) {
    const app = new Hono<AppEnv>();
    app.use('/updates', requireOperator);
    app.use('/updates/*', requireOperator);
    const refusal = (error: unknown) => {
        if (error instanceof UpdatesError) {
            return {
                body: { error: error.message, code: error.code },
                status: STATUS[error.code],
            };
        }
        throw error;
    };
    app.get('/updates', async (c) => c.json(await updates.view()));
    app.put('/updates/settings', async (c) => {
        const parsed = settingsInput.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json({ error: 'Invalid settings.' }, 400);
        }
        try {
            const { reset, ...input } = parsed.data;
            if (reset) {
                await updates.resetSettings();
            } else {
                await updates.saveSettings(input);
            }
        } catch (error) {
            const { body, status } = refusal(error);
            return c.json(body, status);
        }
        // Which fields changed; never the token.
        audit({
            actor: c.get('user').id,
            action: 'update',
            targetKind: 'platform_updates',
            targetId: 'settings',
            detail: parsed.data.reset
                ? 'reset'
                : Object.keys(parsed.data)
                      .map((key) =>
                          key === 'token' ? (parsed.data.token === null ? 'token removed' : 'token set') : key,
                      )
                      .join(', '),
        });
        return c.json(await updates.view());
    });
    app.post('/updates/check', async (c) => {
        if (!updates.settings().feed) {
            return c.json({ error: 'Configure a release feed first.', code: 'no_feed' }, 400);
        }
        await updates.check();
        return c.json(await updates.view());
    });
    app.post('/updates/apply', async (c) => {
        const parsed = applyInput.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json({ error: 'Give the release tag to update to.' }, 400);
        }
        try {
            const preparing = await updates.apply(parsed.data.tag, c.get('user').id, {
                confirmed: parsed.data.confirmUpgrading === true,
            });
            audit({
                actor: c.get('user').id,
                action: 'update',
                targetKind: 'platform_updates',
                targetId: parsed.data.tag,
                detail: 'apply requested',
            });
            return c.json({ preparing }, 202);
        } catch (error) {
            const { body, status } = refusal(error);
            return c.json(body, status);
        }
    });
    return app;
}
