import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    BOARD_STATUSES,
    byVotes,
    compareBoardOrder,
    dotRequestsOnly,
    type FacetName,
    filterIssues,
    groupByStatus,
    isDotRequest,
    issueCounts,
    type IssueFilters,
    NO_FILTERS,
    toggleDotRequests,
} from '@socio/shared/issues/issue-board';
import {
    CLOSED_ISSUE_STATUSES,
    ISSUE_AREAS,
    ISSUE_KINDS,
    ISSUE_LABELS,
    ISSUE_PRIORITIES,
    ISSUE_STATUSES,
    type IssueStatus,
    type IssueSummary,
} from '@socio/shared/issues/issue-types';
import { foldText } from '@socio/shared/pages/page-search';

import { openCacheDb } from '../src/data';
import type { AuthedFetch } from '../src/net/authed-fetch';
import { boardView, type BoardPrefs } from '../src/shell/board';
import { cleanupScopeCollections, createScopeCollections } from '../src/sync/collections';
import { searchIssues, shownIssueMatches } from '../src/sync/issue-search';
import { ISSUES_SNAPSHOT, USERS_KEY } from '../src/sync/issues';
import { openSnapshotCache } from '../src/sync/snapshot-cache';
import { createSnapshotSource } from '../src/sync/snapshot-source';
import { createNodeSqliteDriver } from '../tests/helpers/node-sqlite-driver';

// Board parity on live data: the
// Board's filters, sorts and counts on the phone against the web's, over one
// capture of a workspace's `GET /api/issues` and `GET /api/issues/search`
// bodies (e2e/board-parity.mjs takes it, read-only). Both clients call shared's
// functions, so comparing them alone would compare a function with
// itself. Each side takes its own road from the same bytes instead:
// - **the app's** is its sync path: the raw body through the issues kind's
//   snapshot source (`split`, `mergeSnapshot`, cache.db), the scope's
//   `issues` collection (keyed by number, so the server's order is lost), and
//   the Board's view model (`boardView`: `compareBoardOrder`, the filters, one
//   column at a time), with the search's matches from `searchIssues`;
// - **the web's** takes the parsed body in the server's order and calls the
//   shared functions as IssuesPage.tsx does (`filterIssues`, `byVotes`,
//   `groupByStatus`, `issueCounts`, the statuses it shows), with
//   useIssueSearch's `new Set(numbers)`.
// The matrix: every facet value, every pair of values of two facets with live
// rows, the "Socio requests" lane, the queries (the server's matches, and the
// local filter offline), "Most votes", won't fix on and off. A case compares
// the columns, each column's issues in order, the shown and total counts, the
// header's line, the lane's count and won't fix's. No React Native: tests/
// runs it under Node too.

/** One capture of the workspace: the raw bodies, as the server sent them. */
export interface ParityCapture {
    /** `GET /api/issues`'s body. */
    readonly issues: string;
    /** `GET /api/issues/search?q=`'s body, by query. */
    readonly searches: Readonly<Record<string, string>>;
}

/** The queries asked: words most boards hold, a key, two words, a folded accent and one that matches nothing. */
export const PARITY_QUERIES: readonly string[] = [
    'board',
    'mobile',
    'search',
    'sync',
    'error',
    'page',
    'CB-1',
    'chat message',
    'Café',
    'xqzvw',
];

/** One of the board's settings, as both clients are set. */
export interface ParitySetting {
    /** The matrix's group: `baseline`, `single`, `pair`, `lane`, `query`. */
    readonly group: string;
    /** What it sets, in words with no row data (`priority=high`, `q="board" local`). */
    readonly name: string;
    readonly filters: IssueFilters;
    readonly byVotes: boolean;
    readonly wontFix: boolean;
    /** Whether the server's matches have answered (`server`) or the board filters what it holds (`local`). */
    readonly search: 'server' | 'local';
}

/** A board as one client lays it out. */
export interface SideBoard {
    readonly statuses: readonly IssueStatus[];
    /** Each shown column's issue numbers, in order. */
    readonly columns: Readonly<Partial<Record<IssueStatus, readonly number[]>>>;
    /** Each column's count as its header says it (the web's column head, the app's status chip). */
    readonly chips: Readonly<Partial<Record<IssueStatus, number>>>;
    /** The toolbar's numbers: shown of total. */
    readonly shown: number;
    readonly total: number;
    /** The header's line: "3 open · 1 in progress · 1 done". */
    readonly header: string;
    readonly dotRequests: number;
    readonly dotRequestsOnly: boolean;
    readonly wontFix: number;
}

