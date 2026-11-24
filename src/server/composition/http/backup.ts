/**
 * Backups and the data key at the HTTP edge: the restore drill, the re-seal and
 * a recovery key's check, admins only.
 */
import { Context } from 'effect';
import type { Hono } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { requireAdmin } from '@socio/foundation/http/guards';
import { parseDataKey } from '@socio/foundation/keys/data-keys';

import type { AppEdge } from '../../main.js';
import { DataKeyAdmin } from '../app/data-keys.js';
import { Ports } from '../ports.js';

import { mountBundleRoutes } from './bundle.js';

export function mountBackupRoutes(app: Hono<AppEnv>, edge: AppEdge | undefined) {
    // The data keys' admin, and scheduled backups' late port, read at each request.
    const dataKeys = edge && Context.get(edge.services, DataKeyAdmin);
    const backups = edge && Context.get(edge.services, Ports).backups;
    // The restore drill now (CB-111), in the background: Service setup shows
    // it running, then its result. One at a time; asked again, it's the same.
    app.post('/api/backups/restore-drill', requireAdmin, (c) => {
        const drill = backups?.peek()?.drill;
        if (!drill) {
            return c.json({ error: 'The continuous copy isn’t set up here.' }, 404);
        }
        void drill.run().catch(() => undefined);
        return c.json(drill.status(), 202);
    });
    // "Re-seal under the data key" (CB-322): every value still under an
    // older key, now, in the background; refused without a data key.
    app.post('/api/data-key/reseal', requireAdmin, async (c) => {
        if (!dataKeys) {
            return c.json({ error: 'Not available here.' }, 404);
        }
        try {
            void dataKeys.resealNow(c.get('user').id);
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'The re-seal couldn’t start.' }, 409);
        }
        return c.json(await dataKeys.status(), 202);
    });
    // "Verify a recovery key" (CB-322): a key from escrow opens a sample of
    // the latest restore's seals, in the background. The key is never
    // stored, logged or echoed, and is wiped when the check ends.
    app.post('/api/backups/verify-key', requireAdmin, async (c) => {
        const drill = backups?.peek()?.drill;
        if (!dataKeys || !drill) {
            return c.json({ error: 'The continuous copy isn’t set up here.' }, 404);
        }
        const body = (await c.req.json().catch(() => undefined)) as { key?: unknown } | undefined;
        if (typeof body?.key !== 'string' || !body.key.trim()) {
            return c.json({ error: 'Enter the recovery key.' }, 400);
        }
        let key: Buffer;
        try {
            key = parseDataKey(body.key, 'The recovery key');
        } catch (error) {
            // parseDataKey's message names the format, never the key.
            return c.json({ error: error instanceof Error ? error.message : 'The key isn’t valid.' }, 400);
        } finally {
            body.key = '';
        }
        try {
            void dataKeys.verifyRecoveryKey(key, c.get('user').id).catch(() => undefined);
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'The check couldn’t start.' }, 409);
        }
        return c.json(drill.status(), 202);
    });
}

/** Backups' routes, and the workspace bundle import's (CB-380), which needs a recent backup. */
function mountBackupAndBundleRoutes(app: Hono<AppEnv>, edge: AppEdge | undefined) {
    mountBackupRoutes(app, edge);
    if (edge) {
        mountBundleRoutes(app, edge);
    }
}

/** Backups' step, as index.ts mounts it: their routes. */
export const backupRoutes = { routes: mountBackupAndBundleRoutes };
