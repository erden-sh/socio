/**
 * The MCP connections' layers: they implement `contract.ts`'s tags,
 * `Connections` and `Tools`, over this folder's services, and yield what they
 * need of other features through those features' tags (`People`, `Socios`,
 * `Conversations`, `Approvals`) and of this one through `McpConfig`. Only the
 * composition root and tests import this file.
 *
 * The `make*` functions below are what the layers build the services
 * with, over the `WorkspaceStore` and `ApprovalService` that implement
 * those slices.
 */
import type { DatabaseSync } from 'node:sqlite';

import { Effect, Layer } from 'effect';

import type { DataKeyring } from '@socio/foundation/keys/secret-box';

import { Approvals, type ApprovalsShape } from '../approvals/contract.js';
import {
    Conversations,
    People,
    Socios,
    type ConversationsShape,
    type PeopleShape,
    type SociosShape,
} from '../workspace/contract.js';

import { McpConnections } from './connections.js';
import { Connections, McpConfig, Tools, type McpConfigShape, type McpOwnerAccess } from './contract.js';
import { McpConnectionRepository } from './infra/sqlite/repository.js';
import { McpOAuth } from './oauth.js';
import { McpRuntime } from './runtime.js';
import { McpConnectionsService, McpOAuthService, McpRuntimeService } from './tags.js';

// ── Builders ─────────────────────────────────────────────────────────────

/** Who may still use a connection: an active account, and a socio it may use. */
export function mcpOwnerAccess(
    people: Pick<PeopleShape, 'users' | 'isDeactivated'>,
    socios: Pick<SociosShape, 'canUseDot'>,
): McpOwnerAccess {
    return {
        active: (userId) => people.users().some((user) => user.id === userId) && !people.isDeactivated(userId),
        socio: (userId, dotId) => socios.canUseDot(userId, dotId),
    };
}

/** People's MCP connections on the workspace connection, their credentials sealed with `keys`. */
export function makeMcpConnections(db: DatabaseSync, keys: DataKeyring, access: McpOwnerAccess): McpConnections {
    return new McpConnections(new McpConnectionRepository(db), keys, access);
}

/** The connections' OAuth, its redirects back to the app's public origin (none: OAuth is off). */
export function makeMcpOAuth(connections: McpConnections, config: McpConfigShape): McpOAuth {
    return new McpOAuth(connections, config.appOrigin ?? '');
}

/** The connections' tools in a turn; registers the `external.mcp` approval capability. */
export function makeMcpRuntime(deps: {
    connections: McpConnections;
    oauth: McpOAuth;
    approvals: ApprovalsShape;
    conversations: Pick<ConversationsShape, 'answers' | 'allows'>;
}): McpRuntime {
    const { conversations } = deps;
    return new McpRuntime(deps.connections, deps.oauth, deps.approvals, {
        // The acting person may send there (CB-208): a private chat's
        // owner, as before, or an active member of a live room.
        // A room's socio answering there (CB-206), as its lead.
        thread: (id, userId, dotId) => conversations.answers(id, dotId) && conversations.allows(userId, id, 'send'),
    });
}

// ── This folder's services, whole ────────────────────────────────────────

/** The whole-class tags, in `tags.ts` so the module can read them. */
export { McpConnectionsService, McpOAuthService, McpRuntimeService };

// ── Layers ───────────────────────────────────────────────────────────────

/**
 * The connections on the connection the boot step opened and migrated,
 * sealed with the data keyring; who may use them from `People` and
 * `Socios`. Built once; it starts nothing (the module's `start` does).
 */
export const McpConnectionsLive = (db: DatabaseSync, keys: DataKeyring) =>
    Layer.effect(
        McpConnectionsService,
        Effect.gen(function* () {
            return makeMcpConnections(db, keys, mcpOwnerAccess(yield* People, yield* Socios));
        }),
    );

/** `Connections`, the slice other features call, over the connections. */
export const ConnectionsLive = Layer.effect(
    Connections,
    Effect.gen(function* () {
        return Connections.of(yield* McpConnectionsService);
    }),
);

/** The OAuth over the connections and `McpConfig`'s origin. */
export const McpOAuthLive = Layer.effect(
    McpOAuthService,
    Effect.gen(function* () {
        return makeMcpOAuth(yield* McpConnectionsService, yield* McpConfig);
    }),
);

/**
 * The runtime over the connections, their OAuth and `Approvals` (it
 * registers its capability as it is built), and who may send in a
 * conversation from `Conversations`.
 */
export const McpRuntimeLive = Layer.effect(
    McpRuntimeService,
    Effect.gen(function* () {
        return makeMcpRuntime({
            connections: yield* McpConnectionsService,
            oauth: yield* McpOAuthService,
            approvals: yield* Approvals,
            conversations: yield* Conversations,
        });
    }),
);

/** `Tools`, the module's `dotTools`, over the runtime. */
export const ToolsLive = Layer.effect(
    Tools,
    Effect.gen(function* () {
        return Tools.of(yield* McpRuntimeService);
    }),
);