/** A case's outcome: what differs, by issue number (no titles). */
export interface ParityResult {
    readonly group: string;
    readonly name: string;
    readonly pass: boolean;
    /** The issues the web shows in its columns. */
    readonly rows: number;
    readonly differences: readonly string[];
}

const FACETS: readonly { readonly name: FacetName; readonly values: readonly string[] }[] = [
    { name: 'status', values: ISSUE_STATUSES },
    { name: 'priority', values: ISSUE_PRIORITIES },
    { name: 'kind', values: ISSUE_KINDS },
    { name: 'area', values: ISSUE_AREAS },
    { name: 'label', values: ISSUE_LABELS },
];

const withFacet = (filters: IssueFilters, facet: FacetName, value: string): IssueFilters => ({
    ...filters,
    [facet]: [value],
});

const setting = (
    group: string,
    name: string,
    filters: IssueFilters,
    options: { byVotes?: boolean; wontFix?: boolean; search?: 'server' | 'local' } = {},
): ParitySetting => ({
    group,
    name,
    filters,
    byVotes: options.byVotes ?? false,
    wontFix: options.wontFix ?? false,
    search: options.search ?? 'server',
});

/** The server's list, parsed, in its order: what the web's useIssues holds. */
export function serverIssues(capture: ParityCapture): IssueSummary[] {
    return (JSON.parse(capture.issues) as { issues: IssueSummary[] }).issues;
}

/**
 * The matrix over `issues` (the web's): the baseline with "Most votes" and
 * won't fix on and off, every facet value (live rows or none), every pair of
 * two facets' values that shows a row, the lane, and each query with the
 * server's matches and offline.
 */
export function paritySettings(issues: readonly IssueSummary[], queries: readonly string[]): ParitySetting[] {
    const settings: ParitySetting[] = [];
    for (const byVotes of [false, true]) {
        for (const wontFix of [false, true]) {
            settings.push(
                setting('baseline', `all${byVotes ? ', most votes' : ''}${wontFix ? ', won’t fix' : ''}`, NO_FILTERS, {
                    byVotes,
                    wontFix,
                }),
            );
        }
    }
    for (const facet of FACETS) {
        for (const value of facet.values) {
            const filters = withFacet(NO_FILTERS, facet.name, value);
            settings.push(setting('single', `${facet.name}=${value}`, filters));
            settings.push(setting('single', `${facet.name}=${value}, most votes`, filters, { byVotes: true }));
        }
    }
    FACETS.forEach((first, index) => {
        for (const second of FACETS.slice(index + 1)) {
            for (const a of first.values) {
                for (const b of second.values) {
                    const filters = withFacet(withFacet(NO_FILTERS, first.name, a), second.name, b);
                    if (filterIssues(issues, filters).length > 0) {
                        settings.push(setting('pair', `${first.name}=${a} & ${second.name}=${b}`, filters));
                    }
                }
            }
        }
    });
    const lane = toggleDotRequests(NO_FILTERS);
    settings.push(setting('lane', 'socio requests', lane));
    settings.push(setting('lane', 'socio requests, most votes', lane, { byVotes: true }));
    settings.push(setting('lane', 'socio requests, won’t fix', lane, { wontFix: true }));
    for (const query of queries) {
        const filters = { ...NO_FILTERS, q: query };
        settings.push(setting('query', `q="${query}"`, filters));
        settings.push(setting('query', `q="${query}", most votes`, filters, { byVotes: true }));
        settings.push(setting('query', `q="${query}" offline`, filters, { search: 'local' }));
        settings.push(
            setting('query', `q="${query}" & status=open`, withFacet(filters, 'status', 'open'), { search: 'server' }),
        );
    }
    return settings;
}

// ---- The web's side ---------------------------------------------------------------

/** The search's matches as useIssueSearch gives them: none for an empty query or before an answer. */
function webMatches(capture: ParityCapture, setting: ParitySetting): ReadonlySet<number> | undefined {
    const body = capture.searches[setting.filters.q];
    if (setting.search === 'local' || foldText(setting.filters.q) === '' || body === undefined) {
        return undefined;
    }
    return new Set((JSON.parse(body) as { numbers: number[] }).numbers);
}

