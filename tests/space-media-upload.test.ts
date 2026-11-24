import { DatabaseSync } from 'node:sqlite';

import type { ToolDefinition } from '@copilotkit/runtime/v2';
import { afterEach, expect, it, vi } from 'vitest';

import { migrate } from '@socio/data/migrate';
import type { DotTurn } from '@socio/foundation/turns/turn';
import { APPROVAL_CAPABILITIES } from '@socio/shared/approvals';
import type { Page } from '@socio/shared/pages/page-library';
import type { Space } from '@socio/shared/types';

import { SPACE_UPLOAD_LIMITS } from '../src/server/media/contract.js';
import { mediaSchema } from '../src/server/media/migrations.js';
import type { MediaService } from '../src/server/media/service.js';

import { PNG, pngOf } from './fixtures/media.js';
import { roomsFixture } from './fixtures/rooms.js';

// Space uploads (CB-524): a socio uploads files it may read into a
// Space's media, for a person who edits the Space and with their consent;
// the Space's readers, and nobody else, open them at the URLs it returns.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const DAY = 86_400_000;

interface FileResult {
    path: string;
    ok: boolean;
    status?: string;
    error?: string;
    id?: string;
    url?: string;
    kind?: string;
    mediaType?: string;
    reused?: boolean;
    markdown?: string;
}
interface Result {
    error?: string;
    code?: string;
    complete?: boolean;
    uploaded?: number;
    reused?: number;
    failed?: number;
    results?: FileResult[];
    approval?: { status: string; id: string };
}

async function fixture() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const f = await roomsFixture(cleanup);
    const json = async <T>(response: Promise<Response> | Response) => (await response).json() as Promise<T>;
    // Ada's private Space; Mo reads it, Nina doesn't.
    const space = await json<Space>(
        f.as('ada')('/spaces', 'POST', {
            name: 'Operations',
            private: true,
            people: [{ userId: 'mo', role: 'member' }],
        }),
    );
    const page = await json<Page>(
        f.as('ada')(`/spaces/${space.id}/pages`, 'POST', { title: 'Imported', content: 'Text.' }),
    );
    const other = await json<Page>(
        f.as('ada')(`/spaces/${space.id}/pages`, 'POST', { title: 'Other', content: 'More.' }),
    );
    const socio = f.company;
    const dot = f.workspace.dot(socio.id)!;
    f.workspace.updateDot(socio.id, {
        name: dot.name,
        instructions: dot.instructions,
        researchAllowed: dot.researchAllowed,
        memoryAllowed: dot.memoryAllowed,
        spaceId: dot.spaceId,
        spaceIds: [dot.spaceId, space.id],
    });
    const turn = (userId: string): DotTurn => {
        const threadId = `${userId}-chat`;
        if (!f.workspace.thread(threadId)) {
            f.workspace.bindThread(threadId, socio.id, 'Chat', userId);
        }
        return {
            dot: f.workspace.dot(socio.id)!,
            userId,
            threadId,
            channel: false,
            purpose: 'chat',
            check: () => {},
            signal: new AbortController().signal,
            toolNames: () => [],
        };
    };
    const upload = (userId: string, input: Record<string, unknown>) => {
        const tool = f.platform.dotExtensions.tools(turn(userId)).find((item) => item.name === 'space_media_upload') as
            | (ToolDefinition & { execute: (input: unknown) => Promise<unknown> })
            | undefined;
        if (!tool) {
            throw new Error('No space_media_upload tool.');
        }
        return tool.execute(input) as Promise<Result>;
    };
    /** A file in the socio's own folder of `userId`'s data space. */
    const put = (userId: string, path: string, bytes: Uint8Array) =>
        f.platform.data.putFile(
            { kind: 'dot', userId, dotId: socio.id, threadId: `${userId}-chat` },
            path,
            bytes,
            'application/octet-stream',
        );
    const media = f.platform.media as unknown as MediaService;
    const fetchAs = (userId: string, url: string) => f.as(userId)(url.replace(/^\/api/, ''));
    /** Ada's policy for this socio's uploads. */
    const policy = (value: 'manual' | 'bypass') =>
        f.platform.approvals.setPolicy('ada', socio.id, APPROVAL_CAPABILITIES.spaceMediaUpload, value);
    return { ...f, json, space, page, other, socio, upload, put, media, fetchAs, policy };
}

