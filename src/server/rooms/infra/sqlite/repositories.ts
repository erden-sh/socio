import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';

import type { SqliteData } from '@socio/data/open';
import {
    roomOwnerId,
    type ConversationKind,
    type RoomEvent,
    type RoomMemberStatus,
    type RoomSocioStatus,
} from '@socio/shared/rooms/rooms';

import type { RoomConversation, StoredRoomMember, StoredRoomSocio } from '../../contract.js';
import type {
    NewRoomConversation,
    RoomAccessReader,
    RoomConversationRepository,
    RoomEventRepository,
    RoomHandoff,
    RoomHandoffRepository,
    RoomMemberRepository,
    RoomReadPlace,
    RoomReadStateRepository,
    RoomRepositories,
    RoomSettingsRepository,
    RoomSocioRepository,
    RoomSourceBinding,
    RoomSourceRepository,
    StoredRoomSettings,
} from '../../domain/repositories.js';

import {
    roomConversations,
    roomEvents,
    roomHandoffs,
    roomMembers,
    roomReadState,
    roomSettings,
    roomSocios,
    roomSourceBindings,
} from './schema.js';

/**
 * What the room repositories share: the connection's data layer. Reads run
 * on the open unit of work's handle, or as one autocommit statement; each
 * write joins the open unit, or opens its own.
 */
abstract class SqliteRepository {
    constructor(protected data: SqliteData) {}

    protected get db() {
        return this.data.uow.executor();
    }

    protected write<T>(label: string, work: () => Promise<T>) {
        return this.data.uow.run(work, { label });
    }
}

/** The SQLite row order, as a tie-break. */
const insertionOrder = (table: SQLiteTable) => sql`${table}.rowid`;

class SqliteRoomConversations extends SqliteRepository implements RoomConversationRepository {
    async get(id: string): Promise<RoomConversation | undefined> {
        return this.db
            .select({
                id: roomConversations.id,
                kind: roomConversations.kind,
                ownerId: roomConversations.ownerId,
                dotId: roomConversations.dotId,
                title: roomConversations.title,
                createdAt: roomConversations.createdAt,
                createdBy: roomConversations.createdBy,
                convertedAt: roomConversations.convertedAt,
                archivedAt: roomConversations.archivedAt,
            })
            .from(roomConversations)
            .where(and(eq(roomConversations.id, id), isNull(roomConversations.deletedAt)))
            .get();
    }

    insertRoom(room: NewRoomConversation) {
        return this.write('create room', async () => {
            await this.db.insert(roomConversations).values({
                id: room.id,
                dotId: room.dotId,
                ownerId: roomOwnerId(room.id),
                title: room.title,
                createdAt: room.createdAt,
                // Learning stays off in rooms.
                learningContainerId: null,
                kind: 'room',
                createdBy: room.createdBy,
                // Its maker named it: a title generated from the first message
                // never replaces theirs (CB-66, CB-212).
                renamed: true,
                titled: true,
            });
        });
    }

    convert(id: string, ownerId: string, convertedBy: string, now: number) {
        return this.write('convert to room', async () => {
            const result = await this.db
                .update(roomConversations)
                .set({
                    kind: 'room',
                    ownerId: roomOwnerId(id),
                    createdBy: convertedBy,
                    convertedAt: now,
                    learningContainerId: null,
                })
                .where(
                    and(
                        eq(roomConversations.id, id),
                        eq(roomConversations.kind, 'private'),
                        eq(roomConversations.ownerId, ownerId),
                        isNull(roomConversations.deletedAt),
                        isNull(roomConversations.archivedAt),
                    ),
                )
                .run();
            return Number(result.changes) === 1;
        });
    }

    async kindCounts() {
        const rows = await this.db
            .select({ kind: roomConversations.kind, count: sql<number>`count(*)` })
            .from(roomConversations)
            .where(isNull(roomConversations.deletedAt))
            .groupBy(roomConversations.kind);
        const counts: Record<ConversationKind, number> = { private: 0, room: 0 };
        for (const row of rows) {
            counts[row.kind] = Number(row.count);
        }
        return counts;
    }

    /** A live room's row, for an update. */
    private liveRoom(id: string) {
        return and(
            eq(roomConversations.id, id),
            eq(roomConversations.kind, 'room'),
            isNull(roomConversations.deletedAt),
        );
    }

    rename(id: string, title: string) {
        return this.write('rename room', async () => {
            const result = await this.db
                .update(roomConversations)
                .set({ title, renamed: true, titled: true })
                .where(this.liveRoom(id))
                .run();
            return Number(result.changes) === 1;
        });
    }

