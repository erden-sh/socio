import { and, count, eq, isNull, sql } from 'drizzle-orm';

import type { VoteRepository } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { issueVotes } from './schema.js';

/** Upvotes (CB-83): one live vote per person per item. */
export class SqliteVotes extends SqliteRepository implements VoteRepository {
    private statements = (() => {
        const db = this.data.uow.executor();
        return {
            live: db
                .select({ id: issueVotes.id })
                .from(issueVotes)
                .where(
                    and(
                        eq(issueVotes.issueId, sql.placeholder('issueId')),
                        eq(issueVotes.userId, sql.placeholder('userId')),
                        isNull(issueVotes.withdrawnAt),
                    ),
                )
                .prepare(),
            counts: db
                .select({ issueId: issueVotes.issueId, n: count() })
                .from(issueVotes)
                .where(isNull(issueVotes.withdrawnAt))
                .groupBy(issueVotes.issueId)
                .prepare(),
            mine: db
                .select({ issueId: issueVotes.issueId })
                .from(issueVotes)
                .where(and(eq(issueVotes.userId, sql.placeholder('userId')), isNull(issueVotes.withdrawnAt)))
                .prepare(),
        };
    })();

    async live(issueId: string, userId: string) {
        this.data.uow.executor();
        return (await this.statements.live.get({ issueId, userId }))?.id;
    }

    insert(vote: { id: string; issueId: string; userId: string; dotId: string | null; createdAt: number }) {
        return this.write('cast vote', async () => {
            await this.db.insert(issueVotes).values(vote);
        });
    }

    withdraw(id: string, now: number) {
        return this.write('withdraw vote', async () => {
            await this.db.update(issueVotes).set({ withdrawnAt: now }).where(eq(issueVotes.id, id));
        });
    }

    async count(issueId: string) {
        const row = await this.db
            .select({ n: count() })
            .from(issueVotes)
            .where(and(eq(issueVotes.issueId, issueId), isNull(issueVotes.withdrawnAt)))
            .get();
        return row?.n ?? 0;
    }

    async counts() {
        this.data.uow.executor();
        return new Map((await this.statements.counts.all()).map((row) => [row.issueId, row.n]));
    }

    async mine(userId: string) {
        this.data.uow.executor();
        return new Set((await this.statements.mine.all({ userId })).map((row) => row.issueId));
    }
}
