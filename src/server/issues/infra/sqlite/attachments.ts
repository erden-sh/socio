import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';

import type { IssueAttachment } from '@socio/shared/issues/issue-types';

import type { StoredAttachment } from '../../contract.js';
import type { AttachmentRepository } from '../../domain/repositories.js';

import { SqliteRepository, insertionOrder } from './base.js';
import { issueAttachments } from './schema.js';

/** Everything but the bytes. */
const meta = {
    id: issueAttachments.id,
    issueId: issueAttachments.issueId,
    commentId: issueAttachments.commentId,
    name: issueAttachments.name,
    mediaType: issueAttachments.mediaType,
    size: issueAttachments.size,
    sha256: issueAttachments.sha256,
    uploaderId: issueAttachments.uploaderId,
    createdAt: issueAttachments.createdAt,
};

export class SqliteAttachments extends SqliteRepository implements AttachmentRepository {
    private forIssueQuery = this.data.uow
        .executor()
        .select(meta)
        .from(issueAttachments)
        .where(and(eq(issueAttachments.issueId, sql.placeholder('issueId')), isNull(issueAttachments.deletedAt)))
        .orderBy(asc(issueAttachments.createdAt), insertionOrder(issueAttachments))
        .prepare();

    async forIssue(issueId: string): Promise<IssueAttachment[]> {
        this.data.uow.executor();
        return this.forIssueQuery.all({ issueId });
    }

    async byId(id: string): Promise<StoredAttachment | undefined> {
        return this.db
            .select({ ...meta, data: issueAttachments.data })
            .from(issueAttachments)
            .where(and(eq(issueAttachments.id, id), isNull(issueAttachments.deletedAt)))
            .get();
    }

    async withDeleted(id: string) {
        return this.db.select().from(issueAttachments).where(eq(issueAttachments.id, id)).get();
    }

    async liveCount(issueId: string) {
        const row = await this.db
            .select({ n: count() })
            .from(issueAttachments)
            .where(and(eq(issueAttachments.issueId, issueId), isNull(issueAttachments.deletedAt)))
            .get();
        return row?.n ?? 0;
    }

    insert(file: StoredAttachment) {
        return this.write('add attachment', async () => {
            await this.db.insert(issueAttachments).values(file);
            const saved: IssueAttachment = {
                id: file.id,
                issueId: file.issueId,
                commentId: file.commentId,
                name: file.name,
                mediaType: file.mediaType,
                size: file.size,
                sha256: file.sha256,
                uploaderId: file.uploaderId,
                createdAt: file.createdAt,
            };
            return saved;
        });
    }

    markDeleted(id: string, by: string, now: number) {
        return this.write('delete attachment', async () => {
            await this.db
                .update(issueAttachments)
                .set({ deletedAt: now, deletedBy: by })
                .where(eq(issueAttachments.id, id));
        });
    }

    markDeletedWith(
        owner: { issueId: string } | { commentId: string },
        by: string | null,
        parent: string,
        now: number,
    ) {
        return this.write('delete attachments with their parent', async () => {
            await this.db
                .update(issueAttachments)
                .set({ deletedAt: now, deletedBy: by, deletedWith: parent })
                .where(
                    and(
                        'issueId' in owner
                            ? eq(issueAttachments.issueId, owner.issueId)
                            : eq(issueAttachments.commentId, owner.commentId),
                        isNull(issueAttachments.deletedAt),
                    ),
                );
        });
    }
}
