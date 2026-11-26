import type { DatabaseSync } from 'node:sqlite';

import { sqliteData } from '@socio/data/open';
import {
    foldText,
    PAGE_SEARCH_LIMIT,
    PAGE_SEARCH_MAX_LIMIT,
    PAGE_SEARCH_MAX_OFFSET,
    PAGE_SEARCH_MIN_CHARS,
    snippetParts,
    type Freshness,
    type PageHit,
    type PageSearchResult,
    type SearchIndexSizes,
    type SearchStatsView,
    type SnippetPart,
} from '@socio/shared/pages/page-search';
import { plainMarks } from '@socio/shared/pages/page-text';
import { bucketOf, percentile } from '@socio/shared/pages/search-timing';
import { markdownSnippet, textSnippet } from '@socio/shared/pages/text-snippet';

import type { SearchOptions } from './contract.js';
import type { PageUseRepository } from './domain/repositories.js';
import { SqliteSearchStats, type SearchDay } from './infra/sqlite/search-stats.js';
import { SqlitePageUse } from './infra/sqlite/search.js';

/**
 * Server page search: two FTS5 indexes
 * over `page_search`, the plain text of every live page, which the
 * `Pages` store writes with the page. Callers pass the Spaces to search;
 * the queries join `pages` for its live filter, so a deleted page never
 * shows even if its search row were left behind.
 *
 * - `page_search_fts` (unicode61, prefix indexes): every word of the
 *   query starts a word of the page. Ranked first.
 * - `page_search_tri` (trigram): for queries whose words all have 3 or
 *   more characters, it fills in pages where the words are inside other
 *   words ("voic" in "invoice"), after the word hits, without duplicates.
 * - Typo correction: when both find nothing, a word no indexed word
 *   starts with is replaced by the most common indexed word one edit
 *   away (two from 8 letters), and the answer says so.
 *
 * It also keeps freshness (`page_use`) and the daily timing rollup
 * (`page_search_daily`; no query text).
 */

const DAY = 86_400_000;
/** How many ranked candidates each query reads: paging stays within them. */
export const SEARCH_CANDIDATES = PAGE_SEARCH_MAX_OFFSET + PAGE_SEARCH_MAX_LIMIT;
/** A title hit counts as much as this many body hits (bm25 weights). */
const TITLE_WEIGHT = 10;
/** Queries longer than this are cut. */
const MAX_QUERY = 200;
const MAX_WORDS = 8;

/**
 * Freshness (owner, 2026-10-11): relevance first, then freshness weighs
 * in. f is between 0 and 1, the larger of
 * - edits: 2^(−age / 30 days) from `updatedAt`;
 * - uses: the uses counted (one per person per page per day, each
 *   decaying with the same half-life), a third each, at most 1.
 * Within a title tier the bm25 score is multiplied by 1 + 2f: a page
 * edited or used by three people today counts three times an old one,
 * twice at a month, 1.25 times at three months.
 */
export const FRESH_HALF_LIFE_DAYS = 30;
export const FRESH_WEIGHT = 2;
export const USES_FOR_FULL = 3;
/** Days the per-person-per-day dedupe rows are kept (then deleted). */
export const USE_DAYS_KEPT = 400;
/** Days of timing rollup kept. */
export const STATS_DAYS_KEPT = 0;

const decay = (ms: number) => 2 ** (-Math.max(0, ms) / (FRESH_HALF_LIFE_DAYS * DAY));

export interface PageUse {
    /** Counted uses, decayed to `scoredAt`. */
    score: number;
    scoredAt: number;
    /** The last counted use. */
    usedAt: number;
}

/** A page's freshness now, and which basis gives it. */
export function freshnessOf(updatedAt: number, use: PageUse | undefined, now: number): Freshness & { value: number } {
    const edited = decay(now - updatedAt);
    const used = use ? Math.min(1, (use.score * decay(now - use.scoredAt)) / USES_FOR_FULL) : 0;
    return used > edited
        ? { basis: 'used', at: use!.usedAt, value: used }
        : { basis: 'edited', at: updatedAt, value: edited };
}

/** The palette's title tiers: 0 exact, 1 prefix, 2 word starts, 3 other. */
export function titleTier(title: string, words: readonly string[]) {
    const folded = foldText(title);
    const phrase = words.join(' ');
    if (folded === phrase) {
        return 0;
    }
    if (folded.startsWith(phrase)) {
        return 1;
    }
    const parts = folded.split(/[^\p{L}\p{N}]+/u);
    if (words.every((word) => parts.some((part) => part.startsWith(word)))) {
        return 2;
    }
    return 3;
}

