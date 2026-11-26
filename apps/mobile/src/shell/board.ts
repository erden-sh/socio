import {
    areaLabel,
    BOARD_STATUSES,
    byVotes,
    compareBoardOrder,
    dotRequestsOnly,
    filterIssues,
    filtersActive,
    groupByStatus,
    isDotRequest,
    issueCounts,
    KIND_LABEL,
    NO_FILTERS,
    PRIORITY_LABEL,
    STATUS_LABEL,
    type FacetName,
    type IssueFilters,
} from '@socio/shared/issues/issue-board';
import {
    CLOSED_ISSUE_STATUSES,
    DOT_REQUEST_LABEL,
    ISSUE_AREAS,
    ISSUE_KINDS,
    ISSUE_LABELS,
    ISSUE_PRIORITIES,
    ISSUE_STATUSES,
    issueKey as keyLabel,
    type IssuePriority,
    type IssueStatus,
    type IssueSummary,
} from '@socio/shared/issues/issue-types';
import { foldText } from '@socio/shared/pages/page-search';

import { issueCreateKind } from '../sync/issue-create';
import { ISSUE_EDIT_VIEWS } from '../sync/issue-edit';
import { issueKey, ISSUES } from '../sync/issues';
import { OUTBOX_COPY } from '../sync/outbox';
import type { OverlayItem, OverlayKind } from '../sync/outbox-overlay';
import type { ToneName } from '../theme/theme';
import { searchEmpty, type SearchEmptyView } from '../ui/search-empty';

import {
    type ComponentChipsView,
    componentChips,
    componentFacetOptions,
    type ComponentLabels,
    componentsSpoken,
    componentText,
    filterByComponents,
    keptComponents,
} from './issue-components';
import { PENDING_ISSUE_COLUMN, type PendingIssueRow, pendingIssueRows } from './issue-filing';

// The Board: the web's
// IssuesPage on a phone. The rules are shared's: `filterIssues`, the
// facets and the "Socio requests" lane, "Most votes", the columns and the
// header's counts, so both clients lay the list out alike. What the phone adds:
// - **One column at a time** (CB-249): a sideways row of status chips, each
//   with its count, picks the column one vertical list shows. As on the web, a
//   status filter picks the columns, and won't fix shows on request otherwise.
// - **Its own writes laid over:** a pending priority or vote changes the
//   row, which is then sorted with `compareBoardOrder` (the collection keeps
//   rows by key, not in the server's order), and marked "Waiting to send" until
//   the server has it. Filings not yet numbered (`CB-?`) sit at the top of Triage.
// - **Kept per workspace** (the scope's `kv`): the facets, the lane, "Most
//   votes", won't fix, the chosen column and the board or list view (the web
//   keeps that one in the browser's localStorage, `issues-view`, and a web
//   origin is one workspace: so here, on this phone, per workspace). The
//   search text isn't kept.
// - **The list** (the web's IssueList): every status as a section with
//   its count, empty ones left out, done and won't fix folded at first; a row
//   is the web's list row (the priority's edge, key and title, the excerpt).
// - **Select** (the web's Select mode, admins only): each issue row says
//   whether it is picked; the batch actions are board-select.ts's.
// - **Components** (CB-442): the web's Component facet beside the five, its
//   values the refs on the listed issues (exact match), kept with the other
//   choices; each card and row carries the web's small chips, two then "+n",
//   named by the list's label map, which the phone keeps (`issue-components`),
//   so they read offline.
// No React Native: tests/shell runs it under Node.

/** The view state key the board's choices are kept under. */
export const BOARD_PREFS_KEY = 'board';

/** What the board keeps between visits. */
export interface BoardPrefs {
    /** The facets and the lane; `q` is always empty here (the search isn't kept). */
    readonly filters: IssueFilters;
    /** The chosen column; the first shown when null or no longer shown. */
    readonly column: IssueStatus | null;
    readonly wontFix: boolean;
    readonly byVotes: boolean;
    /** The board (one column at a time) or the list (sections), the web's toggle. */
    readonly view: BoardLayout;
    /** The Component facet's chosen refs (CB-442), outside shared's IssueFilters as on the web. */
    readonly components: readonly string[];
}

/** The web's IssueView: the board or the list. */
export type BoardLayout = 'board' | 'list';

export const NO_BOARD_PREFS: BoardPrefs = {
    filters: NO_FILTERS,
    column: null,
    wontFix: false,
    byVotes: false,
    view: 'board',
    components: [],
};

