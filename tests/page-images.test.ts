import { Context } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import { EMBED_MEDIA_ID, embedCardMarkdown, type EmbedCard } from '@socio/shared/embed-card';
import { pageImageMarkdown } from '@socio/shared/page-image';
import { findFences } from '@socio/shared/pages/fences';
import { mergeUnits } from '@socio/shared/pages/merge-lines';
import type { Page } from '@socio/shared/pages/page-library';
import { pageText } from '@socio/shared/pages/page-text';
import type { Space } from '@socio/shared/types';

import { mayHavePictures, pageMarkdown, rewritePageImages } from '../src/server/pages/page-images.js';
import { Pages } from '../src/server/pages/pages.js';
import { SpacePages } from '../src/server/spaces/contract.js';

import { PNG, pngOf } from './fixtures/media.js';
import { roomsFixture } from './fixtures/rooms.js';

// Pictures in pages (CB-358): `POST /spaces/:id/images` makes an
// image of the Space from a person's own file exactly as a cover is made
// (media's `coverFromFile`), and a move copies the pictures its pages'
// ```image fences name into the new Space, as it copies covers.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const MB = 1048576;

type Made = { embedId: string; url: string };
type Embeds = {
    repos: {
        embeds: {
            forSpace(id: string, n: number): Promise<Array<{ id: string; fileId: string }>>;
            byId(id: string): Promise<{ fileId: string } | undefined>;
        };
    };
};

/** Two members-only Spaces: Deals (Ada, Mo) and Board (Ada, Nina). */
async function fixture() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const f = await roomsFixture(cleanup);
    const json = async <T>(response: Promise<Response> | Response) => (await response).json() as Promise<T>;
    const privateSpace = async (name: string, people: string[]) => {
        const made = await f.as('ada')('/spaces', 'POST', {
            name,
            description: 'Not for everyone.',
            private: true,
            people: people.map((userId) => ({ userId, role: 'member' })),
        });
        expect(made.status).toBe(201);
        return ((await made.json()) as Space).id;
    };
    const space = await privateSpace('Deals', ['mo']);
    const board = await privateSpace('Board', ['nina']);
    const file = async (userId: string, name: string, bytes: Uint8Array) =>
        (await f.platform.media.upload(userId, { name, bytes, purpose: 'file' })).item.id;
    const image = (person: string, spaceId: string, body: unknown) =>
        f.as(person)(`/spaces/${spaceId}/images`, 'POST', body);
    const embeds = (spaceId: string) =>
        (f.platform.media as unknown as Embeds).repos.embeds
            .forSpace(spaceId, 100)
            .then((rows) => rows.map((row) => row.id));
    // A link card's image (CB-230), as `/unfurl` saves it for a page of `spaceId`.
    const cardMedia = async (spaceId: string) =>
        (
            await f.platform.media.saveEmbedMedia('ada', {
                name: 'card.png',
                bytes: PNG,
                folder: 'unfurled/example.com',
                spaceId,
                dotId: null,
                sourceUrl: 'https://example.com/',
            })
        ).id;
    // The embed of `spaceId` made from `original`'s file: its copy there.
    const copyOf = async (original: string, spaceId: string) => {
        const repo = (f.platform.media as unknown as Embeds).repos.embeds;
        const { fileId } = (await repo.byId(original))!;
        const rows = (await repo.forSpace(spaceId, 100)).filter((row) => row.fileId === fileId);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.id).not.toBe(original);
        return rows[0]!.id;
    };
    return { ...f, json, space, board, file, image, embeds, cardMedia, copyOf };
}

/** A link card with these media, its title and its last image's alt holding the first id's text. */
const card = (ids: string[]): EmbedCard => ({
    url: 'https://example.com/post/1',
    kind: 'post',
    provider: 'Example',
    title: ids[0]!,
    text: `About "${ids[0]}".`,
    media: ids.map((id, index) => ({
        id,
        kind: 'image',
        ...(index === ids.length - 1 ? { alt: ids[0] } : {}),
        width: 640,
        height: 480,
    })),
    fetchedAt: '2026-11-01T00:00:00.000Z',
});

it('makes a picture of the Space from the person’s own image, as a cover is made', async () => {
    const f = await fixture();
    const fileId = await f.file('mo', 'whiteboard.png', PNG);
    const response = await f.image('mo', f.space, { fileId });
    expect(response.status).toBe(201);
    const made = (await response.json()) as Made;
    expect(made).toEqual({
        embedId: expect.stringMatching(/^cbemb_/),
        url: `/api/media/embeds/${made.embedId}/content`,
    });
    // Every reader of the Space sees it; nobody outside does.
    for (const [person, status] of [
        ['mo', 200],
        ['ada', 200],
        ['alice', 200],
        ['nina', 404],
    ] as const) {
        expect((await f.as(person)(made.url.slice(4))).status, person).toBe(status);
    }
    // An image of the Space, offered with its covers; the file stays Mo's.
    expect(await f.embeds(f.space)).toEqual([made.embedId]);
    expect(f.platform.data.fileRecord('mo', fileId)?.mediaType).toBe('image/png');
    const audit = f.platform.workspace.db
        .prepare("SELECT actor, action, detail FROM workspace_audit WHERE targetKind='space' AND targetId=?")
        .all(f.space) as Array<{ actor: string; action: string; detail: string }>;
    expect(audit.filter((row) => row.detail.startsWith('page image'))).toEqual([
        { actor: 'mo', action: 'create', detail: `page image ${made.embedId}` },
    ]);
});

