import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { brotliCompressSync, brotliDecompressSync, constants as zlib } from 'node:zlib';

import { z } from 'zod';

import type { SchemaSet } from '@socio/data/migrate';
import { sqliteData } from '@socio/data/open';
import { LIVE, deletedWith, live, unstamped } from '@socio/data/soft-delete';
import { PageError } from '@socio/foundation/pages/page-error';
import {
    coverUrl,
    pageExcerpt,
    type Page,
    type PageTitle,
    type PageTreeItem,
    type ReviewedPage,
} from '@socio/shared/pages/page-library';
import {
    RADAR_LIMIT,
    RADAR_OPEN_MARKERS,
    RADAR_STALE_DAYS,
    type RadarEntry,
    type RadarOpenEntry,
    type SpaceRadar,
} from '@socio/shared/pages/page-radar';
import { pageReviewSchema, type PageReviewDraft } from '@socio/shared/pages/page-review';
import type { PageRevisionStats } from '@socio/shared/pages/page-search';
import { pageText } from '@socio/shared/pages/page-text';
import { spaceItemKey, type SpacePageItem } from '@socio/shared/spaces/space-items';

import {
    type CoverView,
    type PageLink,
    type PageLinkKind,
    type PageRevision,
    type PagesGone,
    type PageStoreShape,
    type PageTag,
    type SearchOptions,
} from './contract.js';
import type { PageRepositories } from './domain/repositories.js';
import { sqlitePageRepositories } from './infra/sqlite/index.js';
import { freshnessOf, PageSearch } from './page-search.js';

export const pageInput = z
    .object({
        title: z.string().trim().min(1).max(160),
        content: z.string().max(100000).default(''),
        parentId: z.string().min(1).nullable().default(null),
        sourceUrl: z.string().max(2048).optional(),
        sourceTitle: z.string().max(300).optional(),
        // CB-426: a folder is a page shown as a container of pages; its body is hidden, not dropped.
        folder: z
            .boolean()
            .default(false)
            .describe('Make it a folder: a page shown as a container of pages, its body hidden (not deleted).'),
    })
    .strict();
export const pagePatch = z
    .object({
        title: z.string().trim().min(1).max(160).optional(),
        content: z.string().max(100000).optional(),
        parentId: z.string().min(1).nullable().optional(),
        expectedRevision: z.number().int().positive(),
    })
    .strict();

/**
 * Space pages, review receipts and page conversations. The baseline is the
 * former constructor DDL; the page_threads rebuild dropped its own
 * BEGIN/COMMIT, because every migration runs in a transaction.
 */
