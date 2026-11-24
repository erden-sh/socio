import { randomUUID } from 'node:crypto';

import { and, asc, count, desc, eq, inArray, lt, ne, sql } from 'drizzle-orm';

import type { Episode } from '@socio/shared/memory';
import { rankByWords } from '@socio/shared/text/rank-words';

import type { EpisodeCapture, EpisodeRepository } from '../../contract.js';
import { EPISODES_SEARCHED, factEpisode, summaryEpisode } from '../../domain/rules.js';

import { SqliteRepository, insertionOrder } from './base.js';
import { memoryEpisodes } from './schema.js';

const COLUMNS = {
    id: memoryEpisodes.id,
    kind: memoryEpisodes.kind,
    label: memoryEpisodes.label,
    text: memoryEpisodes.text,
    dotId: memoryEpisodes.dotId,
    threadId: memoryEpisodes.threadId,
    occurredAt: memoryEpisodes.occurredAt,
    createdAt: memoryEpisodes.createdAt,
};

/** Newest first; one fold's, at the same time, in the order it pinned them. */
const NEWEST = [desc(memoryEpisodes.occurredAt), sql`${insertionOrder(memoryEpisodes)} ASC`];

/** A person's episodes (CB-180), on the shared SQLite connection. */
export class SqliteEpisodes extends SqliteRepository implements EpisodeRepository {
    capture(capture: EpisodeCapture, now = Date.now()) {
        const at = capture.occurredAt ?? now;
        const rows = [
            ...capture.facts.flatMap((fact) => {
                const episode = factEpisode(fact);
                return episode ? [{ ...episode, kind: 'fact' as const }] : [];
            }),
            ...(capture.summary
                ? [summaryEpisode(capture.summary)].flatMap((episode) =>
                      episode ? [{ ...episode, kind: 'summary' as const }] : [],
                  )
                : []),
        ];
        if (!rows.length) {
            return Promise.resolve(0);
        }
        return this.write('capture episodes', async () => {
            let written = 0;
            for (const row of rows) {
                const { changes } = await this.db
                    .insert(memoryEpisodes)
                    .values({
                        id: randomUUID(),
                        userId: capture.userId,
                        threadId: capture.threadId,
                        dotId: capture.dotId ?? null,
                        kind: row.kind,
                        label: row.label,
                        key: row.key,
                        text: row.text,
                        occurredAt: at,
                        createdAt: now,
                    })
                    .onConflictDoUpdate({
                        target: [
                            memoryEpisodes.userId,
                            memoryEpisodes.threadId,
                            memoryEpisodes.kind,
                            memoryEpisodes.key,
                        ],
                        // Pinned again (or the summary moved on): the newer words and time.
                        set: {
                            text: row.text,
                            label: row.label,
                            occurredAt: sql`MAX(${memoryEpisodes.occurredAt}, ${at})`,
                        },
                    })
                    .run();
                written += Number(changes);
            }
            return written;
        });
    }

    async list(
        userId: string,
        options: {
            query?: string;
            limit?: number;
            kind?: Episode['kind'];
            excludeThreadId?: string;
        } = {},
    ): Promise<Episode[]> {
        const where = and(
            eq(memoryEpisodes.userId, userId),
            options.kind ? eq(memoryEpisodes.kind, options.kind) : undefined,
            options.excludeThreadId ? ne(memoryEpisodes.threadId, options.excludeThreadId) : undefined,
        );
        const query = options.query?.trim();
        const limit = options.limit ?? EPISODES_SEARCHED;
        if (!query) {
            return this.db
                .select(COLUMNS)
                .from(memoryEpisodes)
                .where(where)
                .orderBy(...NEWEST)
                .limit(limit)
                .all();
        }
        const rows = await this.db
            .select(COLUMNS)
            .from(memoryEpisodes)
            .where(where)
            .orderBy(...NEWEST)
            .limit(EPISODES_SEARCHED)
            .all();
        // On a tie `rankByWords` puts the later index first: the newer.
        const ordered = [...rows].reverse();
        return rankByWords(
            query,
            ordered.map((row) => row.text),
        )
            .slice(0, limit)
            .map((index) => ordered[index]);
    }

    async count(userId: string) {
        const row = await this.db
            .select({ n: count() })
            .from(memoryEpisodes)
            .where(eq(memoryEpisodes.userId, userId))
            .get();
        return row?.n ?? 0;
    }

    remove(id: string, userId: string) {
        return this.write('delete episode', async () => {
            const { changes } = await this.db
                .delete(memoryEpisodes)
                .where(and(eq(memoryEpisodes.id, id), eq(memoryEpisodes.userId, userId)))
                .run();
            return Number(changes) > 0;
        });
    }

    removeAll(userId: string, options: { threadId?: string } = {}) {
        return this.write('delete episodes', async () => {
            const { changes } = await this.db
                .delete(memoryEpisodes)
                .where(
                    and(
                        eq(memoryEpisodes.userId, userId),
                        options.threadId ? eq(memoryEpisodes.threadId, options.threadId) : undefined,
                    ),
                )
                .run();
            return Number(changes);
        });
    }

    expire(before: number, max = 1_000) {
        return this.write('expire episodes', async () => {
            const old = this.db
                .select({ id: memoryEpisodes.id })
                .from(memoryEpisodes)
                .where(lt(memoryEpisodes.occurredAt, before))
                .orderBy(asc(memoryEpisodes.occurredAt))
                .limit(max);
            const { changes } = await this.db.delete(memoryEpisodes).where(inArray(memoryEpisodes.id, old)).run();
            return Number(changes);
        });
    }
}
