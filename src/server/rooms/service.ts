import { randomUUID } from 'node:crypto';

import type { UnitOfWork } from '@socio/data/uow';
import {
    ROOM_DISCLOSURE_VERSION,
    ROOM_INVITE_TTL_MS,
    reservedOwnerId,
    roomAllows,
    roomEligibleSocio,
    type RoomsReadiness,
} from '@socio/shared/rooms/rooms';
import { MAX_CHAT_TITLE, type Conversation, type DeleteBlocker, type Dot } from '@socio/shared/types';

import type { RoomConversation, StoredRoomEvent, StoredRoomMember, StoredRoomSocio } from './contract.js';
import type { RoomRepositories } from './domain/repositories.js';

/** Why the storage refuses to make or convert a room. */
export type RoomStorageRefusal =
    | 'rooms_off'
    | 'not_found'
    | 'archived'
    | 'invalid_title'
    /** A personal socio's chat, or a personal socio as lead. */
    | 'personal_socio'
    /** A Telegram or page chat, or one with a call in progress. */
    | 'not_convertible'
    /** Scheduled tasks run as their owner: none in rooms in v1. */
    | 'scheduled_tasks';

export class RoomStorageError extends Error {
    constructor(
        readonly reason: RoomStorageRefusal,
        message: string,
    ) {
        super(message);
        this.name = 'RoomStorageError';
    }
}

/** What the storage reads of the workspace (WorkspaceStore). */
export interface RoomWorkspace {
    thread(id: string): Conversation | undefined;
    dot(id: string): Dot | undefined;
    deleteBlocker(id: string): Promise<Exclude<DeleteBlocker, 'running'> | undefined>;
    threadTasks(threadId: string): Promise<string[]>;
}

export interface RoomStorageOptions {
    uow: UnitOfWork;
    repos: RoomRepositories;
    workspace: RoomWorkspace;
    /** Settings → General → Rooms in force (`roomsSettings`). */
    enabled: () => boolean;
}

/**
 * The rooms' storage (CB-207): making a room, converting a person's
 * private chat into one, and reading what the room tables hold, each
 * change in one unit of work with its first member, its lead socio and
 * its event. Who may call it is the routes' and access
 * checks' to decide (CB-208); the storage keeps only the rules nothing
 * may break: Rooms on, a company socio, a private web chat of the person
 * converting it, no scheduled tasks.
 */
export class RoomStorage {
    constructor(private options: RoomStorageOptions) {}

    private get repos() {
        return this.options.repos;
    }

    enabled() {
        return this.options.enabled();
    }

    private requireOn() {
        if (!this.enabled()) {
            throw new RoomStorageError('rooms_off', 'Rooms are turned off in Settings.');
        }
    }

    /** The lead must be a live, unarchived company socio. */
    private requireLead(dotId: string) {
        const dot = this.options.workspace.dot(dotId);
        if (!dot) {
            throw new RoomStorageError('not_found', 'Socio not found.');
        }
        if (dot.ownerId) {
            throw new RoomStorageError('personal_socio', 'Only company socios can be in rooms.');
        }
        if (!roomEligibleSocio(dot)) {
            throw new RoomStorageError('archived', 'This socio is archived.');
        }
        return dot;
    }

    /** The first member: the person who made or converted the room, its admin. */
    private founder(roomId: string, userId: string, now: number) {
        const member: StoredRoomMember = {
            roomId,
            userId,
            role: 'admin',
            status: 'active',
            invitedBy: null,
            invitedAt: now,
            inviteExpiresAt: null,
            acceptedAt: now,
            disclosureVersion: ROOM_DISCLOSURE_VERSION,
            endedAt: null,
            endedBy: null,
            updatedAt: now,
        };
        return member;
    }

    /**
     * The lead socio's row: active at once. A company socio is already open
     * to every member, so no workspace admin is asked (`system`); adding
     * further socios to a room is CB-206's, with an admin's authorization.
     */
    private lead(roomId: string, dotId: string, by: string, now: number) {
        const socio: StoredRoomSocio = {
            roomId,
            dotId,
            status: 'active',
            requestedBy: by,
            authorizedBy: 'system',
            authorizedAt: now,
            endedAt: null,
            updatedAt: now,
        };
        return socio;
    }

    /**
     * A further socio asked for as the room is made (CB-278): it starts as
     * `requested`, for a workspace admin to let in, as `requestSocio` does.
     */
    private requested(roomId: string, dotId: string, by: string, now: number): StoredRoomSocio {
        return {
            roomId,
            dotId,
            status: 'requested',
            requestedBy: by,
            authorizedBy: null,
            authorizedAt: null,
            endedAt: null,
            updatedAt: now,
        };
    }

    /**
     * An initial person's invite, made as the room is created (CB-278): the
     * same row `invite` writes, with the room's maker as the inviter.
     */
    private initialInvite(roomId: string, userId: string, by: string, now: number): StoredRoomMember {
        return {
            roomId,
            userId,
            role: 'member',
            status: 'invited',
            invitedBy: by,
            invitedAt: now,
            inviteExpiresAt: now + ROOM_INVITE_TTL_MS,
            acceptedAt: null,
            disclosureVersion: null,
            endedAt: null,
            endedBy: null,
            updatedAt: now,
        };
    }