it('uploads on the person’s approval, serves readers only, and stops when access is revoked', async () => {
    const f = await fixture();
    await f.put('ada', 'import/photo.png', PNG);
    await f.put('ada', 'import/report.pdf', PDF);
    const args = {
        spaceId: f.space.id,
        pageId: f.page.id,
        files: [{ path: 'import/photo.png', alt: 'The team' }, { path: 'import/report.pdf' }],
    };
    // Manual policy: nothing is shared until Ada approves.
    const asked = await f.upload('ada', args);
    expect(asked.approval?.status).toBe('pending_approval');
    expect(asked.complete).toBe(false);
    expect(asked.results!.map((item) => item.status)).toEqual(['waiting_for_approval', 'waiting_for_approval']);
    await f.platform.approvals.decide(asked.approval!.id, 'ada', true);

    const done = await f.upload('ada', args);
    expect(done).toMatchObject({ complete: true, uploaded: 2, reused: 0, failed: 0 });
    const [image, pdf] = done.results!;
    expect(image).toMatchObject({ ok: true, kind: 'image', mediaType: 'image/png', reused: false });
    expect(image!.url).toBe(`/api/media/embeds/${image!.id}/content`);
    expect(image!.markdown).toContain(`"id": "${image!.id}"`);
    expect(pdf).toMatchObject({ ok: true, kind: 'pdf', mediaType: 'application/pdf' });
    expect(pdf!.markdown).toBe(`[report.pdf](${pdf!.url})`);

    // Readers of the Space open them; someone outside it is refused.
    for (const [person, status] of [
        ['ada', 200],
        ['mo', 200],
        ['alice', 200],
        ['nina', 404],
    ] as const) {
        expect((await f.fetchAs(person, image!.url!)).status, person).toBe(status);
        expect((await f.fetchAs(person, pdf!.url!)).status, person).toBe(status);
    }
    const served = await f.fetchAs('mo', pdf!.url!);
    expect(served.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await served.arrayBuffer())).toEqual(PDF);
    expect((await f.fetchAs('mo', image!.url!)).headers.get('content-type')).toBe('image/png');

    // Revoking Mo's access takes effect at once.
    expect((await f.as('ada')(`/spaces/${f.space.id}/people/mo`, 'DELETE')).status).toBe(200);
    expect((await f.fetchAs('mo', image!.url!)).status).toBe(404);
    expect((await f.fetchAs('mo', pdf!.url!)).status).toBe(404);

    // A retry returns the same assets: no copy, no new approval.
    const again = await f.upload('ada', args);
    expect(again).toMatchObject({ complete: true, uploaded: 0, reused: 2, failed: 0 });
    expect(again.results!.map((item) => item.id)).toEqual([image!.id, pdf!.id]);
    expect(again.approval).toBeUndefined();
    expect(f.platform.data.fileRecords('ada').filter((file) => file.path.startsWith('space-media/'))).toHaveLength(2);
});

