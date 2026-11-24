import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it, vi } from 'vitest';

import { migrate } from '@socio/data/migrate';
import type { CoverImage, PageLibrary, PageSummary, Page } from '@socio/shared/pages/page-library';
import type { Space } from '@socio/shared/types';

import { pagesSchema } from '../src/server/pages/pages.js';
import { workspaceSchema } from '../src/server/workspace/workspace.js';

import { PNG, pngOf } from './fixtures/media.js';
import { roomsFixture } from './fixtures/rooms.js';

// Page covers (CB-308): a cover is a media embed (CB-230) named on the
// page, set from the editor's own image file or an image already in the
// Space, by whoever may edit the page; removing one keeps the image.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const MB = 1048576;

/** Ada's private Space with Mo, a page in it, and the open Space's page. */
async function fixture() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const f = await roomsFixture(cleanup);
    const json = async <T>(response: Promise<Response> | Response) => (await response).json() as Promise<T>;
    const made = await f.as('ada')('/spaces', 'POST', {
        name: 'Deals',
        description: 'Not for everyone.',
        private: true,
        people: [{ userId: 'mo', role: 'member' }],
    });
    expect(made.status).toBe(201);
    const space = ((await made.json()) as Space).id;
    const page = await json<Page>(
        f.as('ada')(`/spaces/${space}/pages`, 'POST', {
            title: 'The deal',
            content: 'Terms.',
        }),
    );
    const open = f.company.spaceId;
    const openPage = await json<Page>(f.as('olive')(`/spaces/${open}/pages`, 'POST', { title: 'Handbook' }));
    /** One of `userId`'s files, as an upload to the Media page stores it. */
    const file = async (userId: string, name: string, bytes: Uint8Array) =>
        (
            await f.platform.media.upload(userId, {
                name,
                bytes,
                purpose: 'file',
            })
        ).item.id;
    const cover = (person: string, pageId: string, body: unknown) =>
        f.as(person)(`/spaces/${space}/pages/${pageId}/cover`, 'PUT', body);
    return { ...f, json, space, page, open, openPage, file, cover };
}

it('adds a nullable coverId to pages, keeping every row (pages 10)', () => {
    const upgraded = new DatabaseSync(':memory:');
    const fresh = new DatabaseSync(':memory:');
    cleanup.push(
        () => upgraded.close(),
        () => fresh.close(),
    );
    migrate(upgraded, [workspaceSchema, { ...pagesSchema, migrations: pagesSchema.migrations!.slice(0, 9) }]);
    upgraded.exec(`INSERT INTO pages (id, spaceId, parentId, title, content, revision, createdAt, updatedAt, sourceThreadId, createdBy) VALUES
    ('p1', 's1', NULL, 'One', 'Body', 3, 1, 2, NULL, 'ada');`);
    const before = upgraded.prepare('SELECT * FROM pages').all();
    expect(migrate(upgraded, [workspaceSchema, pagesSchema])).toEqual([
        { module: 'pages', version: 10, name: 'page covers', action: 'apply' },
        { module: 'pages', version: 11, name: 'page tags', action: 'apply' },
        { module: 'pages', version: 12, name: 'page links', action: 'apply' },
        { module: 'pages', version: 13, name: 'page source attribution', action: 'apply' },
    ]);
    expect(upgraded.prepare('SELECT * FROM pages').all()).toEqual(
        before.map((row) => ({ ...row, coverId: null, sourceUrl: null, sourceTitle: null })),
    );
    const column = (db: DatabaseSync) =>
        db.prepare("SELECT * FROM pragma_table_info('pages') WHERE name='coverId'").get();
    migrate(fresh, [workspaceSchema, pagesSchema]);
    expect(column(upgraded)).toMatchObject({
        type: 'TEXT',
        notnull: 0,
        dflt_value: null,
    });
    expect(column(upgraded)).toEqual(column(fresh));
});

