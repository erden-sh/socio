/**
 * The MCP connections' construction: the graph's steps, which are
 * `mcp/layer.ts`'s layers.
 */
import { Effect, Layer } from 'effect';

import { McpConfig, type McpConfigShape } from '../mcp/contract.js';
import {
    ConnectionsLive,
    McpConnectionsLive,
    McpConnectionsService,
    McpOAuthLive,
    McpOAuthService,
    McpRuntimeLive,
    McpRuntimeService,
    ToolsLive,
} from '../mcp/layer.js';

import { LegacyConfig, LegacyWorkspace } from './base.js';
import { PlatformKeys } from './keys.js';

/** `McpConfig` from the supplied config (`PlatformConfig` has its fields; moving env parsing here is a later change). */
export function mcpConfig(config: McpConfigShape): McpConfigShape {
    return { appOrigin: config.appOrigin };
}

/** MCP connections, under the graph's `LegacyMcpConnections` tag. */
export { McpConnectionsService as LegacyMcpConnections };

/** MCP OAuth, under the graph's `LegacyMcpOAuth` tag (no contract tag). */
export { McpOAuthService as LegacyMcpOAuth };

/** The MCP runtime, under the graph's `LegacyMcpRuntime` tag. */
export { McpRuntimeService as LegacyMcpRuntime };

/**
 * MCP's steps of the graph, in the graph's order: its connections
 * (offered as `Connections`, with `McpConfig` from the supplied config) and
 * OAuth early, its runtime (offered as `Tools`) after the approvals it
 * asks.
 */
export const mcpLayers = {
    connections: Layer.unwrap(
        Effect.gen(function* () {
            const workspace = yield* LegacyWorkspace;
            const { keys } = yield* PlatformKeys;
            const config = mcpConfig(yield* LegacyConfig);
            return ConnectionsLive.pipe(
                Layer.provideMerge(McpConnectionsLive(workspace.db, keys)),
                Layer.merge(Layer.succeed(McpConfig, config)),
            );
        }),
    ),
    oauth: McpOAuthLive,
    runtime: ToolsLive.pipe(Layer.provideMerge(McpRuntimeLive)),
};
