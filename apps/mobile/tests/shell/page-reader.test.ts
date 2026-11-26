import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { viewSpecMarkdown } from '@socio/shared/dataset-view';
import { embedCardMarkdown } from '@socio/shared/embed-card';
import type { Page, PageSummary } from '@socio/shared/pages/page-library';

import { IMAGE_LABEL } from '../../src/chat/markdown';
import {
    cellText,
    pageLink,
    pageParts,
    pagePicture,
    pageView,
    tableCells,
    viewChart,
    viewRowsNote,
    VIEW_ROWS_SHOWN,
} from '../../src/shell/page-reader';
import { UNTITLED_PAGE } from '../../src/shell/space-library';

// Reading a page: its body cut into safe Markdown and the blocks the
// web draws from fences, links to pages opening in the app, and what the
// reader shows from the list and the body, under Node.

const ORIGIN = 'https://acme.example';
const EMBED_ID = 'abcdefghijklmnop1234';

const summary = (id: string, title: string, fields: Partial<PageSummary> = {}): PageSummary => ({
    id,
    spaceId: 's1',
    parentId: null,
    title,
    excerpt: `${title} excerpt`,
    revision: 1,
    createdAt: 1,
    updatedAt: Date.UTC(2026, 10, 8, 12),
    sourceThreadId: null,
    createdBy: null,
    cover: null,
    folder: false,
    ...fields,
});

const body = (from: PageSummary, content: string, fields: Partial<Page> = {}): Page => {
    const { excerpt: _excerpt, ...rest } = from;
    return { ...rest, content, sourceUrl: null, sourceTitle: null, ...fields };
};

