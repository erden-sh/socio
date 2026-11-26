import { describe, expect, it } from 'vitest';

import type { PageSummary } from '@socio/shared/pages/page-library';

import {
    deleteButton,
    deleteMessage,
    deleteRule,
    deleteTitle,
    knownPages,
    moveTargets,
    oneAtATime,
    pageMenu,
    pagesNotSaved,
    parentChoices,
    type ShownPage,
    subpagesOf,
    withPageWrites,
} from '../../src/shell/page-menus';
import { recentPages } from '../../src/shell/space-library';
import type { UnsentWrite } from '../../src/sync/outbox';
import type { OverlayItem } from '../../src/sync/outbox-overlay';
import { PAGE_COVER_KIND, PAGE_DELETE_KIND, PAGE_MANAGE_REFUSALS, PAGE_MOVE_KIND } from '../../src/sync/page-manage';
import { PAGE_CREATE_KIND } from '../../src/sync/page-save';

// A Space's New page and page menus: the web's delete rule with the
// server's subtree rule, the confirm's words, the menu, the move's choices,
// the pending writes laid over the rows and the refused ones said.

const summary = (id: string, fields: Partial<PageSummary> = {}): PageSummary => ({
    id,
    spaceId: 'ops',
    parentId: null,
    title: id[0]!.toUpperCase() + id.slice(1),
    excerpt: '',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    sourceThreadId: null,
    createdBy: 'u-ada',
    cover: null,
    folder: false,
    ...fields,
});

const shown = (page: PageSummary): ShownPage => ({ ...page, waiting: false, coverUpload: null });

const tree = [
    summary('roadmap'),
    summary('q1', { parentId: 'roadmap' }),
    summary('jan', { parentId: 'q1', createdBy: 'u-bob' }),
    summary('notes'),
].map(shown);

const ada = { id: 'u-ada', role: 'member' as const };
const page = (id: string) => tree.find((item) => item.id === id)!;

describe('who may delete a page', () => {
    it('lets a member delete a page they made with only their own subpages', () => {
        expect(deleteRule(ada, page('notes'), tree)).toEqual({ allowed: true, subpages: [] });
    });

    it('offers a member no Delete for a subtree with someone else’s page in it', () => {
        const rule = deleteRule(ada, page('roadmap'), tree);
        expect(rule.allowed).toBe(false);
        expect(rule.subpages.map((item) => item.id)).toEqual(['q1', 'jan']);
    });

    it('offers a member no Delete for someone else’s page, and nobody before the person is known', () => {
        expect(deleteRule(ada, page('jan'), tree).allowed).toBe(false);
        expect(deleteRule(null, page('notes'), tree).allowed).toBe(false);
    });

    it('lets an admin, or an older server’s retired operator, delete any page with its subtree', () => {
        expect(deleteRule({ id: 'u-cy', role: 'admin' }, page('roadmap'), tree).allowed).toBe(true);
        expect(deleteRule({ id: 'u-cy', role: 'operator' as never }, page('jan'), tree).allowed).toBe(true);
    });

    it('takes a member’s rule while the shell hasn’t said the role', () => {
        expect(deleteRule({ id: 'u-ada' }, page('roadmap'), tree).allowed).toBe(false);
        expect(deleteRule({ id: 'u-ada' }, page('notes'), tree).allowed).toBe(true);
    });

    it('lists subpages at any depth once, even through a cycle', () => {
        const loop = [summary('a', { parentId: 'b' }), summary('b', { parentId: 'a' })];
        expect(subpagesOf(loop[0]!, loop).map((item) => item.id)).toEqual(['b']);
    });
});

describe('the delete confirm', () => {
    it('says the web’s words and names each subpage', () => {
        expect(deleteTitle({ title: '  ' })).toBe('Delete “Untitled page”?');
        expect(deleteMessage([])).toBe(
            'It’s removed for everyone in this Space, and links to it say it was deleted. Conversations about it stay in your chats.',
        );
        expect(deleteMessage([{ title: 'Q1' }, { title: 'Jan' }])).toBe(
            'Its 2 subpages will be deleted with it. It’s removed for everyone in this Space, and links to it say it was deleted. Conversations about it stay in your chats.\n\n• Q1\n• Jan',
        );
        expect(deleteMessage([{ title: 'Q1' }])).toMatch(/^Its subpage will be deleted with it\. /);
        expect([deleteButton(0), deleteButton(2)]).toEqual(['Delete page', 'Delete pages']);
    });
});

describe('a page row’s menu', () => {
    it('offers Move, Set cover and Delete where allowed', () => {
        expect(pageMenu(page('notes'), true).map((action) => action.label)).toEqual(['Move', 'Set cover', 'Delete']);
        expect(pageMenu(page('notes'), false).map((action) => action.label)).toEqual(['Move', 'Set cover']);
    });

    it('offers Change cover and Remove cover for a page with one, or one uploading', () => {
        const covered = { cover: { id: 'e1', url: '/api/media/embeds/e1/content' }, coverUpload: null };
        expect(pageMenu(covered, false).map((action) => action.label)).toEqual([
            'Move',
            'Change cover',
            'Remove cover',
        ]);
        expect(pageMenu({ cover: null, coverUpload: 'up-1' }, false).map((action) => action.name)).toEqual([
            'move',
            'set-cover',
            'remove-cover',
        ]);
    });
});

