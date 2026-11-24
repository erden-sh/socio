/**
 * What other features may know of Spaces: who reads and edits a Space
 * (`SpaceAccess`, CB-181) and a socio's `create_space` (CB-271). Its tags,
 * as slices of the methods callers use, the errors their callers catch,
 * and the plain types and constants they name. It imports only `effect`,
 * `@socio/*` and other features' contracts, and holds no logic.
 *
 * The types, errors and constants here moved from the files that defined them
 * (`access.ts`, `create.ts`, `domain/repositories.ts`), which re-export them,
 * so every importer keeps compiling until that importer switches to the
 * contract. The create input's zod schema and limits moved to
 * `@socio/shared/spaces/create-input`.
 *
 * Not here, on purpose:
 * - `SpaceAccessOptions`, `sqliteSpaceAccess` and the `SpaceAccess` class:
 *   construction only; the workspace holds the access, built by the factory
 *   from `composition/workspace-parts.ts`.
 * - `usePrivacyContract` and `useDeleteContract`: the composition root
 *   wires the runtime contract checks once, on the concrete class.
 * - `spaceMemoryRoutes` and `spacesModule`: route mounting and the module
 *   registry, entry code.
 * - A `SpacesConfig` tag: spaces reads no `PlatformConfig` field (its
 *   memory retention comes through Settings' `Limits`).
 */
import type { ToolDefinition } from '@copilotkit/runtime/v2';
import { Context } from 'effect';

import type { DotTurn } from '@socio/foundation/turns/turn';
import type { OwnedList, TransferParties, TransferTally } from '@socio/shared/auth';
import type { Page } from '@socio/shared/pages/page-library';
import type { RunRefRecorder } from '@socio/shared/runs/run-refs';
import type { SpaceAccessLevel, SpacePeopleView, SpaceRole } from '@socio/shared/space-memory';
import type { SpaceCreateRequest, SpaceVisibility } from '@socio/shared/spaces/create-input';
import type { Space, User } from '@socio/shared/types';

import type { ApprovalOutcome } from '../approvals/contract.js';

export {
    SPACE_DESCRIPTION_MAX,
    SPACE_NAME_ERROR,
    SPACE_NAME_MAX,
    SPACE_VISIBILITIES,
    spaceCreateInput,
    type SpaceCreateRequest,
    type SpaceVisibility,
} from '@socio/shared/spaces/create-input';

// ── Repository (`domain/repositories.ts`) ────────────────────────────────

/** A `space_members` row. */
export interface StoredSpaceMember {
    spaceId: string;
    userId: string;
    role: SpaceRole;
    addedBy: string | null;
    addedAt: number;
}

/**
 * Who reads and approves a Space's memory (CB-181): its people and
 * whether it is theirs alone. Reads are synchronous (one statement each,
 * as the rooms' access reads are), so the access rule answers wherever
 * it is asked, a turn's note included. Writes join the open unit of
 * work, or open their own.
 */
export interface SpaceAccessRepository {
    member(spaceId: string, userId: string): StoredSpaceMember | undefined;
    /** A Space's people, in the order they were added. */
    members(spaceId: string): StoredSpaceMember[];
    /** Whether the Space is read by its people only. */
    membersOnly(spaceId: string): boolean;
    /**
     * The person's rows in every Space, in one read (CB-374): what a list of
     * Spaces decides from, instead of `member` once per Space.
     */
    memberships(userId: string): StoredSpaceMember[];
    /**
     * The Spaces read by their people only, in one read (CB-374). A Space
     * not in it is open to the whole workspace, as `membersOnly` answers.
     */
    membersOnlyIds(): Set<string>;
    /** Adds the person, or changes their role. */
    setMember(member: Omit<StoredSpaceMember, 'addedAt'>, now?: number): Promise<StoredSpaceMember>;
    /** Removes the person's row; says whether there was one. */
    removeMember(spaceId: string, userId: string): Promise<boolean>;
    setMembersOnly(spaceId: string, membersOnly: boolean, by: string, now?: number): Promise<void>;
}

// ── Access (`access.ts`) ─────────────────────────────────────────────────

