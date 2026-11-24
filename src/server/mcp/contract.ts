/**
 * What other features may know of people's MCP connections (external MCP
 * servers a person connects and grants to their socios): their tags, the
 * slices of the services they call, and the plain types and constants around
 * them. It imports only `effect` and `@socio/*` (and types from
 * `@copilotkit/runtime/v2`), and holds no logic.
 *
 * The error, the callback path and the owner-access port moved here from
 * `errors.ts`, `routes.ts` and `connections.ts`, which re-export them, so every
 * importer keeps compiling until that importer switches to the contract.
 * `McpConnections` implements `McpConnectionsShape` and `McpRuntime`
 * implements `McpToolsShape`.
 *
 * `McpConnectionError` became a tagged error that keeps its name, message
 * and `status`; `mcp/layer.ts` implements the tags.
 *
 * Not here, on purpose:
 * - `MCP_SEALED_SQL` stays in `infra/sqlite/sealed.ts`. The restore drill
 *   should get it from the composition root, like inference's.
 * - No tag for `McpOAuth`: only `McpRuntime` and the routes (both in this
 *   folder) call it; composition passes it to `mcpPublicRoutes`.
 */
import type { ToolDefinition } from '@copilotkit/runtime/v2';
import { Context, Data } from 'effect';

import type { SealState } from '@socio/foundation/keys/secret-box';
import type { DotTurn } from '@socio/foundation/turns/turn';

// ── Constants ────────────────────────────────────────────────────────────

/** The OAuth callback an MCP server's sign-in navigates back to. */
export const MCP_CALLBACK = '/api/mcp-connections/oauth/callback';

// ── Errors ───────────────────────────────────────────────────────────────

/**
 * A refused MCP connection request, with the HTTP status to answer (the
 * routes' `onError` reads it). Its `name` is its tag, `McpConnectionError`,
 * as before; `mcpError(message, status)` in `errors.ts` makes one.
 */
export class McpConnectionError extends Data.TaggedError('McpConnectionError')<{
    readonly message: string;
    readonly status: number;
}> {}

// ── Ports ────────────────────────────────────────────────────────────────

/** Who may still use a connection: its owner's account, and a socio of theirs. */
export interface McpOwnerAccess {
    active(userId: string): boolean;
    socio(userId: string, dotId: string): boolean;
}

// ── Tags ─────────────────────────────────────────────────────────────────

/**
 * People's MCP connections, the slice other features and the composition call:
 * account lifecycle (auth) disconnects a removed person's connections, and
 * the data key's status and reseal read and reseal their credentials.
 * `McpConnections` implements it.
 */
export interface McpConnectionsShape {
    /** Disconnects every connection of the person; runs after deactivation too. */
    forgetUser(userId: string): Promise<void>;
    /** How many connections `forgetUser` would disconnect (CB-360's deactivation preview). */
    connectionCountOf(userId: string): number;
    /** How the connections' and OAuth flows' secrets are sealed. */
    sealStates(): Record<SealState, number>;
    /** Reseals every secret with the current data key. */
    reseal(): Promise<{ resealed: number; unreadable: number }>;
}

export class Connections extends Context.Service<Connections, McpConnectionsShape>()('socio/mcp/Connections') {}

/**
 * The connections' tools in a socio's turn (the module's `dotTools`).
 * `McpRuntime` implements it.
 */
export interface McpToolsShape {
    /** None outside a person's own chat turn, or with nothing connected. */
    tools(turn: DotTurn): ToolDefinition[];
}

export class Tools extends Context.Service<Tools, McpToolsShape>()('socio/mcp/Tools') {}

// ── Config ───────────────────────────────────────────────────────────────

/**
 * The `PlatformConfig` fields `mcp/` reads. `PlatformConfig` has each with
 * the same type, so it satisfies this shape.
 */
export interface McpConfigShape {
    /** The public origin OAuth redirects come back to; unset disables OAuth. */
    readonly appOrigin?: string;
}

export class McpConfig extends Context.Service<McpConfig, McpConfigShape>()('socio/mcp/McpConfig') {}
