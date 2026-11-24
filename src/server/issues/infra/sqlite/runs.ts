import { asc, eq } from 'drizzle-orm';

import type { IssueRunRepository, IssueRunRow } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { issueRuns } from './schema.js';

/** Items' links to the turns they were filed from (CB-194). */
export class SqliteIssueRuns extends SqliteRepository implements IssueRunRepository {
    link(row: IssueRunRow) {
        return this.write('link issue to run', async () => {
            await this.db.insert(issueRuns).values(row).onConflictDoNothing();
        });
    }

    async forIssue(issueId: string): Promise<IssueRunRow[]> {
        return this.db
            .select()
            .from(issueRuns)
            .where(eq(issueRuns.issueId, issueId))
            .orderBy(asc(issueRuns.createdAt), asc(issueRuns.runId));
    }
}
