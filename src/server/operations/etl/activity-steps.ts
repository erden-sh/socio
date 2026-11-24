import { listValue, type DuckDBConnection } from '@duckdb/node-api';

import type { EtlContext, EtlStep } from '../infra/duckdb/etl.js';
import { rows } from '../infra/duckdb/open.js';
import { sqliteActivitySource } from '../infra/sqlite/activity-source.js';

import { APPROVAL_DDL, MEMORY_DDL, REACTION_DDL, SPACE_WRITE_DDL } from './activity-schema.js';
import type { Keyset, SourcePage, SourceRevision } from './activity-source.js';
import { append } from './append.js';
import { ETL_BATCH } from './source-reader.js';

const DAY = 86_400_000;

/** Facts older than `factDays` go (0 keeps them), as the turns' do. */
async function trim(duck: DuckDBConnection, table: string, column: string, context: EtlContext) {
    const days = context.settings.factDays;
    if (days) {
        await duck.run(`DELETE FROM ${table} WHERE ${column} < $1`, [context.now - days * DAY]);
    }
}

function keyset(text: string | null | undefined): Keyset {
    try {
        const value = JSON.parse(text ?? '') as unknown;
        if (Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'string') {
            return [value[0], value[1]];
        }
    } catch {
        // From the start.
    }
    return [-1, ''];
}

/**
 * Approval events (CB-190), from `approval_audit` by `(createdAt, id)`:
 * append-only, so each batch appends the next rows with their request's
 * chat, for the approvals funnel and sessions' outcomes.
 */
export const approvalsStep: EtlStep = {
    source: 'approval_audit',
    ddl: [APPROVAL_DDL],
    async batch({ sqlite, duck, watermark, context }) {
        const from = keyset(watermark);
        const found = sqliteActivitySource(sqlite).approvalsAfter(from, ETL_BATCH);
        if (!found) {
            return { caughtUp: true };
        }
        // Appended once; a batch read again (it never is) replaces its rows.
        if (found.length) {
            await duck.run('DELETE FROM f_approval WHERE id IN (SELECT unnest($1))', [
                listValue(found.map((row) => row.id)),
            ]);
        }
        await append(
            duck,
            'f_approval',
            found.map((row) => [
                row.id,
                row.createdAt,
                row.requestId,
                row.threadId,
                row.dotId,
                row.userId,
                row.capability,
                row.event,
            ]),
        );
        await trim(duck, 'f_approval', 'happened_at', context);
        const last = found.at(-1);
        return {
            watermark: JSON.stringify(last ? [last.createdAt, last.id] : from),
            caughtUp: found.length < ETL_BATCH,
        };
    },
};

/** A revision's author: `dot:<id>` is a socio's page tool, else a person. */
const author = (id: string | null) =>
    id === null
        ? { kind: null, id: null }
        : id.startsWith('dot:')
          ? { kind: 'socio', id: id.slice(4) }
          : { kind: 'person', id };

/**
 * Who made each page with no chat whose author is still a person: a socio
 * when one of its chats owned by that person ran create_space_page while
 * the page was made. That tool makes the page for the chat's owner and
 * records no chat (`page-tools.ts`), and the call reaches `f_tool` only
 * with its turn, so this runs again whenever such calls arrive. A page
 * made inside two calls goes to the one that started last.
 */
async function creditToolPages(duck: DuckDBConnection) {
    await duck.run(`UPDATE f_space_write SET author_kind = 'socio',
      author_id = m.socio_id, thread_id = m.thread_id
    FROM (
      SELECT w.ref, c.socio_id, t.thread_id
      FROM f_space_write w
      JOIN d_chat c ON c.owner_id = w.author_id
      JOIN f_tool t ON t.thread_id = c.id AND t.tool = 'create_space_page'
        AND w.written_at BETWEEN t.started_at AND t.started_at + t.duration_ms
      WHERE w.kind = 'create' AND w.author_kind = 'person' AND w.thread_id IS NULL
      QUALIFY row_number() OVER (PARTITION BY w.ref ORDER BY t.started_at DESC, t.thread_id DESC) = 1
    ) m
    WHERE f_space_write.kind = 'create' AND f_space_write.ref = m.ref`);
}

/** What `creditToolPages` has seen of `f_tool`: it changes when calls arrive. */
async function toolPagesPrint(duck: DuckDBConnection) {
    const [row] = await rows<{ n: bigint | number; seq: bigint | number | null }>(
        duck,
        `SELECT count(*) AS n, max(run_seq) AS seq FROM f_tool WHERE tool = 'create_space_page'`,
    );
    return `${row?.n ?? 0}:${row?.seq ?? ''}`;
}

/**
 * Writes to Spaces (CB-190): pages made, by `(createdAt, id)`, and edits,
 * one per kept revision (`page_revisions` by `id`). Both append-only. A
 * page is a socio's when a person approved its draft (`page_reviews`) or
 * its create_space_page made it (`creditToolPages`); a person's otherwise,
 * with the chat they saved it from, if any.
 */