/** The list's sections that start folded: the closed ones (the web's COLLAPSED_BY_DEFAULT). */
export const COLLAPSED_BY_DEFAULT: readonly IssueStatus[] = ['done', 'wont_fix'];

const FACET_VALUES: Record<FacetName, readonly string[]> = {
    status: ISSUE_STATUSES,
    priority: ISSUE_PRIORITIES,
    kind: ISSUE_KINDS,
    area: ISSUE_AREAS,
    label: ISSUE_LABELS,
};
const FACET_NAMES = Object.keys(FACET_VALUES) as FacetName[];

/** The kept choices read back: anything unknown dropped, the defaults where nothing usable was kept. */
export function readBoardPrefs(text: string | null): BoardPrefs {
    let value: unknown;
    try {
        value = text === null ? null : JSON.parse(text);
    } catch {
        value = null;
    }
    if (typeof value !== 'object' || value === null) {
        return NO_BOARD_PREFS;
    }
    const kept = value as Record<string, unknown>;
    const filters = (typeof kept.filters === 'object' && kept.filters !== null ? kept.filters : {}) as Record<
        string,
        unknown
    >;
    const facets = Object.fromEntries(
        FACET_NAMES.map((facet) => {
            const chosen = Array.isArray(filters[facet]) ? (filters[facet] as unknown[]) : [];
            return [facet, FACET_VALUES[facet].filter((option) => chosen.includes(option))];
        }),
    ) as Omit<IssueFilters, 'q'>;
    return {
        filters: { ...facets, q: '' },
        column: (ISSUE_STATUSES as readonly unknown[]).includes(kept.column) ? (kept.column as IssueStatus) : null,
        wontFix: kept.wontFix === true,
        byVotes: kept.byVotes === true,
        view: kept.view === 'list' ? 'list' : 'board',
        components: keptComponents(kept.components, 50),
    };
}

/** The choices as the view state keeps them, without the search text. */
export const boardPrefsText = (prefs: BoardPrefs) => JSON.stringify({ ...prefs, filters: { ...prefs.filters, q: '' } });

// ---- Tones (10.1: every pair tests/shell/board.test.ts measures) -----------------

/** A priority's pill (the web's PRIORITY_PILL_TONE): its word in the tone, on the tone's tile. */
export const PRIORITY_TONE: Record<IssuePriority, ToneName> = {
    critical: 'rose',
    high: 'orange',
    medium: 'sky',
    low: 'slate',
};

/** A status's dot (the web's STATUS_RING hues, in the app's tones): a mark beside its word, never alone. */
export const STATUS_TONE: Record<IssueStatus, ToneName> = {
    triage: 'violet',
    open: 'sky',
    ready: 'emerald',
    in_progress: 'amber',
    in_review: 'indigo',
    blocked: 'rose',
    done: 'emerald',
    wont_fix: 'slate',
};

/** A socio request's demand and a blocked issue's wait, as words on their tone's tile. */
/**
 * A status chip's mark: the web's StatusRing (IssueBadges.tsx, `size-2 rounded-full border-[1.5px]
 * border-current` in the status's tone), a hollow ring, never a filled dot.
 */
export const STATUS_RING = { size: 8, borderWidth: 1.5 } as const;

/** The Board's search field's name for screen readers; the field shows only its icon and "Search". */
export const ISSUE_SEARCH_LABEL = 'Search issues';
export const ISSUE_SEARCH_PLACEHOLDER = 'Search';

export const DEMAND_TONE: ToneName = 'violet';
export const BLOCKED_TONE: ToneName = 'amber';

// ---- Words --------------------------------------------------------------------

/** What a label says: the socio request's label in words (never "dot"), the rest as they are. */
export const labelWords = (label: string) => (label === DOT_REQUEST_LABEL ? 'Socio request' : label);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The header's line under the title, the web's: "3 open · 1 in progress · 1 done". */
export function boardSubtitle(issues: readonly IssueSummary[]): string {
    const counts = issueCounts(issues);
    return `${counts.open} open · ${counts.inProgress} in progress · ${counts.done} done`;
}