it('reports each file, and checks content rather than names or declared types', async () => {
    const f = await fixture();
    await f.policy('bypass');
    await f.put('ada', 'import/ok.png', PNG);
    await f.put('ada', 'import/fake.png', Buffer.from('<html><script>alert(1)</script></html>'));
    await f.put('ada', 'import/fake.pdf', Buffer.from('just text'));
    await f.put('ada', 'import/vector.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    await f.put('ada', 'import/huge.png', pngOf(SPACE_UPLOAD_LIMITS.imageMaxBytes + 1));
    // Ada's own file outside the socio's folder, never granted to it.
    await f.platform.data.putFile({ kind: 'user', userId: 'ada' }, 'private/secret.png', pngOf(100, 7));
    const result = await f.upload('ada', {
        spaceId: f.space.id,
        files: [
            { path: 'import/ok.png' },
            { path: 'import/fake.png' },
            { path: 'import/fake.pdf' },
            { path: 'import/vector.svg' },
            { path: 'import/huge.png' },
            { path: '/private/secret.png' },
            { path: '../../private/secret.png' },
            { path: 'import/missing.png' },
            { path: 'import/ok.png' },
        ],
    });
    expect(result.complete).toBe(false);
    expect(result.uploaded).toBe(1);
    expect(result.failed).toBe(8);
    const [ok, html, text, svg, huge, secret, traversal, missing, twice] = result.results!;
    expect(ok).toMatchObject({ ok: true, kind: 'image' });
    for (const item of [html, text, svg]) {
        expect(item).toMatchObject({ ok: false, status: 'failed' });
        expect(item!.error).toMatch(/Only PNG, JPEG, GIF and WebP images and PDFs/);
    }
    expect(huge!.error).toMatch(/at most 5 MB/);
    for (const item of [secret, traversal, missing]) {
        expect(item).toMatchObject({ ok: false, status: 'failed' });
    }
    expect(twice!.error).toMatch(/same file as item 1/);
    // Nothing but the one image reached the Space's media.
    expect(f.platform.data.fileRecords('ada').filter((file) => file.path.startsWith('space-media/'))).toHaveLength(1);
});

it('refuses people who can’t edit the Space, Spaces the socio can’t use, and missing pages', async () => {
    const f = await fixture();
    await f.put('mo', 'import/photo.png', PNG);
    await f.put('nina', 'import/photo.png', PNG);
    await f.put('ada', 'import/photo.png', PNG);
    // Mo reads the Space but doesn't edit it.
    expect(await f.upload('mo', { spaceId: f.space.id, files: [{ path: 'import/photo.png' }] })).toMatchObject({
        code: 'not_an_editor',
    });
    // Nina's chat: the socio may not use a Space she can't read.
    expect(await f.upload('nina', { spaceId: f.space.id, files: [{ path: 'import/photo.png' }] })).toMatchObject({
        code: 'space_not_available',
    });
    expect(
        await f.upload('ada', { spaceId: f.space.id, pageId: 'no-such-page', files: [{ path: 'import/photo.png' }] }),
    ).toMatchObject({ code: 'page_not_found' });
    // An approved request is bound to its files' bytes: new bytes ask again.
    await f.policy('manual');
    const asked = await f.upload('ada', { spaceId: f.space.id, files: [{ path: 'import/photo.png' }] });
    await f.platform.approvals.decide(asked.approval!.id, 'ada', true);
    await f.put('ada', 'import/photo.png', pngOf(64, 3));
    const changed = await f.upload('ada', { spaceId: f.space.id, files: [{ path: 'import/photo.png' }] });
    expect(changed.approval?.status).toBe('pending_approval');
    expect(changed.approval?.id).not.toBe(asked.approval!.id);
});

it('keeps uploads pages name, and cleans up the rest after their grace', async () => {
    const f = await fixture();
    await f.policy('bypass');
    await f.put('ada', 'import/kept.png', pngOf(100, 1));
    await f.put('ada', 'import/shared.pdf', PDF);
    await f.put('ada', 'import/leftover.png', pngOf(100, 2));
    await f.put('ada', 'import/deleted-page.png', pngOf(100, 4));
    const run = await f.upload('ada', {
        spaceId: f.space.id,
        files: [
            { path: 'import/kept.png' },
            { path: 'import/shared.pdf' },
            { path: 'import/leftover.png' },
            { path: 'import/deleted-page.png' },
        ],
    });
    const [kept, shared, leftover, onDeleted] = run.results!;
    // Two pages name the PDF; one names the image; a deleted page names another.
    const edit = async (page: Page, content: string) => {
        const now = await f.json<Page>(f.as('ada')(`/spaces/${f.space.id}/pages/${page.id}`));
        return f.as('ada')(`/spaces/${f.space.id}/pages/${page.id}`, 'PATCH', {
            content,
            expectedRevision: now.revision,
        });
    };
    expect((await edit(f.page, `${kept!.markdown}\n\n${shared!.markdown}`)).status).toBe(200);
    expect((await edit(f.other, `See ${shared!.markdown}`)).status).toBe(200);
    const doomed = await f.json<Page>(
        f.as('ada')(`/spaces/${f.space.id}/pages`, 'POST', { title: 'Doomed', content: onDeleted!.markdown }),
    );
    // Deleting one page never takes what another still names.
    expect((await f.as('ada')(`/spaces/${f.space.id}/pages/${f.other.id}`, 'DELETE')).status).toBe(200);
    expect((await f.as('ada')(`/spaces/${f.space.id}/pages/${doomed.id}`, 'DELETE')).status).toBe(200);
    expect((await f.fetchAs('mo', shared!.url!)).status).toBe(200);

    // Within the grace, nothing goes.
    expect(await f.media.collectSpaceUploads(Date.now() + DAY)).toBe(0);
    // After it, only the upload no page (live or deleted) names.
    const later = Date.now() + SPACE_UPLOAD_LIMITS.graceMs + DAY;
    expect(await f.media.collectSpaceUploads(later)).toBe(1);
    expect((await f.fetchAs('ada', leftover!.url!)).status).toBe(404);
    for (const item of [kept, shared, onDeleted]) {
        expect((await f.fetchAs('ada', item!.url!)).status, item!.path).toBe(200);
    }
    // Its copy in Ada's Files is deleted (restorable); the others stay.
    const files = f.platform.data.fileRecords('ada').filter((file) => file.path.startsWith('space-media/'));
    expect(files).toHaveLength(3);
    // Named ones are looked at again only after a day.
    expect(await f.media.collectSpaceUploads(later + 1000)).toBe(0);

    // An upload whose file another embed names (a cover) keeps its file.
    await f.put('ada', 'import/cover.png', pngOf(100, 5));
    const cover = (await f.upload('ada', { spaceId: f.space.id, files: [{ path: 'import/cover.png' }] })).results![0]!;
    const set = await f.as('ada')(`/spaces/${f.space.id}/pages/${f.page.id}/cover`, 'PUT', { embedId: cover.id });
    expect(set.status).toBe(200);
    expect(await f.media.collectSpaceUploads(Date.now() + SPACE_UPLOAD_LIMITS.graceMs * 3)).toBe(0);
    expect((await f.fetchAs('mo', cover.url!)).status).toBe(200);
});

it('moves an uploaded PDF’s link with its page, so the new Space’s readers open it', async () => {
    const f = await fixture();
    await f.policy('bypass');
    await f.put('ada', 'import/report.pdf', PDF);
    const [pdf] = (
        await f.upload('ada', { spaceId: f.space.id, pageId: f.page.id, files: [{ path: 'import/report.pdf' }] })
    ).results!;
    const current = await f.json<Page>(f.as('ada')(`/spaces/${f.space.id}/pages/${f.page.id}`));
    await f.as('ada')(`/spaces/${f.space.id}/pages/${f.page.id}`, 'PATCH', {
        content: `Read ${pdf!.markdown}.`,
        expectedRevision: current.revision,
    });
    // Ada's Space for the workspace, which Nina reads.
    const open = await f.json<Space>(f.as('alice')('/spaces', 'POST', { name: 'Everyone' }));
    await f.as('alice')(`/spaces/${open.id}/people/ada`, 'PUT', { role: 'editor' });
    const moved = await f.as('ada')(`/spaces/${f.space.id}/pages/${f.page.id}/move`, 'POST', { spaceId: open.id });
    expect(moved.status).toBe(200);
    const page = await f.json<Page>(f.as('nina')(`/spaces/${open.id}/pages/${f.page.id}`));
    const link = /\]\((\/api\/media\/embeds\/[^)]+)\)/.exec(page.content)![1]!;
    expect(link).not.toBe(pdf!.url);
    expect((await f.fetchAs('nina', link)).status).toBe(200);
    // The old Space's asset is still its readers' only.
    expect((await f.fetchAs('nina', pdf!.url!)).status).toBe(404);
});