it('sets a cover from the editor’s own image, outside the page’s revisions', async () => {
    const f = await fixture();
    const fileId = await f.file('mo', 'beach.png', PNG);
    const response = await f.cover('mo', f.page.id, { fileId });
    expect(response.status).toBe(200);
    const page = (await response.json()) as Page;
    expect(page.cover).toEqual({
        id: expect.stringMatching(/^cbemb_/),
        url: `/api/media/embeds/${page.cover!.id}/content`,
    });
    // Not the page's text: no new revision, so an open editor still saves.
    expect(page.revision).toBe(f.page.revision);
    expect(page.updatedAt).toBeGreaterThanOrEqual(f.page.updatedAt);
    expect(page.content).toBe(f.page.content);
    // Every reader of the Space sees it; nobody outside does.
    for (const [person, status] of [
        ['ada', 200],
        ['alice', 200],
        ['nina', 404],
    ] as const) {
        expect((await f.as(person)(page.cover!.url.slice(4))).status, person).toBe(status);
    }
    // The page view carries it.
    expect((await f.json<Page>(f.as('ada')(`/spaces/${f.space}/pages/${f.page.id}`))).cover).toEqual(page.cover);
    // The file stays in Mo's Files.
    expect(f.platform.data.fileRecord('mo', fileId)?.mediaType).toBe('image/png');
    // An edit right after keeps working at the same revision.
    expect(
        (
            await f.as('ada')(`/spaces/${f.space}/pages/${f.page.id}`, 'PATCH', {
                title: 'The deal, signed',
                expectedRevision: f.page.revision,
            })
        ).status,
    ).toBe(200);
});

it('sets a cover from an image already in the Space, without a copy', async () => {
    const f = await fixture();
    const card = await f.platform.media.saveEmbedMedia('ada', {
        name: 'card.png',
        bytes: PNG,
        folder: 'unfurled/example.com',
        spaceId: f.space,
        dotId: null,
        sourceUrl: 'https://example.com/',
    });
    const response = await f.cover('mo', f.page.id, { embedId: card.id });
    expect(response.status).toBe(200);
    expect(((await response.json()) as Page).cover?.id).toBe(card.id);
    // Nothing new in Mo's Files.
    expect(f.platform.data.fileRecords('mo')).toEqual([]);
});

it('refuses covers nobody may set here', async () => {
    const f = await fixture();
    const image = await f.file('ada', 'beach.png', PNG);
    // Someone who can't edit the page (outside the private Space): as for a
    // Space that isn't there.
    const outside = await f.cover('nina', f.page.id, { fileId: image });
    expect(outside.status).toBe(404);
    expect(await outside.json()).toEqual({ error: 'Space not found.' });
    // An image of another Space can't be borrowed.
    const elsewhere = await f.platform.media.saveEmbedMedia('ada', {
        name: 'card.png',
        bytes: PNG,
        folder: 'unfurled/example.com',
        spaceId: f.open,
        dotId: null,
        sourceUrl: 'https://example.com/',
    });
    const borrowed = await f.cover('ada', f.page.id, { embedId: elsewhere.id });
    expect(borrowed.status).toBe(404);
    expect(await borrowed.json()).toEqual({ error: 'Image not found.' });
    // Not an image.
    const text = await f.file('ada', 'notes.txt', Buffer.from('Just text.'));
    const notImage = await f.cover('ada', f.page.id, { fileId: text });
    expect(notImage.status).toBe(415);
    expect(await notImage.json()).toEqual({ error: 'That is not an image.' });
    const svg = await f.file('ada', 'logo.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'));
    expect((await f.cover('ada', f.page.id, { fileId: svg })).status).toBe(415);
    // Too large: over 5 MB.
    const large = await f.file('ada', 'large.png', pngOf(5 * MB + 1));
    const tooLarge = await f.cover('ada', f.page.id, { fileId: large });
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toEqual({
        error: 'Covers can be at most 5 MB.',
    });
    const justFits = await f.file('ada', 'fits.png', pngOf(5 * MB));
    expect((await f.cover('ada', f.page.id, { fileId: justFits })).status).toBe(200);
    // An unknown file, and someone else's, are not found.
    for (const fileId of ['no-such-file', await f.file('mo', 'mo.png', PNG)]) {
        const missing = await f.cover('ada', f.page.id, { fileId });
        expect(missing.status).toBe(404);
        expect(await missing.json()).toEqual({ error: 'File not found.' });
    }
    // Neither or both: a bad request.
    for (const body of [{}, { fileId: image, embedId: 'x' }, { url: 'x' }]) {
        expect((await f.cover('ada', f.page.id, body)).status).toBe(400);
    }
    // A deleted page, as any other edit of it.
    expect((await f.as('ada')(`/spaces/${f.space}/pages/${f.page.id}`, 'DELETE')).status).toBe(200);
    const embeds = f.platform.media as unknown as {
        repos: { embeds: { forSpace(id: string, n: number): Promise<unknown[]> } };
    };
    const before = await embeds.repos.embeds.forSpace(f.space, 100);
    for (const response of [
        await f.cover('ada', f.page.id, { fileId: image }),
        await f.as('ada')(`/spaces/${f.space}/pages/${f.page.id}/cover`, 'DELETE'),
        await f.as('ada')(`/spaces/${f.space}/pages/${f.page.id}`, 'PATCH', {
            title: 'Back?',
            expectedRevision: f.page.revision,
        }),
    ]) {
        expect(response.status).toBe(410);
        expect(await response.json()).toEqual({ error: 'This page was deleted.' });
    }
    // Nothing was recorded for the refused cover.
    expect(await embeds.repos.embeds.forSpace(f.space, 100)).toEqual(before);
});

