import { isAdmin } from '@socio/shared/roles';
import { SPACE_DESCRIPTION_MAX, SPACE_NAME_ERROR, SPACE_NAME_MAX } from '@socio/shared/spaces/create-input';
import { SPACE_CREATE_REFUSED } from '@socio/shared/spaces/create-permission';

import type { ShellWorkspace } from '../sync/shell';
import type { SpaceCreateBlock, SpaceCreateOutcome } from '../sync/space-create';

// New Space (CB-410): the web's create dialog (packages/client's
// WorkspaceDialog, `{ type: 'space' }`, and SpaceSettings' SpaceAudienceField)
// on a phone, the `NewSpace` modal from the Spaces list's header. The same
// fields (Name, "What belongs here?", "Who can see it"), the same rule for who
// sees the action (the server's `permissions.createSpaces`, never a role check
// of our own) and the same request (src/sync/space-create.ts). No React Native,
// so tests/shell runs it under Node.

export const NEW_SPACE_LABEL = 'New Space';
/** The web dialog's title for a Space. */
export const NEW_SPACE_TITLE = 'A space for something.';
export const NAME_LABEL = 'Name';
export const DESCRIPTION_LABEL = 'What belongs here?';
export const AUDIENCE_LEGEND = 'Who can see it';
export const CREATE_ACTION = 'Create';
export { SPACE_DESCRIPTION_MAX, SPACE_NAME_MAX };

/** What a private Space covers, the web's `PRIVATE_SPACE_COVERS` (components/private-space.tsx). */
export const PRIVATE_SPACE_COVERS =
    'its pages and their history, page chats, search results, apps, datasets and files shared with it, and its memory';

/**
 * Whether the person may create Spaces: the server's word in `GET /api/workspace`
 * (`permissions.createSpaces`), as the web's sidebar reads it. Missing (an older
 * server, or before the first answer): no.
 */
export const canCreateSpace = (workspace: Pick<ShellWorkspace, 'permissions'> | null): boolean =>
    workspace?.permissions?.createSpaces === true;

/** One of the two audiences, as the web's radio cards. */
export interface AudienceChoice {
    /** Private: only its people. */
    readonly private: boolean;
    readonly title: string;
    readonly detail: string;
    /** Only admins make a Space for the whole workspace. */
    readonly disabled: boolean;
    readonly testID: string;
}

/** The web's two choices, worded as it words them for an admin or anyone else. */
export function audienceChoices(admin: boolean): readonly AudienceChoice[] {
    return [
        {
            private: false,
            title: 'Whole workspace',
            detail: `Everyone in the workspace sees it and everything in it.${admin ? '' : ' Only workspace admins make a Space for everyone.'}`,
            disabled: !admin,
            testID: 'new-space-audience-workspace',
        },
        {
            private: true,
            title: 'Only its people',
            detail: `Private: only the people added to it, and workspace admins, see it, ${PRIVATE_SPACE_COVERS}. Socios use it only when everyone in the chat may. Anyone else doesn’t see it exists.`,
            disabled: false,
            testID: 'new-space-audience-private',
        },
    ];
}

/** The form as it opens: an admin's Space is for the whole workspace unless they keep it private; anyone else's is private. */
export function newSpaceStart(workspace: Pick<ShellWorkspace, 'user'> | null): { admin: boolean; private: boolean } {
    const admin = workspace !== null && isAdmin(workspace.user);
    return { admin, private: !admin };
}

/** Whether Create can go: a name, nothing in flight, and a connection. */
export const canSubmitSpace = (name: string, busy: boolean, blocked: SpaceCreateBlock | null): boolean =>
    name.trim() !== '' && !busy && blocked === null;

/** Offline: the workspace makes a Space (its id, who may), so it can't wait in the outbox. */
export const SPACE_NEEDS_CONNECTION = 'Needs a connection: the workspace makes new Spaces.';

/** Why nothing can go now, in the screens' words (room-invites' `BLOCK_COPY`). */
export const SPACE_BLOCK_COPY: Readonly<Record<SpaceCreateBlock, string>> = {
    offline: SPACE_NEEDS_CONNECTION,
    away: SPACE_NEEDS_CONNECTION,
    'sign-in': 'Sign in again to do this',
    update: 'Update Socio to do this',
};

export const SPACE_NO_ANSWER = 'No answer from the workspace. Check the Spaces list before you try again.';
export const SPACE_CREATE_FAILED = 'Couldn’t create the Space. Try again.';

/** A refusal's words, by status (the server sends no `code` here), never its text. */
const REFUSAL_COPY: Readonly<Record<string, string>> = {
    'http-400': SPACE_NAME_ERROR,
    'http-403': SPACE_CREATE_REFUSED,
    'http-401': 'Sign in again to do this',
    'http-429': 'Too many tries. Wait a moment.',
};

/** What an outcome says on the form, or null when it worked (or another create is going). */
export function spaceCreateCopy(outcome: SpaceCreateOutcome): string | null {
    switch (outcome.kind) {
        case 'done':
        case 'busy':
            return null;
        case 'blocked':
            return SPACE_BLOCK_COPY[outcome.reason];
        case 'no-answer':
            return SPACE_NO_ANSWER;
        case 'refused':
            return REFUSAL_COPY[outcome.reason] ?? SPACE_CREATE_FAILED;
    }
}

/**
 * Leaving New Space with something typed (Cancel, a swipe down on its page
 * sheet, Back) asks first (CB-421): Discard closes it, Cancel stays.
 */
export const DISCARD_SPACE_QUESTION = 'Discard this new Space?';
export const DISCARD_SPACE = { name: 'discard', label: 'Discard', destructive: true } as const;

/** Whether leaving asks: a name or a description typed. */
export const newSpaceAsks = (name: string, description: string) => name.trim() !== '' || description.trim() !== '';
