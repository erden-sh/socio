/** Connected agents at the HTTP edge: their MCP endpoint and their grants. */
import { Context } from 'effect';
import type { Hono } from 'hono';

import { originList } from '@socio/foundation/http/allowed-host';
import type { AppEnv } from '@socio/foundation/http/app-env';

import { AgentTokens } from '../../agents/contract.js';
import { type AgentMcpSources, mcpRoutes } from '../../agents/mcp.js';
import { agentGrantRoutes } from '../../agents/routes.js';
import { SqliteBoardService } from '../../issues/layer.js';
import type { AppEdge } from '../../main.js';
import { LegacyAgentGrants } from '../agents.js';
import { LegacyWorkspace } from '../base.js';
import { LegacyPlugins } from '../plugins.js';
import { Ports } from '../ports.js';
import { LegacyServiceAccounts } from '../service-accounts.js';

/**
 * Connected agents' MCP endpoint (CB-90): bearer tokens from their grants,
 * outside /api, so none of the key, token or session checks apply. Its
 * sources come from the app's services: the workspace, the board, the
 * plugins and the service accounts, and, at each request, the token
 * resolver (`AgentTokens`) and the docs catalog, which boot phase 4 fills
 * into the `docs` port.
 */
export function mountAgentMcp(app: Hono<AppEnv>, edge: AppEdge, origin: string | string[] | undefined) {
    const { services } = edge;
    const ports = Context.get(services, Ports);
    const sources: AgentMcpSources = {
        workspace: Context.get(services, LegacyWorkspace),
        board: Context.get(services, SqliteBoardService),
        plugins: Context.get(services, LegacyPlugins),
        serviceAccounts: Context.get(services, LegacyServiceAccounts),
        get agentTokens() {
            return Context.get(services, AgentTokens);
        },
        get docs() {
            return ports.docs.peek();
        },
    };
    app.route('/', mcpRoutes(sources, originList(origin)));
}

/** Each person's grants and the admins' view, audited in the workspace. */
export function mountAgentGrants(app: Hono<AppEnv>, edge: AppEdge) {
    const { services } = edge;
    const workspace = Context.get(services, LegacyWorkspace);
    app.route(
        '/api',
        agentGrantRoutes(Context.get(services, LegacyAgentGrants), (entry) => workspace.audit(entry)),
    );
}

/** Connected agents' steps, as index.ts mounts them: their MCP endpoint and their grants. */
export const agentsRoutes = { mcp: mountAgentMcp, grants: mountAgentGrants };