it('refuses pictures nobody may add here, in image words', async () => {
    const f = await fixture();
    const own = await f.file('ada', 'beach.png', PNG);
    // A Space the person can't read: as for one that isn't there.
    const outside = await f.image('nina', f.space, { fileId: await f.file('nina', 'n.png', PNG) });
    expect(outside.status).toBe(404);
    expect(await outside.json()).toEqual({ error: 'Space not found.' });
    // Someone else's file, or none: not found.
    for (const fileId of ['no-such-file', await f.file('mo', 'mo.png', PNG)]) {
        const missing = await f.image('ada', f.space, { fileId });
        expect(missing.status).toBe(404);
        expect(await missing.json()).toEqual({ error: 'File not found.' });
    }
    // Not an image (SVG neither).
    for (const [name, bytes] of [
        ['notes.txt', Buffer.from('Just text.')],
        ['logo.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ] as const) {
        const refused = await f.image('ada', f.space, { fileId: await f.file('ada', name, bytes) });
        expect(refused.status, name).toBe(415);
        expect(await refused.json()).toEqual({ error: 'That is not an image.' });
    }
    // The cover's limit, said for a picture.
    const tooLarge = await f.image('ada', f.space, { fileId: await f.file('ada', 'large.png', pngOf(5 * MB + 1)) });
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toEqual({ error: 'Images can be at most 5 MB.' });
    expect((await f.image('ada', f.space, { fileId: await f.file('ada', 'fits.png', pngOf(5 * MB)) })).status).toBe(
        201,
    );
    // A bad body.
    for (const body of [{}, { fileId: own, spaceId: f.space }, { url: 'https://example.com/a.png' }]) {
        expect((await f.image('ada', f.space, body)).status).toBe(400);
    }
    // Nothing was recorded for any refusal: only the one that fit.
    expect(await f.embeds(f.space)).toHaveLength(1);
});

it('copies a moved page’s pictures into a members-only Space, in the move’s revision', async () => {
    const f = await fixture();
    const fileId = await f.file('ada', 'whiteboard.png', PNG);
    const made = await f.json<Made>(f.image('ada', f.space, { fileId }));
    // An image of another Space, named in a fence by hand, and a fence that
    // doesn't parse.
    const elsewhere = await f.platform.media.saveEmbedMedia('ada', {
        name: 'card.png',
        bytes: PNG,
        folder: 'unfurled/example.com',
        spaceId: f.company.spaceId,
        dotId: null,
        sourceUrl: 'https://example.com/',
    });
    const picture = pageImageMarkdown({ id: made.embedId, alt: 'The whiteboard', width: 1600, height: 1200 });
    const foreign = pageImageMarkdown({ id: elsewhere.id });
    const broken = '```image\n{ "id": "cbemb_not json\n```';
    const content = `Before.\n\n${picture}\n\n${foreign}\n\n${broken}\n\nAfter.`;
    const page = await f.json<Page>(f.as('ada')(`/spaces/${f.space}/pages`, 'POST', { title: 'Plan', content }));
    const child = await f.json<Page>(
        f.as('ada')(`/spaces/${f.space}/pages`, 'POST', {
            title: 'Detail',
            content: `- A list\n\n  ${picture.replace(/\n/g, '\n  ')}\n\n> ${picture.replace(/\n/g, '\n> ')}\n\n- ${picture.replace(/\n/g, '\n  ')}\n`,
            parentId: page.id,
        }),
    );
    // Nina can't read Deals, so she can't see its picture…
    expect((await f.as('nina')(made.url.slice(4))).status).toBe(404);
    const moved = await f.as('ada')(`/spaces/${f.space}/pages/${page.id}/move`, 'POST', { spaceId: f.board });
    expect(moved.status).toBe(200);
    const result = (await moved.json()) as { page: Page; moved: string[] };
    expect(result.moved).toEqual([page.id, child.id]);
    // …but in Board the fence names a copy there, made once for both pages.
    const copies = await f.embeds(f.board);
    expect(copies).toHaveLength(1);
    const [copy] = copies as [string];
    expect(copy).not.toBe(made.embedId);
    expect((await f.as('nina')(`/media/embeds/${copy}/content`)).status).toBe(200);
    const there = await f.json<Page>(f.as('nina')(`/spaces/${f.board}/pages/${page.id}`));
    expect(there.content).toBe(
        `Before.\n\n${pageImageMarkdown({ id: copy, alt: 'The whiteboard', width: 1600, height: 1200 })}\n\n${foreign}\n\n${broken}\n\nAfter.`,
    );
    // One revision: the move's.
    expect(there.revision).toBe(page.revision + 1);
    expect(result.page.content).toBe(there.content);
    // A picture in a list item, a quote or on a list marker's line is copied too.
    const copied = pageImageMarkdown({ id: copy, alt: 'The whiteboard', width: 1600, height: 1200 });
    const subpage = await f.json<Page>(f.as('nina')(`/spaces/${f.board}/pages/${child.id}`));
    expect(subpage.content).toBe(
        `- A list\n\n  ${copied.replace(/\n/g, '\n  ')}\n\n> ${copied.replace(/\n/g, '\n> ')}\n\n- ${copied.replace(/\n/g, '\n  ')}\n`,
    );
    expect(subpage.revision).toBe(child.revision + 1);
    // The image of another Space was never copied, nor Deals' original lost.
    expect(await f.embeds(f.company.spaceId)).toEqual([elsewhere.id]);
    expect(await f.embeds(f.space)).toEqual([made.embedId]);
    expect((await f.as('mo')(made.url.slice(4))).status).toBe(200);
    // The search index has the moved text, as `pageText` reads it: that
    // drops a `_` at a word's edge, so an id like `cbemb_B_-W…` is indexed
    // as `cbemb_B-W…`, and the raw id is not what to look for.
    const indexed = f.platform.workspace.db
        .prepare('SELECT spaceId, body FROM page_search WHERE pageId=?')
        .get(page.id) as { spaceId: string; body: string } | undefined;
    expect(indexed?.spaceId).toBe(f.board);
    expect(indexed?.body).toBe(pageText(there.content));
    expect(indexed?.body).not.toBe(pageText(content));
});

it('copies a moved page’s link-card media into a members-only Space, so its readers see them', async () => {
    const f = await fixture();
    // Two images of a card made in Deals, and one of another Space named
    // on the card by hand.
    const [a, b] = [await f.cardMedia(f.space), await f.cardMedia(f.space)];
    const elsewhere = await f.cardMedia(f.company.spaceId);
    const fence = embedCardMarkdown(card([a, elsewhere, b]));
    // The same card in a list item, and a card in a quote.
    const content = `Before.\n\n${fence}\n\n- ${fence.replace(/\n/g, '\n  ')}\n\n> ${embedCardMarkdown(card([b])).replace(/\n/g, '\n> ')}\n`;
    const page = await f.json<Page>(f.as('ada')(`/spaces/${f.space}/pages`, 'POST', { title: 'Links', content }));
    // Nina reads Board, not Deals: the card's images aren't hers to see.
    for (const id of [a, b]) {
        expect((await f.as('nina')(`/media/embeds/${id}/content`)).status).toBe(404);
    }
    const moved = await f.as('ada')(`/spaces/${f.space}/pages/${page.id}/move`, 'POST', { spaceId: f.board });
    expect(moved.status).toBe(200);
    // One copy each in Board, in the order the move met them.
    const copies = await f.embeds(f.board);
    expect(copies).toHaveLength(2);
    const there = await f.json<Page>(f.as('nina')(`/spaces/${f.board}/pages/${page.id}`));
    const [ca, cb] = [await f.copyOf(a, f.board), await f.copyOf(b, f.board)];
    const swap = (ids: string[]) => ids.map((id) => (id === a ? ca : id === b ? cb : id));
    // Only the media's ids change: the title, text and alt that hold the
    // first id's text, and the other Space's image, stay as they were.
    const copied = (ids: string[]) => {
        const made = card(swap(ids));
        return embedCardMarkdown({
            ...made,
            title: ids[0]!,
            text: `About "${ids[0]}".`,
            media: made.media!.map((item, index) => (index === ids.length - 1 ? { ...item, alt: ids[0] } : item)),
        });
    };
    expect(there.content).toBe(
        `Before.\n\n${copied([a, elsewhere, b])}\n\n- ${copied([a, elsewhere, b]).replace(/\n/g, '\n  ')}\n\n> ${copied([b]).replace(/\n/g, '\n> ')}\n`,
    );
    expect(there.revision).toBe(page.revision + 1);
    // A reader of only Board sees each copy; the other Space's image was
    // never copied, and Deals keeps its originals.
    for (const id of [ca, cb]) {
        expect((await f.as('nina')(`/media/embeds/${id}/content`)).status, id).toBe(200);
    }
    expect(await f.embeds(f.company.spaceId)).toEqual([elsewhere]);
    expect((await f.embeds(f.space)).sort()).toEqual([a, b].sort());
    expect((await f.as('mo')(`/media/embeds/${a}/content`)).status).toBe(200);
});

it('copies pictures, link-card media and covers on a socio’s move too, for a reader of only the new Space', async () => {
    const f = await fixture();
    // The company socio, granted both Spaces, in a chat of Ada's.
    const dot = f.company;
    f.workspace.updateDot(dot.id, {
        name: dot.name,
        instructions: dot.instructions,
        researchAllowed: dot.researchAllowed,
        memoryAllowed: dot.memoryAllowed,
        spaceIds: [dot.spaceId, f.space, f.board],
    });
    f.workspace.bindThread('ada-chat', dot.id, 'Chat', 'ada');
    const picture = await f.json<Made>(f.image('ada', f.space, { fileId: await f.file('ada', 'w.png', PNG) }));
    const media = await f.cardMedia(f.space);
    const content = `${pageImageMarkdown({ id: picture.embedId })}\n\n${embedCardMarkdown(card([media]))}\n`;
    const page = await f.json<Page>(f.as('ada')(`/spaces/${f.space}/pages`, 'POST', { title: 'Plan', content }));
    const covered = await f.as('ada')(`/spaces/${f.space}/pages/${page.id}/cover`, 'PUT', {
        fileId: await f.file('ada', 'cover.png', PNG),
    });
    expect(covered.status).toBe(200);
    const cover = ((await covered.json()) as Page).cover!.id;
    // The tools the Spaces module gives the socio, as the app composes them.
    const tools = Context.get(f.edge.services, SpacePages).tools({
        spaceId: f.space,
        threadId: 'ada-chat',
        check: () => {},
    });
    const move = tools.find((tool) => tool.name === 'move_space_page')!;
    expect(await move.execute!({ id: page.id, toSpaceId: f.board } as never)).toMatchObject({
        id: page.id,
        spaceId: f.board,
        from: f.space,
    });
    // Each of the three is a new embed of Board, which Nina, a reader of
    // only Board, sees; the originals stay Deals' own.
    const copies = await f.embeds(f.board);
    expect(copies).toHaveLength(3);
    const there = await f.json<Page>(f.as('nina')(`/spaces/${f.board}/pages/${page.id}`));
    const [copiedPicture, copiedMedia, copiedCover] = [
        await f.copyOf(picture.embedId, f.board),
        await f.copyOf(media, f.board),
        await f.copyOf(cover, f.board),
    ];
    expect(there.content).toBe(
        `${pageImageMarkdown({ id: copiedPicture })}\n\n${embedCardMarkdown(card([copiedMedia]))}\n`
            .replace(`"title": "${copiedMedia}"`, `"title": "${media}"`)
            .replace(`About \\"${copiedMedia}\\".`, `About \\"${media}\\".`)
            .replace(`"alt": "${copiedMedia}"`, `"alt": "${media}"`),
    );
    expect(there.cover?.id).toBe(copiedCover);
    for (const id of [copiedPicture, copiedMedia, copiedCover]) {
        expect((await f.as('nina')(`/media/embeds/${id}/content`)).status, id).toBe(200);
    }
    for (const id of [picture.embedId, media, cover]) {
        expect((await f.as('nina')(`/media/embeds/${id}/content`)).status, id).toBe(404);
    }
    expect(f.workspace.auditOf('page', page.id)).toContainEqual(
        expect.objectContaining({ actor: `dot:${dot.id}`, action: 'move' }),
    );
});

it('moves a page without pictures, or with ones it can’t copy, unchanged', async () => {
    const f = await fixture();
    const fileId = await f.file('ada', 'whiteboard.png', PNG);
    const made = await f.json<Made>(f.image('ada', f.space, { fileId }));
    // The picture's file is deleted: nothing to copy, the fence stays.
    await f.platform.media.deleteItem('ada', fileId);
    const content = `Text.\n\n${pageImageMarkdown({ id: made.embedId })}\n`;
    const page = await f.json<Page>(f.as('ada')(`/spaces/${f.space}/pages`, 'POST', { title: 'Plan', content }));
    const plain = await f.json<Page>(
        f.as('ada')(`/spaces/${f.space}/pages`, 'POST', { title: 'Plain', content: 'Words.' }),
    );
    for (const item of [page, plain]) {
        expect(
            (await f.as('ada')(`/spaces/${f.space}/pages/${item.id}/move`, 'POST', { spaceId: f.board })).status,
        ).toBe(200);
        const there = await f.json<Page>(f.as('ada')(`/spaces/${f.board}/pages/${item.id}`));
        expect(there.content).toBe(item.content);
        expect(there.revision).toBe(item.revision + 1);
    }
    expect(await f.embeds(f.board)).toEqual([]);
});

it('stops a move whole, with a code, when a page changes between reading and writing it', async () => {
    const f = await fixture();
    const fileId = await f.file('ada', 'whiteboard.png', PNG);
    const made = await f.json<Made>(f.image('ada', f.space, { fileId }));
    const picture = pageImageMarkdown({ id: made.embedId });
    const page = await f.json<Page>(
        f.as('ada')(`/spaces/${f.space}/pages`, 'POST', { title: 'Plan', content: `Text.\n\n${picture}\n` }),
    );
    const child = await f.json<Page>(
        f.as('ada')(`/spaces/${f.space}/pages`, 'POST', {
            title: 'Detail',
            content: `- ${picture.replace(/\n/g, '\n  ')}\n`,
            parentId: page.id,
        }),
    );
    // Someone edits the subpage just after the move has read it (its
    // pictures found outside the unit of work), before the move writes.
    const edited = `Edited.\n\n${picture}\n`;
    const list = Pages.prototype.list;
    vi.spyOn(Pages.prototype, 'list').mockImplementationOnce(function (this: Pages, spaceId: string) {
        const read = list.call(this, spaceId);
        f.platform.workspace.db
            .prepare('UPDATE pages SET content=?, revision=revision+1 WHERE id=?')
            .run(edited, child.id);
        return read;
    });
    const moved = await f.as('ada')(`/spaces/${f.space}/pages/${page.id}/move`, 'POST', { spaceId: f.board });
    expect(moved.status).toBe(409);
    expect(await moved.json()).toEqual({
        error: 'A page changed while it was being moved. Try the move again.',
        code: 'page_changed',
    });
    // Nothing half-done: no copies, both pages where and as they were.
    expect(await f.embeds(f.board)).toEqual([]);
    const plan = await f.json<Page>(f.as('ada')(`/spaces/${f.space}/pages/${page.id}`));
    expect([plan.content, plan.revision]).toEqual([page.content, page.revision]);
    const detail = await f.json<Page>(f.as('ada')(`/spaces/${f.space}/pages/${child.id}`));
    expect([detail.content, detail.revision]).toEqual([edited, child.revision + 1]);
    // Tried again, it moves, with the edited text's picture copied.
    expect((await f.as('ada')(`/spaces/${f.space}/pages/${page.id}/move`, 'POST', { spaceId: f.board })).status).toBe(
        200,
    );
    const [copy] = (await f.embeds(f.board)) as [string];
    const there = await f.json<Page>(f.as('ada')(`/spaces/${f.board}/pages/${child.id}`));
    expect(there.content).toBe(`Edited.\n\n${pageImageMarkdown({ id: copy })}\n`);
});

it.each(['destination', 'source'] as const)(
    'refuses a move whole when the mover leaves the %s Space while its pictures are planned',
    async (which) => {
        const f = await fixture();
        const fileId = await f.file('ada', 'whiteboard.png', PNG);
        const made = await f.json<Made>(f.image('ada', f.space, { fileId }));
        const content = `Text.\n\n${pageImageMarkdown({ id: made.embedId })}\n`;
        const page = await f.json<Page>(f.as('ada')(`/spaces/${f.space}/pages`, 'POST', { title: 'Plan', content }));
        // Ada is taken out of the Space just after the move checked her
        // rights and started planning, before it writes.
        const left = which === 'destination' ? f.board : f.space;
        const list = Pages.prototype.list;
        vi.spyOn(Pages.prototype, 'list').mockImplementationOnce(function (this: Pages, spaceId: string) {
            const read = list.call(this, spaceId);
            f.platform.workspace.db.prepare("DELETE FROM space_members WHERE spaceId=? AND userId='ada'").run(left);
            return read;
        });
        const moved = await f.as('ada')(`/spaces/${f.space}/pages/${page.id}/move`, 'POST', { spaceId: f.board });
        // The refusal the first check gives a person who can't read a Space.
        expect(moved.status).toBe(404);
        expect(await moved.json()).toEqual({ error: 'Space not found.' });
        // Nothing copied, the page where and as it was.
        expect(await f.embeds(f.board)).toEqual([]);
        const there = await f.json<Page>(f.as('mo')(`/spaces/${f.space}/pages/${page.id}`));
        expect([there.content, there.revision]).toEqual([content, page.revision]);
    },
);

it('stops a move whole when a page loses its pictures between reading and writing it', async () => {
    const f = await fixture();
    const fileId = await f.file('ada', 'whiteboard.png', PNG);
    const made = await f.json<Made>(f.image('ada', f.space, { fileId }));
    const page = await f.json<Page>(
        f.as('ada')(`/spaces/${f.space}/pages`, 'POST', {
            title: 'Plan',
            content: `Text.\n\n${pageImageMarkdown({ id: made.embedId })}\n`,
        }),
    );
    // Its every picture taken out just after the move planned their places:
    // the planned offsets now fall in unrelated text.
    const plain = `Plain words only, long enough to cover where the picture's id was planned to be.\n`;
    const list = Pages.prototype.list;
    vi.spyOn(Pages.prototype, 'list').mockImplementationOnce(function (this: Pages, spaceId: string) {
        const read = list.call(this, spaceId);
        f.platform.workspace.db
            .prepare('UPDATE pages SET content=?, revision=revision+1 WHERE id=?')
            .run(plain, page.id);
        return read;
    });
    const moved = await f.as('ada')(`/spaces/${f.space}/pages/${page.id}/move`, 'POST', { spaceId: f.board });
    expect(moved.status).toBe(409);
    expect(((await moved.json()) as { code: string }).code).toBe('page_changed');
    expect(await f.embeds(f.board)).toEqual([]);
    const there = await f.json<Page>(f.as('ada')(`/spaces/${f.space}/pages/${page.id}`));
    expect([there.content, there.revision]).toEqual([plain, page.revision + 1]);
});

it('screens and reads page text in linear time, whatever its line prefixes', () => {
    // Warmed once, then the best of three, so a busy machine or the first
    // compile doesn't decide it; a quadratic or exponential read would take
    // seconds here, not milliseconds.
    const time = (run: () => unknown) => {
        run();
        let best = Infinity;
        for (let i = 0; i < 3; i++) {
            const start = performance.now();
            run();
            best = Math.min(best, performance.now() - start);
        }
        return best;
    };
    const longQuote = '> - '.repeat(25_000);
    for (const text of [
        '-  '.repeat(24) + 'text',
        longQuote,
        `${longQuote}\`\`\` image`,
        ' \t'.repeat(50_000),
        '```' + ' '.repeat(100_000),
        '`'.repeat(100_000),
        `${'1. '.repeat(30_000)}~~~`,
    ]) {
        const label = `${JSON.stringify(text.slice(0, 12))}… (${text.length})`;
        expect(
            time(() => mayHavePictures(text)),
            label,
        ).toBeLessThan(20);
        // The merge's and fences' reader, on the same untrusted lines.
        expect(
            time(() => findFences(text)),
            label,
        ).toBeLessThan(20);
        expect(
            time(() => mergeUnits(`${text}\n${text}\n`)),
            label,
        ).toBeLessThan(40);
    }
    expect(mayHavePictures('-  '.repeat(24) + 'text')).toBe(false);
    expect(mayHavePictures(`${longQuote}\`\`\` image`)).toBe(true);
});

it('never parses a page that only mentions an image', async () => {
    const f = await fixture();
    const parse = vi.spyOn(pageMarkdown, 'parse');
    const id = 'cbemb_AAAAAAAAAAAAAAAAAAAAAA';
    // Prose and code that say "image", but nothing that opens a fence with
    // it (a ```image written inline would be screened in: a false positive
    // costs only a parse).
    const prose = `An image of the board. image\n\n\`\`\`js\nconst image = "${id}";\n\`\`\`\n\n\`\` image\` and ~~ image.\n`;
    const next = vi.fn(async () => 'cbemb_BBBBBBBBBBBBBBBBBBBBBB');
    expect(await rewritePageImages(prose, next)).toBe(prose);
    const page = await f.json<Page>(
        f.as('ada')(`/spaces/${f.space}/pages`, 'POST', { title: 'Notes', content: prose }),
    );
    expect((await f.as('ada')(`/spaces/${f.space}/pages/${page.id}/move`, 'POST', { spaceId: f.board })).status).toBe(
        200,
    );
    expect(parse).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    // A likely opener is parsed, once.
    await rewritePageImages(`> - \`\`\`image\n>   {"id":"${id}"}\n>   \`\`\``, next);
    expect(parse).toHaveBeenCalledTimes(1);
});

it('rewrites only pictures’ ids, as the renderer reads them, leaving every other byte', async () => {
    const id = 'cbemb_AAAAAAAAAAAAAAAAAAAAAA';
    const next = async (old: string) => (old === id ? 'cbemb_BBBBBBBBBBBBBBBBBBBBBB' : undefined);
    const fence = pageImageMarkdown({ id, alt: 'A `tick`' });
    const swapped = pageImageMarkdown({ id: 'cbemb_BBBBBBBBBBBBBBBBBBBBBB', alt: 'A `tick`' });
    expect(await rewritePageImages(fence, next)).toBe(swapped);
    const B = 'cbemb_BBBBBBBBBBBBBBBBBBBBBB';
    // Hand-written JSON keeps its own form: only the id changes.
    expect(await rewritePageImages(`~~~ image\n{"id":"${id}"}\n~~~~`, next)).toBe(`~~~ image\n{"id":"${B}"}\n~~~~`);
    // Any info string whose first word is `image` is a picture, as it renders.
    expect(await rewritePageImages(`\`\`\`image wide\n{"id":"${id}"}\n\`\`\``, next)).toBe(
        `\`\`\`image wide\n{"id":"${B}"}\n\`\`\``,
    );
    // An alt that holds the id's text keeps it; another code block holding
    // the same id is code, and stays.
    const json = `\`\`\`json\n{"id":"${id}"}\n\`\`\``;
    expect(
        await rewritePageImages(
            `${json}\n\n\`\`\`image\n{ "alt": "${id}", "id": "${id}" }\n\`\`\`\n\n    "${id}"\n`,
            next,
        ),
    ).toBe(`${json}\n\n\`\`\`image\n{ "alt": "${id}", "id": "${B}" }\n\`\`\`\n\n    "${id}"\n`);
    // Inside another fence it is code, not a picture.
    const quoted = `~~~md\n${fence}\n~~~`;
    expect(await rewritePageImages(quoted, next)).toBe(quoted);
    // An unclosed fence runs to the end, as Markdown has it.
    expect(await rewritePageImages(fence.slice(0, -4), next)).toBe(swapped.slice(0, -4));
    // Unknown keys, other languages and unknown ids stay byte for byte.
    for (const text of [
        `\`\`\`image\n{"id":"${id}","src":"https://example.com/a.png"}\n\`\`\``,
        `\`\`\`json\n{"id":"${id}"}\n\`\`\``,
        pageImageMarkdown({ id: 'cbemb_CCCCCCCCCCCCCCCCCCCCCC' }),
        // At the top level, four spaces in is an indented code block.
        `Text.\n\n    \`\`\`image\n    {"id":"${id}"}\n    \`\`\``,
        // A quote's end ends its fence: what follows is not its body.
        `> \`\`\`image\n\n{"id":"${id}"}\n\`\`\``,
    ]) {
        expect(await rewritePageImages(text, next)).toBe(text);
    }
    // In a quote, nested quotes and nested list items (four or more spaces
    // in, under `-` or `10.`), as the renderer reads them.
    const at = (prefix: string, text: string) => prefix + text.replace(/\n/g, `\n${prefix}`);
    for (const [before, prefix] of [
        ['', '> '],
        ['', '> > '],
        ['> - Item\n>\n', '>   '],
        ['- Item\n\n  - Nested\n\n', '    '],
        ['10. Item\n\n', '    '],
        ['1. Item\n\n   - Nested\n\n', '     '],
    ] as const) {
        expect(await rewritePageImages(`${before}${at(prefix, fence)}\nAfter.`, next), prefix).toBe(
            `${before}${at(prefix, swapped)}\nAfter.`,
        );
    }
    // Opening on a list item's marker line, and a quote inside a list item
    // (CB-358 review): the body's prefix is the item's indent.
    for (const [marker, prefix] of [
        ['- ', '  '],
        ['1. ', '   '],
        ['10) ', '    '],
        ['- > ', '  > '],
        ['> - ', '>   '],
        ['- Item\n\n  - ', '    '],
    ] as const) {
        const markerAt = (text: string) => marker + text.replace(/\n/g, `\n${prefix}`);
        expect(await rewritePageImages(`Before.\n\n${markerAt(fence)}\nAfter.`, next), marker).toBe(
            `Before.\n\n${markerAt(swapped)}\nAfter.`,
        );
    }
    // Indented code is never a fence, even after a list: left byte for byte.
    const code = `    \`\`\`image\n    {"id":"${id}"}\n    \`\`\``;
    for (const text of [
        // The list ended with a paragraph.
        `- Item\n\nPara.\n\n${code}`,
        `1. Item\n2. Other\n\nPara.\n\n${code}\n`,
        // Indented code inside the item (four past its content column).
        `- Item\n\n  ${code.replace(/\n/g, '\n  ')}`,
        // A paragraph's continuation, not a fence.
        `Para.\n${code}`,
        // At the top level, and after an empty item a blank line ends.
        `${code}\n`,
        `-\n\n${code}`,
        // In a quote, after its list ended.
        `> - Item\n>\n> Para.\n>\n> ${code.replace(/\n/g, '\n> ')}`,
        // A tab is four columns, so this is code too.
        `\t\`\`\`image\n\t{"id":"${id}"}\n\t\`\`\``,
    ]) {
        expect(await rewritePageImages(text, next), text).toBe(text);
    }
    // A body line outside the opener's quote or list item ends it: the
    // picture's JSON isn't its body, and stays as it was.
    for (const text of [
        `- \`\`\`image\n- {"id":"${id}"}\n- \`\`\``,
        `> \`\`\`image\n{"id":"${id}"}\n> \`\`\``,
        `\`\`\`image\n> {"id":"${id}"}\n\`\`\``,
        // Unindented JSON after a list item's fence is outside the item:
        // a paragraph, not the fence's body (CB-358 review).
        `- \`\`\`image\n{"id":"${id}"}\n\`\`\``,
        `- \`\`\`image\n{"id":"${id}"}\n  \`\`\`\n`,
    ]) {
        expect(await rewritePageImages(text, next), text).toBe(text);
    }
    // Hand-written in a quote, with the space after `>` left out.
    expect(await rewritePageImages(`>\`\`\`image\n>{"id":"${id}"}\n>\`\`\``, next)).toBe(
        `>\`\`\`image\n>{"id":"${B}"}\n>\`\`\``,
    );
    // Two pictures in one list item, and one after a continuation
    // paragraph (CB-358 review): each is copied.
    const item = (text: string) => `    ${text.replace(/\n/g, '\n    ')}`;
    for (const before of ['10. Item\n\n' + item(fence) + '\n\n', '10. A paragraph\n    continued.\n\n']) {
        const after = before.split(item(fence)).join(item(swapped));
        expect(await rewritePageImages(`${before}${item(fence)}\n\nAfter.`, next), before).toBe(
            `${after}${item(swapped)}\n\nAfter.`,
        );
    }
    // A blank first body line keeps the list item's indent (CB-358 review).
    expect(await rewritePageImages(`- \`\`\`image\n\n  {"id":"${id}"}\n  \`\`\`\nAfter.`, next)).toBe(
        `- \`\`\`image\n\n  {"id":"${B}"}\n  \`\`\`\nAfter.`,
    );
    // CRLF text keeps its line ends around the fence.
    const crlf = (text: string) => text.replace(/\n/g, '\r\n');
    expect(await rewritePageImages(`a\r\n${crlf(fence)}\r\nb`, next)).toBe(`a\r\n${crlf(swapped)}\r\nb`);
    expect(await rewritePageImages(crlf(`- Item\n\n- ${fence.replace(/\n/g, '\n  ')}\n`), next)).toBe(
        crlf(`- Item\n\n- ${swapped.replace(/\n/g, '\n  ')}\n`),
    );
});

it('rewrites only link cards’ media ids, as the renderer reads them, leaving every other byte', async () => {
    const [A, B, C] = ['cbemb_AAAAAAAAAAAAAAAAAAAAAA', 'cbemb_BBBBBBBBBBBBBBBBBBBBBB', 'cbemb_CCCCCCCCCCCCCCCCCCCCCC'];
    const next = async (old: string) => (old === A ? B : undefined);
    const asked: string[] = [];
    const tracked = async (old: string) => (asked.push(old), next(old));
    // Hand-written JSON keeps its own form; the same id twice on a card is
    // copied once and swapped in both places, the title's text stays.
    const at = '"fetchedAt":"2026-11-01T00:00:00.000Z"';
    const hand = (id: string) =>
        `~~~ embed wide\n{"url":"https://example.com/","kind":"link","title":"${A}",${at},"media":[{"id":"${id}","kind":"image"},{"kind":"image","id":"${id}"},{"id":"${C}","kind":"gif"}]}\n~~~`;
    expect(await rewritePageImages(hand(A), tracked)).toBe(hand(B));
    expect(asked).toEqual([A, C]);
    // Not a card: an unknown key, another language, JSON that doesn't
    // parse, a card inside another fence, an id written with escapes.
    for (const text of [
        `\`\`\`embed\n{"url":"https://example.com/","kind":"link",${at},"media":[{"id":"${A}","kind":"image","src":"x"}]}\n\`\`\``,
        `\`\`\`json\n{"url":"https://example.com/","kind":"link",${at},"media":[{"id":"${A}","kind":"image"}]}\n\`\`\``,
        `\`\`\`embed\n{"media":[{"id":"${A}"\n\`\`\``,
        `~~~md\n${embedCardMarkdown(card([A]))}\n~~~`,
        `\`\`\`embed\n{"url":"https://example.com/","kind":"link",${at},"media":[{"id":"\\u0063${A.slice(1)}","kind":"image"}]}\n\`\`\``,
    ]) {
        expect(await rewritePageImages(text, next), text).toBe(text);
    }
    // A page that names a card is screened in; one that only says "embed" isn't.
    expect(mayHavePictures('```embed\n{}')).toBe(true);
    expect(mayHavePictures('Embed this: an embedded card.')).toBe(false);
});

// CI flake on #369: a copy's random id (`cbemb_` + base64url) can hold `_`
// and `-` side by side. The copy itself was right; the move test looked for
// the raw id in the search text, where `pageText` drops a `_` at a word's
// edge. These ids, fixed and from a seeded loop, pin both halves.
it('copies pictures whose ids hold `_` and `-` anywhere', async () => {
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
    // mulberry32: a 32-bit generator, exact in doubles (Math.imul), so 500 ids are 500 different ids.
    let seed = 358;
    const random = (n: number) => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) % n;
    };
    // Mostly `_` and `-`, so they meet each other and the ends often.
    const char = () => (random(2) ? ALPHABET[62 + random(2)]! : ALPHABET[random(64)]!);
    const randomId = () => Array.from({ length: 16 + random(49) }, char).join('');
    const ids = [
        'cbemb_B_-WHoZeWQLmFB8-8peAIw',
        'cbemb_-AAAAAAAAAAAAAAAAAAAAA',
        'cbemb_AAAAAAAAAAAAAAAAAAAAA_',
        'cbemb_AAAAAAAAAAAAAAAAAAAA__',
        'cbemb__-_-__--__AAAAAAAAAAAA',
        '_AAAAAAAAAAAAAAA',
        '________________',
        '----------------',
        '_'.repeat(64),
        'x'.repeat(16),
        'y'.repeat(16),
        ...Array.from({ length: 500 }, randomId),
    ];
    for (const id of ids) {
        expect(id, id).toMatch(EMBED_MEDIA_ID);
        const copy = `cbemb_${[...id].reverse().join('').slice(0, 22).padEnd(16, '_')}`;
        expect(copy, copy).toMatch(EMBED_MEDIA_ID);
        const fence = (embedId: string) => pageImageMarkdown({ id: embedId, alt: `Alt ${id}`, width: 2, height: 3 });
        const page = (embedId: string) =>
            `${id}\n\n${fence(embedId)}\n\n> ${fence(embedId).replace(/\n/g, '\n> ')}\n\n- ${fence(embedId).replace(/\n/g, '\n  ')}\n`;
        const asked: string[] = [];
        const rewritten = await rewritePageImages(page(id), async (old) => {
            asked.push(old);
            return old === id ? copy : undefined;
        });
        // Every picture's id, and only it: the text's and the alt's stay.
        expect(asked, id).toEqual([id]);
        expect(rewritten, id).toBe(page(copy));
    }
    // What `pageText` does with such an id, on purpose (page-text.ts): a
    // `_` at a word's edge is a Markdown mark, one inside a word stays.
    expect(pageText('cbemb_B_-WHo')).toBe('cbemb_B-WHo');
    expect(pageText('snake_case')).toBe('snake_case');
});

it('rewrites the ids of links to a Space’s media, in links, images and definitions only (CB-524)', async () => {
    const A = 'cbemb_AAAAAAAAAAAAAAAAAAAAAA';
    const B = 'cbemb_BBBBBBBBBBBBBBBBBBBBBB';
    const next = async (old: string) => (old === A ? B : undefined);
    const url = (id: string) => `/api/media/embeds/${id}/content`;
    const text = (id: string) =>
        `See [the report ${A}](${url(id)}) and ![a scan](${url(id)}?download=1).\n\n[ref]: ${url(id)}\n\nAlso [it][ref].\n`;
    expect(await rewritePageImages(text(A), next)).toBe(text(B).replace(`report ${B}`, `report ${A}`));
    // A URL in code, plain text, or with another path stays as it is.
    const kept = `\`${url(A)}\` and ${url(A)} and [x](/api/media/embeds/${A}/other)\n\n\`\`\`\n${url(A)}\n\`\`\`\n`;
    expect(await rewritePageImages(kept, next)).toBe(kept);
    expect(mayHavePictures(`[x](${url(A)})`)).toBe(true);
});
