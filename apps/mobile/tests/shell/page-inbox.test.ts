import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { InAppNotice } from '@socio/shared/notifications';
import type { PageSummary } from '@socio/shared/pages/page-library';

import { inboxView, pageConflictRows, spacesAttention, spacesAttentionView } from '../../src/shell/inbox';
import { saveAsNewTargets } from '../../src/shell/page-conflict';
import { CHANGED_ELSEWHERE, type LibraryPage, pageTree, recentPages, WAITING } from '../../src/shell/space-library';
import { OPEN_PAGE, SAVE_AS_NEW_PAGE, SOME_SPACE, UNSENT_LABEL_TEXT_MAX, unsentListRows } from '../../src/shell/unsent';
import { UNSENT_GONE, type UnsentWrite } from '../../src/sync/outbox';
import type { PageConflict } from '../../src/sync/page-conflicts';
import { saveMineAsNewPage } from '../../src/sync/page-conflicts';
import { PAGE_COVER_KIND, PAGE_DELETE_KIND, PAGE_MANAGE_REFUSALS, PAGE_MOVE_KIND } from '../../src/sync/page-manage';
import {
    PAGE_CREATE_KIND,
    PAGE_SAVE_KIND,
    PAGE_SAVE_REFUSALS,
    pageConflictLane,
    pageLane,
} from '../../src/sync/page-save';

// Page conflicts in the Inbox, the library's badges and the Unsent list's
// words for page writes, under Node.

function conflict(id: string, pageId: string, options: { title?: string; theirs?: string | null; at?: number } = {}) {
    const draft = { title: options.title ?? 'Roadmap mine', content: 'Mine\n' };
    const payload = {
        spaceId: 's1',
        pageId,
        base: { title: 'Roadmap', content: 'Base\n', revision: 3 },
        draft,
        ownRevisions: [],
    };
    const theirs = options.theirs === undefined ? 'Roadmap' : options.theirs;
    return {
        id,
        pageId,
        spaceId: 's1',
        mine: draft,
        theirs: theirs === null ? null : { spaceId: 's1', title: theirs, content: 'Theirs\n', revision: 4 },
        payload,
        createdAt: options.at ?? 1,
    } satisfies PageConflict;
}

const spaceName = (id: string) => (id === 's1' ? 'Engineering' : null);

describe('page conflicts in the Inbox', () => {
    it('lists one row per page, by its oldest conflict, titled as the page is now, in its Space', () => {
        const rows = pageConflictRows(
            [
                conflict('c1', 'p1'),
                conflict('c2', 'p2', { theirs: null, title: '  ' }),
                conflict('c3', 'p1', { at: 5 }),
            ],
            spaceName,
        );
        expect(rows).toEqual([
            {
                id: 'p1',
                spaceId: 's1',
                title: 'Roadmap',
                subtitle: 'Engineering · 2 versions of yours wait',
                accessibilityLabel: 'Roadmap, changed elsewhere, in Engineering, 2 versions of yours wait',
            },
            {
                // An older build's conflict kept no theirs: the person's title, else Untitled page.
                id: 'p2',
                spaceId: 's1',
                title: 'Untitled page',
                subtitle: 'Engineering',
                accessibilityLabel: 'Untitled page, changed elsewhere, in Engineering',
            },
        ]);
        expect(pageConflictRows([conflict('c1', 'p1')], () => null)[0]?.subtitle).toBe('A Space');
    });

    it('shows them at the top of the Spaces list, never in Chats’ attention (the owner, 2026-11-20)', () => {
        const pageConflicts = pageConflictRows([conflict('c1', 'p1')], spaceName);
        const view = spacesAttentionView(pageConflicts);
        expect(view.pageConflicts).toBe(pageConflicts);
        expect(view.empty).toBe(false);
        expect(spacesAttentionView([])).toEqual({ pageConflicts: [], empty: true });
        // Chats' attention has no part for them, whatever the outbox holds.
        const chats = inboxView([], [], [], [], null, { notificationsDenied: true });
        expect(chats.sections).toEqual(['notifications']);
        expect(chats).not.toHaveProperty('pageConflicts');
    });

    it('keeps Chats’ order with the room invites: approvals, notices, invites, rooms, notifications', () => {
        const invites = [
            {
                id: 'r1',
                title: 'Launch',
                subtitle: null,
                accessibilityLabel: 'Launch',
            },
        ];
        const notice: InAppNotice = {
            id: 'n1',
            title: 'Hi',
            body: '',
            link: '/',
            createdAt: 1,
        };
        const view = inboxView([], [notice], [], [], null, {
            invites,
            notificationsDenied: true,
        });
        expect(view.sections).toEqual(['notices', 'invites', 'notifications']);
        expect(view.invites).toBe(invites);
    });

    it('badges Spaces with one per page changed, and draws them at the top of the Spaces list', () => {
        expect(spacesAttention([conflict('c1', 'p1'), conflict('c2', 'p1'), conflict('c3', 'p2')])).toBe(2);
        const spaces = readFileSync(join(import.meta.dirname, '../../src/screens/spaces.tsx'), 'utf8');
        expect(spaces).toMatch(/testID="spaces-heading"\s*\/>\s*\{\/\*[^*]*\*\/\}\s*<SpacesAttention \/>/);
        const attention = readFileSync(join(import.meta.dirname, '../../src/screens/attention.tsx'), 'utf8');
        expect(attention).not.toContain("case 'pages':");
        expect(attention).toContain('if (view.empty) {\n        return null;');
    });
});

