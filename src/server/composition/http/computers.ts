/** Socios' computers at the HTTP edge. */
import { Context } from 'effect';
import type { Hono } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';

import { computerRoutes } from '../../computers/computer-routes.js';
import type { AppEdge } from '../../main.js';
import { LegacyWorkspace } from '../base.js';
import { LegacyComputers } from '../computers.js';

export function mountComputerRoutes(app: Hono<AppEnv>, edge: AppEdge) {
    const { services } = edge;
    app.route('/api', computerRoutes(Context.get(services, LegacyComputers), Context.get(services, LegacyWorkspace)));
}

/** Computers' step, as index.ts mounts it: their routes. */
export const computersRoutes = { routes: mountComputerRoutes };
