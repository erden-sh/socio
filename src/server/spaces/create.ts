import { APPROVAL_CAPABILITIES } from '@socio/shared/approvals';
import { lowerText } from '@socio/shared/locale';
import { isAdmin } from '@socio/shared/roles';
import { canCreateSpaces, SPACE_CREATE_REFUSED } from '@socio/shared/spaces/create-permission';
import type { Settings, Space, User } from '@socio/shared/types';

import type { ApprovalOutcome, ApprovalRecord, ApprovalsShape } from '../approvals/contract.js';
import type { ConversationsShape, PeopleShape, SociosShape, SpacesShape } from '../workspace/contract.js';

import {
    OPEN_SPACE_REFUSED,
    SPACE_DESCRIPTION_MAX,
    SPACE_NAME_ERROR,
    SpaceAccessError,
    spaceCreateInput,
    SpaceCreationError,
    type SpaceAccessShape,
    type SpaceCreateRequest,
    type SpaceCreationShape,
    type SpaceVisibility,
} from './contract.js';

/** The workspace settings the create rule reads: who may create Spaces. */
export type SpaceCreateSettings = () => Pick<Settings, 'spaceCreators'>;

/**
 * What making a Space reads of the workspace, by its slices: the people
 * (who asks, and whether they are still here), the socio that asks, who
 * reads the chat it asks in, the Spaces' own create, and the Spaces'
 * access (`Access`).
 */
export type SpaceCreationWorkspace = Pick<PeopleShape, 'users' | 'isDeactivated'> &
    Pick<SociosShape, 'dot'> &
    Pick<ConversationsShape, 'chatReaders'> &
    Pick<SpacesShape, 'createSpaceFor'> & { readonly spaceAccess: SpaceAccessShape };

/**
 * Makes a Space as `person`, by the one rule (CB-181), for `POST
 * /api/spaces` and a socio's approved `create_space` (CB-271) alike: only
 * someone the "create Spaces" permission lets in (`canCreateSpaces`: admins
 * always, members unless an admin chose admins only; else a 403); a
 * person's Space is private unless an admin opens it; only workspace
 * admins make one for the whole workspace (else a 403). A private one has
 * its maker as editor (an admin edits every Space already) and the people
 * chosen. `grantTo`: the socio that asked, given the new Space.
 */
export function createSpaceAs(
    workspace: Pick<SpacesShape, 'createSpaceFor'>,
    person: Pick<User, 'id' | 'role'>,
    input: SpaceCreateRequest & { grantTo?: string },
    settings: Pick<Settings, 'spaceCreators'>,
): Promise<Space> {
    if (!canCreateSpaces(person, settings)) {
        throw new SpaceAccessError(SPACE_CREATE_REFUSED, 403);
    }
    const admin = isAdmin(person);
    const closed = input.private ?? !admin;
    if (!closed && !admin) {
        throw new SpaceAccessError(OPEN_SPACE_REFUSED, 403);
    }
    return workspace.createSpaceFor(person.id, {
        name: input.name,
        description: input.description,
        private: closed,
        people: closed ? input.people : undefined,
        grantTo: input.grantTo,
    });
}

interface CreateSpacePayload {
    name: string;
    description: string;
    visibility: SpaceVisibility;
}

const sameName = (a: string, b: string) => lowerText(a.trim()) === lowerText(b.trim());

/**
 * A socio makes a Space for the person it acts for (CB-271), the owner's
 * decision of 2026-10-28: always with that person's approval, on the
 * approval card (its name, description and who will see it), never by a
 * bypass or an automatic review (`manualOnly`). A member's socio makes a
 * private Space only, with the member as its editor; an admin's, either.
 * Approved, it is made by `createSpaceAs`, the create dialog's own rule,
 * as the person, and granted to the socio, which then reads it, as every
 * grant, only where `SpaceAccess.reads` allows: a private Space in a chat
 * everyone reading may read it, never a Telegram group or team topic.
 */
export class SpaceCreation implements SpaceCreationShape {
    constructor(
        private workspace: SpaceCreationWorkspace,
        private approvals: ApprovalsShape,
        /** Who may create Spaces, read on every create (Settings → General). */
        private settings: SpaceCreateSettings,
    ) {
        approvals.register<CreateSpacePayload>({
            capability: APPROVAL_CAPABILITIES.spaceCreate,
            label: 'Create a Space',
            description:
                'A socio makes a new Space for you: private to you, or, for workspace admins, for the whole workspace. The socio gets the Space, to add pages to it. You decide every one yourself.',
            manualOnly: true,
            auto: { allowed: false },
            execute: (record) => this.execute(record),
        });
    }