describe('a page’s body', () => {
    it('draws dataset views, link cards and pictures from their fences, and Markdown between', () => {
        const view = viewSpecMarkdown({ datasetId: 'sales', query: 'SELECT 1', display: 'table' });
        const card = embedCardMarkdown({
            url: 'https://x.example/post/1',
            kind: 'post',
            fetchedAt: '2026-11-08T00:00:00.000Z',
        });
        const picture =
            '```image\n{ "id": "' + EMBED_ID + '", "alt": "The board", "width": 1600, "height": 1200 }\n```';
        const parts = pageParts(`# Plan\n\n${view}\n\nBetween.\n\n${card}\n\n${picture}\n\nEnd.`);
        expect(parts.map((part) => (part.kind === 'markdown' ? 'md' : part.value.kind))).toEqual([
            'md',
            'dataset-view',
            'md',
            'embed',
            'image',
            'md',
        ]);
        const image = parts.find((part) => part.kind === 'block' && part.value.kind === 'image');
        expect(image?.kind === 'block' && image.value).toEqual({
            kind: 'image',
            picture: { id: EMBED_ID, alt: 'The board', width: 1600, height: 1200 },
        });
    });

    it('keeps a fence that doesn’t read as code, and never lets an image or HTML through', () => {
        const parts = pageParts(
            '```embed\n{ not json\n```\n\n```image\n{ "id": "short" }\n```\n\n![logo](https://evil.example/x.png)\n\n<img src="https://evil.example/y.png">',
        );
        expect(parts.every((part) => part.kind === 'markdown')).toBe(true);
        const text = parts.map((part) => (part.kind === 'markdown' ? part.text : '')).join('\n');
        expect(text).toContain('```embed');
        expect(text).toContain('[logo](https://evil.example/x.png)');
        expect(text).not.toContain('![logo]');
        expect(text).toContain('\\<img');
        expect(pageParts('![](https://evil.example/z.png)')[0]).toMatchObject({
            text: `[${IMAGE_LABEL}](https://evil.example/z.png)`,
        });
    });

    it('cuts a table out of the Markdown, for the reader to draw full width as the web’s', () => {
        const parts = pageParts(
            'Intro.\n\n| Area | Owner | Due |\n| :--- | :---: | ---: |\n| **Search** | Ada | Dec 1 |\n| [Docs](/spaces/s/pages/p) | Bo\n\nAfter.',
        );
        expect(parts.map((part) => (part.kind === 'markdown' ? part.text : part.value.kind))).toEqual([
            'Intro.\n',
            'table',
            '\nAfter.',
        ]);
        expect(new Set(parts.map((part) => part.key)).size).toBe(3);
        const table = parts[1];
        expect(table?.kind === 'block' && table.value).toEqual({
            kind: 'table',
            table: {
                header: ['Area', 'Owner', 'Due'],
                align: ['left', 'center', 'right'],
                // A short row is padded to the header's columns.
                rows: [
                    ['**Search**', 'Ada', 'Dec 1'],
                    ['[Docs](/spaces/s/pages/p)', 'Bo', ''],
                ],
            },
        });
    });

    it('leaves a table in code, a quote or with a delimiter row that doesn’t match as Markdown', () => {
        const kinds = (text: string) =>
            pageParts(text).map((part) => (part.kind === 'markdown' ? 'md' : part.value.kind));
        expect(kinds('```\n| a | b |\n| - | - |\n```')).toEqual(['md']);
        expect(kinds('~~~md\n| a | b |\n|---|---|\n~~~\n\n| a | b |\n|---|---|')).toEqual(['md', 'table']);
        expect(kinds('> | a | b |\n> |---|---|')).toEqual(['md']);
        expect(kinds('| a | b |\n|---|')).toEqual(['md']);
        expect(kinds('Just a | pipe.')).toEqual(['md']);
    });

    it('draws a table full width in equal columns, header semibold and centered, as editor.css', () => {
        const src = (file: string) => readFileSync(join(import.meta.dirname, '../../src', file), 'utf8');
        const blocks = src('screens/page-blocks.tsx');
        const block = blocks.slice(blocks.indexOf('export function PageTableBlock'));
        expect(block).toContain('contentContainerStyle={{ flexGrow: 1 }}');
        expect(block).toContain('className="border-border px-3 py-2"');
        // Equal shares, so every row's edges line up whatever the cells hold.
        expect(block).toContain('width: `${100 / columns}%`,');
        expect(block).toContain('minWidth: TABLE_MIN_COLUMN');
        expect(block).toContain("cell={header ? 'header' : 'body'}");
        expect(block).toContain("align={table.align[column] ?? (header ? 'center' : null)}");
        expect(src('screens/page.tsx')).toContain(
            "case 'table':\n                        return <PageTableBlock key={part.key} table={block.table} onLink={onLink} />;",
        );
        const css = readFileSync(
            join(import.meta.dirname, '../../../../packages/client/src/modules/pages/editor.css'),
            'utf8',
        );
        expect(css).toMatch(/\.document-prose table \{[^}]*width: 100%;\s*table-layout: fixed;/);
        expect(css).toMatch(/min-width: 60px;\s*padding: 9px 12px;/);
    });

    it('splits a row on its unescaped pipes only', () => {
        expect(tableCells('| a \\| b | `c` |')).toEqual(['a | b', '`c`']);
        expect(tableCells('a|b')).toEqual(['a', 'b']);
    });

    it('keeps a cell’s image a link, as the rest of the page', () => {
        const [table] = pageParts('| Logo |\n|---|\n| ![x](https://evil.example/x.png) |');
        expect(table?.kind === 'block' && table.value.kind === 'table' && table.value.table.rows[0]?.[0]).toBe(
            '[x](https://evil.example/x.png)',
        );
    });

    it('reads a picture’s fence as the editor writes it: only its fields, an embed id, a blank alt as none', () => {
        expect(pagePicture(`{ "id": "${EMBED_ID}", "alt": "  " }`)).toEqual({ id: EMBED_ID });
        expect(pagePicture(`{ "id": "${EMBED_ID}", "url": "https://evil.example" }`)).toBeNull();
        expect(pagePicture(`{ "id": "${EMBED_ID}", "width": -3 }`)).toBeNull();
        expect(pagePicture('{ "id": "../../etc" }')).toBeNull();
        expect(pagePicture('[]')).toBeNull();
    });
});

describe('links in a page', () => {
    it('opens the workspace’s pages and Spaces in the app, in the path and the old hash form', () => {
        expect(pageLink('/spaces/s1/pages/p2', ORIGIN)).toEqual({ kind: 'page', spaceId: 's1', pageId: 'p2' });
        expect(pageLink(`${ORIGIN}/spaces/s1/pages/p2`, ORIGIN)).toEqual({ kind: 'page', spaceId: 's1', pageId: 'p2' });
        expect(pageLink('/#/spaces/s1/pages/p2', ORIGIN)).toEqual({ kind: 'page', spaceId: 's1', pageId: 'p2' });
        expect(pageLink('#/spaces/s1/pages/p%202', ORIGIN)).toEqual({ kind: 'page', spaceId: 's1', pageId: 'p 2' });
        expect(pageLink('/spaces/s1', ORIGIN)).toEqual({ kind: 'space', spaceId: 's1' });
    });

    it('leaves everything else to the replies’ link rules', () => {
        for (const href of [
            'https://other.example/spaces/s1/pages/p2',
            '//acme.example/spaces/s1',
            '/spaces/s1/pages/p2?x=1',
            '/spaces/s1/pages/p2#heading',
            '/spaces/s1/pages',
            '/issues/CB-12',
            'javascript:alert(1)',
            '#section',
            '/spaces/%E0/pages/p',
        ]) {
            expect(pageLink(href, ORIGIN), href).toBeNull();
        }
    });
});