    setArchived(id: string, at: number | null, by: string) {
        return this.write(at === null ? 'unarchive room' : 'archive room', async () => {
            const result = await this.db
                .update(roomConversations)
                .set({ archivedAt: at, archivedBy: at === null ? null : by })
                .where(
                    and(
                        this.liveRoom(id),
                        at === null ? isNotNull(roomConversations.archivedAt) : isNull(roomConversations.archivedAt),
                    ),
                )
                .run();
            return Number(result.changes) === 1;
        });
    }

    setLead(id: string, dotId: string) {
        return this.write('set room lead', async () => {
            const result = await this.db.update(roomConversations).set({ dotId }).where(this.liveRoom(id)).run();
            return Number(result.changes) === 1;
        });
    }
}

class SqliteRoomMembers extends SqliteRepository implements RoomMemberRepository {
    async get(roomId: string, userId: string) {
        return this.db
            .select()
            .from(roomMembers)
            .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)))
            .get();
    }

    async list(roomId: string) {
        return this.db
            .select()
            .from(roomMembers)
            .where(eq(roomMembers.roomId, roomId))
            .orderBy(asc(roomMembers.invitedAt), asc(insertionOrder(roomMembers)));
    }

    async forUser(userId: string, statuses?: readonly RoomMemberStatus[]) {
        return this.db
            .select()
            .from(roomMembers)
            .where(
                and(eq(roomMembers.userId, userId), statuses ? inArray(roomMembers.status, [...statuses]) : undefined),
            )
            .orderBy(asc(roomMembers.invitedAt), asc(insertionOrder(roomMembers)));
    }

    insert(member: StoredRoomMember) {
        return this.write('add room member', async () => {
            await this.db.insert(roomMembers).values(member);
        });
    }

    async roomsWithActive() {
        const rows = await this.db
            .selectDistinct({ roomId: roomMembers.roomId })
            .from(roomMembers)
            .where(eq(roomMembers.status, 'active'));
        return rows.map((row) => row.roomId);
    }

    async lapsed(now: number, limit: number) {
        return this.db
            .select()
            .from(roomMembers)
            .where(
                and(
                    eq(roomMembers.status, 'invited'),
                    isNotNull(roomMembers.inviteExpiresAt),
                    lte(roomMembers.inviteExpiresAt, now),
                ),
            )
            .orderBy(asc(roomMembers.inviteExpiresAt))
            .limit(limit);
    }

    save(member: StoredRoomMember) {
        return this.write('save room member', async () => {
            await this.db
                .insert(roomMembers)
                .values(member)
                .onConflictDoUpdate({
                    target: [roomMembers.roomId, roomMembers.userId],
                    set: member,
                });
        });
    }
}

class SqliteRoomSocios extends SqliteRepository implements RoomSocioRepository {
    async get(roomId: string, dotId: string) {
        return this.db
            .select()
            .from(roomSocios)
            .where(and(eq(roomSocios.roomId, roomId), eq(roomSocios.dotId, dotId)))
            .get();
    }

    async list(roomId: string) {
        return this.db
            .select()
            .from(roomSocios)
            .where(eq(roomSocios.roomId, roomId))
            .orderBy(asc(insertionOrder(roomSocios)));
    }

    async withStatus(status: RoomSocioStatus) {
        return this.db
            .select()
            .from(roomSocios)
            .where(eq(roomSocios.status, status))
            .orderBy(asc(roomSocios.updatedAt), asc(insertionOrder(roomSocios)));
    }

    insert(socio: StoredRoomSocio) {
        return this.write('add room socio', async () => {
            await this.db.insert(roomSocios).values(socio);
        });
    }

    save(socio: StoredRoomSocio) {
        return this.write('save room socio', async () => {
            await this.db
                .insert(roomSocios)
                .values(socio)
                .onConflictDoUpdate({
                    target: [roomSocios.roomId, roomSocios.dotId],
                    set: socio,
                });
        });
    }
}

class SqliteRoomSettings extends SqliteRepository implements RoomSettingsRepository {
    async get(roomId: string) {
        return this.db.select().from(roomSettings).where(eq(roomSettings.roomId, roomId)).get();
    }

    save(settings: StoredRoomSettings) {
        return this.write('save room settings', async () => {
            await this.db
                .insert(roomSettings)
                .values(settings)
                .onConflictDoUpdate({ target: roomSettings.roomId, set: settings });
        });
    }
}