export const pagesSchema: SchemaSet = {
    id: 'pages',
    migrations: [
        {
            version: 1,
            name: 'baseline',
            // Recorded before the formatting pass of v0.30.0 (dba875569), which
            // changed only the source's form: same DDL and data.
            formerChecksums: ['0ab7c98204a7306e'],
            baseline: true,
            up: (db) => {
                db.exec(
                    'CREATE TABLE IF NOT EXISTS page_reviews(threadId TEXT NOT NULL, toolCallId TEXT NOT NULL, pageId TEXT NOT NULL, spaceId TEXT NOT NULL, draft TEXT, PRIMARY KEY(threadId,toolCallId))',
                );
                if (
                    !db
                        .prepare('PRAGMA table_info(page_reviews)')
                        .all()
                        .some((row) => row.name === 'draft')
                ) {
                    db.exec('ALTER TABLE page_reviews ADD COLUMN draft TEXT');
                }
                db.exec(`CREATE TABLE IF NOT EXISTS pages(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, parentId TEXT, title TEXT NOT NULL, content TEXT NOT NULL, revision INTEGER NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, sourceThreadId TEXT);
 CREATE TABLE IF NOT EXISTS page_threads(pageId TEXT NOT NULL,dotId TEXT NOT NULL,userId TEXT NOT NULL,threadId TEXT NOT NULL UNIQUE,ready INTEGER NOT NULL DEFAULT 0, leaseUntil INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(pageId,dotId,userId));`);
                if (
                    !db
                        .prepare('PRAGMA table_info(page_threads)')
                        .all()
                        .some((row) => row.name === 'leaseUntil')
                ) {
                    db.exec('ALTER TABLE page_threads ADD COLUMN leaseUntil INTEGER NOT NULL DEFAULT 0');
                }
                // Page conversations became per user: rebuild the table keyed by
                // (page, Dot, user), taking each row's user from its thread's owner.
                if (
                    !db
                        .prepare('PRAGMA table_info(page_threads)')
                        .all()
                        .some((row) => row.name === 'userId')
                ) {
                    db.exec(`CREATE TABLE page_threads_v2(pageId TEXT NOT NULL,dotId TEXT NOT NULL,userId TEXT NOT NULL,threadId TEXT NOT NULL UNIQUE,ready INTEGER NOT NULL DEFAULT 0, leaseUntil INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(pageId,dotId,userId));
        INSERT INTO page_threads_v2 SELECT p.pageId, p.dotId, COALESCE(t.ownerId, ''), p.threadId, p.ready, p.leaseUntil FROM page_threads p LEFT JOIN thread_bindings t ON t.id = p.threadId;
        DROP TABLE page_threads;
        ALTER TABLE page_threads_v2 RENAME TO page_threads;`);
                }
            },
        },
        {
            // Pages can be deleted: who created a page decides who may delete it
            // besides admins (taken from the source conversation's owner where
            // there is one), and a deleted page leaves a tombstone so links to it
            // say so.
            version: 2,
            name: 'page creators and deletions',
            up: `ALTER TABLE pages ADD COLUMN createdBy TEXT;
        UPDATE pages SET createdBy=(SELECT ownerId FROM thread_bindings WHERE thread_bindings.id=pages.sourceThreadId) WHERE sourceThreadId IS NOT NULL;
        CREATE TABLE page_deletions(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, deletedAt INTEGER NOT NULL);`,
        },
        {
            // CB-64: deleting a page hides it and keeps the row; its subpages are
            // stamped with `deletedWith` page:<id>. `page_deletions` stays for
            // pages deleted before this; new deletes don't write it.
            version: 3,
            name: 'soft delete',
            up: `ALTER TABLE pages ADD COLUMN deletedAt INTEGER;
        ALTER TABLE pages ADD COLUMN deletedBy TEXT;
        ALTER TABLE pages ADD COLUMN deletedWith TEXT;`,
        },
        {
            // A Space's live pages without scanning the table. Partial, as every
            // Space read filters `deletedAt IS NULL` (LIVE): deleted pages stay
            // out of the index. One in `list`/`titles` order (also counts), one
            // in `recent` order, so neither query sorts.
            version: 4,
            name: 'space page indexes',
            up: `CREATE INDEX pages_space_live ON pages(spaceId, createdAt, id) WHERE deletedAt IS NULL;
        CREATE INDEX pages_space_recent ON pages(spaceId, updatedAt DESC, title) WHERE deletedAt IS NULL;`,
        },
        {
            // Server page search. `page_search`
            // holds each live page's title and plain text (pageText) under its
            // own integer key, which VACUUM never renumbers, with its Space (a
            // move updates it, CB-142) so a one-Space search skips the others'
            // rows without reading `pages`; two FTS5 indexes
            // read it as their external content: words (unicode61, prefix
            // indexes) and text inside words (trigram). The triggers are the
            // FTS5 docs' external-content triggers and call no app function.
            // `page_use` is each page's freshness from use; `page_use_days`
            // counts one use per person, page and day and is pruned after a few
            // days. `page_search_daily` is the timing rollup: counts and a
            // histogram per day, never query text. Filled from the live pages.
            version: 5,
            name: 'page search',
            // Recorded before the formatting pass of v0.30.0 (dba875569), which
            // changed only the source's form: same DDL and data.
            formerChecksums: ['a831be64fd61f5f4'],
            up: (db) => {
                db.exec(`CREATE TABLE page_search(id INTEGER PRIMARY KEY, pageId TEXT NOT NULL UNIQUE, spaceId TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL);
          CREATE INDEX page_search_space ON page_search(spaceId);
          CREATE VIRTUAL TABLE page_search_fts USING fts5(title, body, content='page_search', content_rowid='id', tokenize='unicode61 remove_diacritics 2', prefix='2 3');
          CREATE VIRTUAL TABLE page_search_tri USING fts5(title, body, content='page_search', content_rowid='id', tokenize='trigram remove_diacritics 1');
          CREATE VIRTUAL TABLE page_search_vocab USING fts5vocab(page_search_fts, row);
          CREATE TRIGGER page_search_ai AFTER INSERT ON page_search BEGIN
            INSERT INTO page_search_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
            INSERT INTO page_search_tri(rowid, title, body) VALUES (new.id, new.title, new.body);
          END;
          CREATE TRIGGER page_search_ad AFTER DELETE ON page_search BEGIN
            INSERT INTO page_search_fts(page_search_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
            INSERT INTO page_search_tri(page_search_tri, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
          END;
          CREATE TRIGGER page_search_au AFTER UPDATE ON page_search BEGIN
            INSERT INTO page_search_fts(page_search_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
            INSERT INTO page_search_tri(page_search_tri, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
            INSERT INTO page_search_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
            INSERT INTO page_search_tri(rowid, title, body) VALUES (new.id, new.title, new.body);
          END;
          CREATE TABLE page_use(pageId TEXT PRIMARY KEY, score REAL NOT NULL, scoredAt INTEGER NOT NULL, usedAt INTEGER NOT NULL);
          CREATE TABLE page_use_days(pageId TEXT NOT NULL, userId TEXT NOT NULL, day INTEGER NOT NULL, PRIMARY KEY(pageId, userId, day));
          CREATE INDEX page_use_days_day ON page_use_days(day);
          CREATE TABLE page_search_daily(day TEXT PRIMARY KEY, queries INTEGER NOT NULL, empty INTEGER NOT NULL, corrected INTEGER NOT NULL, trigram INTEGER NOT NULL, maxMs REAL NOT NULL, histogram TEXT NOT NULL, sizes TEXT);`);
                const insert = db.prepare('INSERT INTO page_search(pageId, spaceId, title, body) VALUES (?, ?, ?, ?)');
                for (const row of db
                    .prepare(`SELECT id, spaceId, title, content FROM pages WHERE ${LIVE} ORDER BY createdAt, id`)
                    .all()) {
                    insert.run(String(row.id), String(row.spaceId), String(row.title), pageText(String(row.content)));
                }
            },
        },
        {
            // An edit that changes a page's title or body keeps the state it
            // replaced. `revision` is the page's revision number of that state,
            // `createdAt` when it was saved (the page's `updatedAt` then),
            // `replacedAt` when the edit replaced it, and `authorId` who made
            // that edit (a user id, or `dot:<id>` for a Dot's page tool). Saves
            // by the same author within REVISION_FOLD_MS of the latest revision
            // add none. Never searched, never shown to users, kept when the
            // page is deleted; for the admin view (`revisionsOf`).
            version: 6,
            name: 'page revisions',
            up: `CREATE TABLE page_revisions(id INTEGER PRIMARY KEY, pageId TEXT NOT NULL, spaceId TEXT NOT NULL, revision INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, authorId TEXT, createdAt INTEGER NOT NULL, replacedAt INTEGER NOT NULL);
        CREATE INDEX page_revisions_page ON page_revisions(pageId, replacedAt);`,
        },
        {
            // Compressed (2026-10-14): `body` holds the revision's Markdown as
            // bytes in `encoding` (`revisionBody`): 'br' (Brotli) or 'utf8'
            // when that is no smaller. A table rebuild that keeps every row, id
            // and column, compressing each body; titles stay plain.
            version: 7,
            name: 'compressed page revisions',
            // Recorded before the formatting pass of v0.30.0 (dba875569), which
            // changed only the source's form: same DDL and data.
            formerChecksums: ['cc74ff5963855806'],
            up: (db) => {
                db.exec(`DROP INDEX page_revisions_page;
          ALTER TABLE page_revisions RENAME TO page_revisions_v6;
          CREATE TABLE page_revisions(id INTEGER PRIMARY KEY, pageId TEXT NOT NULL, spaceId TEXT NOT NULL, revision INTEGER NOT NULL, title TEXT NOT NULL, body BLOB NOT NULL, encoding TEXT NOT NULL, authorId TEXT, createdAt INTEGER NOT NULL, replacedAt INTEGER NOT NULL);`);
                const insert = db.prepare(
                    'INSERT INTO page_revisions(id, pageId, spaceId, revision, title, body, encoding, authorId, createdAt, replacedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                );
                for (const row of db.prepare('SELECT * FROM page_revisions_v6 ORDER BY id').iterate()) {
                    const stored = revisionBody(String(row.body));
                    insert.run(
                        row.id,
                        row.pageId,
                        row.spaceId,
                        row.revision,
                        row.title,
                        stored.body,
                        stored.encoding,
                        row.authorId,
                        row.createdAt,
                        row.replacedAt,
                    );
                }
                db.exec(`DROP TABLE page_revisions_v6;
          CREATE INDEX page_revisions_page ON page_revisions(pageId, replacedAt);`);
            },
        },
        {
            // CB-191: the live pages' keys in one covering index, which the
            // Operations analytics ETL lists each cycle to see what changed
            // without reading any page's row (its text comes before the times).
            // `pages_space_recent` can't serve it: a partial index's own WHERE
            // column isn't in it, so SQLite would read every row to check it.
            // Keyed by the expression `deletedAt IS NULL`, which only a query
            // that writes it the same way uses: the app's own page queries keep
            // their plans.
            version: 8,
            name: 'live page keys',
            up: 'CREATE INDEX pages_live_keys ON pages(deletedAt IS NULL, spaceId, updatedAt, title)',
        },
        {
            version: 9,
            name: 'page use retention index',
            up: 'CREATE INDEX page_use_days_time ON page_use_days(day)',
        },
        {
            // CB-308: a page's cover, the id of a media embed (CB-230) holding
            // the image. Not part of the page's text, so it has no revisions.
            version: 10,
            name: 'page covers',
            up: 'ALTER TABLE pages ADD COLUMN coverId TEXT',
        },
        {
            // CB-328: workspace-global page tags. Tag names are global (the
            // vocabulary is the workspace's); rows are scoped to a Space for
            // visibility, which `pageAccess` still gates. Mirrors `issue_labels`
            // (issues/migrations.ts:74): a join table on (pageId, tag).
            version: 11,
            name: 'page tags',
            phase: 'expand',
            up: `CREATE TABLE page_tags(pageId TEXT NOT NULL CHECK(length(pageId) > 0), spaceId TEXT NOT NULL CHECK(length(spaceId) > 0), tag TEXT NOT NULL CHECK(length(tag) > 0), createdBy TEXT, createdAt INTEGER NOT NULL, PRIMARY KEY(pageId, tag));
      CREATE INDEX page_tags_space_tag ON page_tags(spaceId, tag);
      CREATE INDEX page_tags_tag ON page_tags(tag);`,
        },
        {
            // CB-328: typed page-to-page edges. Cross-Space: both endpoints'
            // Space ids are stored (fromSpaceId/toSpaceId) so an edge spans
            // Spaces; authorization still checks `pageAccess` on both ends.
            // `kind` is a fixed small vocabulary. Mirrors `issue_links`
            // (issues/migrations.ts:164): soft-deleted edges stamp
            // `removedAt`/`removedBy` and stay, with a partial unique index
            // for one live edge per ordered pair and kind.
            version: 12,
            name: 'page links',
            phase: 'expand',
            compatible: 'the unique index is on the new page_links table, so a build before it has no rows to conflict',
            up: `CREATE TABLE page_links(id TEXT PRIMARY KEY, fromPageId TEXT NOT NULL CHECK(length(fromPageId) > 0), toPageId TEXT NOT NULL CHECK(length(toPageId) > 0), fromSpaceId TEXT NOT NULL CHECK(length(fromSpaceId) > 0), toSpaceId TEXT NOT NULL CHECK(length(toSpaceId) > 0), kind TEXT NOT NULL CHECK(kind IN ('index','derived_from','cites','related')), createdBy TEXT, createdAt INTEGER NOT NULL, removedAt INTEGER CHECK(removedAt IS NULL OR removedAt >= createdAt), removedBy TEXT CHECK(removedBy IS NULL OR length(removedBy) > 0), CHECK(fromPageId <> toPageId), CHECK((removedAt IS NULL) = (removedBy IS NULL)));
      CREATE UNIQUE INDEX page_links_live ON page_links(fromPageId, toPageId, kind) WHERE removedAt IS NULL;
      CREATE INDEX page_links_from ON page_links(fromPageId, kind) WHERE removedAt IS NULL;
      CREATE INDEX page_links_to ON page_links(toPageId, kind) WHERE removedAt IS NULL;`,
        },
        {
            // CB-328: structured attribution. `sourceUrl` is the URL a page was
            // imported from (or a Files path / `file://` form for an uploaded
            // file); `sourceTitle` is its title. Makes "which pages came from
            // this source" a query, not a content scan.
            version: 13,
            name: 'page source attribution',
            phase: 'expand',
            up: `ALTER TABLE pages ADD COLUMN sourceUrl TEXT;
      ALTER TABLE pages ADD COLUMN sourceTitle TEXT;`,
        },
        {
            // CB-426: a folder is a page marked as one. It shows its name and
            // the pages inside it, and hides its body, which stays as it was:
            // turning it back into a page shows the text again.
            version: 14,
            name: 'page folders',
            phase: 'expand',
            up: 'ALTER TABLE pages ADD COLUMN folder INTEGER NOT NULL DEFAULT 0',
        },
    ],
};
/**
 * The open-decision markers a page's title and excerpt carry
 * (`packages/shared/src/pages/page-radar.ts`): case-insensitive, on word boundaries. Returns
 * the distinct marker phrases that matched (deduplicated, in marker order).
 * The content is the library's one-line excerpt, not the full body, so a
 * marker buried deep in a long page may not surface — by design: the radar
 * is a glance, not a deep scan.
 */
function openMarkers(title: string, excerpt: string): string[] {
    const hay = `${title}\n${excerpt}`.toLowerCase();
    const found: string[] = [];
    for (const marker of RADAR_OPEN_MARKERS) {
        if (wordMatch(hay, marker) && !found.includes(marker)) {
            found.push(marker);
        }
    }
    return found;
}
/** Whether `marker` appears in `hay` on a word boundary (or start/end). */
function wordMatch(hay: string, marker: string): boolean {
    if (!marker) {
        return false;
    }
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`, 'i').test(hay);
}
/**
 * How a revision's Markdown is stored (`page_revisions.body`, pages
 * migration 7): Brotli at quality 5, which kept the bench seed's 4 kB
 * pages in about a quarter of their size for a tenth of a millisecond
 * per save, or the UTF-8 bytes when that is no larger (tiny bodies).
 */
export function revisionBody(text: string): {
    body: Uint8Array;
    encoding: 'br' | 'utf8';
} {
    const plain = Buffer.from(text, 'utf8');
    const packed = brotliCompressSync(plain, {
        params: {
            [zlib.BROTLI_PARAM_QUALITY]: 5,
            [zlib.BROTLI_PARAM_SIZE_HINT]: plain.length,
        },
    });
    return packed.length < plain.length ? { body: packed, encoding: 'br' } : { body: plain, encoding: 'utf8' };
}
/** The Markdown a stored revision body holds (`revisionBody`'s inverse). */
export function revisionText(body: Uint8Array, encoding: string): string {
    if (encoding === 'br') {
        return brotliDecompressSync(body).toString('utf8');
    }
    if (encoding === 'utf8') {
        return Buffer.from(body).toString('utf8');
    }
    throw new Error(`Unknown page revision encoding "${encoding}".`);
}
/**
 * Saves by one author this soon after the latest revision of a page add
 * no revision: that one already holds the state before their editing
 * session. The editor autosaves 800 ms after typing stops, so an hour of
 * steady editing by one person keeps about six revisions.
 */
export const REVISION_FOLD_MS = 10 * 60_000;
const plainCover: CoverView = (id) => ({ id, url: coverUrl(id) });
export class Pages implements PageStoreShape {
    /**
     * A stored row as a page: no stamps, and its cover as the media module
     * shows it (gone with its image file), rather than the bare id.
     */
    private pageOf = (row: unknown): Page => {
        const { coverId, folder, ...page } = unstamped(
            row as Omit<Page, 'cover' | 'folder'> & { coverId?: string | null; folder?: number | boolean | null },
        );
        return { ...page, folder: !!folder, cover: coverId ? this.coverView(coverId) : null };
    };
    private tagOf = (row: unknown): PageTag => {
        const r = row as PageTag;
        return {
            pageId: String(r.pageId),
            spaceId: String(r.spaceId),
            tag: String(r.tag),
            createdBy: r.createdBy ?? null,
            createdAt: Number(r.createdAt),
        };
    };
    private linkOf = (row: unknown): PageLink => {
        const r = row as PageLink;
        return {
            id: String(r.id),
            fromPageId: String(r.fromPageId),
            toPageId: String(r.toPageId),
            fromSpaceId: String(r.fromSpaceId),
            toSpaceId: String(r.toSpaceId),
            kind: r.kind as PageLinkKind,
            createdBy: r.createdBy ?? null,
            createdAt: Number(r.createdAt),
        };
    };
    private coverView: CoverView = plainCover;
    /** How covers are shown (the platform's media module, CB-308). */
    useCovers(view: CoverView) {
        this.coverView = view;
    }
    private index: PageSearch;
    private stored?: PageRepositories;
    /** Made on first write: the connection's data layer is its own (CB-110). */
    private get repos() {
        return (this.stored ??= sqlitePageRepositories(sqliteData(this.db)));
    }
    /**
     * Writes as one unit of work on the shared connection: at once, or
     * queued behind a unit open there; inside the caller's own unit, a
     * savepoint of it (CB-110).
     */
    private unit<T>(label: string, work: () => Promise<T>) {
        return sqliteData(this.db).uow.run(work, { label, savepoint: true });
    }
    private retention: () => { pageUseDays: number; pageSearchDays: number } = () => ({
        pageUseDays: 400,
        pageSearchDays: 0,
    });
    setSearchRetention(retention: typeof this.retention) {
        this.retention = retention;
    }
    constructor(
        private db: DatabaseSync,
        private spaceExists: (id: string) => boolean,
        /** Whether a user id is a person (not a service account, not a team). */
        private isPerson: (id: string) => boolean = () => true,
    ) {
        this.index = new PageSearch(db, () => this.retention());
    }
    /**
     * Searches the live pages of the Spaces the caller may read:
     * every Space for people and service accounts, a Dot's granted ones.
     */
    search(options: SearchOptions) {
        return this.index.search(options);
    }
    /** The search timing rollup and index sizes (operators). */
    searchStats(days?: number) {
        return this.index.stats(days);
    }
    /** Writes pending search timings (at shutdown). */
    flushSearchStats() {
        this.index.flush();
    }
    /**
     * A sign that a page was useful to a person: they opened it from a
     * search, or a Dot read it for them. Counts once per person, page and
     * day toward the page's freshness; ignored for a deleted page or Space,
     * and for anyone who isn't a person. Resolves whether it counted.
     */
    async noteUse(spaceId: string, id: string, userId: string, now = Date.now()): Promise<boolean> {
        if (!this.isPerson(userId) || !this.spaceExists(spaceId)) {
            return false;
        }
        const live = this.db.prepare(`SELECT 1 FROM pages WHERE id=? AND spaceId=? AND ${LIVE}`).get(id, spaceId);
        return live ? this.index.recordUse(id, userId, now) : false;
    }
    /** Keeps a page's search row in step with its title and body. */
    private indexPage(spaceId: string, id: string, title: string, content: string) {
        return this.repos.search.put({
            pageId: id,
            spaceId,
            title,
            body: pageText(content),
        });
    }
    /** Whether a Space is there (live). */
    spaceLive(spaceId: string) {
        return this.spaceExists(spaceId);
    }
    /**
     * Whether a user may edit pages in a Space (CB-142, moves): Spaces are
     * the team's, so every person may edit every live one; service accounts
     * (read-only keys) and unknown ids may not.
     */
    canEdit(userId: string, spaceId: string) {
        return this.isPerson(userId) && this.spaceExists(spaceId);
    }
    requireSpace(spaceId: string) {
        if (!this.spaceExists(spaceId)) {
            throw new PageError('Space not found.', 404);
        }
    }
    list(spaceId: string): Page[] {
        this.requireSpace(spaceId);
        return this.db
            .prepare(`SELECT * FROM pages WHERE spaceId=? AND ${LIVE} ORDER BY createdAt,id`)
            .all(spaceId)
            .map(this.pageOf);
    }
    /**
     * The Space's live pages, id and title only, in `list`'s order: the ⌘K
     * palette's page search.
     */
    titles(spaceId: string, now = Date.now()): PageTitle[] {
        this.requireSpace(spaceId);
        const rows = this.db
            .prepare(
                `SELECT id, spaceId, title, updatedAt FROM pages WHERE spaceId=? AND ${LIVE} ORDER BY createdAt,id`,
            )
            .all(spaceId);
        const uses = this.index.uses(rows.map((row) => String(row.id)));
        return rows.map(({ id, spaceId: space, title, updatedAt }) => {
            const { basis, at } = freshnessOf(Number(updatedAt), uses.get(String(id)), now);
            return {
                id: String(id),
                spaceId: String(space),
                title: String(title),
                freshness: { basis, at },
            };
        });
    }
    /**
     * The Space's live pages, id, parent and title only, in `list`'s order:
     * the sidebar's page tree.
     */
    tree(spaceId: string): PageTreeItem[] {
        this.requireSpace(spaceId);
        return this.db
            .prepare(`SELECT id, parentId, title, folder FROM pages WHERE spaceId=? AND ${LIVE} ORDER BY createdAt,id`)
            .all(spaceId)
            .map(({ id, parentId, title, folder }) => ({
                id: String(id),
                parentId: parentId === null ? null : String(parentId),
                title: String(title),
                folder: !!folder,
            }));
    }
    /**
     * The Space's live pages as its items list shows them (CB-451): with
     * their revision, and a position from `createdAt` and id, so `tree`'s
     * order, which no page stores yet.
     */
    items(spaceId: string): SpacePageItem[] {
        this.requireSpace(spaceId);
        return this.db
            .prepare(
                `SELECT id, parentId, title, folder, revision, createdAt FROM pages WHERE spaceId=? AND ${LIVE} ORDER BY createdAt,id`,
            )
            .all(spaceId)
            .map(({ id, parentId, title, folder, revision, createdAt }) => ({
                kind: 'page' as const,
                id: String(id),
                parentId: parentId === null ? null : String(parentId),
                title: String(title),
                folder: !!folder,
                position: spaceItemKey(Number(createdAt), String(id)),
                version: Number(revision),
            }));
    }
    private gone: PagesGone = () => {};
    /** Who hears that pages left a Space (the data space, CB-451). */
    usePagesGone(gone: PagesGone) {
        this.gone = gone;
    }
    /** Pages left `spaceId`, in the caller's transaction: what sat under them goes to `parentId`. */
    pagesGone(spaceId: string, pageIds: readonly string[], parentId: string | null) {
        this.gone(spaceId, pageIds, parentId);
    }
    /**
     * The Space's most recently edited live pages, newest first, and how
     * many it has: the library's first screen (`limit` pages).
     */
    recent(spaceId: string, limit: number): { pages: Page[]; total: number } {
        this.requireSpace(spaceId);
        const pages = this.db
            .prepare(`SELECT * FROM pages WHERE spaceId=? AND ${LIVE} ORDER BY updatedAt DESC, title LIMIT ?`)
            .all(spaceId, limit)
            .map(this.pageOf);
        const { total } = this.db
            .prepare(`SELECT COUNT(*) AS total FROM pages WHERE spaceId=? AND ${LIVE}`)
            .get(spaceId) as { total: number };
        return { pages, total };
    }
    /**
     * The Space's change radar (CB-282): recent changes, open
     * decisions/experiments (heuristic), and stale pages — computed from
     * existing page and revision data, nothing new written. Read-gated by
     * `requireSpace`; the caller's access is asked again in the view. A
     * subtree (`rootId`) narrows the scope to a page and its descendants;
     * `staleDays` overrides the default threshold. See
     * `packages/shared/src/pages/page-radar.ts` for the signals and markers.
     */
    radar(
        spaceId: string,
        {
            rootId = null,
            staleDays = RADAR_STALE_DAYS,
            now = Date.now(),
        }: { rootId?: string | null; staleDays?: number; now?: number } = {},
    ): SpaceRadar {
        this.requireSpace(spaceId);
        const all = this.list(spaceId);
        // A subtree narrows the scope to a page and its descendants.
        const scope = rootId ? this.subtree(all, rootId) : all;
        const inScope = new Set(scope.map((page) => page.id));
        // How many kept revisions each page in scope has, in one pass.
        const counts = new Map<string, number>();
        if (inScope.size) {
            const rows = this.db.prepare('SELECT pageId, COUNT(*) AS n FROM page_revisions GROUP BY pageId').all() as {
                pageId: string;
                n: number;
            }[];
            for (const row of rows) {
                if (inScope.has(row.pageId)) {
                    counts.set(row.pageId, Number(row.n));
                }
            }
        }
        const entries: RadarEntry[] = scope.map((page) => ({
            id: page.id,
            spaceId: page.spaceId,
            parentId: page.parentId,
            title: page.title,
            excerpt: pageExcerpt(page.content, page.title),
            revision: page.revision,
            revisions: counts.get(page.id) ?? 0,
            createdAt: page.createdAt,
            updatedAt: page.updatedAt,
            ageDays: Math.floor((now - page.updatedAt) / 86_400_000),
        }));
        const recent = [...entries]
            .sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title))
            .slice(0, RADAR_LIMIT);
        // Stale is older than `staleDays` from now, not from the newest page:
        // a lone page in a quiet Space is still stale if it has not been touched.
        const threshold = now - staleDays * 86_400_000;
        const stale = entries
            .filter((page) => page.updatedAt < threshold)
            .sort((a, b) => a.updatedAt - b.updatedAt || a.title.localeCompare(b.title))
            .slice(0, RADAR_LIMIT);
        const open: RadarOpenEntry[] = [];
        for (const entry of entries) {
            const markers = openMarkers(entry.title, entry.excerpt);
            if (markers.length) {
                open.push({ ...entry, markers });
            }
        }
        open.sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title));
        return {
            spaceId,
            now,
            staleDays,
            recent,
            open,
            stale,
            total: scope.length,
        };
    }
    /** A page and all its descendants within the Space (depth-first). */
    private subtree(pages: Page[], rootId: string): Page[] {
        const root = pages.find((page) => page.id === rootId);
        if (!root) {
            return [];
        }
        const byParent = new Map<string | null, Page[]>();
        for (const page of pages) {
            const key = page.parentId;
            const list = byParent.get(key) ?? [];
            list.push(page);
            byParent.set(key, list);
        }
        const out: Page[] = [root];
        const stack = [root];
        while (stack.length) {
            const current = stack.pop()!;
            for (const child of byParent.get(current.id) ?? []) {
                out.push(child);
                stack.push(child);
            }
        }
        return out;
    }
    get(spaceId: string, id: string): Page {
        this.requireSpace(spaceId);
        const row = this.db.prepare('SELECT * FROM pages WHERE id=? AND spaceId=?').get(id, spaceId);
        if (!row || row.deletedAt !== null) {
            throw row || this.db.prepare('SELECT 1 FROM page_deletions WHERE id=? AND spaceId=?').get(id, spaceId)
                ? new PageError('This page was deleted.', 410)
                : new PageError('Page not found in this Space.', 404);
        }
        return this.pageOf(row);
    }
    /** A page, deleted or not, with its stamp (admin, tests). */
    withDeleted(id: string) {
        return this.db.prepare('SELECT * FROM pages WHERE id=?').get(id) as
            | (Page & {
                  deletedAt: number | null;
                  deletedBy: string | null;
                  deletedWith: string | null;
              })
            | undefined;
    }
    /**
     * Whether any live page of the Space has a cover that still shows
     * (CB-308): the library then gives every card a band.
     */
    hasCovers(spaceId: string) {
        return this.db
            .prepare(`SELECT coverId FROM pages WHERE spaceId=? AND ${LIVE} AND coverId IS NOT NULL`)
            .all(spaceId)
            .some((row) => this.coverView(String(row.coverId)) !== null);
    }
    /**
     * Of `ids`, the media embeds some page names (CB-524): live or deleted,
     * in its text, a kept revision or as its cover. A plain substring
     * match, so any mention keeps an upload (never too few). Reads every
     * page and revision once; the clean-up calls it at most daily per
     * upload, and only with uploads past their grace.
     */
    embedsNamed(ids: readonly string[], { revisions = true }: { revisions?: boolean } = {}): Set<string> {
        const named = new Set<string>();
        const wanted = new Set(ids);
        const see = (text: string) => {
            for (const id of wanted) {
                if (text.includes(id)) {
                    named.add(id);
                    wanted.delete(id);
                }
            }
        };
        if (!wanted.size) {
            return named;
        }
        for (const row of this.db.prepare('SELECT content, coverId FROM pages').iterate() as Iterable<{
            content: string;
            coverId: string | null;
        }>) {
            if (row.coverId && wanted.has(row.coverId)) {
                named.add(row.coverId);
                wanted.delete(row.coverId);
            }
            see(row.content);
            if (!wanted.size) {
                return named;
            }
        }
        if (!revisions) {
            return named;
        }
        for (const row of this.db.prepare('SELECT body, encoding FROM page_revisions').iterate() as Iterable<{
            body: Uint8Array;
            encoding: string;
        }>) {
            see(revisionText(row.body, row.encoding));
            if (!wanted.size) {
                return named;
            }
        }
        return named;
    }
    /**
     * Sets or clears a live page's cover (CB-308). The cover isn't the
     * page's text: `updatedAt` moves, so lists and polls see the change,
     * but `revision` doesn't, so an open editor's next save isn't refused.
     * Resolves the page and the cover it had.
     */
    setCover(
        spaceId: string,
        id: string,
        coverId: string | null,
        now = Date.now(),
    ): Promise<{ page: Page; previous: string | null }> {
        return this.unit('set page cover', async () => {
            this.get(spaceId, id);
            const row = this.db.prepare('SELECT coverId FROM pages WHERE id=?').get(id) as { coverId: string | null };
            await this.repos.pages.cover(id, coverId, now);
            return { page: this.get(spaceId, id), previous: row.coverId };
        });
    }
    /**
     * Turns a live page into a folder or back into a page (CB-426). Only the
     * mark changes: the title and body stay as they are, a folder's body
     * hidden, so no revision of the text is kept. It is a new revision all
     * the same, as a move within the Space is: everything that follows a
     * page by its revision (other tabs' open page, the sidebar's items,
     * Socio Mobile's sync) then sees the change, and an editor still open
     * on the old revision elsewhere gets the usual conflict instead of
     * saving over a page that became a folder. Already so, nothing changes.
     */
    setFolder(spaceId: string, id: string, folder: boolean, now = Date.now()): Promise<Page> {
        return this.unit('set page folder', async () => {
            const page = this.get(spaceId, id);
            if (page.folder === folder) {
                return page;
            }
            await this.repos.pages.folder(id, folder, now);
            return this.get(spaceId, id);
        });
    }
    private parent(spaceId: string, parentId: string | null, id?: string) {
        const seen = new Set([id]);
        let cursor = parentId;
        while (cursor) {
            if (seen.has(cursor)) {
                throw new PageError('A page cannot be moved into itself or a descendant.');
            }
            seen.add(cursor);
            cursor = this.get(spaceId, cursor).parentId;
        }
    }
    /**
     * A new page, as one transaction on the shared connection: at once, or
     * queued behind a unit of work open there (CB-110). Await it.
     */
    create(
        spaceId: string,
        input: z.input<typeof pageInput>,
        sourceThreadId: string | null = null,
        createdBy: string | null = null,
    ): Promise<Page> {
        return this.unit('create page', () => this.insert(spaceId, input, sourceThreadId, createdBy));
    }
    /** `create`'s work, inside a unit of work already open (createReviewed's). */
    private async insert(
        spaceId: string,
        input: z.input<typeof pageInput>,
        sourceThreadId: string | null,
        createdBy: string | null,
    ): Promise<Page> {
        this.requireSpace(spaceId);
        const parsed = pageInput.safeParse(input);
        if (!parsed.success) {
            throw new PageError('Pages require a title up to 160 characters and content up to 100,000 characters.');
        }
        const data = parsed.data;
        this.parent(spaceId, data.parentId);
        const id = randomUUID(),
            now = Date.now();
        // Inside the caller's unit, a savepoint: the search row never exists
        // without the page, nor the page without it.
        await this.unit('add page', async () => {
            await this.repos.pages.insert({
                id,
                spaceId,
                parentId: data.parentId,
                title: data.title,
                content: data.content,
                createdAt: now,
                sourceThreadId,
                createdBy,
                sourceUrl: data.sourceUrl ?? null,
                sourceTitle: data.sourceTitle ?? null,
                folder: data.folder,
            });
            await this.indexPage(spaceId, id, data.title, data.content);
        });
        return this.get(spaceId, id);
    }
    reviewReceipt(
        threadId: string,
        toolCallId: string,
    ): { pageId: string; spaceId: string; draft: PageReviewDraft | null } | null {
        const row = this.db
            .prepare('SELECT pageId,spaceId,draft FROM page_reviews WHERE threadId=? AND toolCallId=?')
            .get(threadId, toolCallId);
        return row
            ? {
                  pageId: String(row.pageId),
                  spaceId: String(row.spaceId),
                  draft: row.draft ? pageReviewSchema.parse(JSON.parse(String(row.draft))) : null,
              }
            : null;
    }
    async createReviewed(
        spaceId: string,
        input: Pick<PageReviewDraft, 'title' | 'content'>,
        threadId: string,
        toolCallId: string,
        createdBy: string | null = null,
    ): Promise<ReviewedPage> {
        const draft = pageReviewSchema.parse({ ...input, spaceId });
        return this.unit('save reviewed page', async () => {
            const previous = this.reviewReceipt(threadId, toolCallId);
            if (previous) {
                if (previous.spaceId !== spaceId) {
                    throw new PageError('This review was already saved to another Space.', 409);
                }
                if (
                    previous.draft &&
                    (previous.draft.title !== draft.title || previous.draft.content !== draft.content)
                ) {
                    throw new PageError(
                        'This review was already saved with a different draft. Start a new review for the changed draft.',
                        409,
                    );
                }
                const page = this.get(spaceId, previous.pageId);
                return { ...page, reviewDraft: previous.draft };
            }
            const page = await this.insert(
                spaceId,
                { title: draft.title, content: draft.content },
                threadId,
                createdBy,
            );
            await this.repos.reviews.insert({
                threadId,
                toolCallId,
                pageId: page.id,
                spaceId,
                draft: JSON.stringify(draft),
            });
            return { ...page, reviewDraft: draft };
        });
    }
    /**
     * Edits a page. `by` is who edits (a user id, or `dot:<id>` for a Dot's
     * page tool); when the title or body changes, the state it replaces is
     * kept as a revision unless `by` wrote the page's latest revision less
     * than REVISION_FOLD_MS ago.
     */
    async update(
        spaceId: string,
        id: string,
        input: z.input<typeof pagePatch>,
        { by = null, now = Date.now() }: { by?: string | null; now?: number } = {},
    ): Promise<Page> {
        const parsed = pagePatch.safeParse(input);
        if (!parsed.success) {
            throw new PageError('A valid page patch and expectedRevision are required.');
        }
        const data = parsed.data;
        return this.unit('update page', async () => {
            const page = this.get(spaceId, id);
            if (page.revision !== data.expectedRevision) {
                throw new PageError('This page changed. Reload the latest revision before saving your draft.', 409);
            }
            const parent = data.parentId === undefined ? page.parentId : data.parentId;
            this.parent(spaceId, parent, id);
            // A move changes neither the title nor the text.
            const changed =
                (data.title !== undefined && data.title !== page.title) ||
                (data.content !== undefined && data.content !== page.content);
            if (changed) {
                await this.keepRevision(page, by, now);
            }
            await this.repos.pages.edit(
                id,
                data.expectedRevision,
                {
                    title: data.title ?? page.title,
                    content: data.content ?? page.content,
                    parentId: parent,
                },
                now,
            );
            if (changed) {
                await this.indexPage(spaceId, id, data.title ?? page.title, data.content ?? page.content);
            }
            return this.get(spaceId, id);
        });
    }
    /**
     * Keeps the state `page` is in before an edit by `by`, unless `by` wrote
     * the page's latest revision within REVISION_FOLD_MS (that one holds the
     * state before their editing session). An unknown author never folds.
     */
    private async keepRevision(page: Page, by: string | null, now: number) {
        const latest = await this.repos.revisions.latest(page.id);
        if (by !== null && latest?.authorId === by && now - latest.replacedAt < REVISION_FOLD_MS) {
            return;
        }
        await this.repos.revisions.insert({
            pageId: page.id,
            spaceId: page.spaceId,
            revision: page.revision,
            title: page.title,
            ...revisionBody(page.content),
            authorId: by,
            createdAt: page.updatedAt,
            replacedAt: now,
        });
    }
    /**
     * Every kept revision of a page, newest first, whether the page is live
     * or deleted: for the admin view only (no user or Dot reads them). The
     * text of a revision was written by the author of the revision before it
     * (or, for the first, by whoever wrote the page before it kept revisions).
     */
    revisionsOf(pageId: string): PageRevision[] {
        return this.db
            .prepare(
                'SELECT id, pageId, spaceId, revision, title, body, encoding, authorId, createdAt, replacedAt FROM page_revisions WHERE pageId=? ORDER BY replacedAt DESC, id DESC',
            )
            .all(pageId)
            .map(({ body, encoding, ...row }) => ({
                ...(row as unknown as Omit<PageRevision, 'body'>),
                body: revisionText(body as Uint8Array, String(encoding)),
            }));
    }
    /**
     * How many revisions are kept, of how many pages, in how many bytes on
     * disk, compressed as stored (operators).
     */
    revisionStats(): PageRevisionStats {
        const counts = this.db
            .prepare('SELECT COUNT(*) AS revisions, COUNT(DISTINCT pageId) AS pages FROM page_revisions')
            .get() as { revisions: number; pages: number };
        const size = this.db.prepare(
            'SELECT COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat WHERE name = ? AND aggregate = TRUE',
        );
        return {
            revisions: Number(counts.revisions),
            pages: Number(counts.pages),
            bytes: ['page_revisions', 'page_revisions_page'].reduce(
                (total, name) => total + Number(size.get(name)?.bytes ?? 0),
                0,
            ),
        };
    }
    /**
     * Deletes a page, with its subpages when `subpages` is set (otherwise a
     * page with subpages is refused), in one transaction. `allowed` decides
     * for each page (admins, or its creator); one refusal deletes nothing.
     * CB-64: the pages are hidden and kept, stamped with `by`; subpages also
     * with `deletedWith` page:<id>. Conversations about the pages stay as
     * ordinary conversations of their owners (their page bindings go);
     * review receipts stay with their conversations and answer that the
     * page was deleted, as links to it do.
     */
    delete(
        spaceId: string,
        id: string,
        {
            subpages = false,
            allowed = () => true,
            by = null,
        }: {
            subpages?: boolean;
            allowed?: (page: Page) => boolean;
            /** Who deletes: a user id, or null when unknown. */
            by?: string | null;
        } = {},
    ): Promise<{ deleted: string[] }> {
        return this.unit('delete page', async () => {
            const page = this.get(spaceId, id);
            const all = this.list(spaceId);
            const tree = [page];
            for (let i = 0; i < tree.length; i++) {
                tree.push(...all.filter((item) => item.parentId === tree[i].id));
            }
            if (!allowed(page)) {
                throw new PageError('Only an admin or the person who created this page can delete it.', 403);
            }
            if (tree.length > 1 && !subpages) {
                throw new PageError(
                    `This page has ${tree.length - 1} ${tree.length === 2 ? 'subpage' : 'subpages'}. Delete them with it, or move them first.`,
                    409,
                );
            }
            if (!tree.every(allowed)) {
                throw new PageError('Only an admin can delete subpages someone else created.', 403);
            }
            const deletedAt = Date.now();
            for (const item of tree) {
                await this.repos.threads.removeForPage(item.id);
                await this.repos.pages.hide(item.id, {
                    at: deletedAt,
                    by,
                    with: item.id === page.id ? null : deletedWith('page', page.id),
                });
                // Deleted pages leave the index; their use counts go (a restore
                // starts from the edit date).
                await this.repos.search.remove(item.id);
                await this.repos.use.removeForPage(item.id);
            }
            // A dataset is never deleted with a page (CB-451): those under
            // the subtree go to its root's parent, which lives on.
            this.pagesGone(
                spaceId,
                tree.map((item) => item.id),
                page.parentId,
            );
            return { deleted: tree.map((item) => item.id) };
        });
    }
    /** The user's conversation about a page with a Dot. */
    thread(pageId: string, dotId: string, userId: string) {
        const row = this.db
            .prepare('SELECT threadId,ready FROM page_threads WHERE pageId=? AND dotId=? AND userId=?')
            .get(pageId, dotId, userId);
        return row ? { threadId: String(row.threadId), ready: !!row.ready } : undefined;
    }
    /**
     * Keeps `threadId` for the conversation unless it has one, and leases
     * its creation for a minute. Resolves whether this call holds the lease.
     */
    reserveThread(pageId: string, dotId: string, userId: string, threadId: string): Promise<boolean> {
        const now = Date.now();
        return this.repos.threads.reserve({ pageId, dotId, userId }, threadId, now + 60000, now);
    }
    finishThread(pageId: string, dotId: string, userId: string) {
        return this.repos.threads.finish({ pageId, dotId, userId });
    }
    releaseThread(pageId: string, dotId: string, userId: string) {
        return this.repos.threads.release({ pageId, dotId, userId });
    }
    forThread(threadId: string, spaceId?: string): Page | undefined {
        const row = this.db
            .prepare(
                'SELECT pageId, pages.spaceId FROM page_threads JOIN pages ON pages.id=page_threads.pageId WHERE threadId=? AND ready=1 AND pages.deletedAt IS NULL',
            )
            .get(threadId);
        return row ? this.get(spaceId ?? String(row.spaceId), String(row.pageId)) : undefined;
    }

    // ---- Tags (CB-328) -------------------------------------------------------

    /**
     * Sets a tag on a page. Idempotent: re-tagging a tagged page is a no-op
     * (the existing row stays). `by` is who tags (a user id, or `dot:<id>`).
     * The page must be live; the Space must exist. Returns the tag row.
     */
    async tagPage(spaceId: string, pageId: string, tag: string, by: string | null = null): Promise<PageTag> {
        this.requireSpace(spaceId);
        const page = this.get(spaceId, pageId);
        const name = tag.trim();
        if (!name) {
            throw new PageError('A tag must not be empty.', 400);
        }
        const now = Date.now();
        await this.repos.tags.upsert({
            pageId: page.id,
            spaceId,
            tag: name,
            createdBy: by,
            createdAt: now,
        });
        const row = this.db.prepare('SELECT * FROM page_tags WHERE pageId=? AND tag=?').get(page.id, name);
        return this.tagOf(row);
    }
    /** Removes a tag from a page. Idempotent. Returns whether a row was removed. */
    untagPage(spaceId: string, pageId: string, tag: string): Promise<boolean> {
        this.requireSpace(spaceId);
        const page = this.get(spaceId, pageId);
        const name = tag.trim();
        if (!name) {
            return Promise.resolve(false);
        }
        return this.repos.tags.remove(page.id, name);
    }
    /** The tags on a page (live page only), in tag order. */
    tagsOf(spaceId: string, pageId: string): PageTag[] {
        this.requireSpace(spaceId);
        const page = this.get(spaceId, pageId);
        return this.db.prepare('SELECT * FROM page_tags WHERE pageId=? ORDER BY tag').all(page.id).map(this.tagOf);
    }
    /**
     * Live pages with a given tag across the given Spaces (the caller has
     * already filtered to Spaces the reader may use). Returns each page's
     * id, spaceId and title, in `list` order.
     */
    pagesByTag(tag: string, spaces: readonly string[]): { id: string; spaceId: string; title: string }[] {
        const name = tag.trim();
        if (!name || !spaces.length) {
            return [];
        }
        const placeholders = spaces.map(() => '?').join(',');
        const rows = this.db
            .prepare(
                `SELECT t.pageId AS id, t.spaceId, p.title FROM page_tags t JOIN pages p ON p.id = t.pageId WHERE t.tag=? AND t.spaceId IN (${placeholders}) AND ${live('p')} ORDER BY p.createdAt, p.id`,
            )
            .all(name, ...spaces);
        return rows.map((row) => ({
            id: String(row.id),
            spaceId: String(row.spaceId),
            title: String(row.title),
        }));
    }

    // ---- Links (CB-328) -----------------------------------------------------

    /**
     * Creates a typed edge from one page to another (cross-Space allowed).
     * Idempotent: re-linking an existing live edge of the same kind is a
     * no-op. Both pages must be live. `by` is who links. Returns the edge.
     */
    async linkPages(
        from: { spaceId: string; pageId: string },
        to: { spaceId: string; pageId: string },
        kind: PageLinkKind,
        by: string | null = null,
    ): Promise<PageLink> {
        this.requireSpace(from.spaceId);
        this.requireSpace(to.spaceId);
        const fromPage = this.get(from.spaceId, from.pageId);
        const toPage = this.get(to.spaceId, to.pageId);
        const now = Date.now();
        const id = randomUUID();
        await this.repos.links.upsert({
            id,
            fromPageId: fromPage.id,
            toPageId: toPage.id,
            fromSpaceId: from.spaceId,
            toSpaceId: to.spaceId,
            kind,
            createdBy: by,
            createdAt: now,
        });
        const row = this.db
            .prepare(`SELECT * FROM page_links WHERE fromPageId=? AND toPageId=? AND kind=? AND removedAt IS NULL`)
            .get(fromPage.id, toPage.id, kind);
        return this.linkOf(row);
    }
    /**
     * Removes a live edge. Idempotent. Stamps `removedAt`/`removedBy` and
     * keeps the row (soft delete, as `issue_links`). Returns whether a row
     * was removed.
     */
    unlinkPages(
        from: { spaceId: string; pageId: string },
        to: { spaceId: string; pageId: string },
        kind: PageLinkKind,
        by: string | null = null,
    ): Promise<boolean> {
        this.requireSpace(from.spaceId);
        const fromPage = this.get(from.spaceId, from.pageId);
        const toPage = this.get(to.spaceId, to.pageId);
        return this.repos.links.remove(fromPage.id, toPage.id, kind, Date.now(), by);
    }
    /** The outgoing edges of a page (live), in creation order. */
    linksFrom(spaceId: string, pageId: string): PageLink[] {
        this.requireSpace(spaceId);
        const page = this.get(spaceId, pageId);
        return this.db
            .prepare(`SELECT * FROM page_links WHERE fromPageId=? AND removedAt IS NULL ORDER BY createdAt, id`)
            .all(page.id)
            .map(this.linkOf);
    }
    /** The incoming edges of a page (live backlinks), in creation order. */
    linksTo(spaceId: string, pageId: string): PageLink[] {
        this.requireSpace(spaceId);
        const page = this.get(spaceId, pageId);
        return this.db
            .prepare(`SELECT * FROM page_links WHERE toPageId=? AND removedAt IS NULL ORDER BY createdAt, id`)
            .all(page.id)
            .map(this.linkOf);
    }
}