/** The filter sheet's facets, in the web's order, each option in words. */
export const BOARD_FACETS: readonly {
    readonly name: FacetName;
    readonly label: string;
    readonly options: readonly { readonly value: string; readonly label: string }[];
}[] = [
    { name: 'status', label: 'Status', options: ISSUE_STATUSES.map((v) => ({ value: v, label: STATUS_LABEL[v] })) },
    {
        name: 'priority',
        label: 'Priority',
        options: ISSUE_PRIORITIES.map((v) => ({ value: v, label: PRIORITY_LABEL[v] })),
    },
    { name: 'kind', label: 'Kind', options: ISSUE_KINDS.map((v) => ({ value: v, label: KIND_LABEL[v] })) },
    { name: 'area', label: 'Area', options: ISSUE_AREAS.map((v) => ({ value: v, label: areaLabel(v) })) },
    { name: 'label', label: 'Label', options: ISSUE_LABELS.map((v) => ({ value: v, label: labelWords(v) })) },
];

/** The Component facet's title (the web's FacetMenu label). */
export const COMPONENT_FACET_LABEL = 'Component';

/** A component's value turned on or off in the facet. */
export const toggleComponentFacet = (chosen: readonly string[], ref: string): string[] =>
    chosen.includes(ref) ? chosen.filter((item) => item !== ref) : [...chosen, ref];

/** A facet's value turned on or off. */
export function toggleFacet(filters: IssueFilters, facet: FacetName, value: string): IssueFilters {
    const chosen = filters[facet] as readonly string[];
    return {
        ...filters,
        [facet]: chosen.includes(value) ? chosen.filter((v) => v !== value) : [...chosen, value],
    };
}

// ---- Overlays -------------------------------------------------------------------

/** The writes laid over the board's rows (`overlaysOf`'s kinds): filings, field edits and votes. */
export const BOARD_VIEWS: readonly OverlayKind<unknown>[] = [
    issueCreateKind() as OverlayKind<unknown>,
    ...ISSUE_EDIT_VIEWS,
];

/** An issue with this device's pending edits and vote laid over, and their mark while they wait. */
export interface ShownIssue {
    readonly issue: IssueSummary;
    /** 10.2's words while one of its writes waits or goes; null when none does. */
    readonly pending: string | null;
}

/**
 * The issues with the pending field edits and votes laid over (`overlaysOf`'s
 * patches on `issues`). A refused write lays nothing over: the row shows the
 * server's values, and the Unsent list says why. One sent and not yet in the
 * list keeps its values with no mark, so it never flickers back.
 */
export function withIssueWrites(issues: readonly IssueSummary[], overlays: readonly OverlayItem[]): ShownIssue[] {
    const patches = new Map<string, { value: Record<string, unknown>; pending: string | null }>();
    for (const item of overlays) {
        if (item.collection !== ISSUES || item.mode !== 'patch' || item.state === 'unsent') {
            continue;
        }
        const before = patches.get(item.key);
        const words =
            item.state === 'sent'
                ? null
                : item.state === 'unconfirmed'
                  ? OUTBOX_COPY.unconfirmed
                  : OUTBOX_COPY.waitingToSend;
        patches.set(item.key, {
            value: { ...before?.value, ...(item.value as Record<string, unknown>) },
            // "Couldn't confirm" says more than "Waiting to send".
            pending: before?.pending === OUTBOX_COPY.unconfirmed ? before.pending : (words ?? before?.pending ?? null),
        });
    }
    return issues.map((issue) => {
        const patch = patches.get(issueKey(issue.number));
        return patch === undefined
            ? { issue, pending: null }
            : { issue: { ...issue, ...patch.value } as IssueSummary, pending: patch.pending };
    });
}

// ---- The view -----------------------------------------------------------------

/** A status chip of the column picker: one tab. */
export interface BoardColumn {
    readonly status: IssueStatus;
    readonly label: string;
    readonly count: number;
    readonly selected: boolean;
    readonly tone: ToneName;
    /** "Triage, 2 issues": the count said with the label. */
    readonly accessibilityLabel: string;
    readonly testID: string;
}

/** An issue's row, the web's card: every mark with its words, never color alone. */
export interface BoardIssueRow {
    readonly type: 'issue';
    /** The number as text: the list's key and the detail's. */
    readonly key: string;
    readonly number: number;
    /** `CB-12`. */
    readonly label: string;
    readonly title: string;
    readonly priority: IssuePriority;
    readonly priorityLabel: string;
    readonly priorityTone: ToneName;
    /** "Bug · Server". */
    readonly kindArea: string;
    /** The kind and the area as the list row's tags: ["Bug", "Server"]. */
    readonly kindTags: readonly string[];
    /** Its labels in words, the socio request's included. */
    readonly tags: readonly string[];
    readonly votes: number;
    readonly voted: boolean;
    /** "2 asks", for a socio request; null otherwise. */
    readonly demand: string | null;
    /** "Blocked by 1", while an issue it waits for is open; null otherwise. */
    readonly blocked: string | null;
    readonly assignee: { readonly name: string; readonly initials: string } | null;
    readonly pending: string | null;
    /** The description as one plain line (the web's list row shows it); empty when there is none. */
    readonly excerpt: string;
    /** In Select: whether it is picked; null outside Select. */
    readonly selected: boolean | null;
    /** The plugins and apps it is about (CB-442): two chips, then "+n". */
    readonly components: ComponentChipsView;
    readonly accessibilityLabel: string;
    readonly testID: string;
}