describe('the library’s conflict badge', () => {
    const page = (id: string, title: string, parentId: string | null = null): PageSummary =>
        ({
            id,
            spaceId: 's1',
            parentId,
            title,
            excerpt: '',
            updatedAt: Date.UTC(2026, 10, 8),
            cover: null,
        }) as unknown as PageSummary;
    const pages = [page('p1', 'Roadmap'), page('p2', 'Notes', 'p1')];

    it('marks the pages with a conflict, and says so after the title', () => {
        const recent = recentPages(pages, 's1', new Set(['p1']));
        expect(recent.map((row) => [row.id, row.conflict])).toEqual([
            ['p2', false],
            ['p1', true],
        ]);
        expect(recent.find((row) => row.id === 'p1')?.accessibilityLabel).toMatch(
            new RegExp(`^Roadmap, ${CHANGED_ELSEWHERE}, Edited`),
        );
        const tree = pageTree(pages, 's1', new Set(['p1']), new Set(['p2']));
        expect(tree.map((row) => [row.id, row.conflict, row.accessibilityLabel])).toEqual([
            ['p1', false, 'Roadmap, 1 subpage'],
            ['p2', true, `Notes, ${CHANGED_ELSEWHERE}`],
        ]);
        // None by default.
        expect(recentPages(pages, 's1').some((row) => row.conflict)).toBe(false);
    });

    it('keeps the page menus’ waiting and cover upload beside the badge, in one label', () => {
        const waiting: LibraryPage[] = [{ ...page('p1', 'Roadmap'), waiting: true, coverUpload: 'u1' }];
        const [row] = recentPages(waiting, 's1', new Set(['p1']));
        expect(row).toMatchObject({
            conflict: true,
            waiting: true,
            coverUpload: 'u1',
        });
        expect(row?.accessibilityLabel).toMatch(new RegExp(`^Roadmap, ${CHANGED_ELSEWHERE}, Edited .+, ${WAITING}$`));
    });
});

const write = (
    fields: Partial<UnsentWrite> & Pick<UnsentWrite, 'id' | 'kind' | 'payload' | 'reason'>,
): UnsentWrite => ({
    lane: 'page:p1',
    dependsOn: null,
    payloadVersion: 1,
    createdAt: 1,
    ...fields,
});

const save = (pageId: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
        spaceId: 's1',
        pageId,
        base: { title: 'Roadmap', content: 'Base\n', revision: 3 },
        draft: { title: 'Roadmap', content: 'Ship it\n' },
        ownRevisions: [],
        ...extra,
    });