/**
 * What the user typed, as the words to search: cut to 200 characters,
 * folded, at most 8 words with a letter or digit; one-character words go
 * when others remain. None when fewer than 2 characters are left.
 */
export function queryWords(query: string): string[] {
    let words = foldText(query.slice(0, MAX_QUERY))
        .split(' ')
        .filter((word) => /[\p{L}\p{N}]/u.test(word))
        .slice(0, MAX_WORDS);
    if (words.some((word) => [...word].length > 1)) {
        words = words.filter((word) => [...word].length > 1);
    }
    return words.join('').length >= PAGE_SEARCH_MIN_CHARS ? words : [];
}

const quoted = (text: string) => `"${text.replaceAll('"', '""')}"`;
/** unicode61: every word a prefix, ANDed. Quoting makes any input literal. */
export const wordMatch = (words: readonly string[]) => words.map((word) => `${quoted(word)}*`).join(' ');
/** The words as the trigram index and the plain text have them. */
const textWords = (words: readonly string[]) => words.map((word) => plainMarks(word).replace(/\s+/g, ' ').trim());
/** trigram: every word a substring; none under 3 characters can match. */
export function textMatch(words: readonly string[]) {
    const parts = textWords(words);
    return parts.every((part) => [...part].length >= 3) ? parts.map(quoted).join(' ') : null;
}

/** Optimal string alignment distance (a swap of neighbors is one edit). */
export function editDistance(a: string, b: string, max = Infinity) {
    const x = [...a],
        y = [...b];
    if (Math.abs(x.length - y.length) > max) {
        return max + 1;
    }
    let previous2: number[] = [];
    let previous = Array.from({ length: y.length + 1 }, (_, j) => j);
    for (let i = 1; i <= x.length; i++) {
        const row = [i];
        let best = i;
        for (let j = 1; j <= y.length; j++) {
            const cost = x[i - 1] === y[j - 1] ? 0 : 1;
            let value = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + cost);
            if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) {
                value = Math.min(value, previous2[j - 2]! + 1);
            }
            row.push(value);
            best = Math.min(best, value);
        }
        if (best > max) {
            return max + 1;
        }
        previous2 = previous;
        previous = row;
    }
    return previous[y.length]!;
}

/** One day's searches in the rollup. */
interface DayCounts {
    queries: number;
    empty: number;
    corrected: number;
    trigram: number;
    maxMs: number;
    /** Bucket → count. */
    histogram: Record<number, number>;
}

const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);

interface Candidate {
    row: number;
    id: string;
    spaceId: string;
    title: string;
    updatedAt: number;
    score: number;
    matched: 'word' | 'text';
    /** A folder (CB-426): its body is hidden, so it gets no snippet. */
    folder: boolean;
}

export class PageSearch {
    private pending = new Map<string, DayCounts>();
    private flushedAt = Date.now();
    private stored?: { use: PageUseRepository; daily: SqliteSearchStats };
    /** Made on first use: the connection's data layer is its own (CB-110). */
    private get repos() {
        return (this.stored ??= {
            use: new SqlitePageUse(sqliteData(this.db)),
            daily: new SqliteSearchStats(this.db),
        });
    }
    private get daily() {
        return this.repos.daily;
    }
    constructor(
        private db: DatabaseSync,
        private retention: () => {
            pageUseDays: number;
            pageSearchDays: number;
        } = () => ({ pageUseDays: USE_DAYS_KEPT, pageSearchDays: STATS_DAYS_KEPT }),
    ) {}

    /**
     * The best `limit` matches in rank order, in the caller's Spaces. FTS5
     * hands rows over in rank order; the Space filter is a set of
     * `page_search` keys taken from its Space index, tested before any row
     * is read (the unary `+` keeps FTS5 from looking each key up with the
     * MATCH instead, which took 70 ms and more). The join to `pages` is the
     * live filter.
     */
    private candidates(
        table: 'page_search_fts' | 'page_search_tri',
        match: string,
        spaces: readonly string[],
        exclude: readonly number[],
        limit: number,
    ): Candidate[] {
        if (limit <= 0) {
            return [];
        }
        return this.db
            .prepare(
                `SELECT s.id AS row, p.id, p.spaceId, p.title, p.updatedAt, p.folder, f.rank AS score
         FROM ${table} f JOIN page_search s ON s.id = f.rowid JOIN pages p ON p.id = s.pageId
         WHERE ${table} MATCH ? AND f.rank MATCH 'bm25(${TITLE_WEIGHT}.0, 1.0)'
           AND +f.rowid IN (SELECT id FROM page_search WHERE spaceId IN (SELECT value FROM json_each(?)))
           AND p.spaceId = s.spaceId AND p.deletedAt IS NULL
           ${exclude.length ? 'AND s.id NOT IN (SELECT value FROM json_each(?))' : ''}
         ORDER BY f.rank LIMIT ?`,
            )
            .all(match, JSON.stringify(spaces), ...(exclude.length ? [JSON.stringify(exclude)] : []), limit)
            .map((row) => ({
                row: Number(row.row),
                id: String(row.id),
                spaceId: String(row.spaceId),
                title: String(row.title),
                updatedAt: Number(row.updatedAt),
                score: Number(row.score),
                matched: table === 'page_search_fts' ? 'word' : 'text',
                folder: !!row.folder,
            }));
    }