it('adds the upload columns to media embeds, keeping every row (media 7)', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [{ ...mediaSchema, migrations: mediaSchema.migrations!.slice(0, 6) }]);
    db.exec(
        "INSERT INTO media_embeds (id, fileId, ownerUserId, dotId, spaceId, sourceUrl, createdAt) VALUES ('e1', 'f1', 'ada', NULL, 's1', '', 1)",
    );
    const before = db.prepare('SELECT * FROM media_embeds').all();
    expect(migrate(db, [mediaSchema])).toEqual([
        { module: 'media', version: 7, name: 'space uploads', action: 'apply' },
    ]);
    expect(db.prepare('SELECT * FROM media_embeds').all()).toEqual(
        before.map((row) => ({
            ...row,
            origin: null,
            pageId: null,
            contentHash: null,
            uploadedAt: null,
            checkedAt: null,
        })),
    );
});

it('refuses an uploader removed from the Space, and never reuses a copy whose bytes changed (review round 1)', async () => {
    const f = await fixture();
    await f.policy('bypass');
    // Mo edits the Space for a while and uploads for it.
    expect((await f.as('ada')(`/spaces/${f.space.id}/people/mo`, 'PUT', { role: 'editor' })).status).toBe(200);
    await f.platform.approvals.setPolicy('mo', f.socio.id, APPROVAL_CAPABILITIES.spaceMediaUpload, 'bypass');
    await f.put('mo', 'import/photo.png', PNG);
    const [photo] = (await f.upload('mo', { spaceId: f.space.id, files: [{ path: 'import/photo.png' }] })).results!;
    expect(photo).toMatchObject({ ok: true });
    expect((await f.fetchAs('mo', photo!.url!)).status).toBe(200);
    // Removed, Mo no longer opens it at the Space's URL; readers still do.
    expect((await f.as('ada')(`/spaces/${f.space.id}/people/mo`, 'DELETE')).status).toBe(200);
    expect((await f.fetchAs('mo', photo!.url!)).status).toBe(404);
    expect((await f.fetchAs('ada', photo!.url!)).status).toBe(200);

    // Ada's upload (other bytes: Mo's are in the Space already), whose
    // stored copy is then replaced in her Files.
    const mine = pngOf(70, 6);
    await f.put('ada', 'import/photo.png', mine);
    const [first] = (await f.upload('ada', { spaceId: f.space.id, files: [{ path: 'import/photo.png' }] })).results!;
    const copy = f.platform.data.fileRecords('ada').find((file) => file.path.startsWith('space-media/'))!;
    await f.platform.data.putFile({ kind: 'user', userId: 'ada' }, copy.path, pngOf(80, 9), 'image/png');
    const [again] = (await f.upload('ada', { spaceId: f.space.id, files: [{ path: 'import/photo.png' }] })).results!;
    expect(again).toMatchObject({ ok: true, reused: false });
    expect(again!.id).not.toBe(first!.id);
    expect((await f.fetchAs('mo', again!.url!)).status).toBe(404);
    expect(Buffer.from(await (await f.fetchAs('ada', again!.url!)).arrayBuffer())).toEqual(mine);
});

