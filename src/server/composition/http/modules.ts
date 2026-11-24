/** The server modules' routes, in the registry's order. */
import { Context } from 'effect';
import type { Hono } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';

import type { AppEdge } from '../../main.js';
import { mountModule } from '../../modules/mount.js';
import { ModuleHost } from '../base.js';

export function mountModules(app: Hono<AppEnv>, edge: AppEdge) {
    Context.get(edge.services, ModuleHost).use((modules, context) => {
        for (const module of modules) {
            mountModule(app, module, context);
        }
    });
}

/** Modules' step, as index.ts mounts it. */
export const modulesRoutes = { routes: mountModules };