    /** The stored use aggregates of these pages. */
    uses(pageIds: readonly string[]): Map<string, PageUse> {
        if (!pageIds.length) {
            return new Map();
        }
        return new Map(
            this.db
                .prepare(
                    'SELECT pageId, score, scoredAt, usedAt FROM page_use WHERE pageId IN (SELECT value FROM json_each(?))',
                )
                .all(JSON.stringify(pageIds))
                .map((row) => [
                    String(row.pageId),
                    {
                        score: Number(row.score),
                        scoredAt: Number(row.scoredAt),
                        usedAt: Number(row.usedAt),
                    },
                ]),
        );
    }

    /**
     * Word hits, then, when they don't fill the page asked for (`need`
     * hits), trigram hits that add to them. Trigram hits always rank after
     * word hits, so the pages before stay the same either way.
     */
    private find(words: string[], spaces: readonly string[], need: number) {
        const found = this.candidates('page_search_fts', wordMatch(words), spaces, [], SEARCH_CANDIDATES);
        const text = textMatch(words);
        let trigram = false;
        if (text && found.length < need) {
            const more = this.candidates(
                'page_search_tri',
                text,
                spaces,
                found.map((hit) => hit.row),
                SEARCH_CANDIDATES - found.length,
            );
            trigram = more.length > 0;
            found.push(...more);
        }
        return { found, trigram };
    }

    /**
     * Corrections for misspelt words, best first: for each word of 4 or
     * more letters that no indexed word starts with, the indexed words with
     * its first letter within one edit (two from 8 letters) of it or of
     * their own start, most common first. Undefined when no word needs one
     * or none has a candidate.
     */
    private corrections(words: string[]) {
        const vocab = this.db.prepare('SELECT term, doc FROM page_search_vocab WHERE term >= ? AND term < ?');
        const prefixed = this.db.prepare('SELECT 1 FROM page_search_vocab WHERE term >= ? AND term < ? LIMIT 1');
        const options: string[][] = [];
        let changed = false;
        for (const word of words) {
            const letters = [...word];
            if (letters.length < 4 || !/^\p{L}+$/u.test(word) || prefixed.get(word, `${word}\u{10FFFF}`)) {
                options.push([word]);
                continue;
            }
            const first = letters[0]!;
            const next = String.fromCodePoint(first.codePointAt(0)! + 1);
            const max = letters.length >= 8 ? 2 : 1;
            const ranked = vocab
                .all(first, next)
                .map((row) => {
                    const term = String(row.term);
                    const distance = Math.min(
                        editDistance(word, term, max),
                        editDistance(word, [...term].slice(0, letters.length).join(''), max),
                    );
                    return { term, doc: Number(row.doc), distance };
                })
                .filter((entry) => entry.distance <= max && entry.term !== word)
                .sort((a, b) => b.doc - a.doc || a.distance - b.distance || (a.term < b.term ? -1 : 1))
                .slice(0, 3)
                .map((entry) => entry.term);
            if (!ranked.length) {
                return undefined;
            }
            changed = true;
            options.push(ranked);
        }
        if (!changed) {
            return undefined;
        }
        return [0, 1, 2]
            .map((index) => options.map((list) => list[Math.min(index, list.length - 1)]!))
            .filter((list, index, all) => all.findIndex((other) => other.join(' ') === list.join(' ')) === index);
    }