describe('what the reader shows', () => {
    const root = summary('root', 'Handbook');
    const mid = summary('mid', 'People', { parentId: 'root' });
    const leaf = summary('leaf', '  ', { parentId: 'mid', revision: 4, cover: { id: EMBED_ID, url: 'u' } });
    const other = summary('x', 'Elsewhere', { spaceId: 's2' });
    const list = [root, mid, leaf, other];

    it('has the parents, the subpages and the body', () => {
        const view = pageView(list, 's1', 'mid', body(mid, '# People'));
        expect(view).toMatchObject({
            title: 'People',
            content: '# People',
            ancestors: [{ id: 'root', title: 'Handbook' }],
            children: [{ id: 'leaf', title: UNTITLED_PAGE }],
            coverId: null,
        });
        expect(view?.edited).toMatch(/^Edited Nov 8$/);
    });

    it("shows a save still waiting on the phone over the server's body", () => {
        const waiting = { title: 'People, edited', content: '# People\n\nTyped offline' };
        expect(pageView(list, 's1', 'mid', body(mid, '# People'), waiting)).toMatchObject({
            title: 'People, edited',
            content: '# People\n\nTyped offline',
        });
        // With no body on the phone yet, the draft still shows.
        expect(pageView(list, 's1', 'mid', null, waiting)?.content).toBe('# People\n\nTyped offline');
        expect(pageView(list, 's1', 'mid', body(mid, '# People'), null)?.content).toBe('# People');
    });

    it('with no body, the title and excerpt from the list; with a body and no list, the body', () => {
        expect(pageView(list, 's1', 'leaf', null)).toMatchObject({
            content: null,
            coverId: EMBED_ID,
            excerpt: 'excerpt',
        });
        expect(pageView([], 's1', 'mid', body(mid, 'Text'))).toMatchObject({
            title: 'People',
            content: 'Text',
            children: [],
        });
        expect(pageView(list, 's1', 'nope', null)).toBeNull();
        // Another page's or Space's body is never shown here.
        expect(pageView([], 's1', 'mid', body(root, 'Text'))).toBeNull();
    });

    it('takes the title from the list when the list has seen a newer revision', () => {
        const stale = body(mid, 'Old', { title: 'Old title', revision: 0 });
        expect(pageView(list, 's1', 'mid', stale)).toMatchObject({ title: 'People', content: 'Old' });
    });
});

describe('a dataset view’s result', () => {
    const result = {
        columns: ['month', 'total'],
        rows: Array.from({ length: 30 }, (_, index) => [`M${index}`, index] as (string | number)[]),
        truncated: false,
        maxRows: 1000,
    };

    it('says how many rows show', () => {
        expect(viewRowsNote({ ...result, rows: result.rows.slice(0, 3) })).toBeNull();
        expect(viewRowsNote(result)).toBe(`Showing ${VIEW_ROWS_SHOWN} of 30 rows.`);
        expect(viewRowsNote({ ...result, truncated: true })).toContain('views stop at 1000 rows');
        expect(cellText(null)).toBe('null');
        expect(cellText({ $blob: 'x' })).toBe('Binary data');
    });

    it('charts as a reply’s chart, or says why it can’t', () => {
        const chart = viewChart(result, { display: 'line', title: 'Totals' }, 'Sales');
        expect(typeof chart === 'object' && chart).toMatchObject({
            kind: 'line',
            title: 'Totals',
            xLabel: 'month',
            yLabel: 'total',
        });
        expect(typeof chart === 'object' && chart.points).toHaveLength(30);
        expect(viewChart(result, { display: 'bar', x: 'week' }, 'Sales')).toContain('no column “week”');
        expect(viewChart({ columns: ['a'], rows: [['x']] }, { display: 'bar' }, 'Sales')).toBe(
            'The query has no column of numbers to chart.',
        );
    });
});

describe('the dataset view block', () => {
    const source = readFileSync(join(import.meta.dirname, '../../src/screens/page-blocks.tsx'), 'utf8');
    const block = source.slice(
        source.indexOf('export function DatasetViewBlock'),
        source.indexOf('function ViewResult'),
    );

    it('follows the view by its key and asks through one ask per mount, so a denial never asks again', () => {
        // tests/sync/dataset-views.test.ts shows the asks; this pins the block to them.
        expect(block).toContain('const key = datasetViewKey(spaceId, pageId, spec);');
        expect(block).toContain('useMemo(() => pages.views.itemAt(key), [pages, key])');
        expect(block).toContain('useMemo(() => createViewAsk(pages.views), [pages])');
        expect(block).toContain('ask(spaceId, pageId, spec)');
        expect(block).not.toMatch(/pages\.views\.(item|load)\(/);
    });
});
