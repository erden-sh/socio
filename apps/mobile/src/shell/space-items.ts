import { compareText } from '@socio/shared/locale';
import type { PageSummary } from '@socio/shared/pages/page-library';
import type { SpaceDatasetItem } from '@socio/shared/spaces/space-items';
import type { Space } from '@socio/shared/types';

import type { ShellWorkspace } from '../sync/shell';
import type { HeldItem } from '../sync/space-items';
import { DATASETS_IN_SPACES } from '../sync/space-items';

import { pageTree, type TreeRow } from './space-library';

// Datasets in Spaces (CB-469, CB-451), the view models: a Space's
// tree with its datasets among its pages (a dataset may sit under a page, never
// a page under a dataset), the Private group at the top of the Spaces, who sees
// the placing controls (the Space's editors: `Space.access`, as the web's
// library reads it; the server checks every placement again), the Move sheet's
// choices, and a dataset's own screen (its tables). All of it only with the
// workspace's `datasets-in-spaces` flag, read as the app reads its other flags
// (`workspace.flags.on`). No React Native, so tests/shell runs it under Node.

/** Whether the person has datasets in Spaces: the web's flag, as the server evaluated it for them. */
export const datasetsInSpaces = (workspace: Pick<ShellWorkspace, 'flags'> | null): boolean =>
    workspace?.flags?.on.includes(DATASETS_IN_SPACES) === true;

/** Whether the person may place datasets in the Space, or move them within it: its editors only. */
export const canPlaceIn = (space: Pick<Space, 'access'> | undefined): boolean => space?.access === 'editor';

export const PRIVATE_GROUP = 'Private';
export const PRIVATE_EMPTY = 'No private datasets';
export const NOT_SUPPORTED = 'Not supported in this version';
export const UNTITLED_DATASET = 'Untitled dataset';
export const MOVE_DATASET = 'Move…';
export const PLACE_DATASET = 'Move to a Space…';

const isDataset = (item: HeldItem): item is SpaceDatasetItem => item.kind === 'dataset';

const byPosition = (a: HeldItem, b: HeldItem) =>
    a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** "3 tables", or a one-table dataset's rows ("120 rows"). */
export function tablesLine(item: Pick<SpaceDatasetItem, 'tables'>): string {
    const tables = item.tables ?? [];
    if (tables.length === 1) {
        const rows = tables[0]?.rows;
        return rows === null || rows === undefined
            ? '1 table'
            : `${rows.toLocaleString('en-US')} ${rows === 1 ? 'row' : 'rows'}`;
    }
    return `${tables.length} ${tables.length === 1 ? 'table' : 'tables'}`;
}

/** One item that isn't a page: a dataset, or a kind a later server added. */
export interface ItemRow {
    readonly id: string;
    readonly kind: 'dataset' | 'unknown';
    readonly title: string;
    /** "3 tables" for a dataset; "Not supported in this version" for an unknown kind. */
    readonly subtitle: string;
    /** A socio's scratch dataset, or a plugin's: who it is ("Written by Events"). */
    readonly badge: string | null;
    /** Only a dataset opens. */
    readonly opens: boolean;
    readonly accessibilityLabel: string;
}

export function itemRow(item: HeldItem): ItemRow {
    const title = item.title.trim() || (isDataset(item) ? UNTITLED_DATASET : 'Untitled');
    if (!isDataset(item)) {
        return {
            id: item.id,
            kind: 'unknown',
            title,
            subtitle: NOT_SUPPORTED,
            badge: null,
            opens: false,
            accessibilityLabel: `${title}, ${NOT_SUPPORTED}`,
        };
    }
    const subtitle = tablesLine(item);
    const badge =
        item.plugin !== undefined
            ? `Written by ${item.plugin.name}`
            : item.socio !== undefined
              ? (item.socio.name ?? 'A socio’s')
              : null;
    return {
        id: item.id,
        kind: 'dataset',
        title,
        subtitle,
        badge,
        opens: true,
        accessibilityLabel: ['Dataset', title, subtitle, badge].filter(Boolean).join(', '),
    };
}

/** A row of a Space's tree: a page (the library's own row), or an item beside the pages. */
export type LibraryTreeRow =
    | { readonly kind: 'page'; readonly row: TreeRow }
    | { readonly kind: 'item'; readonly depth: number; readonly item: ItemRow };

/**
 * The Space's tree with its items (CB-469): the pages as the library's tree draws them (by title),
 * each page's datasets after its subpages, in their stored order, and the root's after the root's
 * pages. A page with only datasets under it gets a toggle too. An item whose parent page the phone
 * doesn't hold sits at the root, so nothing is dropped.
 */
export function libraryTree(
    pages: readonly PageSummary[],
    items: readonly HeldItem[],
    spaceId: string,
    expanded: ReadonlySet<string>,
    conflicted?: ReadonlySet<string>,
): LibraryTreeRow[] {
    const own = pages.filter((page) => page.spaceId === spaceId);
    const pageIds = new Set(own.map((page) => page.id));
    const under = new Map<string | null, HeldItem[]>();
    for (const item of items) {
        if (item.kind === 'page') {
            continue;
        }
        const parent = item.parentId !== null && pageIds.has(item.parentId) ? item.parentId : null;
        under.set(parent, [...(under.get(parent) ?? []), item]);
    }
    for (const list of under.values()) {
        list.sort(byPosition);
    }
    // A page whose only children are datasets expands like one with subpages.
    const rows = walk(pageTree(own, spaceId, expanded, conflicted), under, expanded);
    for (const item of under.get(null) ?? []) {
        rows.push({ kind: 'item', depth: 0, item: itemRow(item) });
    }
    return rows;
}

