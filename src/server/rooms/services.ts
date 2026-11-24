import type { DatabaseSync } from 'node:sqlite';

import { sqliteData } from '@socio/data/open';
import type { RoomAction, RoomDecision } from '@socio/shared/rooms/rooms';
import type { Conversation } from '@socio/shared/types';

import type { RunnerShape } from '../turns/contract.js';

import type { RoomAccessCheck, RoomsTelegramChannel } from './contract.js';
import { sqliteRoomNotices as sqliteRoomNoticeRepository } from './infra/sqlite/notices.js';
import { sqliteRoomRepositories } from './infra/sqlite/repositories.js';
import { RoomMembership, type RoomMembershipOptions } from './membership.js';
import { RoomNotices, type RoomNoticesOptions } from './notices.js';
import type { RoomOrchestrator, RoomOrchestratorOptions } from './orchestrator.js';
import { RoomStorage, type RoomWorkspace } from './service.js';
import { RoomTopics, type RoomTopicsOptions } from './telegram-topics.js';

/**
 * What rooms reads of the workspace store (`WorkspaceStore` answers it):
 * what each of its services reads, its connection, the access rule it
 * holds and its switch. Rooms declares it rather than importing the
 * workspace's slices, which sit above it in the folder order
 * (scripts/feature-ranks.json); no slice offers the connection or the
 * access rule yet.
 */
export type RoomsWorkspaceShape = RoomWorkspace &
    RoomMembershipOptions['workspace'] &
    RoomTopicsOptions['workspace'] &
    RoomNoticesOptions['workspace'] &
    RoomOrchestratorOptions['workspace'] & {
        readonly db: DatabaseSync;
        /** Has signed in at least once. */
        hasUser(userId: string): boolean;
        /** The rule's answer and the conversation, for a route's 404 or refusal. */
        access(
            userId: string,
            id: string,
            action: RoomAction,
            check?: RoomAccessCheck,
        ): { thread?: Conversation; decision: RoomDecision };
        /** Sets the switch the access rule reads (Settings → General → Rooms). */
        useRooms(enabled: () => boolean): void;
        /** A person deactivated, a chat archived, ... */
        onAccessChange(listener: () => void): unknown;
    };

/** What the rooms' routes show of the Telegram channel: moved to the contract. */
export type { RoomsTelegramChannel };

/**
 * What the rooms module's hooks read of the platform they are given
 * (`ModuleContext.platform`): its routes, ticks and prompt hooks. The
 * services rooms builds itself are made in `layer.ts`; until the module
 * hooks can yield tags (the composition root binds `ModuleRuntimeServices`)
 * they reach them here. The workspace is what rooms reads of the
 * workspace store (`RoomsWorkspaceShape`, above).
 */
export interface RoomsPlatform {
    readonly orchestrator: RoomOrchestrator;
    readonly roomNotices: RoomNotices;
    readonly roomTopics: RoomTopics;
    readonly rooms: RoomMembership;
    readonly runner: RunnerShape;
    readonly telegram?: RoomsTelegramChannel;
    readonly workspace: Pick<RoomsWorkspaceShape, 'access' | 'thread' | 'users' | 'dot' | 'db' | 'roomAccess'>;
}

/**
 * Rooms (CB-207) on a migrated connection: the storage over the SQLite
 * repositories and the connection's unit of work.
 */
export function sqliteRooms(db: DatabaseSync, options: { workspace: RoomWorkspace; enabled: () => boolean }) {
    const data = sqliteData(db);
    return new RoomStorage({
        uow: data.uow,
        repos: sqliteRoomRepositories(data),
        ...options,
    });
}

/**
 * Rooms' membership and lifecycle (CB-208) on a connection: the storage
 * that makes and converts rooms and the membership service over the same
 * repositories and unit of work.
 */
export function sqliteRoomMembership(
    db: DatabaseSync,
    options: Omit<RoomMembershipOptions, 'uow' | 'repos' | 'storage'> & {
        workspace: RoomWorkspace & RoomMembershipOptions['workspace'];
    },
) {
    const data = sqliteData(db);
    const repos = sqliteRoomRepositories(data);
    const storage = new RoomStorage({
        uow: data.uow,
        repos,
        workspace: options.workspace,
        enabled: options.enabled,
    });
    return new RoomMembership({ ...options, uow: data.uow, repos, storage });
}

/**
 * Rooms' Telegram topics (CB-214) on a connection: binding a forum topic
 * to a room, over the same repositories and unit of work as membership.
 */
export function sqliteRoomTopics(db: DatabaseSync, options: Omit<RoomTopicsOptions, 'uow' | 'repos'>) {
    const data = sqliteData(db);
    return new RoomTopics({
        ...options,
        uow: data.uow,
        repos: sqliteRoomRepositories(data),
    });
}

/**
 * Rooms' notices (CB-216) on a connection: each member's level, the
 * mentions and the notices sent, over the room's members and socios.
 */
export function sqliteRoomNotices(
    db: DatabaseSync,
    options: Omit<RoomNoticesOptions, 'notices' | 'members' | 'socios'>,
) {
    const data = sqliteData(db);
    const repos = sqliteRoomRepositories(data);
    return new RoomNotices({
        ...options,
        notices: sqliteRoomNoticeRepository(data),
        members: repos.members,
        socios: repos.socios,
    });
}
