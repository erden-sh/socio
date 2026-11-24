// Must stay first: see packages/foundation/src/no-vendor-telemetry.ts.
import '@socio/foundation/no-vendor-telemetry';
import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';

import { toolError } from '@socio/foundation/http/tool-error';
import type { DotTurn } from '@socio/foundation/turns/turn';
import { lowerText } from '@socio/shared/locale';
import { SPACE_NAME_ERROR, SPACE_NAME_MAX, spaceNameInput } from '@socio/shared/spaces/create-input';

import type { ConversationsShape, SpacesShape } from '../workspace/contract.js';

import { SPACE_NOT_FOUND, SpaceAccessError, type SpaceAccessShape } from './contract.js';

/** What `rename_space` reads of the workspace, by its slices. */
export interface SpaceRenameWorkspace {
    readonly spaces: Pick<SpacesShape, 'renameSpace'>;
    readonly conversations: Pick<ConversationsShape, 'socioReader'>;
    readonly access: Pick<SpaceAccessShape, 'reads' | 'readable'>;
}

const sameName = (a: string, b: string) => lowerText(a.trim()) === lowerText(b.trim());

/**
 * `rename_space` (CB-366): a socio renames a Space for the person it acts
 * for, by the rule of the Space's Settings (`SpacesShape.renameSpace`): the
 * person must be one of its editors (workspace admins edit every Space).
 * The socio must have the Space and may use it in this chat
 * (`SpaceAccess.reads`), as for every page tool; a Space it can't use is
 * answered as one that isn't there. The name follows the create rule, and is
 * never that of another Space this chat may use (its reader's): a clash is
 * named only when the chat may read the other Space. Only
 * the name changes: links name the Space's id, so they keep working.
 */
export function renameSpaceTool(workspace: SpaceRenameWorkspace, turn: DotTurn) {
    return defineTool({
        name: 'rename_space',
        description: `Rename a Space when the person asks (for example "call the Design Space Studio"). Only the name changes: its pages, chats, memory, people and links stay as they are. The person must be one of the Space's editors, and it must be a Space you may use (list_authorized_spaces). The name is 1 to ${SPACE_NAME_MAX} characters and can't be the name of another Space you may use here. Don't rename a Space the person didn't ask you to.`,
        parameters: z.object({
            spaceId: z.string().min(1).describe('The Space to rename, from list_authorized_spaces.'),
            name: z.string().describe(`Its new name, 1 to ${SPACE_NAME_MAX} characters.`),
        }),
        execute: async ({ spaceId, name }) => {
            turn.check();
            /** The chat's reader, now: the socio and every person the chat shows. */
            const reader = () => workspace.conversations.socioReader(turn.threadId, turn.dot.id);
            /** A Space the socio can't use in this chat is answered as one that isn't there. */
            const usable = () => {
                if (!workspace.access.reads(spaceId, reader())) {
                    throw new SpaceAccessError(SPACE_NOT_FOUND, 404);
                }
            };
            /**
             * Only the Spaces this chat may use, never every one the person
             * sees: a shared room must not learn the name of one of their
             * private Spaces from a refusal. Settings allows a repeated name,
             * so a clash with a Space hidden here is not refused either.
             */
            const unclashed = (wanted: string) => {
                const taken = workspace.access
                    .readable(reader())
                    .find((space) => space.id !== spaceId && sameName(space.name, wanted));
                if (taken) {
                    throw new SpaceAccessError(`Another Space is named “${taken.name}”. Choose another name.`, 409);
                }
            };
            try {
                usable();
            } catch (error) {
                return toolError(error as SpaceAccessError);
            }
            const parsed = spaceNameInput.safeParse(name);
            if (!parsed.success) {
                return toolError({ message: SPACE_NAME_ERROR, status: 400 });
            }
            try {
                const space = await workspace.spaces.renameSpace(spaceId, turn.userId, parsed.data, {
                    dotId: turn.dot.id,
                    // Both again under the write lock, so a grant taken away or
                    // a Space renamed just before is seen.
                    guard: (wanted) => {
                        usable();
                        unclashed(wanted);
                    },
                });
                return {
                    renamed: true,
                    space: { id: space.id, name: space.name },
                    url: `/spaces/${space.id}`,
                };
            } catch (error) {
                if (error instanceof SpaceAccessError) {
                    return toolError(error);
                }
                throw error;
            }
        },
    });
}