    private rank(found: Candidate[], words: string[], now: number) {
        const uses = this.uses(found.map((hit) => hit.id));
        return found
            .map((hit) => {
                const fresh = freshnessOf(hit.updatedAt, uses.get(hit.id), now);
                return {
                    hit,
                    fresh,
                    group: hit.matched === 'word' ? 0 : 1,
                    tier: titleTier(hit.title, words),
                    weighted: hit.score * (1 + FRESH_WEIGHT * fresh.value),
                };
            })
            .sort(
                (a, b) =>
                    a.group - b.group ||
                    a.tier - b.tier ||
                    a.weighted - b.weighted ||
                    b.hit.updatedAt - a.hit.updatedAt ||
                    (a.hit.id < b.hit.id ? -1 : 1),
            );
    }

    private snippets(all: Candidate[], words: string[]): Map<number, SnippetPart[]> {
        const out = new Map<number, SnippetPart[]>();
        // A folder's body is hidden (CB-426): it still matches, by its title too, but shows none.
        const hits = all.filter((hit) => !hit.folder);
        // `+rowid`: a filter on the matches, not a MATCH per row (2 to 4 times
        // faster on long queries).
        const byWord = hits.filter((hit) => hit.matched === 'word');
        if (byWord.length) {
            for (const row of this.db
                .prepare(
                    `SELECT rowid AS row, snippet(page_search_fts, 1, char(1), char(2), '…', 16) AS snippet
           FROM page_search_fts WHERE page_search_fts MATCH ? AND +rowid IN (SELECT value FROM json_each(?))`,
                )
                .all(wordMatch(words), JSON.stringify(byWord.map((hit) => hit.row)))) {
                out.set(Number(row.row), snippetParts(String(row.snippet ?? '')));
            }
        }
        const byText = hits.filter((hit) => hit.matched === 'text');
        if (byText.length) {
            const parts = textWords(words);
            for (const row of this.db
                .prepare('SELECT id, body FROM page_search WHERE id IN (SELECT value FROM json_each(?))')
                .all(JSON.stringify(byText.map((hit) => hit.row)))) {
                out.set(Number(row.id), textSnippet(String(row.body), parts));
            }
        }
        return out;
    }

    /**
     * Searches the live pages of `spaces`. Every input is literal; the
     * answer is at most `limit` (1 to 20) hits from `offset` (up to 180).
     */
    search(options: SearchOptions): PageSearchResult {
        const started = performance.now();
        const now = options.now ?? Date.now();
        const limit = Math.min(PAGE_SEARCH_MAX_LIMIT, Math.max(1, Math.floor(options.limit ?? PAGE_SEARCH_LIMIT)));
        const offset = Math.min(PAGE_SEARCH_MAX_OFFSET, Math.max(0, Math.floor(options.offset ?? 0)));
        let words = queryWords(options.query);
        const empty = {
            query: words.join(' '),
            corrected: null,
            results: [],
            more: false,
        };
        if (!words.length || !options.spaces.length) {
            return empty;
        }
        const need = offset + limit + 1;
        let { found, trigram } = this.find(words, options.spaces, need);
        let corrected: string | null = null;
        if (!found.length && !options.exact) {
            for (const attempt of this.corrections(words) ?? []) {
                const again = this.find(attempt, options.spaces, need);
                if (again.found.length) {
                    ({ found, trigram } = again);
                    words = attempt;
                    corrected = attempt.join(' ');
                    break;
                }
            }
        }
        const ranked = this.rank(found, words, now);
        const page = ranked.slice(offset, offset + limit);
        const snippets = this.snippets(
            page.map((entry) => entry.hit),
            words,
        );
        const results: PageHit[] = page.map(({ hit, fresh }) => ({
            id: hit.id,
            spaceId: hit.spaceId,
            title: hit.title,
            updatedAt: hit.updatedAt,
            snippet: snippets.get(hit.row) ?? [],
            matched: hit.matched,
            freshness: { basis: fresh.basis, at: fresh.at },
        }));
        this.record(performance.now() - started, now, {
            empty: !found.length,
            corrected: !!corrected,
            trigram,
        });
        return {
            query: words.join(' '),
            corrected,
            results,
            more: ranked.length > offset + limit,
        };
    }

    /** The words a hit's snippet marks, as plain text with `**…**` (Dots). */
    static markdownSnippet(parts: readonly SnippetPart[]) {
        return markdownSnippet(parts);
    }

    /**
     * Counts a use of a live page by a person (opened from a search, or
     * read by a Dot for them): once per person, page and UTC day. The
     * caller checked the page is live and the person may read it. Returns
     * whether it counted.
     */
    async recordUse(pageId: string, userId: string, now = Date.now()) {
        const day = Math.floor(now / DAY);
        const keep = this.retention().pageUseDays;
        // One unit of work: queued behind another chain's (a parallel tool
        // call, CB-110), never inside it.
        return sqliteData(this.db).uow.run(
            async () => {
                const { use } = this.repos;
                if (keep > 0) {
                    await use.pruneDaysBefore(day - keep + 1);
                }
                const counted = await use.addDay(pageId, userId, day);
                if (counted) {
                    const previous = await use.use(pageId);
                    const score = previous ? previous.score * decay(now - previous.scoredAt) + 1 : 1;
                    await use.put(pageId, { score, scoredAt: now, usedAt: now });
                }
                return counted;
            },
            { label: 'note page use', savepoint: true },
        );
    }