    /** `createSpaceAs` as this workspace's: the one rule, for `POST /api/spaces`. */
    createAs(person: Pick<User, 'id' | 'role'>, input: SpaceCreateRequest & { grantTo?: string }): Promise<Space> {
        return createSpaceAs(this.workspace, person, input, this.settings());
    }

    /** The person, as the workspace knows them now; none once deactivated. */
    private person(userId: string) {
        const user = this.workspace.users().find((entry) => entry.id === userId);
        if (!user || this.workspace.isDeactivated(userId)) {
            throw new SpaceCreationError('The person you act for is no longer in the workspace.', 403);
        }
        return user;
    }

    /** The request checked as `POST /api/spaces` would, plus what a socio adds. */
    private check(
        userId: string,
        raw: { name: string; description?: string; visibility?: SpaceVisibility },
        threadId: string | null,
    ) {
        const person = this.person(userId);
        // The "create Spaces" permission, when asked and again when approved.
        if (!canCreateSpaces(person, this.settings())) {
            throw new SpaceCreationError(
                `${SPACE_CREATE_REFUSED} The person you act for is not a workspace admin: don't offer to create one.`,
                403,
            );
        }
        // Private unless the whole workspace is asked for by name.
        const visibility: SpaceVisibility = raw.visibility === 'workspace' ? 'workspace' : 'private';
        const input = {
            ...raw,
            visibility,
        };
        const parsed = spaceCreateInput.safeParse({
            name: input.name,
            description: input.description ?? '',
            private: input.visibility === 'private',
        });
        if (!parsed.success) {
            throw new SpaceCreationError(
                `${SPACE_NAME_ERROR} A description is at most ${SPACE_DESCRIPTION_MAX} characters.`,
                400,
            );
        }
        if (input.visibility === 'workspace' && !isAdmin(person)) {
            throw new SpaceCreationError(
                `${OPEN_SPACE_REFUSED} The person you act for is not a workspace admin: offer them a private Space instead.`,
                403,
            );
        }
        // One the person sees already: never a second of the same name. Only
        // the Spaces this chat may see, so the refusal says nothing of one
        // hidden from anyone reading it (`chatSpaces`).
        const taken = this.chatSpaces(userId, threadId).find((space) => sameName(space.name, parsed.data.name));
        if (taken) {
            throw new SpaceCreationError(
                `A Space named “${taken.name}” already exists. Use it (list_authorized_spaces lists the ones you may use; if it isn't there, the person or an admin can give it to you in your settings) or choose another name.`,
                409,
            );
        }
        if (input.visibility === 'private') {
            try {
                this.workspace.spaceAccess.requirePrivacyEnforced();
            } catch (error) {
                if (error instanceof SpaceAccessError) {
                    throw new SpaceCreationError(error.message, 409);
                }
                throw error;
            }
        }
        return {
            person,
            payload: {
                name: parsed.data.name,
                description: parsed.data.description.trim(),
                visibility: input.visibility,
            } satisfies CreateSpacePayload,
        };
    }

    /**
     * The Spaces a refusal in this chat may name (as `rename_space`, CB-366):
     * of those the person reads, only the ones everyone reading the chat
     * reads too, so a shared room never learns the name of one of their
     * private Spaces. Where Socio can't name every reader (a Telegram group
     * or team topic, or no chat), only Spaces for the whole workspace. In
     * the person's own chat, every Space they read. A clash with a Space
     * hidden here is not refused, as the create dialog allows a repeated name.
     */
    private chatSpaces(userId: string, threadId: string | null) {
        const access = this.workspace.spaceAccess;
        const readers = threadId ? this.workspace.chatReaders(threadId) : null;
        const mine = access.spacesFor(userId);
        if (readers === null) {
            return mine.filter((space) => !space.private);
        }
        const shared = new Set(
            access.readableByAll(
                mine.map((space) => space.id),
                [...new Set([userId, ...readers])],
            ),
        );
        return mine.filter((space) => shared.has(space.id));
    }