class SqliteRoomSources extends SqliteRepository implements RoomSourceRepository {
    async bySource(source: RoomSourceBinding['source'], sourceKey: string) {
        return this.db
            .select()
            .from(roomSourceBindings)
            .where(and(eq(roomSourceBindings.source, source), eq(roomSourceBindings.sourceKey, sourceKey)))
            .get();
    }

    async forRoom(roomId: string) {
        return this.db
            .select()
            .from(roomSourceBindings)
            .where(eq(roomSourceBindings.roomId, roomId))
            .orderBy(asc(roomSourceBindings.boundAt));
    }

    insert(binding: RoomSourceBinding) {
        return this.write('bind room source', async () => {
            await this.db.insert(roomSourceBindings).values(binding);
        });
    }

    disable(id: string, now: number) {
        return this.write('unbind room source', async () => {
            await this.db
                .update(roomSourceBindings)
                .set({ status: 'disabled', endedAt: now })
                .where(and(eq(roomSourceBindings.id, id), eq(roomSourceBindings.status, 'active')));
        });
    }

    rebind(id: string, binding: Pick<RoomSourceBinding, 'roomId' | 'boundBy' | 'boundAt'>) {
        return this.write('bind room source again', async () => {
            const changed = await this.db
                .update(roomSourceBindings)
                .set({ ...binding, status: 'active', bridge: false, endedAt: null })
                .where(and(eq(roomSourceBindings.id, id), eq(roomSourceBindings.status, 'disabled')))
                .returning({ id: roomSourceBindings.id });
            return changed.length > 0;
        });
    }
}

class SqliteRoomEvents extends SqliteRepository implements RoomEventRepository {
    append(event: RoomEvent) {
        return this.write('room event', async () => {
            const { at, ...rest } = event;
            await this.db.insert(roomEvents).values({ ...rest, createdAt: at });
        });
    }

    async forRoom(roomId: string, limit: number) {
        const rows = await this.db
            .select()
            .from(roomEvents)
            .where(eq(roomEvents.roomId, roomId))
            .orderBy(desc(roomEvents.id))
            .limit(limit);
        return rows.map(({ createdAt, ...row }) => ({ ...row, at: createdAt }));
    }

    async forPerson(userId: string, before: { at: number; id: number } | undefined, limit: number) {
        const rows = await this.db
            .select()
            .from(roomEvents)
            .where(
                and(
                    or(
                        eq(roomEvents.actor, userId),
                        and(eq(roomEvents.targetKind, 'person'), eq(roomEvents.targetId, userId)),
                    ),
                    before
                        ? sql`(${roomEvents.createdAt}, ${roomEvents.id}) < (${before.at}, ${before.id})`
                        : undefined,
                ),
            )
            .orderBy(desc(roomEvents.createdAt), desc(roomEvents.id))
            .limit(limit);
        return rows.map(({ createdAt, ...row }) => ({ ...row, at: createdAt }));
    }
}

class SqliteRoomHandoffs extends SqliteRepository implements RoomHandoffRepository {
    insert(handoff: RoomHandoff) {
        return this.write('add room handoff', async () => {
            await this.db.insert(roomHandoffs).values(handoff);
        });
    }

    update(id: string, patch: Partial<Pick<RoomHandoff, 'cycleId' | 'status' | 'detail' | 'hop' | 'runId'>>) {
        return this.write('update room handoff', async () => {
            const result = await this.db
                .update(roomHandoffs)
                .set({ ...patch, updatedAt: Date.now() })
                .where(eq(roomHandoffs.id, id))
                .run();
            return Number(result.changes) === 1;
        });
    }

    async forCycle(cycleId: string, afterRunId?: string) {
        return this.db
            .select()
            .from(roomHandoffs)
            .where(
                afterRunId
                    ? or(
                          eq(roomHandoffs.cycleId, cycleId),
                          and(isNull(roomHandoffs.cycleId), eq(roomHandoffs.afterRunId, afterRunId)),
                      )
                    : eq(roomHandoffs.cycleId, cycleId),
            )
            .orderBy(asc(roomHandoffs.createdAt), asc(insertionOrder(roomHandoffs)));
    }

    bindCycle(afterRunId: string, cycleId: string) {
        return this.write('bind room handoffs', async () => {
            await this.db
                .update(roomHandoffs)
                .set({ cycleId })
                .where(and(eq(roomHandoffs.afterRunId, afterRunId), isNull(roomHandoffs.cycleId)));
        });
    }

    async pending(roomId?: string) {
        return this.db
            .select()
            .from(roomHandoffs)
            .where(and(eq(roomHandoffs.status, 'pending'), roomId ? eq(roomHandoffs.roomId, roomId) : undefined))
            .orderBy(asc(roomHandoffs.createdAt), asc(insertionOrder(roomHandoffs)));
    }
}