/** IssuesPage.tsx's board for `setting`, over the server's list in its order. */
export function webBoard(capture: ParityCapture, all: readonly IssueSummary[], setting: ParitySetting): SideBoard {
    const { filters } = setting;
    const matching = filterIssues(all, filters, webMatches(capture, setting));
    const shown = setting.byVotes ? byVotes(matching) : matching;
    const counts = issueCounts(all);
    const statuses = filters.status.length
        ? ISSUE_STATUSES.filter((status) => filters.status.includes(status))
        : setting.wontFix
          ? [...BOARD_STATUSES, 'wont_fix' as const]
          : BOARD_STATUSES;
    const groups = groupByStatus(shown);
    return {
        statuses,
        columns: Object.fromEntries(statuses.map((status) => [status, groups[status].map((issue) => issue.number)])),
        chips: Object.fromEntries(statuses.map((status) => [status, groups[status].length])),
        shown: shown.length,
        total: all.length,
        header: `${counts.open} open · ${counts.inProgress} in progress · ${counts.done} done`,
        dotRequests: all.filter((issue) => isDotRequest(issue) && !CLOSED_ISSUE_STATUSES.includes(issue.status)).length,
        dotRequestsOnly: dotRequestsOnly(filters),
        wontFix: all.filter((issue) => issue.status === 'wont_fix').length,
    };
}

// ---- The app's side ---------------------------------------------------------------

/** A fetch that answers the raw body, as the server did. */
const answering =
    (body: string): AuthedFetch =>
    async () =>
        new Response(body, { status: 200, headers: { 'content-type': 'application/json', etag: '"parity"' } });

/** What the app holds after one pull of the capture: the scope's collections' rows. */
export interface AppHolding {
    /** The `issues` collection's rows, in its order (by key, not the server's). */
    readonly issues: readonly IssueSummary[];
    readonly users: Readonly<Record<string, string>>;
    /** `searchIssues`' answer, by query. */
    readonly matches: ReadonlyMap<string, ReadonlySet<number>>;
}

/**
 * The capture through the app's sync path: the issues kind's snapshot source
 * pulls the raw body into a real cache.db (`split`, `mergeSnapshot`), and the
 * scope's collections mirror it; each query's body goes through `searchIssues`.
 */
export async function appHolding(capture: ParityCapture): Promise<AppHolding> {
    const directory = mkdtempSync(join(tmpdir(), 'socio-board-parity-'));
    const { db } = await openCacheDb(createNodeSqliteDriver(), directory, '0f'.repeat(32));
    const cache = await openSnapshotCache({ db, definitions: [] });
    try {
        const source = createSnapshotSource({ definition: ISSUES_SNAPSHOT, cache, fetch: answering(capture.issues) });
        const pulled = await source.pull('', null);
        if (pulled.outcome !== 'changed') {
            throw new Error(`The issues kind's pull answered ${pulled.outcome}.`);
        }
        await cache.flush();
        const collections = createScopeCollections('board-parity', cache, []);
        const issues = [...collections.issues.values()];
        const users = collections.issueUsers.get(USERS_KEY)?.value ?? {};
        await cleanupScopeCollections(collections);
        const matches = new Map<string, ReadonlySet<number>>();
        for (const [query, body] of Object.entries(capture.searches)) {
            matches.set(query, await searchIssues(answering(body), query));
        }
        return { issues, users, matches };
    } finally {
        await cache.close();
        await db.close();
        rmSync(directory, { recursive: true, force: true });
    }
}

const COUNT_LINE = /^(\d+) of (\d+)$|^(\d+) issues?$/;

/** The Board's view model for `setting`, every column in turn (the phone shows one at a time). */
export function appBoard(holding: AppHolding, setting: ParitySetting): SideBoard {
    const query = setting.filters.q;
    const kept = holding.matches.get(query);
    const matches =
        setting.search === 'server' && kept !== undefined
            ? shownIssueMatches({ query: foldText(query), matches: kept }, query)
            : undefined;
    const prefs: BoardPrefs = {
        filters: { ...setting.filters, q: '' },
        column: null,
        wontFix: setting.wontFix,
        byVotes: setting.byVotes,
        view: 'board',
        components: [],
    };
    const input = { issues: holding.issues, users: holding.users, overlays: [], prefs, query, matches };
    const view = boardView(input);
    const statuses = view.columns.map((column) => column.status);
    const columns: Partial<Record<IssueStatus, readonly number[]>> = {};
    for (const status of statuses) {
        const shown = boardView({ ...input, prefs: { ...prefs, column: status } });
        columns[status] = shown.rows.flatMap((row) => (row.type === 'issue' ? [row.number] : []));
    }
    const count = COUNT_LINE.exec(view.countLine);
    if (count === null) {
        throw new Error(`The board's count line reads "${view.countLine}".`);
    }
    const [shown, total] =
        count[3] === undefined ? [Number(count[1]), Number(count[2])] : [Number(count[3]), Number(count[3])];
    return {
        statuses,
        columns,
        chips: Object.fromEntries(view.columns.map((column) => [column.status, column.count])),
        shown,
        total,
        header: view.subtitle,
        dotRequests: view.dotRequests,
        dotRequestsOnly: view.dotRequestsOnly,
        wontFix: view.wontFix.count,
    };
}

