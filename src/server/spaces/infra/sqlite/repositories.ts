import { and, asc, eq, sql } from 'drizzle-orm';

import type { SqliteData } from '@socio/data/open';

import type { SpaceAccessRepository, StoredSpaceMember } from '../../contract.js';

import { spaceMembers, spaceSettings } from './schema.js';

const MEMBER = {
    spaceId: spaceMembers.spaceId,
    userId: spaceMembers.userId,
    role: spaceMembers.role,
    addedBy: spaceMembers.addedBy,
    addedAt: spaceMembers.addedAt,
};

/**
 * Space access (CB-181) on the shared connection. Drizzle on node:sqlite
 * answers at once, so the reads stay synchronous.
 */
class SqliteSpaceAccess implements SpaceAccessRepository {
    constructor(private data: SqliteData) {}

    private get db() {
        return this.data.uow.executor();
    }

    member(spaceId: string, userId: string) {
        return this.db
            .select(MEMBER)
            .from(spaceMembers)
            .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)))
            .get();
    }

    members(spaceId: string) {
        return this.db
            .select(MEMBER)
            .from(spaceMembers)
            .where(eq(spaceMembers.spaceId, spaceId))
            .orderBy(asc(spaceMembers.addedAt), sql`${spaceMembers}.rowid ASC`)
            .all();
    }

    membersOnly(spaceId: string) {
        return !!this.db
            .select({ membersOnly: spaceSettings.membersOnly })
            .from(spaceSettings)
            .where(eq(spaceSettings.spaceId, spaceId))
            .get()?.membersOnly;
    }

    memberships(userId: string) {
        return this.db.select(MEMBER).from(spaceMembers).where(eq(spaceMembers.userId, userId)).all();
    }

    membersOnlyIds() {
        const rows = this.db
            .select({ spaceId: spaceSettings.spaceId })
            .from(spaceSettings)
            .where(eq(spaceSettings.membersOnly, true))
            .all();
        return new Set(rows.map((row) => row.spaceId));
    }

    setMember(member: Omit<StoredSpaceMember, 'addedAt'>, now = Date.now()): Promise<StoredSpaceMember> {
        return this.data.uow.run(
            async () => {
                await this.db
                    .insert(spaceMembers)
                    .values({ ...member, addedAt: now, updatedAt: now })
                    .onConflictDoUpdate({
                        target: [spaceMembers.spaceId, spaceMembers.userId],
                        set: { role: member.role, updatedAt: now },
                    })
                    .run();
                return this.member(member.spaceId, member.userId)!;
            },
            { label: 'set space member' },
        );
    }

    removeMember(spaceId: string, userId: string) {
        return this.data.uow.run(
            async () => {
                const { changes } = await this.db
                    .delete(spaceMembers)
                    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)))
                    .run();
                return Number(changes) > 0;
            },
            { label: 'remove space member' },
        );
    }

    setMembersOnly(spaceId: string, membersOnly: boolean, by: string, now = Date.now()) {
        return this.data.uow.run(
            async () => {
                await this.db
                    .insert(spaceSettings)
                    .values({ spaceId, membersOnly, updatedBy: by, updatedAt: now })
                    .onConflictDoUpdate({
                        target: spaceSettings.spaceId,
                        set: { membersOnly, updatedBy: by, updatedAt: now },
                    })
                    .run();
            },
            { label: 'set space access' },
        );
    }
}

/** Space access on a migrated connection. */
export function sqliteSpaceAccess(data: SqliteData): SpaceAccessRepository {
    return new SqliteSpaceAccess(data);
}