it('removes a cover softly, and Undo puts it back', async () => {
    const f = await fixture();
    const fileId = await f.file('ada', 'beach.png', PNG);
    const set = await f.json<Page>(f.cover('ada', f.page.id, { fileId }));
    const removed = await f.as('mo')(`/spaces/${f.space}/pages/${f.page.id}/cover`, 'DELETE');
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ previous: set.cover!.id });
    const page = await f.json<Page>(f.as('ada')(`/spaces/${f.space}/pages/${f.page.id}`));
    expect(page.cover).toBeNull();
    expect(page.revision).toBe(f.page.revision);
    // The image stays in its owner's Files, and still shows to readers.
    expect(f.platform.data.fileRecord('ada', fileId)).toBeDefined();
    expect((await f.as('mo')(set.cover!.url.slice(4))).status).toBe(200);
    // Removing it again: nothing to undo.
    expect(await f.json(f.as('mo')(`/spaces/${f.space}/pages/${f.page.id}/cover`, 'DELETE'))).toEqual({
        previous: null,
    });
    // Undo: the same embed, put back by anyone who may edit the page.
    const undone = await f.json<Page>(f.cover('mo', f.page.id, { embedId: set.cover!.id }));
    expect(undone.cover).toEqual(set.cover);
    // Outside the Space, a removal is refused like any other edit.
    expect((await f.as('nina')(`/spaces/${f.space}/pages/${f.page.id}/cover`, 'DELETE')).status).toBe(404);
});

it('lists covers, and whether the Space has any, for the library', async () => {
    const f = await fixture();
    const second = await f.json<Page>(f.as('ada')(`/spaces/${f.space}/pages`, 'POST', { title: 'Second' }));
    const library = (spaceId: string, limit = 60) =>
        f.json<PageLibrary>(f.as('ada')(`/spaces/${spaceId}/pages?bodies=false&limit=${limit}`));
    expect((await library(f.space)).hasCovers).toBe(false);
    expect((await library(f.space)).pages.map((page) => page.cover)).toEqual([null, null]);
    const fileId = await f.file('ada', 'beach.png', PNG);
    const { cover } = await f.json<Page>(f.cover('ada', f.page.id, { fileId }));
    // The covered page was edited last, so the first screen of one page
    // leaves out the other: the flag still counts every live page.
    await f.as('ada')(`/spaces/${f.space}/pages/${second.id}`, 'PATCH', {
        title: 'Second, edited',
        expectedRevision: second.revision,
    });
    const first = await library(f.space, 1);
    expect(first.pages.map((page) => [page.id, page.cover])).toEqual([[second.id, null]]);
    expect(first.hasCovers).toBe(true);
    // Every page of the Space, as an open Space polls them.
    const all = await f.json<PageSummary[]>(f.as('ada')(`/spaces/${f.space}/pages`));
    expect(Object.fromEntries(all.map((page) => [page.id, page.cover]))).toEqual({
        [f.page.id]: cover,
        [second.id]: null,
    });
    // Another Space is unaffected.
    expect((await library(f.open)).hasCovers).toBe(false);
    // Deleting the image file takes the cover off the page and the flag.
    await f.platform.media.deleteItem('ada', fileId);
    expect((await f.json<Page>(f.as('ada')(`/spaces/${f.space}/pages/${f.page.id}`))).cover).toBeNull();
    expect((await library(f.space)).hasCovers).toBe(false);
    // A deleted page's cover doesn't count either.
    await f.cover('ada', second.id, {
        fileId: await f.file('ada', 'other.png', PNG),
    });
    expect((await library(f.space)).hasCovers).toBe(true);
    await f.as('ada')(`/spaces/${f.space}/pages/${second.id}`, 'DELETE');
    expect((await library(f.space)).hasCovers).toBe(false);
});