describe('the move’s choices', () => {
    it('lists every other Space and the target’s whole tree under the top', () => {
        const spaces = [
            { id: 'ops', name: 'Ops', description: '', createdAt: 1 },
            { id: 'eng', name: 'Eng', description: '', createdAt: 1 },
        ];
        expect(moveTargets(spaces, 'ops').map((space) => space.id)).toEqual(['eng']);
        const rows = parentChoices(tree, 'ops');
        expect(rows.map((row) => [row.id, row.depth])).toEqual([
            ['notes', 0],
            ['roadmap', 0],
            ['q1', 1],
            ['jan', 2],
        ]);
    });
});

const overlay = (fields: Partial<OverlayItem> & Pick<OverlayItem, 'key' | 'mode' | 'value'>): OverlayItem => ({
    collection: 'pages',
    id: `row-${fields.key}`,
    state: 'queued',
    reason: null,
    createdAt: 5,
    ...fields,
});

describe('pending writes over the library', () => {
    const pages = [summary('roadmap'), summary('notes'), summary('old')];

    it('adds a page made here, moves, deletes and changes covers at once, each saying it waits', () => {
        const rows = withPageWrites(pages, [
            overlay({ key: 'local-page-1', mode: 'insert', value: summary('local-page-1', { title: 'Ideas' }) }),
            overlay({ key: 'roadmap', mode: 'patch', value: { spaceId: 'eng', parentId: null } }),
            overlay({ key: 'old', mode: 'patch', value: { pendingDelete: true } }),
            overlay({ key: 'notes', mode: 'patch', value: { coverUpload: 'up-1' } }),
        ]);
        expect(rows.map((row) => [row.id, row.spaceId, row.waiting, row.coverUpload])).toEqual([
            ['roadmap', 'eng', true, null],
            ['notes', 'ops', true, 'up-1'],
            ['local-page-1', 'ops', true, null],
        ]);
        const recent = recentPages(rows, 'ops');
        expect(recent.map((row) => [row.id, row.waiting, row.coverUpload])).toEqual([
            ['local-page-1', true, null],
            ['notes', true, 'up-1'],
        ]);
        expect(recent[0]!.accessibilityLabel).toMatch(/Waiting to send$/);
    });

    it('drops an upload’s picture once a cover is set or removed after it', () => {
        const rows = withPageWrites(pages, [
            overlay({ key: 'notes', mode: 'patch', value: { coverUpload: 'up-1' } }),
            overlay({ key: 'notes', mode: 'patch', value: { cover: null }, createdAt: 6 }),
        ]);
        expect(rows.find((row) => row.id === 'notes')).toMatchObject({ cover: null, coverUpload: null });
    });

    it('lays nothing for a refused write or what waits behind it, and no refused create', () => {
        const rows = withPageWrites(pages, [
            overlay({ key: 'old', mode: 'patch', value: { pendingDelete: true }, state: 'unsent' }),
            overlay({ key: 'old', mode: 'patch', value: { spaceId: 'eng' }, createdAt: 6 }),
            overlay({ key: 'local-page-2', mode: 'insert', value: summary('local-page-2'), state: 'unsent' }),
        ]);
        expect(rows.map((row) => [row.id, row.spaceId, row.waiting])).toEqual([
            ['roadmap', 'ops', false],
            ['notes', 'ops', false],
            ['old', 'ops', false],
        ]);
    });

    it('takes a pending delete’s subpages out with it, and moves a pending move’s subpages with it', () => {
        const tree = [
            summary('roadmap'),
            summary('q1', { parentId: 'roadmap' }),
            summary('q1-notes', { parentId: 'q1' }),
            summary('notes'),
            summary('old'),
            summary('old-child', { parentId: 'old' }),
        ];
        const rows = withPageWrites(tree, [
            overlay({ key: 'roadmap', mode: 'patch', value: { spaceId: 'eng', parentId: null } }),
            overlay({ key: 'old', mode: 'patch', value: { pendingDelete: true } }),
        ]);
        expect(rows.map((row) => [row.id, row.spaceId, row.parentId])).toEqual([
            ['roadmap', 'eng', null],
            ['q1', 'eng', 'roadmap'],
            ['q1-notes', 'eng', 'q1'],
            ['notes', 'ops', null],
        ]);
        // The old Space's library no longer lists them as top-level rows.
        expect(recentPages(rows, 'ops').map((row) => row.id)).toEqual(['notes']);
    });

    it('gives New page every synced page of the Space as known, one with a pending write too', () => {
        const synced = [summary('roadmap'), summary('notes'), summary('elsewhere', { spaceId: 'eng' })];
        const rows = withPageWrites(synced, [
            overlay({ key: 'notes', mode: 'patch', value: { coverUpload: 'up-1' } }),
            overlay({ key: 'local-page-1', mode: 'insert', value: summary('local-page-1') }),
        ]);
        expect(rows.find((row) => row.id === 'notes')?.waiting).toBe(true);
        expect(knownPages(synced, 'ops')).toEqual(['roadmap', 'notes']);
        // Never a page made on this phone, even if one is handed in.
        expect(knownPages(rows, 'ops')).toEqual(['roadmap', 'notes']);
    });

    it('shows a sent write without the waiting mark', () => {
        const rows = withPageWrites(pages, [
            overlay({ key: 'notes', mode: 'patch', value: { title: 'Notes 2' }, state: 'sent' }),
        ]);
        expect(rows.find((row) => row.id === 'notes')).toMatchObject({ title: 'Notes 2', waiting: false });
    });
});