it('lists every file of a full batch on the approval card', async () => {
    const f = await fixture();
    const files = [];
    for (let i = 0; i < SPACE_UPLOAD_LIMITS.filesPerCall; i++) {
        await f.put('ada', `import/scan-${i + 1}.png`, pngOf(64 + i, i));
        files.push({ path: `import/scan-${i + 1}.png` });
    }
    const asked = await f.upload('ada', { spaceId: f.space.id, files });
    expect(asked.approval?.status).toBe('pending_approval');
    const view = await f.platform.approvals.get(asked.approval!.id, 'ada');
    expect(view.details[0]).toMatch(/Everyone who can read the Space/);
    for (let i = 0; i < files.length; i++) {
        expect(view.details.join('\n')).toContain(`scan-${i + 1}.png`);
    }
});

it('serves a PDF embed a bundle import wrote, without the upload columns, to the Space’s readers', async () => {
    const f = await fixture();
    const file = await f.platform.data.putFile(
        { kind: 'user', userId: 'ada' },
        'imported/report',
        PDF,
        'application/pdf',
    );
    const id = 'cbemb_imported_pdf_012345';
    f.workspace.db
        .prepare(
            "INSERT INTO media_embeds(id, fileId, ownerUserId, dotId, spaceId, sourceUrl, createdAt) VALUES (?, ?, 'ada', NULL, ?, '', 1)",
        )
        .run(id, f.platform.data.fileAt('ada', file.path)!.id, f.space.id);
    expect((await f.fetchAs('mo', `/api/media/embeds/${id}/content`)).status).toBe(200);
    expect((await f.fetchAs('nina', `/api/media/embeds/${id}/content`)).status).toBe(404);
    // Never a cover: covers are images only.
    expect((await f.as('ada')(`/spaces/${f.space.id}/pages/${f.page.id}/cover`, 'PUT', { embedId: id })).status).toBe(
        404,
    );
});