/**
 * Members' read cursors (CB-215), read beside their memberships: a room
 * is someone's to have read only while they are an active member there.
 */
class SqliteRoomReads extends SqliteRepository implements RoomReadStateRepository {
    private select(userId: string, roomId?: string) {
        return this.db
            .select({
                roomId: roomMembers.roomId,
                lastSeq: sql<number>`coalesce(${roomReadState.lastSeq}, 0)`,
                joinedAt: sql<number>`coalesce(${roomMembers.acceptedAt}, ${roomMembers.invitedAt})`,
            })
            .from(roomMembers)
            .leftJoin(
                roomReadState,
                and(eq(roomReadState.roomId, roomMembers.roomId), eq(roomReadState.userId, roomMembers.userId)),
            )
            .where(
                and(
                    eq(roomMembers.userId, userId),
                    eq(roomMembers.status, 'active'),
                    roomId === undefined ? undefined : eq(roomMembers.roomId, roomId),
                ),
            );
    }

    async places(userId: string): Promise<RoomReadPlace[]> {
        return this.select(userId).all();
    }

    async place(roomId: string, userId: string) {
        return this.select(userId, roomId).get();
    }

    advance(roomId: string, userId: string, seq: number, now: number) {
        return this.write('advance room read state', async () => {
            // Only forward: an older cursor (another device's) changes nothing,
            // not even the row's time, so it bumps no live update.
            await this.db
                .insert(roomReadState)
                .values({ roomId, userId, lastSeq: seq, updatedAt: now })
                .onConflictDoUpdate({
                    target: [roomReadState.roomId, roomReadState.userId],
                    set: { lastSeq: seq, updatedAt: now },
                    setWhere: sql`${roomReadState.lastSeq} < ${seq}`,
                });
            const row = await this.db
                .select({ lastSeq: roomReadState.lastSeq })
                .from(roomReadState)
                .where(and(eq(roomReadState.roomId, roomId), eq(roomReadState.userId, userId)))
                .get();
            return row?.lastSeq ?? seq;
        });
    }
}

/**
 * The access rule's reads (CB-208): Drizzle on node:sqlite answers at
 * once, so these stay synchronous for the request checks that are.
 */
class SqliteRoomAccessReader implements RoomAccessReader {
    constructor(private data: SqliteData) {}

    private get db() {
        return this.data.uow.executor();
    }

    member(roomId: string, userId: string) {
        return this.db
            .select({ role: roomMembers.role, status: roomMembers.status })
            .from(roomMembers)
            .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)))
            .get();
    }

    activeRooms(userId: string) {
        return this.db
            .select({ roomId: roomMembers.roomId, role: roomMembers.role })
            .from(roomMembers)
            .where(and(eq(roomMembers.userId, userId), eq(roomMembers.status, 'active')))
            .all();
    }

    people(roomId: string, now: number) {
        return this.db
            .select({ userId: roomMembers.userId })
            .from(roomMembers)
            .where(
                and(
                    eq(roomMembers.roomId, roomId),
                    or(
                        eq(roomMembers.status, 'active'),
                        and(
                            eq(roomMembers.status, 'invited'),
                            or(isNull(roomMembers.inviteExpiresAt), gt(roomMembers.inviteExpiresAt, now)),
                        ),
                    ),
                ),
            )
            .all()
            .map((row) => row.userId);
    }

    socios(roomId: string, status: RoomSocioStatus) {
        return this.db
            .select({ dotId: roomSocios.dotId })
            .from(roomSocios)
            .where(and(eq(roomSocios.roomId, roomId), eq(roomSocios.status, status)))
            .orderBy(asc(insertionOrder(roomSocios)))
            .all()
            .map((row) => row.dotId);
    }
}

/** The access rule's synchronous reads on a migrated connection. */
export function sqliteRoomAccessReader(data: SqliteData): RoomAccessReader {
    return new SqliteRoomAccessReader(data);
}

/**
 * Rooms' repositories on a migrated connection (CB-207): the only code
 * that reads or writes the room tables, and a room's `thread_bindings` row.
 */
export function sqliteRoomRepositories(data: SqliteData): RoomRepositories {
    return {
        conversations: new SqliteRoomConversations(data),
        members: new SqliteRoomMembers(data),
        socios: new SqliteRoomSocios(data),
        settings: new SqliteRoomSettings(data),
        sources: new SqliteRoomSources(data),
        events: new SqliteRoomEvents(data),
        reads: new SqliteRoomReads(data),
        handoffs: new SqliteRoomHandoffs(data),
    };
}
