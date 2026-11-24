/** Memory at the HTTP edge. */
import { Context } from 'effect';
import type { Hono } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';

import type { AppEdge } from '../../main.js';
import { DEFAULT_EPISODE_RETENTION_DAYS } from '../../memory/contract.js';
import { episodeRetentionDays } from '../../memory/module.js';
import { memoryRoutes as memoryApiRoutes } from '../../memory/routes.js';
import { LegacyConfig, LegacyStore, LegacyWorkspace } from '../base.js';
import type { CoreStore } from '../core-store.js';

/** A person's profile and memories, and their socios' proposals (CB-106). */
export function mountMemoryRoutes(app: Hono<AppEnv>, store: CoreStore, edge: AppEdge | undefined) {
    const workspace = edge && Context.get(edge.services, LegacyWorkspace);
    const retention = edge && {
        store: Context.get(edge.services, LegacyStore).slices.settings,
        config: Context.get(edge.services, LegacyConfig),
    };
    app.route(
        '/api',
        memoryApiRoutes(
            store,
            (entry) => workspace?.audit(entry),
            () =>
                retention
                    ? episodeRetentionDays(retention)
                    : (store.slices.settings.settings().limits?.episodeRetentionDays ?? DEFAULT_EPISODE_RETENTION_DAYS),
        ),
    );
}

/** Memory's step, as index.ts mounts it: its routes. */
export const memoryRoutes = { routes: mountMemoryRoutes };
