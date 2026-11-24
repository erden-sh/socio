import { and, asc, desc, eq, isNotNull, isNull, lt, or } from 'drizzle-orm';

import type { Attachment } from '../../contract.js';
import type { AttachmentBinding, AttachmentRepository } from '../../domain/repositories.js';

import { SqliteRepository, insertionOrder } from './base.js';
import { mediaAttachments as a } from './schema.js';

const live = isNull(a.deletedAt);

/** Chat attachments (CB-54), hidden and kept once deleted (CB-64). */
export class SqliteAttachments extends SqliteRepository implements AttachmentRepository {
    async byId(id: string): Promise<Attachment | undefined> {
        return this.db
            .select()
            .from(a)
            .where(and(eq(a.id, id), live))
            .get();
    }

    async withDeleted(id: string): Promise<Attachment | undefined> {
        return this.db.select().from(a).where(eq(a.id, id)).get();
    }

    async forThread(threadId: string): Promise<Attachment[]> {
        return this.db
            .select()
            .from(a)
            .where(and(eq(a.threadId, threadId), isNotNull(a.boundAt), live))
            .orderBy(asc(a.boundAt), asc(a.createdAt), insertionOrder(a));
    }

    async forFile(ownerUserId: string, fileId: string): Promise<Attachment[]> {
        return this.db
            .select()
            .from(a)
            .where(and(eq(a.fileId, fileId), eq(a.ownerUserId, ownerUserId), live))
            .orderBy(asc(a.createdAt), insertionOrder(a));
    }

    async kinds(ownerUserId: string) {
        return this.db
            .select({ fileId: a.fileId, kind: a.kind })
            .from(a)
            .where(and(eq(a.ownerUserId, ownerUserId), live))
            .orderBy(desc(a.createdAt), desc(insertionOrder(a)));
    }

    async carried(ownerUserId: string, threadId: string, fileId: string) {
        return !!this.db
            .select({ id: a.id })
            .from(a)
            .where(
                and(
                    eq(a.ownerUserId, ownerUserId),
                    eq(a.threadId, threadId),
                    eq(a.fileId, fileId),
                    isNotNull(a.boundAt),
                    live,
                ),
            )
            .limit(1)
            .get();
    }

    async pendingBefore(before: number): Promise<Attachment[]> {
        return this.db
            .select()
            .from(a)
            .where(and(isNull(a.boundAt), eq(a.source, 'web'), lt(a.createdAt, before), live))
            .orderBy(asc(a.createdAt), insertionOrder(a));
    }

    insert(attachment: Attachment) {
        return this.write('add attachment', async () => {
            await this.db.insert(a).values(attachment);
        });
    }

    bind(id: string, binding: AttachmentBinding, now: number) {
        return this.write('bind attachment', async () => {
            const { changes } = await this.db
                .update(a)
                .set({
                    threadId: binding.threadId,
                    dotId: binding.dotId,
                    messageId: binding.messageId,
                    boundAt: now,
                })
                .where(
                    and(
                        eq(a.id, id),
                        isNull(a.boundAt),
                        or(isNull(a.threadId), eq(a.threadId, binding.threadId)),
                        live,
                    ),
                );
            return Number(changes) > 0;
        });
    }

    removePending(id: string, by: string, now: number) {
        return this.write('remove pending attachment', async () => {
            const { changes } = await this.db
                .update(a)
                .set({ deletedAt: now, deletedBy: by })
                .where(and(eq(a.id, id), isNull(a.boundAt), live));
            return Number(changes) > 0;
        });
    }

    removeWithFile(ownerUserId: string, fileId: string, stamp: { at: number; by: string; with: string }) {
        return this.write('remove attachments with their file', async () => {
            await this.db
                .update(a)
                .set({
                    deletedAt: stamp.at,
                    deletedBy: stamp.by,
                    deletedWith: stamp.with,
                })
                .where(and(eq(a.fileId, fileId), eq(a.ownerUserId, ownerUserId), live));
        });
    }
}
