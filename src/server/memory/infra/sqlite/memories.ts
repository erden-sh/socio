import { randomUUID } from 'node:crypto';

import { and, count, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';

import type { MemoryItem } from '@socio/shared/memory';

import type { MemoryPatch, MemoryRepository, NewMemory, StoredMemory } from '../../contract.js';
import { memoryKey } from '../../domain/rules.js';

import { SqliteRepository, insertionOrder } from './base.js';
import { memories } from './schema.js';

const COLUMNS = {
    id: memories.id,
    text: memories.text,
    createdAt: memories.createdAt,
    status: memories.status,
    source: memories.source,
    shareable: memories.shareable,
    dotId: memories.dotId,
    threadId: memories.threadId,
    updatedAt: memories.updatedAt,
    confirmedAt: memories.confirmedAt,
};

type Row = Pick<typeof memories.$inferSelect, keyof typeof COLUMNS>;

const itemOf = (row: Row): MemoryItem => ({
    id: row.id,
    text: row.text,
    createdAt: row.createdAt,
    status: row.status,
    source: row.source,
    shareable: row.shareable,
    dotId: row.dotId,
    threadId: row.threadId,
    updatedAt: row.updatedAt ?? row.createdAt,
    confirmedAt: row.confirmedAt,
});

const NEWEST = [desc(memories.createdAt), sql`${insertionOrder(memories)} DESC`];
const owned = (...where: SQL[]) =>
    and(eq(memories.userId, sql.placeholder('userId')), isNull(memories.deletedAt), ...where);

/** A person's memories (CB-106), on the shared SQLite connection. */
export class SqliteMemories extends SqliteRepository implements MemoryRepository {
    private statements = (() => {
        const db = this.data.uow.executor();
        const active = eq(memories.status, 'active');
        return {
            list: db
                .select(COLUMNS)
                .from(memories)
                .where(owned())
                .orderBy(...NEWEST)
                .prepare(),
            active: db
                .select(COLUMNS)
                .from(memories)
                .where(owned(active))
                .orderBy(...NEWEST)
                .prepare(),
            shareable: db
                .select(COLUMNS)
                .from(memories)
                .where(owned(active, eq(memories.shareable, true)))
                .orderBy(...NEWEST)
                .prepare(),
            one: db
                .select(COLUMNS)
                .from(memories)
                .where(owned(eq(memories.id, sql.placeholder('id'))))
                .prepare(),
            waiting: db
                .select({ n: count() })
                .from(memories)
                .where(owned(eq(memories.status, 'proposed')))
                .prepare(),
        };
    })();

    async list(userId: string) {
        this.data.uow.executor();
        return (await this.statements.list.all({ userId })).map(itemOf);
    }

    async active(userId: string, options: { shareableOnly?: boolean } = {}) {
        this.data.uow.executor();
        const query = options.shareableOnly ? this.statements.shareable : this.statements.active;
        return (await query.all({ userId })).map(itemOf);
    }

    async get(id: string, userId: string) {
        this.data.uow.executor();
        const row = await this.statements.one.get({ id, userId });
        return row && itemOf(row);
    }

    async withDeleted(id: string): Promise<StoredMemory | undefined> {
        const row = await this.db
            .select({
                ...COLUMNS,
                userId: memories.userId,
                deletedAt: memories.deletedAt,
                deletedBy: memories.deletedBy,
            })
            .from(memories)
            .where(eq(memories.id, id))
            .get();
        return (
            row && {
                ...itemOf(row),
                userId: row.userId,
                deletedAt: row.deletedAt,
                deletedBy: row.deletedBy,
            }
        );
    }

    add(memory: NewMemory, now = Date.now()) {
        return this.write('add memory', async () => {
            const own = memory.source === 'person';
            // Through a socio: proposed, or asked of it by the person (CB-172).
            if (!own || memory.dotId) {
                const key = memoryKey(memory.text);
                const same = (await this.list(memory.userId)).find((item) => memoryKey(item.text) === key);
                if (same) {
                    return own && same.status === 'proposed'
                        ? ((await this.approve(same.id, memory.userId, now)) ?? same)
                        : same;
                }
            }
            const id = randomUUID();
            await this.db.insert(memories).values({
                id,
                text: memory.text,
                createdAt: now,
                status: own ? 'active' : 'proposed',
                source: memory.source,
                shareable: !!memory.shareable,
                dotId: memory.dotId ?? null,
                threadId: memory.threadId ?? null,
                updatedAt: now,
                confirmedAt: own ? now : null,
                userId: memory.userId,
            });
            return (await this.get(id, memory.userId))!;
        });
    }

    update(id: string, userId: string, patch: MemoryPatch, now = Date.now()) {
        return this.write('update memory', async () => {
            const current = await this.get(id, userId);
            if (!current) {
                return undefined;
            }
            await this.db
                .update(memories)
                .set({
                    text: patch.text ?? current.text,
                    shareable: patch.shareable ?? current.shareable,
                    updatedAt: now,
                })
                .where(this.mine(id, userId));
            return this.get(id, userId);
        });
    }

    approve(id: string, userId: string, now = Date.now()) {
        return this.write('approve memory', async () => {
            await this.db
                .update(memories)
                .set({ status: 'active', confirmedAt: now, updatedAt: now })
                .where(this.mine(id, userId, eq(memories.status, 'proposed')));
            return this.get(id, userId);
        });
    }

    confirm(id: string, userId: string, now = Date.now()) {
        return this.write('confirm memory', async () => {
            await this.db
                .update(memories)
                .set({ confirmedAt: now })
                .where(this.mine(id, userId, eq(memories.status, 'active')));
            return this.get(id, userId);
        });
    }

    forget(id: string, userId: string, now = Date.now()) {
        return this.write('forget memory', async () => {
            const { changes } = await this.db
                .update(memories)
                .set({ deletedAt: now, deletedBy: userId })
                .where(this.mine(id, userId))
                .run();
            return Number(changes) > 0;
        });
    }

    async waiting(userId: string) {
        this.data.uow.executor();
        return (await this.statements.waiting.get({ userId }))?.n ?? 0;
    }

    assignUnowned(userId: string) {
        return this.write('assign unowned memories', async () => {
            const { changes } = await this.db.update(memories).set({ userId }).where(isNull(memories.userId)).run();
            return Number(changes);
        });
    }

    /** The person's live memory `id`, and whatever else is asked. */
    private mine(id: string, userId: string, ...where: SQL[]) {
        return and(eq(memories.id, id), eq(memories.userId, userId), isNull(memories.deletedAt), ...where);
    }
}