it('offers the Space’s images to its readers only, newest first', async () => {
    const f = await fixture();
    const card = await f.platform.media.saveEmbedMedia('ada', {
        name: 'card.png',
        bytes: PNG,
        folder: 'unfurled/example.com',
        spaceId: f.space,
        dotId: null,
        sourceUrl: 'https://example.com/',
    });
    await f.platform.media.saveEmbedMedia('ada', {
        name: 'elsewhere.png',
        bytes: PNG,
        folder: 'unfurled/example.com',
        spaceId: f.open,
        dotId: null,
        sourceUrl: 'https://example.com/',
    });
    const fileId = await f.file('mo', 'beach.png', PNG);
    const { cover } = await f.json<Page>(f.cover('mo', f.page.id, { fileId }));
    const images = (person: string) => f.as(person)(`/spaces/${f.space}/cover-images`);
    const listed = await f.json<CoverImage[]>(images('ada'));
    expect(listed.map((image) => [image.id, image.name])).toEqual([
        [cover!.id, 'beach.png'],
        [card.id, 'card.png'],
    ]);
    expect(listed[0]).toMatchObject({
        url: cover!.url,
        mediaType: 'image/png',
    });
    // Someone who can't read the Space: as for one that isn't there.
    const outside = await images('nina');
    expect(outside.status).toBe(404);
    expect(await outside.json()).toEqual({ error: 'Space not found.' });
    // The same file set twice is listed once, as its newest embed.
    const again = await f.json<Page>(f.cover('mo', f.page.id, { fileId }));
    expect(again.cover!.id).not.toBe(cover!.id);
    expect((await f.json<CoverImage[]>(images('mo'))).map((image) => image.id)).toEqual([again.cover!.id, card.id]);
    // An image whose file was deleted is no longer offered.
    await f.platform.media.deleteItem('mo', fileId);
    expect((await f.json<CoverImage[]>(images('alice'))).map((image) => image.id)).toEqual([card.id]);
});

it('gives a moved page its cover in the new Space, and audits cover changes', async () => {
    const f = await fixture();
    const fileId = await f.file('ada', 'beach.png', PNG);
    const set = (await (await f.cover('ada', f.page.id, { fileId })).json()) as Page;
    const before = set.cover!;
    // Nina can't read the private Space, so she can't see its cover…
    expect((await f.as('nina')(before.url.slice(4))).status).toBe(404);
    const moved = await f.as('ada')(`/spaces/${f.space}/pages/${f.page.id}/move`, 'POST', {
        spaceId: f.open,
    });
    expect(moved.status).toBe(200);
    const page = ((await moved.json()) as { page: Page }).page;
    // …but once the page is in the open Space, its cover is a copy there.
    expect(page.cover?.id).not.toBe(before.id);
    expect((await f.as('nina')(page.cover!.url.slice(4))).status).toBe(200);
    // The original stays for the old Space's pages that may show it.
    expect((await f.as('ada')(before.url.slice(4))).status).toBe(200);
    // Set and removed covers are in the audit log (no text revision).
    await f.as('ada')(`/spaces/${f.open}/pages/${f.page.id}/cover`, 'DELETE');
    const audit = f.platform.workspace.db
        .prepare("SELECT action, detail FROM workspace_audit WHERE targetKind='page' AND targetId=? ORDER BY id")
        .all(f.page.id) as { action: string; detail: string }[];
    expect(audit.map((row) => row.detail).filter((detail) => detail.startsWith('cover'))).toEqual([
        `cover ${before.id}`,
        `cover removed (${page.cover!.id})`,
    ]);
});
