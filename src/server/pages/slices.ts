import type { SpaceAccessShape } from '../spaces/contract.js';
import type { AuditShape, ConversationsShape, SociosShape } from '../workspace/contract.js';

import type { PageStoreShape } from './contract.js';

/**
 * What `pages/` needs from the workspace (it was
 * `platform-needs.ts`): the Space's pages, who reads which Space, the
 * socios, their chats and the workspace's audit, each from its tag's
 * slice. `WorkspaceStore` satisfies it, for a platform built on its own;
 * the layers (`layer.ts`) build it from the tags (`pagesWorkspace`).
 */
export interface PagesWorkspace
    extends
        Pick<SociosShape, 'dot' | 'canUseDot'>,
        Pick<
            ConversationsShape,
            'thread' | 'bindThread' | 'requireThread' | 'requireOwnedThread' | 'socioReader' | 'socioReads'
        >,
        Pick<AuditShape, 'audit'> {
    readonly pages: PageStoreShape;
    readonly spaceAccess: SpaceAccessShape;
}

/**
 * The pages' view of the workspace over its slices: each member forwards
 * to its slice, as `WorkspaceStore`'s own members do.
 */
export function pagesWorkspace(parts: {
    socios: Pick<SociosShape, 'dot' | 'canUseDot'>;
    conversations: Pick<
        ConversationsShape,
        'thread' | 'bindThread' | 'requireThread' | 'requireOwnedThread' | 'socioReader' | 'socioReads'
    >;
    audit: Pick<AuditShape, 'audit'>;
    pages: PageStoreShape;
    spaceAccess: SpaceAccessShape;
}): PagesWorkspace {
    const { socios, conversations, audit } = parts;
    return {
        dot: (...args) => socios.dot(...args),
        canUseDot: (...args) => socios.canUseDot(...args),
        thread: (...args) => conversations.thread(...args),
        bindThread: (...args) => conversations.bindThread(...args),
        requireThread: (...args) => conversations.requireThread(...args),
        requireOwnedThread: (...args) => conversations.requireOwnedThread(...args),
        socioReader: (...args) => conversations.socioReader(...args),
        socioReads: (...args) => conversations.socioReads(...args),
        audit: (...args) => audit.audit(...args),
        pages: parts.pages,
        spaceAccess: parts.spaceAccess,
    };
}