/** A section of the list: its status, its count, folded or open. */
export interface BoardSectionRow {
    readonly type: 'section';
    readonly key: string;
    readonly status: IssueStatus;
    readonly label: string;
    readonly count: number;
    readonly open: boolean;
    /** The list's first section: it rounds the card's top. */
    readonly first: boolean;
    readonly tone: ToneName;
    /** "Done, 3 issues, folded". */
    readonly accessibilityLabel: string;
    readonly testID: string;
}

/** A filing not yet numbered (`CB-?`), at the top of Triage. */
export interface BoardPendingRow extends PendingIssueRow {
    readonly type: 'pending';
    readonly testID: string;
}

export type BoardRow = BoardIssueRow | BoardPendingRow | BoardSectionRow;

export interface BoardInput {
    /** The `issues` collection's rows, in any order. */
    readonly issues: readonly IssueSummary[];
    /** The list's names for the assignees. */
    readonly users: Readonly<Record<string, string>>;
    /** The list's component labels (CB-442); none from a server before them. */
    readonly components?: ComponentLabels | null;
    /** `overlaysOf` the outbox's rows with the board's kinds. */
    readonly overlays: readonly OverlayItem[];
    /** The unconfirmed filings' candidates (`filingCandidates`). */
    readonly candidates?: ReadonlyMap<string, readonly string[]>;
    readonly prefs: BoardPrefs;
    /** The search field's text. */
    readonly query: string;
    /** The server's matches for `query`, once they have answered (`/api/issues/search`). */
    readonly matches?: ReadonlySet<number>;
    /** The list's folded sections (the screen's, not kept); COLLAPSED_BY_DEFAULT when not given. */
    readonly collapsed?: ReadonlySet<IssueStatus>;
    /** In Select: the picked issues' numbers; undefined outside Select. */
    readonly selection?: ReadonlySet<number>;
}

/** A column beside the chosen one: its status and the first rows a swipe brings in (CB-468). */
export interface BoardPeek {
    readonly status: IssueStatus;
    readonly rows: readonly BoardRow[];
    readonly empty: boolean;
}

/** The line under the Board's "no results" (CB-552). */
export const BOARD_EMPTY_LINE = 'Try other words or filters.';

/** How many of a neighbor's rows a swipe draws beside the cards: more than a phone's screen holds. */
export const PEEK_ROWS = 8;

export interface BoardView {
    /** "3 open · 1 in progress · 1 done", over every issue. */
    readonly subtitle: string;
    readonly columns: readonly BoardColumn[];
    readonly column: IssueStatus;
    readonly rows: readonly BoardRow[];
    /**
     * The columns either side of the chosen one, each with its first rows (CB-468): what a
     * sideways swipe brings in beside the cards, as a page view shows its next page. Null at
     * either end and in the list.
     */
    readonly neighbors: { readonly before: BoardPeek | null; readonly after: BoardPeek | null };
    /** "4 of 9" while filtered, "9 issues" otherwise (the web's toolbar count). */
    readonly countLine: string;
    readonly filtersActive: boolean;
    /** The facets and lane chosen, without the search: the filter button's count. */
    readonly facetCount: number;
    /** Open socio requests: the lane's count. */
    readonly dotRequests: number;
    readonly dotRequestsOnly: boolean;
    /** Won't fix issues; its choice shows only while no status filter picks the columns. */
    readonly wontFix: { readonly count: number; readonly offered: boolean };
    /** What the column says with no rows. */
    readonly empty: string;
    /**
     * The empty state a search or the filters leave (CB-552): "No results for “…”" or the web's "No
     * issues match", with Clear search and Clear filters for what is set; null with neither.
     */
    readonly noMatch: SearchEmptyView | null;
    /** This device's writes waiting on the whole board (every column, filtered or not): the announcement's count. */
    readonly pendingCount: number;
    /** The board or the list. */
    readonly layout: BoardLayout;
    /** Every issue the filters let through, in every column: what Select all picks (the web's `shown`). */
    readonly selectable: readonly number[];
    /**
     * The Component facet's values (CB-442): the refs on the listed issues and any
     * chosen, each named by the label map; empty (the facet left out) with none.
     */
    readonly componentFacet: readonly {
        readonly ref: string;
        readonly label: string;
        readonly selected: boolean;
        readonly testID: string;
    }[];
}