    /**
     * Whether the socio could use the new Space in this chat right after
     * (`SpaceAccess.reads` as it will be): one for the whole workspace
     * anywhere; a private one only where everyone reading the chat is its
     * maker or a workspace admin. Never in a Telegram group or team topic.
     */
    usableIn(threadId: string, userId: string, visibility: SpaceVisibility) {
        if (visibility === 'workspace') {
            return true;
        }
        const readers = this.workspace.chatReaders(threadId);
        if (!readers?.length) {
            return false;
        }
        const users = this.workspace.users();
        return readers.every(
            (id) =>
                id === userId || (!this.workspace.isDeactivated(id) && isAdmin(users.find((user) => user.id === id))),
        );
    }

    /** Who will see the Space, in the card's words (`SpaceAudienceField`'s). */
    private audience(person: User, visibility: SpaceVisibility) {
        if (visibility === 'workspace') {
            return 'Who can see it: the whole workspace. Everyone sees it and everything in it.';
        }
        return isAdmin(person)
            ? 'Who can see it: only its people, and workspace admins (you are one). It starts with no people; add them under its Settings.'
            : 'Who can see it: only its people, and workspace admins. You are its editor and, for now, its only person; add colleagues under its Settings.';
    }

    /**
     * `create_space`: checks the request, then asks the person on the
     * approval card. Nothing is made until they approve it; asking again for
     * the same name while it waits returns the request waiting (CB-131).
     */
    async propose(
        turn: { userId: string; dotId: string; threadId: string },
        input: {
            name: string;
            description?: string;
            visibility?: SpaceVisibility;
        },
    ): Promise<ApprovalOutcome & { usableHere: boolean; note?: string }> {
        const { person, payload } = this.check(turn.userId, input, turn.threadId);
        const usableHere = this.usableIn(turn.threadId, turn.userId, payload.visibility);
        const note = usableHere
            ? undefined
            : 'A private Space is used only in chats where everyone can see it. Here not everyone can (other people read this chat, or it is a Telegram group or team topic), so once it is made you can add pages to it from the person’s own chat with you, not this one.';
        const waiting = await this.approvals.findPending<CreateSpacePayload>(
            turn.userId,
            turn.dotId,
            APPROVAL_CAPABILITIES.spaceCreate,
            (other) => sameName(other.name, payload.name) && other.visibility === payload.visibility,
        );
        if (waiting) {
            return { ...waiting, usableHere, ...(note ? { note } : {}) };
        }
        const socio = this.workspace.dot(turn.dotId)?.name ?? 'This socio';
        const outcome = await this.approvals.request<CreateSpacePayload>({
            userId: turn.userId,
            dotId: turn.dotId,
            threadId: turn.threadId,
            capability: APPROVAL_CAPABILITIES.spaceCreate,
            summary:
                payload.visibility === 'private'
                    ? `Create the private Space “${payload.name}”`
                    : `Create the Space “${payload.name}” for the whole workspace`,
            details: [
                `Name: ${payload.name}`,
                `Description: ${payload.description || '(none)'}`,
                this.audience(person, payload.visibility),
                `${socio} gets the Space, to add pages to it. It uses a private Space only in chats where everyone can see it.`,
                ...(note ? ['Not usable by the socio in this chat: not everyone here can see a private Space.'] : []),
            ],
            payload,
        });
        return { ...outcome, usableHere, ...(note ? { note } : {}) };
    }

    /**
     * The approved request: checked again as it runs (the person's role and
     * Spaces may have changed meanwhile), then made by the one rule, as the
     * person, and granted to the socio, in one unit of work.
     */
    private async execute(record: ApprovalRecord<CreateSpacePayload>) {
        const dot = this.workspace.dot(record.dotId);
        if (!dot || dot.archivedAt) {
            throw new SpaceCreationError('The socio is no longer available.', 409);
        }
        const { person, payload } = this.check(record.userId, record.payload, record.threadId);
        const space = await this.createAs(person, {
            name: payload.name,
            description: payload.description,
            private: payload.visibility === 'private',
            grantTo: dot.id,
        });
        return `Created the ${payload.visibility === 'private' ? 'private ' : ''}Space “${space.name}” (spaceId ${space.id}). ${dot.name} has it and may add pages to it.`;
    }
}