const unsent = (id: string, kind: string, payload: object, reason: string, createdAt = 1): UnsentWrite =>
    ({ id, kind, payload: JSON.stringify(payload), payloadVersion: 1, reason, createdAt }) as unknown as UnsentWrite;

describe('refused page writes', () => {
    const pages = [summary('roadmap'), summary('notes')];
    const resolve = (id: string) => (id === 'local-page-9' ? 'notes' : null);

    it('says each of the four kinds of this Space, oldest first, in the app’s words', () => {
        const rows = pagesNotSaved(
            [
                unsent(
                    'd1',
                    PAGE_DELETE_KIND,
                    { spaceId: 'ops', pageId: 'roadmap', subpages: [] },
                    PAGE_MANAGE_REFUSALS.newSubpages,
                    4,
                ),
                unsent(
                    'm1',
                    PAGE_MOVE_KIND,
                    { spaceId: 'ops', pageId: 'local-page-9', to: 'eng', parentId: null },
                    'gone',
                    3,
                ),
                unsent(
                    'local-page-1',
                    PAGE_CREATE_KIND,
                    { spaceId: 'ops', pageId: 'local-page-1', title: 'Ideas', content: '' },
                    'page-refused',
                    1,
                ),
                unsent(
                    'c1',
                    PAGE_COVER_KIND,
                    { spaceId: 'ops', pageId: 'roadmap' },
                    PAGE_MANAGE_REFUSALS.coverTooLarge,
                    2,
                ),
                unsent('x1', PAGE_DELETE_KIND, { spaceId: 'eng', pageId: 'other', subpages: [] }, 'gone', 5),
                unsent('s1', 'page-save', { spaceId: 'ops', pageId: 'roadmap' }, 'conflict', 6),
            ],
            pages,
            'ops',
            resolve,
        );
        expect(rows.map((row) => [row.id, row.text, row.again, row.pageId])).toEqual([
            ['local-page-1', 'Couldn’t create “Ideas”. You can’t edit this page.', 'retry', 'local-page-1'],
            ['c1', expect.stringMatching(/^Couldn’t change the cover of “Roadmap”\. .+\.$/), 'retry', 'roadmap'],
            ['m1', 'Couldn’t move “Notes”. You no longer have access.', 'retry', 'notes'],
            ['d1', 'Couldn’t delete “Roadmap”. This page has new subpages.', 'confirm-delete', 'roadmap'],
        ]);
    });

    it('lets Copy take only what the person wrote: a new page’s title and text', () => {
        const rows = pagesNotSaved(
            [
                unsent(
                    'local-page-1',
                    PAGE_CREATE_KIND,
                    { spaceId: 'ops', pageId: 'local-page-1', title: 'Ideas', content: 'One\nTwo' },
                    'page-refused',
                ),
                unsent(
                    'd1',
                    PAGE_DELETE_KIND,
                    { spaceId: 'ops', pageId: 'roadmap', subpages: [] },
                    'page-delete-refused',
                    2,
                ),
            ],
            pages,
            'ops',
            resolve,
        );
        expect(rows.map((row) => row.copy)).toEqual(['Ideas\n\nOne\nTwo', null]);
    });
});

describe('oneAtATime', () => {
    it('queues one create for two quick Saves, and lets the next one through once it settles', async () => {
        const once = oneAtATime();
        let finish: () => void = () => {};
        let creates = 0;
        const create = () => {
            creates += 1;
            return new Promise<void>((resolve) => {
                finish = resolve;
            });
        };
        const first = once(create);
        expect(once(create)).toBeUndefined();
        expect(creates).toBe(1);
        finish();
        await first;
        await once(() => Promise.resolve());
        expect(creates).toBe(1);
        expect(once(create)).toBeDefined();
        expect(creates).toBe(2);
    });

    it('frees itself after a refused or throwing write', async () => {
        const once = oneAtATime();
        await expect(once(() => Promise.reject(new Error('refused')))).rejects.toThrow('refused');
        expect(() =>
            once(() => {
                throw new Error('sync');
            }),
        ).toThrow('sync');
        expect(once(() => Promise.resolve('ok'))).toBeDefined();
    });
});