    private record(ms: number, now: number, flags: { empty: boolean; corrected: boolean; trigram: boolean }) {
        const day = dayOf(now);
        const counts = this.pending.get(day) ?? {
            queries: 0,
            empty: 0,
            corrected: 0,
            trigram: 0,
            maxMs: 0,
            histogram: {},
        };
        counts.queries++;
        if (flags.empty) {
            counts.empty++;
        }
        if (flags.corrected) {
            counts.corrected++;
        }
        if (flags.trigram) {
            counts.trigram++;
        }
        counts.maxMs = Math.max(counts.maxMs, ms);
        const bucket = bucketOf(ms);
        counts.histogram[bucket] = (counts.histogram[bucket] ?? 0) + 1;
        this.pending.set(day, counts);
        // At most one write a minute, not one per keystroke.
        if (now - this.flushedAt >= 60_000) {
            this.flush(now);
        }
    }

    /** The index's sizes now, from `dbstat`. */
    sizes(): SearchIndexSizes {
        const bytes = this.db.prepare(
            'SELECT COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat WHERE name = ? AND aggregate = TRUE',
        );
        const sum = (names: string[]) => names.reduce((total, name) => total + Number(bytes.get(name)?.bytes ?? 0), 0);
        const shadows = (table: string) => ['data', 'idx', 'docsize', 'config'].map((part) => `${table}_${part}`);
        return {
            pages: Number(this.db.prepare('SELECT COUNT(*) AS n FROM page_search').get()?.n ?? 0),
            textBytes: sum(['page_search', 'sqlite_autoindex_page_search_1']),
            wordBytes: sum(shadows('page_search_fts')),
            trigramBytes: sum(shadows('page_search_tri')),
        };
    }

    /** Writes the pending counts into the daily rollup and prunes old days. */
    flush(now = Date.now()) {
        // Not inside another chain's unit of work (CB-110): the counts wait
        // for the next search or flush.
        if (!this.pending.size || !sqliteData(this.db).uow.writable) {
            return;
        }
        this.flushedAt = now;
        const days = [...this.pending].map(([day, counts]): SearchDay => {
            const row = this.daily.day(day);
            const histogram: Record<number, number> = row ? JSON.parse(row.histogram) : {};
            for (const [bucket, count] of Object.entries(counts.histogram)) {
                histogram[Number(bucket)] = (histogram[Number(bucket)] ?? 0) + count;
            }
            return {
                day,
                queries: (row?.queries ?? 0) + counts.queries,
                empty: (row?.empty ?? 0) + counts.empty,
                corrected: (row?.corrected ?? 0) + counts.corrected,
                trigram: (row?.trigram ?? 0) + counts.trigram,
                maxMs: Math.max(row?.maxMs ?? 0, counts.maxMs),
                histogram: JSON.stringify(histogram),
                sizes: row?.sizes ? row.sizes : JSON.stringify(this.sizes()),
            };
        });
        const keep = this.retention().pageSearchDays;
        this.daily.save(days, keep > 0 ? dayOf(now - keep * DAY) : undefined);
        this.pending.clear();
    }

    /** The rollup, newest day first, and the index's sizes now (operators). */
    stats(days = 30, now = Date.now()): SearchStatsView {
        this.flush(now);
        return {
            days: this.daily.latest(days).map((row) => {
                const histogram = JSON.parse(row.histogram) as Record<number, number>;
                const maxMs = Math.round(row.maxMs * 100) / 100;
                // A bucket's middle can lie above the slowest search itself.
                const at = (p: number) => {
                    const value = percentile(histogram, p);
                    return value === null ? null : Math.min(value, maxMs);
                };
                return {
                    day: row.day,
                    queries: row.queries,
                    empty: row.empty,
                    corrected: row.corrected,
                    trigram: row.trigram,
                    p50: at(50),
                    p95: at(95),
                    p99: at(99),
                    maxMs,
                    sizes: row.sizes ? (JSON.parse(row.sizes) as SearchIndexSizes) : null,
                };
            }),
            now: this.sizes(),
        };
    }
}
