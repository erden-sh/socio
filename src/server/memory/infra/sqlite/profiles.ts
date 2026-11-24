import { randomUUID } from 'node:crypto';

import { and, count, eq, isNull, sql } from 'drizzle-orm';

import type { ProfileFields, UserProfile } from '@socio/shared/memory';

import type { ProfileRepository } from '../../contract.js';
import { filledFields } from '../../domain/rules.js';

import { SqliteRepository } from './base.js';
import { userProfiles } from './schema.js';

/** A person's profile (CB-106), on the shared SQLite connection. */
export class SqliteProfiles extends SqliteRepository implements ProfileRepository {
    /** Every turn reads it (its time zone, CB-159): prepared once. */
    private liveQuery = this.data.uow
        .executor()
        .select({
            fields: userProfiles.fields,
            shareable: userProfiles.shareable,
            timezoneDetected: userProfiles.timezoneDetected,
            createdAt: userProfiles.createdAt,
        })
        .from(userProfiles)
        .where(and(eq(userProfiles.userId, sql.placeholder('userId')), isNull(userProfiles.deletedAt)))
        .prepare();

    async get(userId: string): Promise<UserProfile | null> {
        this.data.uow.executor();
        const row = await this.liveQuery.get({ userId });
        if (!row) {
            return null;
        }
        const fields = filledFields(row.fields);
        return {
            fields,
            shareable: row.shareable,
            ...(row.timezoneDetected && fields.timezone ? { timezoneDetected: true as const } : {}),
            updatedAt: row.createdAt,
        };
    }

    save(
        userId: string,
        profile: {
            fields: ProfileFields;
            shareable: boolean;
            timezoneDetected?: boolean;
        },
        now = Date.now(),
    ) {
        const fields = filledFields(profile.fields);
        return this.write('save profile', async () => {
            const before = await this.get(userId);
            const detected =
                !!fields.timezone &&
                (profile.timezoneDetected ??
                    (!!before?.timezoneDetected && before.fields.timezone === fields.timezone));
            await this.stamp(userId, now);
            if (Object.keys(fields).length) {
                await this.db.insert(userProfiles).values({
                    id: randomUUID(),
                    userId,
                    fields,
                    shareable: profile.shareable,
                    timezoneDetected: detected,
                    createdAt: now,
                });
            }
            return this.get(userId);
        });
    }

    clear(userId: string, now = Date.now()) {
        return this.write('clear profile', async () => (await this.stamp(userId, now)) > 0);
    }

    async cleared(userId: string) {
        const row = await this.db
            .select({
                kept: count(),
                live: sql<number | null>`SUM(CASE WHEN ${userProfiles.deletedAt} IS NULL THEN 1 ELSE 0 END)`,
            })
            .from(userProfiles)
            .where(eq(userProfiles.userId, userId))
            .get();
        return !!row && row.kept > 0 && !row.live;
    }

    /** Stamps the person's live version deleted; says how many it stamped. */
    private async stamp(userId: string, now: number) {
        const { changes } = await this.db
            .update(userProfiles)
            .set({ deletedAt: now, deletedBy: userId })
            .where(and(eq(userProfiles.userId, userId), isNull(userProfiles.deletedAt)))
            .run();
        return Number(changes);
    }
}
