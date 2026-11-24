/**
 * This folder's services, whole, by tag: what its module and routes use
 * (other features use `Connections` and `Tools`, the contract's slices).
 * Moved from `layer.ts` so the module can read them from the app's
 * services: only entry files import a `layer.ts`, and `contract.ts` can't
 * name the classes. `layer.ts` builds them.
 */
import { Context } from 'effect';

import type { McpConnections } from './connections.js';
import type { McpOAuth } from './oauth.js';
import type { McpRuntime } from './runtime.js';

/**
 * The connections, as this folder's routes and module use them (other
 * features use `Connections`, the contract's slice).
 */
export class McpConnectionsService extends Context.Service<McpConnectionsService, McpConnections>()(
    'socio/mcp/McpConnectionsService',
) {}

/** The connections' OAuth; only this folder uses it (no contract tag). */
export class McpOAuthService extends Context.Service<McpOAuthService, McpOAuth>()('socio/mcp/McpOAuthService') {}

/** The runtime behind `Tools`, whole. */
export class McpRuntimeService extends Context.Service<McpRuntimeService, McpRuntime>()(
    'socio/mcp/McpRuntimeService',
) {}