function initials(name: string): string {
    return name
        .split(/\s+/)
        .filter(Boolean)
        .map((part) => part[0])
        .join('')
        .slice(0, 2)
        .toUpperCase();
}

function issueRow(
    shown: ShownIssue,
    users: Readonly<Record<string, string>>,
    selection: ReadonlySet<number> | undefined,
    labels: ComponentLabels,
): BoardIssueRow {
    const { issue, pending } = shown;
    const label = keyLabel(issue.number);
    const name = issue.assigneeId ? (users[issue.assigneeId] ?? issue.assigneeId) : null;
    const votes = issue.votes ?? 0;
    const demand = issue.demand ? plural(issue.demand, 'ask') : null;
    const blockers = issue.openBlockers?.length ?? 0;
    const blocked = blockers > 0 ? `Blocked by ${blockers}` : null;
    const kindArea = `${KIND_LABEL[issue.kind]}${issue.area ? ` · ${areaLabel(issue.area)}` : ''}`;
    const tags = issue.labels.map(labelWords);
    const priorityLabel = PRIORITY_LABEL[issue.priority];
    const selected = selection === undefined ? null : selection.has(issue.number);
    return {
        type: 'issue',
        key: issueKey(issue.number),
        number: issue.number,
        label,
        title: issue.title,
        priority: issue.priority,
        priorityLabel,
        priorityTone: PRIORITY_TONE[issue.priority],
        kindArea,
        kindTags: [KIND_LABEL[issue.kind], ...(issue.area ? [areaLabel(issue.area)] : [])],
        tags,
        votes,
        voted: issue.voted === true,
        demand,
        blocked,
        assignee: name === null ? null : { name, initials: initials(name) },
        pending,
        excerpt: issue.excerpt,
        selected,
        components: componentChips(issue.components, labels),
        accessibilityLabel: [
            ...(selected === null ? [] : [selected ? 'Selected' : 'Not selected']),
            `${label}, ${issue.title}`,
            `${priorityLabel} priority`,
            kindArea,
            ...tags,
            ...componentsSpoken(issue.components, labels),
            plural(votes, 'vote'),
            ...(issue.voted === true ? ['You voted'] : []),
            ...(demand === null ? [] : [demand]),
            ...(blocked === null ? [] : [blocked]),
            ...(name === null ? [] : [`Assigned to ${name}`]),
            ...(pending === null ? [] : [pending]),
        ].join(', '),
        testID: `board-issue-${issue.number}`,
    };
}

