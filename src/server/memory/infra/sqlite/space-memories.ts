import { randomUUID } from 'node:crypto';

import { and, asc, count, desc, eq, inArray, lt, max as maxOf, or, sql } from 'drizzle-orm';

import type { SpaceMemoryStatus, SpaceMemoryVersion } from '@socio/shared/space-memory';

import type { NewSpaceMemory, SpaceMemoryRepository, SpaceMemoryResult } from '../../contract.js';
import { memoryKey } from '../../domain/rules.js';

import { SqliteRepository, insertionOrder } from './base.js';
import { spaceMemories } from './schema.js';

const NEWEST = [desc(spaceMemories.createdAt), sql`${insertionOrder(spaceMemories)} DESC`];

/** Out of use, so retention may delete it once it has been long enough. */
const ENDED: SpaceMemoryStatus[] = ['superseded', 'rejected', 'withdrawn'];

/** A Space's shared memory (CB-181), on the shared SQLite connection. */
export class SqliteSpaceMemories extends SqliteRepository implements SpaceMemoryRepository {
    async get(spaceId: string, id: string) {
        return this.db
            .select()
            .from(spaceMemories)
            .where(and(eq(spaceMemories.spaceId, spaceId), eq(spaceMemories.id, id)))
            .get();
    }

    async history(spaceId: string, entryId: string) {
        return this.db
            .select()
            .from(spaceMemories)
            .where(and(eq(spaceMemories.spaceId, spaceId), eq(spaceMemories.entryId, entryId)))
            .orderBy(...NEWEST)
            .all();
    }

    async list(spaceId: string, statuses: readonly SpaceMemoryStatus[], limit = 1_000) {
        if (!statuses.length) {
            return [];
        }
        return this.db
            .select()
            .from(spaceMemories)
            .where(and(eq(spaceMemories.spaceId, spaceId), inArray(spaceMemories.status, [...statuses])))
            .orderBy(...NEWEST)
            .limit(limit)
            .all();
    }

    async active(spaceIds: readonly string[]) {
        if (!spaceIds.length) {
            return [];
        }
        return this.db
            .select()
            .from(spaceMemories)
            .where(and(inArray(spaceMemories.spaceId, [...spaceIds]), eq(spaceMemories.status, 'active')))
            .orderBy(desc(spaceMemories.decidedAt), sql`${insertionOrder(spaceMemories)} DESC`)
            .all();
    }

    async count(spaceId: string, status: SpaceMemoryStatus) {
        const row = await this.db
            .select({ n: count() })
            .from(spaceMemories)
            .where(and(eq(spaceMemories.spaceId, spaceId), eq(spaceMemories.status, status)))
            .get();
        return row?.n ?? 0;
    }

    /**
     * The version with the same words (but for case and spaces) in `statuses`,
     * in use first, if one is.
     */
    private async same(spaceId: string, text: string, statuses: readonly SpaceMemoryStatus[] = ['active', 'proposed']) {
        const key = memoryKey(text);
        const rows = await this.list(spaceId, statuses);
        return (
            rows.find((row) => row.status === 'active' && memoryKey(row.text) === key) ??
            rows.find((row) => memoryKey(row.text) === key)
        );
    }

    /** The entry's version in use. */
    private inUse(spaceId: string, entryId: string) {
        return this.db
            .select()
            .from(spaceMemories)
            .where(
                and(
                    eq(spaceMemories.spaceId, spaceId),
                    eq(spaceMemories.entryId, entryId),
                    eq(spaceMemories.status, 'active'),
                ),
            )
            .get();
    }

    /** The number the entry's next approved version gets. */
    private async nextVersion(entryId: string) {
        const row = await this.db
            .select({ last: maxOf(spaceMemories.version) })
            .from(spaceMemories)
            .where(eq(spaceMemories.entryId, entryId))
            .get();
        return (row?.last ?? 0) + 1;
    }

    /**
     * Whether a change still applies: a new entry always does; a change
     * needs the entry's version in use to be the one it replaces.
     */
    private async current(spaceId: string, memory: Pick<NewSpaceMemory, 'entryId' | 'supersedes'>) {
        if (!memory.entryId) {
            return { applies: true, inUse: undefined };
        }
        const inUse = await this.inUse(spaceId, memory.entryId);
        return {
            applies: !!inUse && inUse.id === (memory.supersedes ?? null),
            inUse,
        };
    }

