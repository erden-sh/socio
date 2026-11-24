import { describe, expect, it } from 'vitest';

import type { PageSummary } from '@socio/shared/pages/page-library';
import type { Space } from '@socio/shared/types';

import {
    canPlaceIn,
    datasetScreen,
    datasetsInSpaces,
    itemRow,
    libraryTree,
    moveSpaceChoices,
    NOT_SUPPORTED,
    privateRows,
    spaceItemRows,
    tablesLine,
} from '../../src/shell/space-items';
import type { HeldItem } from '../../src/sync/space-items';

// Datasets in Spaces (CB-469): the flag, who sees the placing controls, the
// tree with datasets under pages, the Private group, the Move sheet's Spaces
// and the dataset's screen.

const summary = (id: string, title: string, parentId: string | null = null): PageSummary =>
    ({
        id,
        spaceId: 'sp',
        parentId,
        title,
        excerpt: '',
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
    }) as PageSummary;

const ds = (id: string, parentId: string | null, position: string, extra: Partial<HeldItem> = {}): HeldItem =>
    ({
        kind: 'dataset',
        id,
        parentId,
        title: id.toUpperCase(),
        position,
        version: 1,
        owner: 'person',
        tables: [{ name: 't', title: 'T', rows: 3, analytical: false }],
        ...extra,
    }) as HeldItem;

const space = (id: string, name: string, access?: 'editor' | 'reader'): Space =>
    ({ id, name, createdAt: 1, ...(access === undefined ? {} : { access }) }) as Space;

describe('datasets in Spaces, the flag and the role', () => {
    it('reads the workspace’s datasets-in-spaces flag', () => {
        expect(datasetsInSpaces({ flags: { on: ['datasets-in-spaces'] } })).toBe(true);
        expect(datasetsInSpaces({ flags: { on: ['coding-sessions'] } })).toBe(false);
        expect(datasetsInSpaces({})).toBe(false);
        expect(datasetsInSpaces(null)).toBe(false);
    });

    it('shows the placing controls to the Space’s editors only', () => {
        expect(canPlaceIn(space('a', 'A', 'editor'))).toBe(true);
        expect(canPlaceIn(space('a', 'A', 'reader'))).toBe(false);
        expect(canPlaceIn(space('a', 'A'))).toBe(false);
        expect(canPlaceIn(undefined)).toBe(false);
    });
});

describe('a Space’s tree with its datasets', () => {
    const pages = [summary('p1', 'Project X'), summary('p2', 'Alpha'), summary('p3', 'Notes', 'p1')];
    const items = [
        { kind: 'page', id: 'p1', parentId: null, title: 'Project X', position: '1', version: 1 } as HeldItem,
        ds('tasks', 'p1', '2'),
        ds('budget', 'p1', '1'),
        ds('root', null, '9'),
        ds('lost', 'gone', '3'),
        ds('alpha-ds', 'p2', '1'),
    ];

    it('puts a page’s datasets after its subpages, in their order, and the root’s last', () => {
        const rows = libraryTree(pages, items, 'sp', new Set(['p1', 'p2']));
        expect(
            rows.map((row) => (row.kind === 'page' ? `page:${row.row.id}` : `item:${row.item.id}@${row.depth}`)),
        ).toEqual([
            'page:p2',
            'item:alpha-ds@1',
            'page:p1',
            'page:p3',
            'item:budget@1',
            'item:tasks@1',
            'item:lost@0',
            'item:root@0',
        ]);
    });

    it('gives a page with only datasets under it a toggle, collapsed until opened', () => {
        const collapsed = libraryTree(pages, items, 'sp', new Set());
        const alpha = collapsed.find((row) => row.kind === 'page' && row.row.id === 'p2');
        expect(alpha).toMatchObject({ row: { children: 1, expanded: false } });
        expect(alpha?.kind === 'page' && alpha.row.accessibilityLabel).toBe('Alpha, 1 item');
        expect(collapsed.some((row) => row.kind === 'item' && row.item.id === 'alpha-ds')).toBe(false);
        const p1 = collapsed.find((row) => row.kind === 'page' && row.row.id === 'p1');
        expect(p1).toMatchObject({ row: { children: 3 } });
    });

    it('shows a kind it doesn’t know by title, not openable', () => {
        const row = itemRow({
            kind: 'dashboard',
            id: 'd',
            parentId: null,
            title: 'KPIs',
            position: '1',
            version: 1,
        } as HeldItem);
        expect(row).toMatchObject({ kind: 'unknown', title: 'KPIs', subtitle: NOT_SUPPORTED, opens: false });
    });

    it('lists the Space’s datasets in their order for Recent, without its pages', () => {
        expect(spaceItemRows(items).map((row) => row.id)).toEqual(['alpha-ds', 'budget', 'tasks', 'lost', 'root']);
    });
});

describe('the Private group and the dataset rows', () => {
    it('says a socio’s and a plugin’s, and counts tables or rows', () => {
        const rows = privateRows([
            ds('b', null, '2', { socio: { id: 's', name: 'Scout' } } as Partial<HeldItem>),
            ds('a', null, '1', { plugin: { id: 'ev', name: 'Events' } } as Partial<HeldItem>),
        ]);
        expect(rows.map((row) => [row.id, row.badge])).toEqual([
            ['a', 'Written by Events'],
            ['b', 'Scout'],
        ]);
        expect(rows[0]?.accessibilityLabel).toBe('Dataset, A, 3 rows, Written by Events');
        expect(tablesLine({ tables: [] })).toBe('0 tables');
        expect(tablesLine({ tables: [{ name: 'a', title: 'A', rows: 1, analytical: false }] })).toBe('1 row');
        expect(
            tablesLine({
                tables: [
                    { name: 'a', title: 'A', rows: 1, analytical: false },
                    { name: 'b', title: 'B', rows: null, analytical: true },
                ],
            }),
        ).toBe('2 tables');
    });

    it('offers Move to the Spaces the person edits, and Private only for one in a Space', () => {
        const spaces = [space('b', 'Beta', 'editor'), space('r', 'Read', 'reader'), space('a', 'Alpha', 'editor')];
        expect(moveSpaceChoices(spaces, null).map((c) => c.id)).toEqual(['a', 'b']);
        expect(moveSpaceChoices(spaces, 'a').map((c) => c.id)).toEqual(['a', 'b', '']);
    });

    it('draws the dataset’s screen from its item: where it is, its tables and the plugin note', () => {
        const view = datasetScreen(
            {
                ...(ds('x', null, '1') as Extract<HeldItem, { kind: 'dataset' }>),
                title: 'Events',
                tables: [
                    { name: 'bookings', title: 'Bookings', rows: 1200, analytical: false },
                    { name: 'facts', title: '', rows: null, analytical: true },
                ],
                plugin: { id: 'ev', name: 'Events' },
            },
            'Ops',
        );
        expect(view.intro).toBe('In Ops · 2 tables');
        expect(view.tables.map((t) => [t.title, t.line])).toEqual([
            ['Bookings', '1,200 rows'],
            ['facts', 'Analytical'],
        ]);
        expect(view.note).toMatch(/^Written by Events/);
        expect(datasetScreen(ds('y', null, '1') as Extract<HeldItem, { kind: 'dataset' }>, null).intro).toBe(
            'Private · 3 rows',
        );
    });
});
