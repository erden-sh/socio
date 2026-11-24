import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import type { IssueComment } from '@socio/shared/issues/issue-types';

import type { CommentRepository } from '../../domain/repositories.js';

import { SqliteRepository, insertionOrder } from './base.js';
import { issueComments } from './schema.js';

export class SqliteComments extends SqliteRepository implements CommentRepository {
    private forIssueQuery = this.data.uow
        .executor()
        .select({
            id: issueComments.id,
            issueId: issueComments.issueId,
            authorKind: issueComments.authorKind,
            authorId: issueComments.authorId,
            body: issueComments.body,
            createdAt: issueComments.createdAt,
            editedAt: issueComments.editedAt,
        })
        .from(issueComments)
        .where(and(eq(issueComments.issueId, sql.placeholder('issueId')), isNull(issueComments.deletedAt)))
        .orderBy(asc(issueComments.createdAt), insertionOrder(issueComments))
        .prepare();

    async forIssue(issueId: string): Promise<IssueComment[]> {
        this.data.uow.executor();
        return this.forIssueQuery.all({ issueId });
    }

    insert(comment: IssueComment) {
        return this.write('add comment', async () => {
            await this.db.insert(issueComments).values({
                id: comment.id,
                issueId: comment.issueId,
                authorKind: comment.authorKind,
                authorId: comment.authorId,
                body: comment.body,
                createdAt: comment.createdAt,
            });
        });
    }

    edit(id: string, body: string, now: number) {
        return this.write('edit comment', async () => {
            await this.db.update(issueComments).set({ body, editedAt: now }).where(eq(issueComments.id, id));
        });
    }

    markDeleted(id: string, by: string, now: number) {
        return this.write('delete comment', async () => {
            await this.db.update(issueComments).set({ deletedAt: now, deletedBy: by }).where(eq(issueComments.id, id));
        });
    }

    markDeletedWith(issueId: string, by: string | null, parent: string, now: number) {
        return this.write('delete comments with issue', async () => {
            await this.db
                .update(issueComments)
                .set({ deletedAt: now, deletedBy: by, deletedWith: parent })
                .where(and(eq(issueComments.issueId, issueId), isNull(issueComments.deletedAt)));
        });
    }
}