    propose(memory: NewSpaceMemory, now = Date.now()) {
        return this.write('propose space memory', async (): Promise<SpaceMemoryResult> => {
            const same = await this.same(memory.spaceId, memory.text);
            if (same) {
                return { ok: false, reason: 'duplicate', version: same };
            }
            const { applies } = await this.current(memory.spaceId, memory);
            if (!applies) {
                return { ok: false, reason: 'changed' };
            }
            const row: SpaceMemoryVersion = {
                id: randomUUID(),
                entryId: memory.entryId ?? randomUUID(),
                spaceId: memory.spaceId,
                version: null,
                text: memory.text,
                status: 'proposed',
                proposedBy: memory.proposedBy,
                dotId: memory.dotId ?? null,
                threadId: memory.threadId ?? null,
                supersedes: memory.entryId ? (memory.supersedes ?? null) : null,
                createdAt: now,
                decidedBy: null,
                decidedAt: null,
                endedBy: null,
                endedAt: null,
            };
            await this.db.insert(spaceMemories).values(row).run();
            return { ok: true, version: row };
        });
    }

    add(memory: NewSpaceMemory, by: string, now = Date.now()) {
        return this.write('add space memory', async (): Promise<SpaceMemoryResult> => {
            const same = await this.same(memory.spaceId, memory.text);
            if (same?.status === 'active') {
                return { ok: false, reason: 'duplicate', version: same };
            }
            // The same new entry waiting: the editor's adding it approves it,
            // with its proposer's provenance.
            if (same && !memory.entryId && !same.supersedes) {
                const version = await this.nextVersion(same.entryId);
                const stamps = { decidedBy: by, decidedAt: now };
                await this.db
                    .update(spaceMemories)
                    .set({ status: 'active', version, ...stamps })
                    .where(eq(spaceMemories.id, same.id))
                    .run();
                return {
                    ok: true,
                    version: { ...same, status: 'active', version, ...stamps },
                };
            }
            const { applies, inUse } = await this.current(memory.spaceId, memory);
            if (!applies) {
                return { ok: false, reason: 'changed' };
            }
            const entryId = memory.entryId ?? randomUUID();
            if (inUse) {
                await this.end(inUse.id, 'superseded', by, now);
            }
            const row: SpaceMemoryVersion = {
                id: randomUUID(),
                entryId,
                spaceId: memory.spaceId,
                version: await this.nextVersion(entryId),
                text: memory.text,
                status: 'active',
                proposedBy: memory.proposedBy,
                dotId: memory.dotId ?? null,
                threadId: memory.threadId ?? null,
                supersedes: inUse?.id ?? null,
                createdAt: now,
                decidedBy: by,
                decidedAt: now,
                endedBy: null,
                endedAt: null,
            };
            await this.db.insert(spaceMemories).values(row).run();
            return { ok: true, version: row };
        });
    }

    private async end(id: string, status: 'superseded' | 'retired' | 'withdrawn', by: string, now: number) {
        await this.db
            .update(spaceMemories)
            .set({ status, endedBy: by, endedAt: now })
            .where(eq(spaceMemories.id, id))
            .run();
    }

    approve(spaceId: string, id: string, by: string, options: { text?: string } = {}, now = Date.now()) {
        return this.write('approve space memory', async (): Promise<SpaceMemoryResult> => {
            const row = await this.get(spaceId, id);
            if (!row) {
                return { ok: false, reason: 'not_found' };
            }
            if (row.status !== 'proposed') {
                return { ok: false, reason: 'not_waiting', version: row };
            }
            const isChange = !!row.supersedes;
            const { applies, inUse } = await this.current(spaceId, {
                entryId: isChange ? row.entryId : undefined,
                supersedes: row.supersedes,
            });
            if (!applies) {
                return { ok: false, reason: 'changed', version: row };
            }
            const text = options.text ?? row.text;
            const same = await this.same(spaceId, text, ['active']);
            if (same) {
                return { ok: false, reason: 'duplicate', version: same };
            }
            if (inUse) {
                await this.end(inUse.id, 'superseded', by, now);
            }
            const version = await this.nextVersion(row.entryId);
            await this.db
                .update(spaceMemories)
                .set({
                    status: 'active',
                    text,
                    version,
                    decidedBy: by,
                    decidedAt: now,
                })
                .where(eq(spaceMemories.id, id))
                .run();
            return {
                ok: true,
                version: {
                    ...row,
                    status: 'active',
                    text,
                    version,
                    decidedBy: by,
                    decidedAt: now,
                },
            };
        });
    }

