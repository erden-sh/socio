import { randomUUID } from 'node:crypto';

import { and, eq, isNull } from 'drizzle-orm';

import type { SessionEnd, SkillSession, SkillSessionsRepository } from '../../contract.js';

import { SqliteRepository } from './base.js';
import { chatSkillSessions as c } from './schema.js';

/** The `until-done` skill each person has on in each chat. */
export class SqliteSkillSessions extends SqliteRepository implements SkillSessionsRepository {
    private on(threadId: string, person: string) {
        return and(eq(c.threadId, threadId), eq(c.startedBy, person), isNull(c.endedAt));
    }

    private async close(threadId: string, person: string, reason: SessionEnd, now: number) {
        await this.db
            .update(c)
            .set({ endedAt: now, endedBy: person, endReason: reason })
            .where(this.on(threadId, person));
    }

    async active(threadId: string, person: string): Promise<SkillSession | undefined> {
        return this.db
            .select({
                skill: c.skill,
                startedAt: c.startedAt,
                startedBy: c.startedBy,
            })
            .from(c)
            .where(this.on(threadId, person))
            .get();
    }

    async start(threadId: string, skill: string, person: string, now = Date.now()) {
        await this.write('start skill session', async () => {
            await this.close(threadId, person, 'replaced', now);
            await this.db.insert(c).values({
                id: randomUUID(),
                threadId,
                skill,
                startedAt: now,
                startedBy: person,
            });
        });
        return { skill, startedAt: now, startedBy: person };
    }

    end(threadId: string, person: string, reason: SessionEnd, now = Date.now()) {
        // The read and the close in one unit of work, queued behind another
        // open on the shared connection (CB-110).
        return this.write('end skill session', async () => {
            const on = await this.active(threadId, person);
            if (on) {
                await this.close(threadId, person, reason, now);
            }
            return on;
        });
    }
}