/** The board as the screen draws it: the header's line, the column picker, the chosen column's rows. */
export function boardView(input: BoardInput): BoardView {
    const { prefs, query } = input;
    const filters: IssueFilters = { ...prefs.filters, q: query };
    const shown = withIssueWrites(input.issues, input.overlays).sort((a, b) => compareBoardOrder(a.issue, b.issue));
    const all = shown.map((item) => item.issue);
    const byNumber = new Map(shown.map((item) => [item.issue.number, item]));
    const labels = input.components ?? {};
    const matching = filterByComponents(filterIssues(all, filters, input.matches), prefs.components);
    const ordered = prefs.byVotes ? byVotes(matching) : matching;
    const groups = groupByStatus(ordered);
    const pending = pendingIssueRows(input.overlays, input.candidates);
    // A status filter picks the columns (won't fix too, when chosen); otherwise won't fix shows on request.
    const statuses: readonly IssueStatus[] = filters.status.length
        ? ISSUE_STATUSES.filter((status) => filters.status.includes(status))
        : prefs.wontFix
          ? [...BOARD_STATUSES, 'wont_fix']
          : BOARD_STATUSES;
    const column = prefs.column !== null && statuses.includes(prefs.column) ? prefs.column : statuses[0]!;
    const countOf = (status: IssueStatus) =>
        groups[status].length + (status === PENDING_ISSUE_COLUMN ? pending.length : 0);
    const columns = statuses.map((status): BoardColumn => ({
        status,
        label: STATUS_LABEL[status],
        count: countOf(status),
        selected: status === column,
        tone: STATUS_TONE[status],
        accessibilityLabel: `${STATUS_LABEL[status]}, ${plural(countOf(status), 'issue')}`,
        testID: `board-column-${status}`,
    }));
    const pendingRows = pending.map((row): BoardPendingRow => ({
        ...row,
        type: 'pending',
        testID: `board-pending-${row.key}`,
    }));
    const rowsOf = (status: IssueStatus): BoardRow[] => [
        ...(status === PENDING_ISSUE_COLUMN ? pendingRows : []),
        ...groups[status].map((issue) => issueRow(byNumber.get(issue.number)!, input.users, input.selection, labels)),
    ];
    const collapsed = input.collapsed ?? new Set(COLLAPSED_BY_DEFAULT);
    // The list: every status (or the filter's), empty sections left out, as the web's IssueList.
    const sections = (filters.status.length ? filters.status : ISSUE_STATUSES).filter((status) => countOf(status) > 0);
    const rows: BoardRow[] =
        prefs.view === 'list'
            ? ISSUE_STATUSES.filter((status) => sections.includes(status)).flatMap((status, index): BoardRow[] => {
                  const open = !collapsed.has(status);
                  const section: BoardSectionRow = {
                      type: 'section',
                      key: `section:${status}`,
                      status,
                      label: STATUS_LABEL[status],
                      count: countOf(status),
                      open,
                      first: index === 0,
                      tone: STATUS_TONE[status],
                      accessibilityLabel: `${STATUS_LABEL[status]}, ${plural(countOf(status), 'issue')}, ${open ? 'open' : 'folded'}`,
                      testID: `board-section-${status}`,
                  };
                  return [section, ...(open ? rowsOf(status) : [])];
              })
            : rowsOf(column);
    const peek = (offset: number): BoardPeek | null => {
        const status = prefs.view === 'list' ? undefined : statuses[statuses.indexOf(column) + offset];
        if (status === undefined) {
            return null;
        }
        const columnRows = rowsOf(status);
        return { status, rows: columnRows.slice(0, PEEK_ROWS), empty: columnRows.length === 0 };
    };
    const active = filtersActive(filters) || prefs.components.length > 0;
    const facetCount =
        FACET_NAMES.reduce((sum, facet) => sum + prefs.filters[facet].length, 0) + prefs.components.length;
    const searching = foldText(query) !== '';
    return {
        subtitle: boardSubtitle(all),
        columns,
        column,
        rows,
        neighbors: { before: peek(-1), after: peek(1) },
        countLine: active ? `${matching.length} of ${all.length}` : plural(all.length, 'issue'),
        filtersActive: active,
        facetCount,
        dotRequests: all.filter((issue) => isDotRequest(issue) && !CLOSED_ISSUE_STATUSES.includes(issue.status)).length,
        dotRequestsOnly: dotRequestsOnly(filters),
        wontFix: {
            count: all.filter((issue) => issue.status === 'wont_fix').length,
            offered: filters.status.length === 0,
        },
        empty: searching || active ? 'No issues match.' : 'No issues',
        noMatch:
            searching || active
                ? searchEmpty({
                      query,
                      line: BOARD_EMPTY_LINE,
                      // The facets and the lane, not the words (`active` counts them too).
                      filtered: filtersActive({ ...prefs.filters, q: '' }) || prefs.components.length > 0,
                      ...(searching ? {} : { title: 'No issues match' }),
                  })
                : null,
        pendingCount: pending.length + shown.filter((item) => item.pending !== null).length,
        layout: prefs.view,
        selectable: ordered.map((issue) => issue.number),
        componentFacet: componentFacetOptions(all, labels, prefs.components).map((ref) => ({
            ref,
            label: componentText(ref, labels),
            selected: prefs.components.includes(ref),
            testID: `board-filter-component-${ref}`,
        })),
    };
}

/**
 * What a screen reader is told once when a mark appears on the board: the
 * whole board's pending count in words (BoardView.pendingCount, so switching
 * columns says nothing again), or undefined with none (so nothing is said
 * when the last one goes).
 */
export function pendingAnnouncement(waiting: number): string | undefined {
    return waiting === 0 ? undefined : `${plural(waiting, 'change')} on the board waiting to send`;
}

/** Home's Board tile: the open issues, as the header counts them. */
export const openIssueCount = (issues: readonly IssueSummary[]) => issueCounts(issues).open;