describe('the Unsent list’s page writes', () => {
    const context = {
        chatTitle: () => null,
        resolve: () => null,
        spaceName,
        pageTitle: (spaceId: string, pageId: string) => (pageId === 'p1' ? 'Roadmap' : null),
        pageId: (localId: string) => (localId === 'local-page-a' ? 'p9' : null),
    };

    it('a save refused because its page is a folder now (CB-426) offers Retry, Copy and Discard', () => {
        const [folder, gone] = unsentListRows(
            [
                write({ id: 'w1', kind: PAGE_SAVE_KIND, payload: save('p1'), reason: PAGE_SAVE_REFUSALS.folder }),
                write({
                    id: 'w2',
                    kind: PAGE_SAVE_KIND,
                    payload: save('p1'),
                    reason: PAGE_SAVE_REFUSALS.deleted,
                    createdAt: 2,
                }),
            ],
            [],
            context,
        );
        expect(folder).toMatchObject({
            why: 'This page is now a folder, so this change wasn’t saved. Turn it back into a page to save it',
            retry: true,
            saveAsNew: null,
            opens: null,
        });
        expect(folder!.text).not.toBeNull();
        expect(gone!.retry).toBe(false);
    });

    it('says the page and its Space, and Copy takes the title and text', () => {
        const rows = unsentListRows(
            [
                write({
                    id: 'w1',
                    kind: PAGE_SAVE_KIND,
                    payload: save('p1'),
                    reason: PAGE_SAVE_REFUSALS.deleted,
                }),
                write({
                    id: 'w2',
                    kind: PAGE_CREATE_KIND,
                    payload: JSON.stringify({
                        spaceId: 's2',
                        pageId: 'local-page-b',
                        title: 'Plans',
                        content: '',
                    }),
                    reason: PAGE_MANAGE_REFUSALS.parentDeleted,
                    createdAt: 2,
                }),
                write({
                    id: 'w3',
                    kind: PAGE_MOVE_KIND,
                    payload: JSON.stringify({
                        spaceId: 's1',
                        pageId: 'p1',
                        to: 's2',
                        parentId: null,
                    }),
                    reason: PAGE_MANAGE_REFUSALS.moveTarget,
                    createdAt: 3,
                }),
                write({
                    id: 'w4',
                    kind: PAGE_DELETE_KIND,
                    payload: JSON.stringify({
                        spaceId: 's1',
                        pageId: 'p-unknown',
                        subpages: [],
                    }),
                    reason: PAGE_MANAGE_REFUSALS.deleteRefused,
                    createdAt: 4,
                }),
                write({
                    id: 'w5',
                    kind: PAGE_COVER_KIND,
                    payload: JSON.stringify({
                        spaceId: 's1',
                        pageId: 'p1',
                        change: { kind: 'remove' },
                        previous: null,
                    }),
                    reason: PAGE_MANAGE_REFUSALS.coverGone,
                    createdAt: 5,
                }),
            ],
            [],
            context,
        );
        expect(rows.map((row) => [row.what, row.where, row.text, row.why])).toEqual([
            ['Couldn’t save “Roadmap”', 'Engineering', 'Roadmap\n\nShip it\n', 'This page was deleted'],
            ['New page “Plans”', SOME_SPACE, 'Plans', 'Its parent page was deleted'],
            ['Move “Roadmap”', 'Engineering', null, 'That Space or parent page is no longer there'],
            ['Delete a page', 'Engineering', null, 'Only an admin or the person who created a page can delete it'],
            ['Remove the cover of “Roadmap”', 'Engineering', null, 'That image is no longer there'],
        ]);
        expect(rows[0]?.accessibilityLabel).toBe(
            'Couldn’t save “Roadmap”, Engineering, Roadmap Ship it, This page was deleted',
        );
    });

    it('says a long page in its label as a short excerpt, never the whole body; Copy still takes it all', () => {
        const body = `${'A long paragraph of the page. '.repeat(400)}The end.`;
        const [row] = unsentListRows(
            [
                write({
                    id: 'w1',
                    kind: PAGE_SAVE_KIND,
                    payload: JSON.stringify({
                        spaceId: 's1',
                        pageId: 'p1',
                        base: { title: 'Roadmap', content: '', revision: 1 },
                        draft: { title: 'Roadmap', content: body },
                        ownRevisions: [],
                    }),
                    reason: PAGE_SAVE_REFUSALS.deleted,
                }),
            ],
            [],
            context,
        );
        expect(row?.text).toBe(`Roadmap\n\n${body}`);
        const label = row?.accessibilityLabel ?? '';
        expect(label).not.toContain('The end.');
        expect(label).toMatch(
            /^Couldn’t save “Roadmap”, Engineering, Roadmap A long paragraph of the page\. .*…, This page was deleted$/,
        );
        const excerpt = label.slice('Couldn’t save “Roadmap”, Engineering, '.length, -', This page was deleted'.length);
        expect(excerpt.length).toBeLessThanOrEqual(UNSENT_LABEL_TEXT_MAX);
        expect(excerpt.length).toBeGreaterThan(UNSENT_LABEL_TEXT_MAX / 2);
    });

    it('offers Save as a new page for a save whose page is gone, and Open page for a conflict', () => {
        const rows = unsentListRows(
            [
                write({
                    id: 'gone',
                    kind: PAGE_SAVE_KIND,
                    payload: save('p1'),
                    reason: PAGE_SAVE_REFUSALS.deleted,
                }),
                write({
                    id: 'lost',
                    kind: PAGE_SAVE_KIND,
                    payload: save('p1'),
                    reason: UNSENT_GONE,
                    createdAt: 2,
                }),
                write({
                    id: 'never',
                    kind: PAGE_SAVE_KIND,
                    payload: save('local-page-x'),
                    reason: PAGE_SAVE_REFUSALS.noPage,
                    createdAt: 3,
                }),
                write({
                    id: 'refused',
                    kind: PAGE_SAVE_KIND,
                    payload: save('p1'),
                    reason: PAGE_SAVE_REFUSALS.refused,
                    createdAt: 4,
                }),
                write({
                    id: 'conflict',
                    kind: PAGE_SAVE_KIND,
                    lane: pageConflictLane('local-page-a'),
                    payload: save('local-page-a', {
                        theirs: {
                            spaceId: 's3',
                            title: 'Roadmap',
                            content: 'Theirs\n',
                            revision: 4,
                        },
                    }),
                    reason: PAGE_SAVE_REFUSALS.conflict,
                    createdAt: 5,
                }),
                write({
                    id: 'move',
                    kind: PAGE_MOVE_KIND,
                    payload: JSON.stringify({
                        spaceId: 's1',
                        pageId: 'p1',
                        to: 's2',
                        parentId: null,
                    }),
                    reason: UNSENT_GONE,
                    createdAt: 6,
                }),
            ],
            [],
            context,
        );
        const mine = { title: 'Roadmap', content: 'Ship it\n' };
        expect(rows.map((row) => [row.id, row.saveAsNew, row.opens])).toEqual([
            ['gone', { spaceId: 's1', mine }, null],
            ['lost', { spaceId: 's1', mine }, null],
            ['never', { spaceId: 's1', mine }, null],
            ['refused', null, null],
            // The conflict opens its page where theirs is now, by its server id once its create resolved.
            ['conflict', null, { spaceId: 's3', pageId: 'p9' }],
            ['move', null, null],
        ]);
        expect([SAVE_AS_NEW_PAGE, OPEN_PAGE]).toEqual(['Save as a new page', 'Open page']);
    });

    it('saves a refused save as a new page once, then lets it go', async () => {
        const refused = write({
            id: 'gone',
            kind: PAGE_SAVE_KIND,
            payload: save('p1'),
            reason: 'page-deleted',
        });
        let unsent = [refused];
        const enqueued: {
            id: string;
            kind: string;
            lane: string;
            payload: string;
        }[] = [];
        const outbox = {
            rows: () => [],
            unsent: () => unsent,
            resolve: () => null,
            enqueue: async (row: { id: string; kind: string; lane: string; payload: string }) => {
                enqueued.push(row);
                return row;
            },
            discardUnsent: async (id: string) => {
                const found = unsent.find((item) => item.id === id) ?? null;
                unsent = unsent.filter((item) => item.id !== id);
                return found;
            },
        };
        let n = 0;
        const options = {
            outbox: outbox as never,
            newId: () => `uuid-${++n}`,
            spaceId: 's2',
            createdBy: 'user-me',
            serverAt: null,
            known: [],
        };
        const [first, again] = await Promise.all([
            saveMineAsNewPage({ id: 'gone', mine: { title: 'Roadmap', content: 'Ship it\n' } }, options),
            saveMineAsNewPage({ id: 'gone', mine: { title: 'Roadmap', content: 'Ship it\n' } }, options),
        ]);
        expect(first).not.toBeNull();
        expect(again).toBe(first);
        expect(enqueued).toHaveLength(1);
        expect(enqueued[0]).toMatchObject({
            kind: PAGE_CREATE_KIND,
            lane: pageLane(first ?? ''),
        });
        expect(JSON.parse(enqueued[0]!.payload)).toMatchObject({
            spaceId: 's2',
            title: 'Roadmap',
            content: 'Ship it\n',
        });
        expect(unsent).toEqual([]);
    });
});

describe('Save as a new page’s Spaces', () => {
    it('offers the page’s own Space first, then the others by name', () => {
        const spaces = [
            { id: 'b', name: 'Zeta' },
            { id: 'a', name: 'Alpha' },
            { id: 's1', name: 'Mine' },
        ];
        expect(saveAsNewTargets(spaces, 's1').map((space) => space.id)).toEqual(['s1', 'a', 'b']);
        expect(saveAsNewTargets(spaces, 'gone').map((space) => space.id)).toEqual(['a', 's1', 'b']);
    });
});
