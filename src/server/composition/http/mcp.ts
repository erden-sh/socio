/** MCP connections' OAuth at the HTTP edge. */
import { Context } from 'effect';
import type { Hono } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';

import type { AppEdge } from '../../main.js';
import { MCP_CALLBACK } from '../../mcp/contract.js';
import { mcpPublicRoutes } from '../../mcp/routes.js';
import { LegacyMcpOAuth } from '../mcp.js';

/** The OAuth callback an MCP server's sign-in navigates back to, from its own site. */
export function mcpNavigationPaths(edge: AppEdge | undefined): string[] {
    return edge ? [MCP_CALLBACK] : [];
}

/** Its public routes: after sign-in's, before the session check. */
export function mountMcpOAuth(app: Hono<AppEnv>, edge: AppEdge) {
    app.route('/', mcpPublicRoutes(Context.get(edge.services, LegacyMcpOAuth)));
}

/** MCP sign-in's steps, as index.ts uses them: the paths it navigates to and its OAuth routes. */
export const mcpRoutes = {
    navigationPaths: mcpNavigationPaths,
    oauth: mountMcpOAuth,
};
