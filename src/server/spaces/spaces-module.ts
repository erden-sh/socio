import type { DotTurn } from '@socio/foundation/turns/turn';
import { MODULE_IDS } from '@socio/shared/modules';

import { SpaceMemory } from '../memory/contract.js';
import type { ModuleContext, ServerModule } from '../modules/contract.js';
import { Conversations, Spaces } from '../workspace/contract.js';

import { Access, SpacePages, type SpacePageInput } from './contract.js';
import { spacesSchema } from './migrations.js';
import { renameSpaceTool } from './rename.js';
import { spaceMemoryRoutes } from './routes.js';

/**
 * What a turn may read and write of the Spaces: the Dot's Spaces, and the
 * page its conversation is about. Page reads count toward a page's
 * freshness only while answering someone (web, Telegram, voice), not in
 * scheduled turns. What a turn reads is recorded as its
 * grounding (CB-194) in every turn. The page moves, for a socio's
 * `move_space_page`, are added by `SpacePages`.
 */
const pageInput = ({ services }: ModuleContext, turn: DotTurn): SpacePageInput => {
    // The chat must exist when its page tools are made, as it always has:
    // the page tools read its socio and owner when first called.
    services.get(Conversations).requireThread(turn.threadId);
    return {
        spaceId: turn.dot.spaceId,
        threadId: turn.threadId,
        check: turn.check,
        usedBy: turn.purpose === 'chat' ? turn.userId : null,
        ref: turn.ref,
    };
};

/**
 * Spaces: the page tools every Dot has (list, search, read, create, edit,
 * and the review a person approves), `create_space` (a new Space the
 * person approves, CB-271), `rename_space` (CB-366) and the current page
 * for its prompt.
 * The pages themselves are the workspace's (`workspace.pages`, the `pages`
 * schema); the routes are `page-routes`. Its own tables and routes are a
 * Space's people and shared memory (CB-181).
 */
export const spacesModule: ServerModule = {
    // Who reads and approves each Space's shared memory (CB-181).
    ...spacesSchema,
    id: MODULE_IDS.spaces,
    // The page tools are pages' `PageTools`, with the page moves and the
    // Spaces' `Creation`, as `SpacePages`.
    dotTools: (ctx, turn) => {
        const pages = ctx.services.get(SpacePages);
        return [
            ...pages.tools(pageInput(ctx, turn)),
            // A new Space, on the person's approval (CB-271): the platform's
            // approvals ask it, so a turn built without one has no such tool.
            ...(pages.createSpace ? [pages.createSpace(turn)] : []),
            // Renaming a Space the socio has, for one of its editors (CB-366).
            renameSpaceTool(
                {
                    spaces: ctx.services.get(Spaces),
                    conversations: ctx.services.get(Conversations),
                    access: ctx.services.get(Access),
                },
                turn,
            ),
        ];
    },
    // A Space's shared memory and its people (CB-181): the people are the
    // workspace's Space access (`Access`).
    routes: ({ services }) => spaceMemoryRoutes(services.get(SpaceMemory), services.get(Access)),
    dotPageContext: (ctx, turn) => ctx.services.get(SpacePages).pageContext(pageInput(ctx, turn)) ?? null,
};