it('asks again when a reused asset’s copy is deleted while the call runs (review round 2)', async () => {
    const f = await fixture();
    await f.policy('bypass');
    await f.put('ada', 'import/photo.png', PNG);
    const args = { spaceId: f.space.id, files: [{ path: 'import/photo.png' }] };
    const [first] = (await f.upload('ada', args)).results!;
    expect(first).toMatchObject({ ok: true });
    await f.policy('manual');
    const save = f.media.saveSpaceUpload.bind(f.media) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(f.media, 'saveSpaceUpload').mockImplementationOnce((async (...args: unknown[]) => {
        const copy = f.platform.data.fileRecords('ada').find((file) => file.path.startsWith('space-media/'))!;
        await f.platform.data.deleteFile('ada', copy.path);
        return save(...args);
    }) as never);
    const again = await f.upload('ada', args);
    expect(again.approval?.status).toBe('pending_approval');
    expect(again.results![0]).toMatchObject({ ok: false, status: 'waiting_for_approval' });
});

it('keeps a file a second embed names, also one made while the clean-up runs (review round 2b)', async () => {
    const f = await fixture();
    await f.policy('bypass');
    await f.put('ada', 'import/a.png', pngOf(90, 1));
    await f.put('ada', 'import/b.png', pngOf(90, 2));
    const [a, b] = (
        await f.upload('ada', { spaceId: f.space.id, files: [{ path: 'import/a.png' }, { path: 'import/b.png' }] })
    ).results!;
    const files = f.platform.data.fileRecords('ada').filter((file) => file.path.startsWith('space-media/'));
    expect(files).toHaveLength(2);
    // A: a second embed (a cover made from Ada's copy in her Files) names its file.
    const fileA = files.find((file) => file.name === 'a.png')!;
    const cover = await f.media.coverFromFile('ada', { fileId: fileA.id, spaceId: f.space.id });
    await f.as('ada')(`/spaces/${f.space.id}/pages/${f.page.id}/cover`, 'PUT', { embedId: cover });
    // B: a cover is made from its file while the clean-up is counting.
    const fileB = files.find((file) => file.name === 'b.png')!;
    const repos = (
        f.media as unknown as { repos: { embeds: { countForFile: (...args: unknown[]) => Promise<number> } } }
    ).repos.embeds;
    const count = repos.countForFile.bind(repos);
    let late: Promise<string | Error> | undefined;
    vi.spyOn(repos, 'countForFile').mockImplementation(async (...args: unknown[]) => {
        const n = await count(...args);
        // Between the count and the delete: the window the review found.
        if (args[1] === fileB.id && !late) {
            late = f.media
                .coverFromFile('ada', { fileId: fileB.id, spaceId: f.space.id })
                .catch((error: Error) => error);
            await late;
        }
        return n;
    });
    expect(await f.media.collectSpaceUploads(Date.now() + SPACE_UPLOAD_LIMITS.graceMs + DAY)).toBe(2);
    // The uploads are gone; A's file stays for its cover.
    expect((await f.fetchAs('ada', a!.url!)).status).toBe(404);
    expect((await f.fetchAs('ada', b!.url!)).status).toBe(404);
    expect(f.platform.data.fileRecord('ada', fileA.id)).toBeDefined();
    expect((await f.fetchAs('mo', `/api/media/embeds/${cover}/content`)).status).toBe(200);
    // B's late cover was refused, or its file kept: never an embed without its file.
    const made = await late!;
    if (made instanceof Error) {
        expect(made.message).toBe('File not found.');
        expect(f.platform.data.fileRecord('ada', fileB.id)).toBeUndefined();
    } else {
        expect((await f.fetchAs('ada', `/api/media/embeds/${made}/content`)).status).toBe(200);
    }
});