    close(spaceId: string, id: string, by: string, status: 'rejected' | 'withdrawn', now = Date.now()) {
        return this.write(`${status} space memory`, async (): Promise<SpaceMemoryResult> => {
            const row = await this.get(spaceId, id);
            if (!row) {
                return { ok: false, reason: 'not_found' };
            }
            if (row.status !== 'proposed') {
                return { ok: false, reason: 'not_waiting', version: row };
            }
            const stamps = status === 'rejected' ? { decidedBy: by, decidedAt: now } : { endedBy: by, endedAt: now };
            await this.db
                .update(spaceMemories)
                .set({ status, ...stamps })
                .where(eq(spaceMemories.id, id))
                .run();
            return { ok: true, version: { ...row, status, ...stamps } };
        });
    }

    retire(spaceId: string, entryId: string, by: string, now = Date.now()) {
        return this.write('retire space memory', async (): Promise<SpaceMemoryResult> => {
            const inUse = await this.inUse(spaceId, entryId);
            if (!inUse) {
                return { ok: false, reason: 'not_found' };
            }
            await this.end(inUse.id, 'retired', by, now);
            // What waited to change it goes with it.
            await this.db
                .update(spaceMemories)
                .set({ status: 'rejected', decidedBy: by, decidedAt: now })
                .where(
                    and(
                        eq(spaceMemories.spaceId, spaceId),
                        eq(spaceMemories.entryId, entryId),
                        eq(spaceMemories.status, 'proposed'),
                    ),
                )
                .run();
            return {
                ok: true,
                version: { ...inUse, status: 'retired', endedBy: by, endedAt: now },
            };
        });
    }

    remove(spaceId: string, entryId: string) {
        return this.write('delete space memory', async () => {
            const rows = await this.history(spaceId, entryId);
            if (!rows.length) {
                return { ok: false as const, reason: 'not_found' as const };
            }
            if (rows.some((row) => row.status === 'active')) {
                return { ok: false as const, reason: 'in_use' as const };
            }
            const { changes } = await this.db
                .delete(spaceMemories)
                .where(and(eq(spaceMemories.spaceId, spaceId), eq(spaceMemories.entryId, entryId)))
                .run();
            return { ok: true as const, deleted: Number(changes) };
        });
    }

    expire(before: number, max = 1_000) {
        return this.write('expire space memory', async () => {
            // Retired entries, whole: every version of each.
            const retired = this.db
                .select({ entryId: spaceMemories.entryId })
                .from(spaceMemories)
                .where(and(eq(spaceMemories.status, 'retired'), lt(spaceMemories.endedAt, before)))
                .orderBy(asc(spaceMemories.endedAt))
                .limit(max);
            let deleted = Number(
                (
                    await this.db
                        .delete(spaceMemories)
                        .where(
                            and(
                                inArray(spaceMemories.entryId, retired),
                                sql`NOT EXISTS (SELECT 1 FROM space_memories AS live WHERE live.entryId = ${spaceMemories.entryId} AND live.status = 'active')`,
                            ),
                        )
                        .run()
                ).changes,
            );
            if (deleted >= max) {
                return deleted;
            }
            // Versions out of use, and proposals that waited too long.
            const old = this.db
                .select({ id: spaceMemories.id })
                .from(spaceMemories)
                .where(
                    or(
                        and(
                            inArray(spaceMemories.status, ENDED),
                            lt(
                                sql`COALESCE(${spaceMemories.endedAt}, ${spaceMemories.decidedAt}, ${spaceMemories.createdAt})`,
                                before,
                            ),
                        ),
                        and(eq(spaceMemories.status, 'proposed'), lt(spaceMemories.createdAt, before)),
                    ),
                )
                .orderBy(asc(spaceMemories.createdAt))
                .limit(max - deleted);
            deleted += Number(
                (await this.db.delete(spaceMemories).where(inArray(spaceMemories.id, old)).run()).changes,
            );
            return deleted;
        });
    }
}