export const spaceWritesStep: EtlStep = {
    source: 'space_writes',
    ddl: [SPACE_WRITE_DDL],
    async batch({ sqlite, duck, watermark, context }) {
        let state: { revision: number; page: Keyset; tools: string } = {
            revision: 0,
            page: [-1, ''],
            tools: '',
        };
        try {
            const saved = JSON.parse(watermark ?? '') as {
                revision?: unknown;
                page?: unknown;
                tools?: unknown;
            };
            state = {
                revision: Number.isInteger(saved.revision) ? (saved.revision as number) : 0,
                page: keyset(JSON.stringify(saved.page)),
                tools: typeof saved.tools === 'string' ? saved.tools : '',
            };
        } catch {
            // From the start.
        }
        const reader = sqliteActivitySource(sqlite);
        let revisions: SourceRevision[] | null;
        let pages: SourcePage[] | null;
        sqlite.exec('BEGIN');
        try {
            revisions = reader.revisionsAfter(state.revision, ETL_BATCH);
            pages = reader.pagesAfter(state.page, ETL_BATCH);
        } finally {
            sqlite.exec('COMMIT');
        }
        if (!revisions && !pages) {
            return { caughtUp: true };
        }
        revisions ??= [];
        pages ??= [];
        const refs = [
            ...pages.map((page) => `create\u0000${page.id}`),
            ...revisions.map((revision) => `edit\u0000${revision.id}`),
        ];
        if (refs.length) {
            await duck.run(`DELETE FROM f_space_write WHERE concat(kind, chr(0), ref) IN (SELECT unnest($1))`, [
                listValue(refs),
            ]);
        }
        await append(duck, 'f_space_write', [
            ...pages.map((page) => {
                const bySocio = !!page.reviewed && page.sourceThreadId !== null && page.socioId !== null;
                return [
                    'create',
                    page.id,
                    page.createdAt,
                    page.spaceId,
                    page.id,
                    bySocio ? 'socio' : page.createdBy ? 'person' : null,
                    bySocio ? page.socioId : page.createdBy,
                    page.sourceThreadId,
                ];
            }),
            ...revisions.map((revision) => {
                const by = author(revision.authorId);
                return [
                    'edit',
                    String(revision.id),
                    revision.replacedAt,
                    revision.spaceId,
                    revision.pageId,
                    by.kind,
                    by.id,
                    null,
                ];
            }),
        ]);
        const tools = await toolPagesPrint(duck);
        if (pages.length || tools !== state.tools) {
            await creditToolPages(duck);
        }
        await trim(duck, 'f_space_write', 'written_at', context);
        const lastPage = pages.at(-1);
        return {
            watermark: JSON.stringify({
                revision: revisions.at(-1)?.id ?? state.revision,
                page: lastPage ? [lastPage.createdAt, lastPage.id] : state.page,
                tools,
            }),
            caughtUp: revisions.length < ETL_BATCH && pages.length < ETL_BATCH,
        };
    },
};

/**
 * People's reactions (CB-190): `message_reactions` is mutable (a removed
 * reaction is deleted), so it is read whole, only when its fingerprint
 * changed; the watermark is the fingerprint.
 */
export const reactionsStep: EtlStep = {
    source: 'message_reactions',
    ddl: [REACTION_DDL],
    async batch({ sqlite, duck, watermark, context }) {
        const reader = sqliteActivitySource(sqlite);
        const print = reader.reactionsPrint();
        if (print === null || print === watermark) {
            return { caughtUp: true };
        }
        const all = reader.reactions();
        await duck.run('DELETE FROM f_reaction');
        await append(
            duck,
            'f_reaction',
            all.map((row) => [row.threadId, row.messageId, row.userId, row.kind, row.createdAt]),
        );
        await trim(duck, 'f_reaction', 'reacted_at', context);
        return { watermark: print, caughtUp: true };
    },
};

/**
 * Memories made in chats (CB-190): mutable (proposed, then kept or
 * deleted), so read whole when their fingerprint changed. A kept one is
 * an outcome signal, at when it was confirmed (or made, when kept at once).
 */
export const memoriesStep: EtlStep = {
    source: 'memories',
    ddl: [MEMORY_DDL],
    async batch({ sqlite, duck, watermark, context }) {
        const reader = sqliteActivitySource(sqlite);
        const print = reader.memoriesPrint();
        if (print === null || print === watermark) {
            return { caughtUp: true };
        }
        const all = reader.memories();
        await duck.run('DELETE FROM f_memory');
        await append(
            duck,
            'f_memory',
            all.map((row) => [
                row.id,
                row.threadId,
                row.userId,
                row.status,
                row.confirmedAt ?? row.createdAt,
                row.deletedAt,
            ]),
        );
        await trim(duck, 'f_memory', 'kept_at', context);
        return { watermark: print, caughtUp: true };
    },
};

export const ACTIVITY_STEPS = [approvalsStep, spaceWritesStep, reactionsStep, memoriesStep];