/** The page rows (in tree order) with each page's datasets after its subpages, its toggle counting both. */
function walk(
    rows: readonly TreeRow[],
    under: ReadonlyMap<string | null, HeldItem[]>,
    expanded: ReadonlySet<string>,
): LibraryTreeRow[] {
    const out: LibraryTreeRow[] = [];
    for (let index = 0; index < rows.length; index++) {
        const row = rows[index]!;
        const extra = under.get(row.id) ?? [];
        const children = row.children + extra.length;
        const open = children > 0 && expanded.has(row.id);
        const label =
            row.children === 0 && extra.length > 0
                ? `${row.accessibilityLabel}, ${children} ${children === 1 ? 'item' : 'items'}`
                : row.accessibilityLabel;
        out.push({ kind: 'page', row: { ...row, children, expanded: open, accessibilityLabel: label } });
        // Its subpages (with theirs) follow it in `rows`: walked here, then its own datasets.
        let end = index + 1;
        while (end < rows.length && rows[end]!.depth > row.depth) {
            end++;
        }
        if (open) {
            out.push(...walk(rows.slice(index + 1, end), under, expanded));
            out.push(
                ...extra.map((item): LibraryTreeRow => ({ kind: 'item', depth: row.depth + 1, item: itemRow(item) })),
            );
        }
        index = end - 1;
    }
    return out;
}

/** The Space's items beside its pages, in their stored order: the Recent view's "Datasets" section. */
export const spaceItemRows = (items: readonly HeldItem[]): ItemRow[] =>
    items
        .filter((item) => item.kind !== 'page')
        .sort(byPosition)
        .map(itemRow);

/** "2 datasets". */
export const datasetCount = (n: number) => `${n} ${n === 1 ? 'dataset' : 'datasets'}`;

/** The Private group's rows: the person's datasets in no Space, oldest first (the server's order). */
export const privateRows = (items: readonly HeldItem[]): ItemRow[] => spaceItemRows(items);

// ----- Move (who may place) -----

/** A place in the Move sheet's first list: a Space the person edits, or Private (out of every Space). */
export interface MoveSpaceChoice {
    /** '' is Private. */
    readonly id: string;
    readonly label: string;
}

/**
 * Where a dataset may go: the Spaces the person edits (the server refuses the others), by name,
 * and, for one in a Space, Private, which takes it out (its owner's right; the server checks).
 */
export function moveSpaceChoices(spaces: readonly Space[], from: string | null): MoveSpaceChoice[] {
    const editable = spaces
        .filter((space) => canPlaceIn(space))
        .sort((a, b) => compareText(a.name, b.name) || (a.id < b.id ? -1 : 1))
        .map((space) => ({ id: space.id, label: space.name }));
    return from === null ? editable : [...editable, { id: '', label: `${PRIVATE_GROUP} (out of this Space)` }];
}

/** The Move sheet's line over its lists. */
export const moveDatasetLine = (from: string | null) =>
    from === null
        ? 'Put it in a Space you edit. Everyone who reads that Space can then read it.'
        : 'Only this Space’s editors can move it. Private takes it out: the Space’s readers lose access.';

/** The Move sheet's title. */
export const moveDatasetTitle = (title: string) => `Move “${title.trim() || UNTITLED_DATASET}”`;

// ----- The dataset's screen -----

export interface DatasetTableRow {
    readonly name: string;
    readonly title: string;
    /** "120 rows", "Analytical", or null when the count is unknown. */
    readonly line: string | null;
    readonly analytical: boolean;
    readonly accessibilityLabel: string;
}

export interface DatasetScreenView {
    readonly title: string;
    /** The first line under the bar: where it lives and who writes it. */
    readonly intro: string;
    readonly tables: readonly DatasetTableRow[];
    /** "Written by Events: read-only to people while it writes it." */
    readonly note: string | null;
}

export const DATASET_MISSING = 'This dataset isn’t here';
export const DATASET_MISSING_LINE = 'Open it from its Space, or from Private on the Spaces.';

/** A dataset's screen (its tables, then each table's views), from the item the phone holds. */
export function datasetScreen(item: SpaceDatasetItem, spaceName: string | null): DatasetScreenView {
    const title = item.title.trim() || UNTITLED_DATASET;
    const where = spaceName === null ? PRIVATE_GROUP : `In ${spaceName}`;
    const owner = item.socio !== undefined ? `${item.socio.name ?? 'A socio'}’s` : null;
    const tables = (item.tables ?? []).map((table): DatasetTableRow => {
        const line =
            table.rows === null
                ? table.analytical
                    ? 'Analytical'
                    : null
                : `${table.rows.toLocaleString('en-US')} ${table.rows === 1 ? 'row' : 'rows'}${table.analytical ? ' · Analytical' : ''}`;
        const label = table.title.trim() || table.name;
        return {
            name: table.name,
            title: label,
            line,
            analytical: table.analytical,
            accessibilityLabel: [label, line].filter(Boolean).join(', '),
        };
    });
    return {
        title,
        intro: [where, owner, tablesLine(item)].filter(Boolean).join(' · '),
        tables,
        note:
            item.plugin === undefined
                ? null
                : `Written by ${item.plugin.name}: read-only to people while it writes it.`,
    };
}
