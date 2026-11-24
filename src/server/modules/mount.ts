import type { Hono } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { requireAdmin } from '@socio/foundation/http/guards';

import type { ModuleContext, ServerModule } from './contract.js';

const ID = /^[a-z][a-z0-9-]*$/;
const paths = (module: Pick<ServerModule, 'id' | 'paths'>) => module.paths ?? [module.id];

/** Ids and paths are unique; checked once, when the platform is built. */
export function checkModules(modules: readonly ServerModule[]) {
    const ids = new Set<string>();
    const owners = new Map<string, string>();
    for (const module of modules) {
        if (!ID.test(module.id)) {
            throw new Error(`Invalid module id "${module.id}".`);
        }
        if (ids.has(module.id)) {
            throw new Error(`Module "${module.id}" is registered twice.`);
        }
        ids.add(module.id);
        for (const path of paths(module)) {
            if (!ID.test(path)) {
                throw new Error(`Module "${module.id}" has an invalid path "${path}".`);
            }
            const owner = owners.get(path);
            if (owner) {
                throw new Error(`Modules "${owner}" and "${module.id}" both claim /api/${path}.`);
            }
            owners.set(path, module.id);
        }
    }
    return modules;
}

/**
 * Mounts a module's routes at `/api`. Every route, middleware included, must
 * sit under one of the module's paths, so a module can't shadow or guard
 * another module's routes.
 */
export function mountModule(app: Hono<AppEnv>, module: ServerModule, ctx: ModuleContext) {
    if (!module.routes) {
        return;
    }
    const routes = module.routes(ctx);
    const own = paths(module);
    for (const route of routes.routes) {
        if (!own.some((path) => route.path === `/${path}` || route.path.startsWith(`/${path}/`))) {
            throw new Error(
                `Module "${module.id}" registers ${route.method} /api${route.path}, outside ${own.map((path) => `/api/${path}`).join(', ')}.`,
            );
        }
    }
    if (module.access === 'admin') {
        for (const path of own) {
            app.use(`/api/${path}`, requireAdmin);
            app.use(`/api/${path}/*`, requireAdmin);
        }
    }
    app.route('/api', routes);
}