    /**
     * A new room with `createdBy` as its admin and `dotId` as its lead.
     * CB-278: `dotIds` asks for further company socios (each `requested`),
     * `userIds` invites people as members, and `description` is the room's
     * optional purpose — all in the same unit of work as the room's row.
     */
    async createRoom(input: {
        dotId: string;
        title: string;
        createdBy: string;
        id?: string;
        now?: number;
        /** Further company socios to ask for (the lead is `dotId`). */
        dotIds?: readonly string[];
        /** People to invite as members (the creator's own membership is implicit). */
        userIds?: readonly string[];
        /** The room's optional description / purpose. */
        description?: string;
    }): Promise<RoomConversation> {
        this.requireOn();
        const title = input.title.trim();
        if (!title || title.length > MAX_CHAT_TITLE) {
            throw new RoomStorageError('invalid_title', `Name the room in 1 to ${MAX_CHAT_TITLE} characters.`);
        }
        this.requireLead(input.dotId);
        // De-duplicate the further socios, dropping the lead and repeats.
        const further = Array.from(new Set(input.dotIds ?? [])).filter((dotId) => dotId !== input.dotId);
        for (const dotId of further) {
            this.requireLead(dotId);
        }
        // De-duplicate the invited people, dropping the creator (their membership
        // is the founder row) and sentinels. Eligibility is the membership
        // layer's check (`RoomError not_eligible`), done before this is called.
        const invited = Array.from(new Set(input.userIds ?? [])).filter(
            (userId) => userId !== input.createdBy && !reservedOwnerId(userId),
        );
        const description = input.description?.trim() || null;
        const id = input.id ?? randomUUID();
        const now = input.now ?? Date.now();
        await this.options.uow.run(
            async () => {
                await this.repos.conversations.insertRoom({
                    id,
                    dotId: input.dotId,
                    title,
                    createdBy: input.createdBy,
                    createdAt: now,
                });
                await this.repos.members.insert(this.founder(id, input.createdBy, now));
                await this.repos.socios.insert(this.lead(id, input.dotId, input.createdBy, now));
                for (const dotId of further) {
                    await this.repos.socios.insert(this.requested(id, dotId, input.createdBy, now));
                }
                for (const userId of invited) {
                    await this.repos.members.insert(this.initialInvite(id, userId, input.createdBy, now));
                }
                if (description) {
                    await this.repos.settings.save({
                        roomId: id,
                        limits: {},
                        updatedBy: input.createdBy,
                        updatedAt: now,
                        description,
                    });
                }
                await this.repos.events.append({
                    roomId: id,
                    actor: input.createdBy,
                    action: 'create',
                    targetKind: 'room',
                    targetId: id,
                    outcome: 'ok',
                    detail: '',
                    at: now,
                });
            },
            { label: 'create room' },
        );
        return (await this.repos.conversations.get(id))!;
    }

    /**
     * Turns `by`'s own private web chat into a room: same id,
     * history and links; `by` becomes its admin, its socio the lead. Its
     * earlier person messages are known to be `by`'s, which the `convert`
     * event records; no message is rewritten. Telegram and page chats, a
     * chat with a call in progress, with scheduled tasks or with a personal
     * socio do not convert.
     */
    async convertToRoom(id: string, by: string, now = Date.now()): Promise<RoomConversation> {
        const thread = this.options.workspace.thread(id);
        const decision = thread
            ? roomAllows({ ...thread, kind: thread.kind ?? 'private' }, { userId: by }, 'convert', {
                  roomsEnabled: this.enabled(),
              })
            : ({ allowed: false, reason: 'not_found' } as const);
        if (!decision.allowed) {
            if (decision.reason === 'rooms_off') {
                this.requireOn();
            }
            if (decision.reason === 'archived') {
                throw new RoomStorageError('archived', 'Unarchive the chat before making it a room.');
            }
            throw new RoomStorageError('not_found', 'Conversation not found.');
        }
        this.requireLead(thread!.dotId);
        if (await this.options.workspace.deleteBlocker(id)) {
            throw new RoomStorageError(
                'not_convertible',
                'Only a web chat with no call in progress can become a room.',
            );
        }
        if ((await this.options.workspace.threadTasks(id)).length) {
            throw new RoomStorageError(
                'scheduled_tasks',
                'Remove this chat’s scheduled tasks before making it a room.',
            );
        }
        await this.options.uow.run(
            async () => {
                if (!(await this.repos.conversations.convert(id, by, by, now))) {
                    throw new RoomStorageError('not_found', 'Conversation not found.');
                }
                await this.repos.members.insert(this.founder(id, by, now));
                await this.repos.socios.insert(this.lead(id, thread!.dotId, by, now));
                await this.repos.events.append({
                    roomId: id,
                    actor: by,
                    action: 'convert',
                    targetKind: 'room',
                    targetId: id,
                    outcome: 'ok',
                    // Decision 12.8: who wrote its earlier person messages.
                    detail: 'from a private chat; earlier messages are the actor’s',
                    at: now,
                });
            },
            { label: 'convert to room' },
        );
        return (await this.repos.conversations.get(id))!;
    }

    /** A room's row; undefined for a private chat or a missing one. */
    async room(id: string): Promise<RoomConversation | undefined> {
        const row = await this.repos.conversations.get(id);
        return row?.kind === 'room' ? row : undefined;
    }

    members(roomId: string): Promise<StoredRoomMember[]> {
        return this.repos.members.list(roomId);
    }

    socios(roomId: string): Promise<StoredRoomSocio[]> {
        return this.repos.socios.list(roomId);
    }

    events(roomId: string, limit = 100): Promise<StoredRoomEvent[]> {
        return this.repos.events.forRoom(roomId, limit);
    }

    /**
     * The reconcile before Rooms is turned on: live conversations per kind.
     * Before the first room, every one is private.
     */
    async readiness(): Promise<RoomsReadiness> {
        const conversations = await this.repos.conversations.kindCounts();
        return {
            enabled: this.enabled(),
            conversations,
            allPrivate: conversations.room === 0,
        };
    }
}