/**
 * Who reads a Space (CB-181, Spaces made private): a person (or a service
 * account, a workspace user with a role), or a socio for the people who
 * read its chat. `people` is every one of them (a room's members and live
 * invites, a private chat's owner); null when Socio can't name them all
 * (a Telegram group or team topic), where only Spaces open to the whole
 * workspace are read.
 */
export type SpaceReader = { userId: string } | { dotId: string; people: readonly string[] | null };

/** The contract every runtime records once it keeps private Spaces private. */
export const SPACE_PRIVACY_CONTRACT_NAME = 'space-privacy';
export const SPACE_PRIVACY_CONTRACT = 1;
/** The contract every runtime records once a deleted Space is gone everywhere (CB-277). */
export const SPACE_DELETE_CONTRACT_NAME = 'space-delete';
export const SPACE_DELETE_CONTRACT = 1;

/** Space access's refusal: `@socio/foundation/spaces/access-error`. */
export { SpaceAccessError } from '@socio/foundation/spaces/access-error';

/** The one refusal for a Space someone may not read: as for one that isn't there. */
export const SPACE_NOT_FOUND = 'Space not found.';

/**
 * Space access (CB-181): the one place that answers who reads a Space and
 * everything in it, and who edits it, asked afresh every time. Its reads
 * are synchronous (docs/MEMORY.md "Space access"); refusals throw
 * `SpaceAccessError`. `access.ts`'s `SpaceAccess` implements it (the
 * workspace's `spaceAccess`, and Space memory's `access`).
 */
export interface SpaceAccessShape {
    /** The person's level in the Space, or null when they can't read it. */
    level(spaceId: string, userId: string, loaded?: { users: User[]; spaces: Space[] }): SpaceAccessLevel | null;
    /** `reads` for a person: the one read check. */
    canRead(spaceId: string, userId: string): boolean;
    canEdit(spaceId: string, userId: string): boolean;
    /** The one read check: whether `reader` may read the Space and anything in it now. */
    reads(spaceId: string, reader: SpaceReader, loaded?: { users: User[]; spaces: Space[] }): boolean;
    /** The live Spaces `reader` may read, in the workspace's order. */
    readable(reader: SpaceReader): Space[];
    /** The ids of `readable`, for filtering many rows. */
    readableIds(reader: SpaceReader): Set<string>;
    /** The Spaces `userId` may read, each with whether it is private and their level. */
    spacesFor(userId: string): Space[];
    /** Of `spaceIds`, the Spaces every one of `userIds` can read now; none for no one. */
    readableByAll(spaceIds: readonly string[], userIds: readonly string[]): string[];
    /** The level, or a refusal that never says a hidden Space is there. */
    require(spaceId: string, userId: string, needs?: SpaceAccessLevel): SpaceAccessLevel;
    /** `GET /api/spaces/:id/people`. */
    people(spaceId: string, viewer: string): SpacePeopleView;
    /** Adds a person to the Space, or changes their role (editors). */
    setRole(spaceId: string, by: string, userId: string, role: SpaceRole): Promise<void>;
    /** Removes a person from the Space (editors). */
    remove(spaceId: string, by: string, userId: string): Promise<void>;
    /** Makes the Space private to its people, or opens it to the whole workspace. */
    setMembersOnly(spaceId: string, by: string, membersOnly: boolean): Promise<void>;
    /** Refuses (409) while a live runtime would still show a private Space. */
    requirePrivacyEnforced(): void;
    /** Whether `by` may delete the Space (CB-277), or the refusal. */
    requireDeletable(spaceId: string, by: string): void;
    /** Whether the Space is private to its people (`space_settings`). */
    membersOnly(spaceId: string): boolean;
    /** The person's row in the Space, if they have one (CB-360's person page). */
    memberRole(spaceId: string, userId: string): SpaceRole | undefined;
    /** A new Space's access (`POST /api/spaces`). */
    created(
        spaceId: string,
        by: string,
        options: { private: boolean; people?: ReadonlyArray<{ userId: string; role: SpaceRole }> },
    ): Promise<void>;
}