// ---- Comparing ---------------------------------------------------------------------

/** What differs between the two boards, by issue number. */
export function boardDifferences(web: SideBoard, app: SideBoard): string[] {
    const differences: string[] = [];
    const same = (what: string, a: unknown, b: unknown) => {
        if (JSON.stringify(a) !== JSON.stringify(b)) {
            differences.push(`${what}: web ${JSON.stringify(a)}, app ${JSON.stringify(b)}`);
        }
    };
    same('columns', web.statuses, app.statuses);
    for (const status of web.statuses) {
        const a = web.columns[status] ?? [];
        const b = app.columns[status] ?? [];
        same(`${status} count`, a.length, b.length);
        same(`${status} header count`, web.chips[status], app.chips[status]);
        if (a.length === b.length) {
            same(`${status} order`, a, b);
        } else {
            const missing = a.filter((n) => !b.includes(n));
            const extra = b.filter((n) => !a.includes(n));
            differences.push(
                `${status} rows: only on the web ${JSON.stringify(missing)}, only in the app ${JSON.stringify(extra)}`,
            );
        }
    }
    same('shown', web.shown, app.shown);
    same('total', web.total, app.total);
    same('header', web.header, app.header);
    same('socio requests', web.dotRequests, app.dotRequests);
    same('lane on', web.dotRequestsOnly, app.dotRequestsOnly);
    same('won’t fix', web.wontFix, app.wontFix);
    return differences;
}

/** The server's order against `compareBoardOrder`'s: the issues out of place, by number. */
export function serverOrderDifferences(all: readonly IssueSummary[]): string[] {
    const sorted = [...all].sort(compareBoardOrder).map((issue) => issue.number);
    const server = all.map((issue) => issue.number);
    const out = server.flatMap((number, index) =>
        sorted[index] === number ? [] : [`#${index}: server ${number}, compareBoardOrder ${sorted[index]}`],
    );
    return out;
}

/** The whole run over one capture: the server's order, then every setting. */
export async function runParity(
    capture: ParityCapture,
    queries: readonly string[] = Object.keys(capture.searches),
): Promise<ParityResult[]> {
    const all = serverIssues(capture);
    const holding = await appHolding(capture);
    const order = serverOrderDifferences(all);
    const results: ParityResult[] = [
        {
            group: 'order',
            name: 'compareBoardOrder = the server’s order',
            pass: order.length === 0,
            rows: all.length,
            differences: order,
        },
        {
            group: 'order',
            name: 'the app holds every issue once',
            pass: holding.issues.length === all.length,
            rows: holding.issues.length,
            differences:
                holding.issues.length === all.length ? [] : [`web ${all.length}, app ${holding.issues.length}`],
        },
    ];
    for (const one of paritySettings(all, queries)) {
        const web = webBoard(capture, all, one);
        const differences = boardDifferences(web, appBoard(holding, one));
        const rows = Object.values(web.columns).reduce((sum, column) => sum + column.length, 0);
        results.push({ group: one.group, name: one.name, pass: differences.length === 0, rows, differences });
    }
    return results;
}

/** Each group's cases and passes, and the whole run's. */
export function paritySummary(results: readonly ParityResult[]) {
    const groups = new Map<string, { cases: number; passed: number; rows: number }>();
    for (const result of results) {
        const group = groups.get(result.group) ?? { cases: 0, passed: 0, rows: 0 };
        group.cases += 1;
        group.passed += result.pass ? 1 : 0;
        group.rows += result.rows;
        groups.set(result.group, group);
    }
    const cases = results.length;
    const passed = results.filter((result) => result.pass).length;
    return { cases, passed, pass: cases > 0 && passed === cases, groups: Object.fromEntries(groups) };
}
