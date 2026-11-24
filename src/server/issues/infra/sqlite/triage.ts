import { and, count, eq, gte } from 'drizzle-orm';

import type { IssueArea, IssueKind, IssueLabel, IssuePriority } from '@socio/shared/issues/issue-types';

import type { TriageRepository, TriageRow } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { issueTriage } from './schema.js';

/** Automatic triage rows (CB-30): one per issue, never asked again. */
export class SqliteTriage extends SqliteRepository implements TriageRepository {
    async get(issueId: string): Promise<TriageRow | undefined> {
        return this.db.select().from(issueTriage).where(eq(issueTriage.issueId, issueId)).get();
    }

    async startedSince(since: number) {
        const row = await this.db
            .select({ n: count() })
            .from(issueTriage)
            .where(gte(issueTriage.createdAt, since))
            .get();
        return row?.n ?? 0;
    }

    insertPending(issueId: string, now: number) {
        return this.write('start triage', async () => {
            await this.db.insert(issueTriage).values({ issueId, state: 'pending', createdAt: now });
        });
    }

    propose(
        issueId: string,
        fields: {
            kind: IssueKind;
            area: IssueArea | null;
            priority: IssuePriority;
            labels: IssueLabel[];
            components: string[];
            reason: string;
            reasonAudience?: 'admins' | null;
        },
        commentId: string,
    ) {
        return this.write('propose triage', async () => {
            await this.db
                .update(issueTriage)
                .set({ state: 'proposed', ...fields, commentId })
                .where(and(eq(issueTriage.issueId, issueId), eq(issueTriage.state, 'pending')));
        });
    }

    fail(issueId: string, error: string) {
        return this.write('fail triage', async () => {
            await this.db
                .update(issueTriage)
                .set({ state: 'failed', error })
                .where(and(eq(issueTriage.issueId, issueId), eq(issueTriage.state, 'pending')));
        });
    }

    failPending(error: string) {
        return this.write('fail pending triage', async () => {
            const { changes } = await this.db
                .update(issueTriage)
                .set({ state: 'failed', error })
                .where(eq(issueTriage.state, 'pending'))
                .run();
            return Number(changes);
        });
    }

    decide(issueId: string, state: 'applied' | 'ignored', userId: string, now: number) {
        return this.write('decide triage', async () => {
            const { changes } = await this.db
                .update(issueTriage)
                .set({ state, decidedAt: now, decidedBy: userId })
                .where(and(eq(issueTriage.issueId, issueId), eq(issueTriage.state, 'proposed')))
                .run();
            return Number(changes) > 0;
        });
    }
}
