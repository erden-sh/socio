import { Navigate, Outlet, redirect, type MiddlewareFunction } from 'react-router';

import { isAdmin } from '@socio/shared/roles';

import { web } from '../lib/web-context';
import type { RouteHandle } from '../shell/shell-context';
import { RouteError } from '../views/RouteError';

import { useModuleContext, useModules } from './context';
import { canUse } from './derive';
import { clientModules } from './registry';
import type { ModuleId } from './types';

/**
 * A module's pages: rendered for users who may use the module, else sent
 * home. Unknown ids (no manifest in the registry) are sent home too. On
 * a page load the server has already decided (`gateMiddleware`); this
 * covers client navigations and a role change between polls.
 */
export function ModuleGate({ id }: { id: ModuleId }) {
    const module = useModules().find((item) => item.id === id);
    const context = useModuleContext();
    if (!module || !canUse(module, context)) {
        return <Navigate to="/" replace />;
    }
    return <Outlet />;
}

/**
 * The gate on the server: before any loader under it runs, on a page load
 * and on a data request, a user who may not use the module is redirected
 * home. The access rule is the manifest's, applied to what the shell gets
 * (the API's state and workspace for this user). Signed out, the request
 * goes on: the shell shows sign-in, and page loaders return nothing.
 */
export const gateMiddleware =
    (moduleId: ModuleId): MiddlewareFunction<Response> =>
    async ({ context }) => {
        const { services } = web(context);
        if (!(await services.user())) {
            return;
        }
        const [state, workspace] = await Promise.all([services.state(), services.workspace()]);
        const module = clientModules.find((item) => item.id === moduleId);
        if (
            !module ||
            !workspace ||
            !canUse(module, {
                admin: isAdmin(workspace.user),
                workspace,
                state,
                configured: workspace.setup.missing.length === 0,
                homeDot: workspace.dots.find((dot) => !dot.archivedAt)!,
            })
        ) {
            throw redirect('/');
        }
    };

/** The handle of a module's gate route: names the module for the header. */
export const gateHandle = (moduleId: ModuleId): RouteHandle => ({ moduleId });

/**
 * A module page that failed to render: the shell stays, the page area says
 * so and offers a reload.
 */
export function ModuleErrorBoundary() {
    return <RouteError />;
}