export class Access extends Context.Service<Access, SpaceAccessShape>()('socio/spaces/Access') {}

/**
 * A person's Space memberships, as member or editor, and handing them to
 * another person (CB-360's transfer): a Space only they edit gets the new
 * owner as its editor. `infra/sqlite/ownership.ts` implements it.
 */
export interface SpaceMembershipOwnershipShape {
    owned(userId: string): OwnedList;
    /** How many live Spaces have `userId` as their only editor. */
    soleEditorOf(userId: string): number;
    /**
     * Every membership of `from` becomes `to`'s, inside the caller's
     * transaction; where `to` is in the Space already, the higher role
     * stays. `from` is no longer a member.
     */
    transfer(parties: TransferParties): TransferTally;
}

// ── Creation (`create.ts`) ───────────────────────────────────────────────

export const OPEN_SPACE_REFUSED =
    'Only workspace admins make a Space for the whole workspace. Make it private to the people you choose.';

/** The answer a refused `create_space` gives the socio (`toolError`'s shape). */
export class SpaceCreationError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 403 | 404 | 409,
    ) {
        super(message);
        this.name = 'SpaceCreationError';
    }
}

/**
 * Making Spaces (CB-181, CB-271): a person's, by the one rule (`createAs`,
 * for `POST /api/spaces`), and a socio's `create_space`, on its person's
 * approval (`propose`). `create.ts`'s `SpaceCreation` implements it.
 */
export interface SpaceCreationShape {
    /**
     * Makes a Space as `person`, by the one rule: only someone the "create
     * Spaces" permission lets in; private unless an admin opens it; only workspace admins make one for the whole workspace
     * (else a 403 `SpaceAccessError`). `createSpaceAs`, as a method.
     */
    createAs(person: Pick<User, 'id' | 'role'>, input: SpaceCreateRequest & { grantTo?: string }): Promise<Space>;
    /** Whether the socio could use the new Space in this chat right after. */
    usableIn(threadId: string, userId: string, visibility: SpaceVisibility): boolean;
    /**
     * `create_space`: checks the request, then asks the person on the
     * approval card; throws `SpaceCreationError` when refused.
     */
    propose(
        turn: { userId: string; dotId: string; threadId: string },
        input: { name: string; description?: string; visibility?: SpaceVisibility },
    ): Promise<ApprovalOutcome & { usableHere: boolean; note?: string }>;
}

export class Creation extends Context.Service<Creation, SpaceCreationShape>()('socio/spaces/Creation') {}

// ── The module's page tools (`spaces-module.ts`) ─────────────────────────

/**
 * What a turn's page tools are made for: pages' `PageAccessInput`, less the
 * page moves, which the composition adds.
 */
export interface SpacePageInput {
    /** The socio's own Space: the default for page calls. */
    spaceId: string;
    threadId: string;
    /** Throws once the turn is stopped. */
    check: () => void;
    /** The person whose page reads count toward freshness; null for turns nobody waits on. */
    usedBy?: string | null;
    /** Where the turn records what grounded it (CB-194). */
    ref?: RunRefRecorder;
}

/**
 * The page tools the module gives every socio, a socio's `create_space`
 * and the page a turn's chat is about: pages' `PageTools` by the slice the
 * module calls, with the page moves (pages' `PageMoves`) and the Spaces'
 * `Creation` filled in. Pages is above Spaces in the folder order, so the
 * port is declared here and the composition provides it.
 */
export interface SpacePagesShape {
    /** The page tools every socio has (list, search, read, create, edit, ...). */
    readonly tools: (input: SpacePageInput) => ToolDefinition[];
    /**
     * `create_space`: a new Space, on the person's approval (CB-271); none
     * where nothing approves one (a turn a test builds on its own).
     */
    readonly createSpace?: (turn: DotTurn) => ToolDefinition;
    /** The chat's page, while this socio may read its Space. */
    readonly pageContext: (input: SpacePageInput) => Page | undefined;
}

export class SpacePages extends Context.Service<SpacePages, SpacePagesShape>()('socio/spaces/SpacePages') {}
