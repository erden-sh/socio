import type { ServerModule } from '../modules/contract.js';
import { Socios } from '../workspace/contract.js';

import { Tools } from './contract.js';
import { mcpConnectionsSchema } from './migrations.js';
import { mcpConnectionRoutes } from './routes.js';
import { McpConnectionsService, McpOAuthService } from './tags.js';

/**
 * People's MCP connections: their tables, routes and tools. The hooks read
 * this folder's services (`McpConnectionsService`, `McpOAuthService`,
 * `tags.ts`) and the turn's tools (`Tools`) from the app's services at the
 * moment of use.
 */
export const mcpConnectionsModule: ServerModule = {
    ...mcpConnectionsSchema,
    dotTools: ({ services }, turn) => services.get(Tools).tools(turn),
    routes: ({ services }) => {
        // The person's socios are the workspace's `Socios`.
        const socios = services.get(Socios);
        return mcpConnectionRoutes({
            connections: services.get(McpConnectionsService),
            oauth: services.get(McpOAuthService),
            socios: (userId) => socios.dotsFor(userId).map(({ id, name }) => ({ id, name })),
        });
    },
    start: async ({ services }) => {
        const connections = services.get(McpConnectionsService);
        connections.resume();
        await connections.repository.recoverCalls(Date.now());
        await connections.repository.pruneOAuth(Date.now());
    },
    stop: ({ services }) => services.get(McpConnectionsService).stop(),
    tick: {
        everyMs: 60_000,
        run: ({ services }) => services.get(McpConnectionsService).repository.pruneOAuth(Date.now()),
    },
};
