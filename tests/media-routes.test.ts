import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Message } from '@ag-ui/core';
import { afterEach, expect, it, vi } from 'vitest';

import type { AttachmentRef, AttachmentView, MediaItem, MediaListing, UploadResult } from '@socio/shared/media-types';
import { attachmentPart, attachmentRef } from '@socio/shared/media/refs';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import type { DataLimits } from '../src/server/dataspace/contract.js';

import { PNG } from './fixtures/media.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function fixture(limits?: Partial<DataLimits>) {
    const dir = mkdtempSync(join(tmpdir(), 'cb-media-routes-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const { platform, workspace, app, dispose } = await makeTestRuntime({
        config: { sessionSecret: 'secret-0123456789abcdef-xyz', data: { userDataDir: dir, limits } },
        app: {
            auth: {
                provider: new MockAuthProvider(DEFAULT_MOCK_USERS, 'secret-0123456789abcdef-xyz'),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    for (const user of DEFAULT_MOCK_USERS) {
        workspace.recordUser(user);
    }
    const as = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0];
        const request = (path: string, method = 'GET', body?: unknown) =>
            app.request(`/api${path}`, {
                method,
                headers: {
                    cookie,
                    ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
        const upload = (
            bytes: Uint8Array,
            name: string,
            query = 'purpose=attachment',
            headers: Record<string, string> = {},
        ) =>
            app.request(`/api/media/uploads?${query}`, {
                method: 'POST',
                headers: {
                    cookie,
                    'Content-Type': 'application/octet-stream',
                    'X-CB-Upload': '1',
                    'X-File-Name': encodeURIComponent(name),
                    ...headers,
                },
                body: new Uint8Array(bytes),
            });
        return Object.assign(request, { upload });
    };
    const dot = workspace.dots()[0];
    return { platform, workspace, dot, as };
}

const today = () => new Date().toISOString().slice(0, 10);

it('stores a raw upload as a pending attachment that only its owner can read', async () => {
    const f = await fixture();
    const alice = await f.as('alice');
    const bob = await f.as('bob');
    const response = await alice.upload(PNG, 'Screen shot é.png', 'purpose=attachment', {
        'X-File-Type': 'image/png',
    });
    expect(response.status).toBe(201);
    const result = (await response.json()) as UploadResult;
    expect(result.attachment).toMatchObject({
        name: 'Screen shot é.png',
        mediaType: 'image/png',
        kind: 'image',
        size: PNG.length,
    });
    expect(result.attachment!.id).toMatch(/^cbatt_[A-Za-z0-9_-]{22}$/);
    // The path is safe and dated; the original name is kept for display.
    expect(result.item).toMatchObject({
        path: `attachments/${today()}/Screen shot e.png`,
        name: 'Screen shot é.png',
        folder: `attachments/${today()}/`,
        kind: 'image',
        attachments: [
            {
                id: result.attachment!.id,
                threadId: null,
                boundAt: null,
                source: 'web',
            },
        ],
    });
    const id = result.attachment!.id;
    const view = (await (await alice(`/media/attachments/${id}`)).json()) as AttachmentView;
    expect(view).toMatchObject({ threadId: null, path: result.item.path });

    const content = await alice(`/media/attachments/${id}/content`);
    expect(content.status).toBe(200);
    expect(Buffer.from(await content.arrayBuffer())).toEqual(PNG);
    expect(content.headers.get('content-type')).toBe('image/png');
    expect(content.headers.get('x-content-type-options')).toBe('nosniff');
    expect(content.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(content.headers.get('cache-control')).toBe('private, no-cache');
    expect(content.headers.get('content-disposition')).toContain('inline;');
    expect(content.headers.get('content-disposition')).toContain("filename*=UTF-8''Screen%20shot%20%C3%A9.png");
    const download = await alice(`/media/attachments/${id}/content?download=1`);
    expect(download.headers.get('content-disposition')).toMatch(/^attachment;/);

    // Another user can't tell it exists.
    expect((await bob(`/media/attachments/${id}`)).status).toBe(404);
    expect((await bob(`/media/attachments/${id}/content`)).status).toBe(404);
    expect((await bob(`/media/attachments/${id}`, 'DELETE')).status).toBe(404);
    // It is a file in alice's data space, counted in her quota.
    expect(f.platform.data.usage('alice').files).toBe(1);
});

it('refuses uploads without the custom header, too large, over quota or into another user’s chat', async () => {
    const f = await fixture({ fileMaxBytes: 1000, userMaxBytes: 2500 });
    const alice = await f.as('alice');
    const bob = await f.as('bob');
    const text = Buffer.from('hello');
    expect(
        (
            await alice.upload(text, 'a.txt', 'purpose=attachment', {
                'X-CB-Upload': '',
            })
        ).status,
    ).toBe(415);
    expect(
        (
            await alice.upload(text, 'a.txt', 'purpose=attachment', {
                'Content-Type': 'application/json',
            })
        ).status,
    ).toBe(415);
    const big = await alice.upload(Buffer.alloc(1001, 97), 'big.txt');
    expect(big.status).toBe(413);
    expect(((await big.json()) as { error: string }).error).toMatch(/at most/);
    expect((await alice.upload(Buffer.alloc(0), 'empty.txt')).status).toBe(400);
    expect((await alice.upload(text, '', 'purpose=attachment')).status).toBe(400);
    expect((await alice.upload(text, 'a.txt', 'purpose=nothing')).status).toBe(400);
    // Quota: two files fit, the third doesn't.
    for (const name of ['1.txt', '2.txt']) {
        expect((await alice.upload(Buffer.alloc(900, 97), name)).status).toBe(201);
    }
    expect((await alice.upload(Buffer.alloc(900, 97), '3.txt')).status).toBe(413);
    // A thread that isn't hers is missing.
    const thread = await f.platform.createConversation(f.dot.id, 'Bob', 'bob');
    expect((await alice.upload(text, 'x.txt', `purpose=attachment&threadId=${thread.id}`)).status).toBe(404);
    expect((await bob.upload(text, 'x.txt', `purpose=attachment&threadId=${thread.id}`)).status).toBe(201);
});

it('classifies by content and serves only raster images and plain text inline', async () => {
    const f = await fixture();
    const alice = await f.as('alice');
    const cases = [
        ['notes.md', Buffer.from('# Notes\n\n- one'), 'text', 'text/markdown', 'text/plain; charset=utf-8', true],
        ['data.csv', Buffer.from('a,b\n1,2\n'), 'text', 'text/csv', 'text/plain; charset=utf-8', true],
        [
            'main.ts',
            Buffer.from('export const x = 1;\n'),
            'text',
            'text/x-typescript',
            'text/plain; charset=utf-8',
            true,
        ],
        [
            'page.html',
            Buffer.from('<html><script>alert(1)</script></html>'),
            'text',
            'text/html',
            'application/octet-stream',
            false,
        ],
        [
            'logo.svg',
            Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
            'file',
            'image/svg+xml',
            'application/octet-stream',
            false,
        ],
        [
            'fake.png',
            Buffer.from([0, 1, 2, 3, 255]),
            'file',
            'application/octet-stream',
            'application/octet-stream',
            false,
        ],
        [
            'doc.pdf',
            Buffer.from('%PDF-1.4\n%\xff\xff\n', 'latin1'),
            'file',
            'application/pdf',
            'application/octet-stream',
            false,
        ],
    ] as const;
    for (const [name, bytes, kind, mediaType, served, inline] of cases) {
        const result = (await (
            await alice.upload(bytes, name, 'purpose=attachment', {
                'X-File-Type': 'image/png',
            })
        ).json()) as UploadResult;
        expect(result.attachment, name).toMatchObject({ kind, mediaType });
        const content = await alice(`/media/attachments/${result.attachment!.id}/content`);
        expect(content.headers.get('content-type'), name).toBe(served);
        expect(content.headers.get('content-disposition'), name).toMatch(inline ? /^inline;/ : /^attachment;/);
    }
    // PDFs are their own kind on the Media page.
    const pdf = f.platform.data.fileAt('alice', `attachments/${today()}/doc.pdf`)!;
    expect((await f.platform.media.item('alice', pdf)).kind).toBe('pdf');
});

it('gives the same name a free path, and plain files go to a folder', async () => {
    const f = await fixture();
    const alice = await f.as('alice');
    const paths: string[] = [];
    for (let i = 0; i < 3; i++) {
        paths.push(((await (await alice.upload(PNG, 'shot.png')).json()) as UploadResult).item.path);
    }
    expect(paths).toEqual([
        `attachments/${today()}/shot.png`,
        `attachments/${today()}/shot-2.png`,
        `attachments/${today()}/shot-3.png`,
    ]);
    const file = (await (
        await alice.upload(Buffer.from('x'), '../../etc/passwd', 'purpose=file&folder=reports/')
    ).json()) as UploadResult;
    expect(file.attachment).toBeUndefined();
    expect(file.item).toMatchObject({ path: 'reports/passwd', name: 'passwd' });
    expect((await alice.upload(Buffer.from('x'), 'a.txt', 'purpose=file&folder=../x/')).status).toBe(400);
});

it('deletes a pending attachment with its file, but not a sent one, and collects unsent ones after a day', async () => {
    const f = await fixture();
    const alice = await f.as('alice');
    const upload = async (name: string) =>
        ((await (await alice.upload(PNG, name)).json()) as UploadResult).attachment!.id;
    const pending = await upload('a.png');
    expect((await alice(`/media/attachments/${pending}`, 'DELETE')).status).toBe(200);
    expect((await alice(`/media/attachments/${pending}`)).status).toBe(404);
    expect(f.platform.data.usage('alice').files).toBe(0);

    const sent = await upload('b.png');
    const thread = await f.platform.createConversation(f.dot.id, 'A', 'alice');
    await f.platform.media.bind(
        (await f.platform.media.attachment(sent))!,
        { userId: 'alice', dotId: f.dot.id, threadId: thread.id },
        'message-1',
    );
    const deleting = await alice(`/media/attachments/${sent}`, 'DELETE');
    expect(deleting.status).toBe(409);

    const stale = await upload('c.png');
    expect(await f.platform.media.collectPending(Date.now() + 1000)).toBe(0);
    expect(await f.platform.media.collectPending(Date.now() + 24 * 3600_000 + 1000)).toBe(1);
    expect(await f.platform.media.attachment(stale)).toBeUndefined();
    // The sent one stays; deleting its file takes the attachment row too.
    expect(await f.platform.media.attachment(sent)).toBeDefined();
    const path = f.platform.media.view((await f.platform.media.attachment(sent))!).path!;
    await f.platform.data.deleteFile('alice', path);
    expect(await f.platform.media.attachment(sent)).toBeUndefined();
});

// AG-UI 1.0's media part, as the apps send it now, and the pre-1.0 `binary`
// reference, as the native app builds already shipped still do.
const NEW_SHAPE = (attachment: AttachmentRef) =>
    attachmentPart({ id: attachment.id, mimeType: attachment.mediaType, filename: attachment.name });
const OLD_SHAPE = (attachment: AttachmentRef) => ({
    type: 'binary',
    id: attachment.id,
    mimeType: attachment.mediaType,
    filename: attachment.name,
});

it.each([
    ['the 1.0 media part', NEW_SHAPE],
    ['the pre-1.0 binary part', OLD_SHAPE],
])('binds a message’s attachments (%s) when its run is accepted, not when the model is called', async (_, ref) => {
    const f = await fixture();
    const alice = await f.as('alice');
    const upload = async (as: typeof alice, name: string) =>
        ((await (await as.upload(PNG, name)).json()) as UploadResult).attachment!;
    const report = await upload(alice, 'report.png');
    const bobs = await upload(await f.as('bob'), 'bob.png');
    const thread = await f.platform.createConversation(f.dot.id, 'A', 'alice');
    // The run stops before the model factory runs (Stop pressed at once, a
    // paused workspace…): the runner has stored the message all the same.
    const runtime = vi.spyOn(f.platform.handler, 'fetch').mockImplementation(async () => new Response('stopped'));
    const response = await f.platform.handle(
        new Request(`http://localhost/api/copilotkit/agent/${f.dot.id}/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                threadId: thread.id,
                runId: 'run-1',
                messages: [
                    {
                        id: 'message-1',
                        role: 'user',
                        content: [{ type: 'text', text: 'see' }, ref(report), ref(bobs)],
                    },
                ],
                tools: [],
                context: [],
                state: {},
                forwardedProps: {},
            }),
        }),
        'alice',
    );
    expect(await response.text()).toBe('stopped');
    expect(runtime).toHaveBeenCalledTimes(1);
    // CopilotKit gets (and the runner stores) the 1.0 part, whichever came:
    // its request parser drops the old one.
    const forwarded = (await (runtime.mock.calls[0][0] as Request).json()) as { messages: Message[] };
    expect(forwarded.messages[0].content).toEqual([{ type: 'text', text: 'see' }, NEW_SHAPE(report), NEW_SHAPE(bobs)]);
    expect(await f.platform.media.attachment(report.id)).toMatchObject({
        threadId: thread.id,
        dotId: f.dot.id,
        messageId: 'message-1',
        boundAt: expect.any(Number),
    });
    // Another user's attachment stays theirs and pending.
    expect(await f.platform.media.attachment(bobs.id)).toMatchObject({
        threadId: null,
        boundAt: null,
    });
    // A day later the hourly tick leaves the sent one and its file alone.
    expect(await f.platform.media.collectPending(Date.now() + 24 * 3600_000 + 1000)).toBe(1);
    expect(await f.platform.media.attachment(report.id)).toBeDefined();
    expect(f.platform.data.usage('alice').files).toBe(1);
});

it('keeps a file the user moved out of attachments/ when its unsent attachment goes', async () => {
    const f = await fixture();
    const alice = await f.as('alice');
    const kept = (await (await alice.upload(PNG, 'kept.png')).json()) as UploadResult;
    const removed = (await (await alice.upload(PNG, 'removed.png')).json()) as UploadResult;
    for (const [shot, path] of [
        [kept, 'keep/kept.png'],
        [removed, 'keep/removed.png'],
    ] as const) {
        expect((await alice(`/media/items/${shot.item.id}`, 'PATCH', { path })).status).toBe(200);
    }
    // Removing the chip from the composer drops the attachment, not the file.
    expect((await alice(`/media/attachments/${removed.attachment!.id}`, 'DELETE')).status).toBe(200);
    expect(await f.platform.media.collectPending(Date.now() + 24 * 3600_000 + 1000)).toBe(1);
    expect(await f.platform.media.attachment(kept.attachment!.id)).toBeUndefined();
    expect(await f.platform.media.attachment(removed.attachment!.id)).toBeUndefined();
    expect(
        f.platform.data
            .fileRecords('alice')
            .map((file) => file.path)
            .sort(),
    ).toEqual(['keep/kept.png', 'keep/removed.png']);
});

it('lets members of a team conversation see its attachments', async () => {
    const f = await fixture();
    const alice = await f.as('alice');
    const bob = await f.as('bob');
    const thread = f.workspace.bindThread('team-thread', f.dot.id, 'Telegram topic 7', 'telegram-team:-100');
    await f.workspace.telegram.bindThread('tg:-100:topic:7', thread.id, 'topic', '-100', '7');
    await f.workspace.telegram.recordMember('-100', 'alice');
    const [message] = await f.platform.media.ingest({ userId: 'alice', threadId: thread.id, dotId: f.dot.id }, [
        {
            id: 'photo',
            role: 'user',
            content: [
                { type: 'text', text: 'look' },
                {
                    type: 'image',
                    source: {
                        type: 'data',
                        value: PNG.toString('base64'),
                        mimeType: 'image/png',
                    },
                },
            ],
        } as never,
    ]);
    // Stored as the 1.0 media part that refers to the saved file.
    const part = (message.content as unknown[])[1];
    expect(part).toMatchObject({
        type: 'image',
        source: { type: 'file', provider: 'socio', mimeType: 'image/png' },
        metadata: { filename: 'telegram-photo.png' },
    });
    const ref = attachmentRef(part)!;
    const url = `/media/attachments/${ref.id}/content`;
    expect((await alice(url)).status).toBe(200);
    expect((await bob(url)).status).toBe(404);
    await f.workspace.telegram.recordMember('-100', 'bob');
    expect((await bob(url)).status).toBe(200);
    // Sent already: no one deletes it from the chat.
    expect((await alice(`/media/attachments/${ref.id}`, 'DELETE')).status).toBe(409);
});

it('shows a socio’s screenshot only to people who can read its chat (CB-157)', async () => {
    const f = await fixture();
    const alice = await f.as('alice');
    const bob = await f.as('bob');
    const own = await f.platform.createConversation(f.dot.id, 'Reversi', 'alice');
    const image = await f.platform.media.saveToolImage(
        { userId: 'alice', dotId: f.dot.id, threadId: own.id },
        { name: 'screenshot-083015.png', bytes: PNG, width: 1, height: 1 },
    );
    expect(image).toMatchObject({
        mediaType: 'image/png',
        size: PNG.length,
        width: 1,
        height: 1,
    });
    const url = `/media/attachments/${image.id}/content`;
    const shown = await alice(url);
    expect(shown.status).toBe(200);
    expect(shown.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await shown.arrayBuffer())).toEqual(PNG);
    expect(await (await alice(`/media/attachments/${image.id}`)).json()).toMatchObject({
        threadId: own.id,
        source: 'tool',
        kind: 'image',
    });
    // Someone who can't read the chat can't tell it exists.
    expect((await bob(url)).status).toBe(404);
    expect((await bob(`/media/attachments/${image.id}`)).status).toBe(404);
    // In a team chat, its members see it too, and only they do.
    const team = f.workspace.bindThread('team-shots', f.dot.id, 'Telegram topic 8', 'telegram-team:-200');
    await f.workspace.telegram.bindThread('tg:-200:topic:8', team.id, 'topic', '-200', '8');
    await f.workspace.telegram.recordMember('-200', 'alice');
    const shared = await f.platform.media.saveToolImage(
        { userId: 'alice', dotId: f.dot.id, threadId: team.id },
        { name: 'screenshot-083016.png', bytes: PNG },
    );
    const sharedUrl = `/media/attachments/${shared.id}/content`;
    expect((await bob(sharedUrl)).status).toBe(404);
    await f.workspace.telegram.recordMember('-200', 'bob');
    expect((await bob(sharedUrl)).status).toBe(200);
    // A sent screenshot stays with its chat.
    expect((await alice(`/media/attachments/${image.id}`, 'DELETE')).status).toBe(409);
    // The model gets it only for its own conversation.
    expect(await f.platform.media.threadImage(own.id, image.id)).toBeDefined();
    expect(await f.platform.media.threadImage(team.id, image.id)).toBeUndefined();
});

it('lists a folder of the user’s files, newest first, with search, kinds and paging', async () => {
    const f = await fixture();
    const alice = await f.as('alice');
    const bob = await f.as('bob');
    const listing = async (query = '') => (await (await alice(`/media${query}`)).json()) as MediaListing;
    const shot = (await (
        await alice.upload(PNG, 'shot.png', 'purpose=attachment', {
            'X-File-Type': 'image/png',
        })
    ).json()) as UploadResult;
    await alice.upload(Buffer.from('# Notes'), 'notes.md', 'purpose=file');
    await alice.upload(Buffer.from('%PDF-1.7\n%\xe2\xe3\n1 0 obj'), 'q3.pdf', 'purpose=file&folder=reports/2026/');
    await f.platform.data.putFile(
        { kind: 'dot', userId: 'alice', dotId: f.dot.id },
        'draft.txt',
        Buffer.from('From the Dot'),
        'text/plain',
    );
    expect((await alice('/media/folders', 'POST', { path: 'empty' })).status).toBe(201);

    const root = await listing();
    expect(root.folder).toBe('');
    expect(root.items.map((item) => item.name)).toEqual(['notes.md']);
    expect(root.folders).toEqual(['attachments/', 'dots/', 'empty/', 'reports/']);
    expect(root.tree).toEqual([
        'attachments/',
        `attachments/${today()}/`,
        'dots/',
        `dots/${f.dot.id}/`,
        'empty/',
        'reports/',
        'reports/2026/',
    ]);
    expect(root.usage.files).toBe(4);
    expect(root.limits.fileMaxBytes).toBeGreaterThan(0);

    const day = await listing(`?folder=attachments/${today()}/`);
    expect(day.items).toMatchObject([
        {
            id: shot.item.id,
            kind: 'image',
            attachments: [{ id: shot.attachment!.id, threadTitle: null }],
        },
    ]);
    expect((await listing(`?folder=dots/${f.dot.id}/`)).items).toMatchObject([
        { name: 'draft.txt', createdByDotId: f.dot.id, dotName: f.dot.name },
    ]);
    // A search looks under the whole folder; kinds filter.
    expect((await listing('?q=Q3')).items.map((item) => item.kind)).toEqual(['pdf']);
    expect((await listing('?q=.&kind=text')).items.map((item) => item.name).sort()).toEqual(['draft.txt', 'notes.md']);
    const first = await listing('?q=.&limit=3');
    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).toBe('3');
    const rest = await listing(`?q=.&limit=3&cursor=${first.nextCursor}`);
    expect(rest.items).toHaveLength(1);
    expect(rest.nextCursor).toBeUndefined();
    expect((await alice('/media?kind=svg')).status).toBe(400);
    expect((await alice('/media?folder=../')).status).toBe(400);

    // Owner only: another user sees their own (empty) space and gets 404s.
    expect(((await (await bob('/media')).json()) as MediaListing).items).toEqual([]);
    expect((await bob(`/media/items/${shot.item.id}`)).status).toBe(404);
    expect((await bob(`/media/items/${shot.item.id}/content`)).status).toBe(404);
    const content = await alice(`/media/items/${shot.item.id}/content`);
    expect(content.headers.get('content-type')).toBe('image/png');
    expect(content.headers.get('content-disposition')).toMatch(/^inline/);
    expect(content.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await content.arrayBuffer())).toEqual(PNG);
    const download = await alice(`/media/items/${shot.item.id}/content?download=1`);
    expect(download.headers.get('content-disposition')).toMatch(/^attachment/);
});

it('moves and renames files, and keeps the attachment linked', async () => {
    const f = await fixture();
    const alice = await f.as('alice');
    const shot = (await (await alice.upload(PNG, 'Screen é.png')).json()) as UploadResult;
    const notes = (await (await alice.upload(Buffer.from('n'), 'notes.md', 'purpose=file')).json()) as UploadResult;
    const moved = await alice(`/media/items/${shot.item.id}`, 'PATCH', {
        path: 'keep/Screen e.png',
    });
    expect(moved.status).toBe(200);
    // Moved, not renamed: the original name stays.
    expect((await moved.json()) as MediaItem).toMatchObject({
        path: 'keep/Screen e.png',
        folder: 'keep/',
        name: 'Screen é.png',
        attachments: [{ id: shot.attachment!.id }],
    });
    const renamed = (await (
        await alice(`/media/items/${shot.item.id}`, 'PATCH', {
            path: 'keep/login.png',
        })
    ).json()) as MediaItem;
    expect(renamed.name).toBe('login.png');
    // The chat still finds it by its attachment id.
    expect(((await (await alice(`/media/attachments/${shot.attachment!.id}`)).json()) as AttachmentView).path).toBe(
        'keep/login.png',
    );
    expect(
        (
            await alice(`/media/items/${notes.item.id}`, 'PATCH', {
                path: 'keep/login.png',
            })
        ).status,
    ).toBe(409);
    expect((await alice(`/media/items/${notes.item.id}`, 'PATCH', { path: '../x' })).status).toBe(400);
    expect((await alice(`/media/items/${notes.item.id}`, 'PATCH', {})).status).toBe(400);
    // Deleting the file deletes its attachment; the bubble then says Removed.
    expect((await alice(`/media/items/${shot.item.id}`, 'DELETE')).status).toBe(200);
    expect((await alice(`/media/attachments/${shot.attachment!.id}`)).status).toBe(404);
    expect((await alice(`/media/items/${shot.item.id}`)).status).toBe(404);
});

it('creates, renames and deletes folders', async () => {
    const f = await fixture();
    const alice = await f.as('alice');
    const put = (path: string) =>
        f.platform.data.putFile({ kind: 'user', userId: 'alice' }, path, Buffer.from(path), 'text/plain');
    const tree = async () => ((await (await alice('/media')).json()) as MediaListing).tree;
    await put('work/a.txt');
    await put('work/deep/b.txt');
    await put('other/a.txt');
    expect((await alice('/media/folders', 'POST', { path: 'work/' })).status).toBe(409);
    expect((await alice('/media/folders', 'POST', { path: 'work/empty/' })).status).toBe(201);
    expect(await tree()).toEqual(['other/', 'work/', 'work/deep/', 'work/empty/']);

    // A clash anywhere refuses the rename before anything moves.
    await put('done/deep/b.txt');
    const clash = await alice('/media/folders', 'PATCH', {
        from: 'work/',
        to: 'done/',
    });
    expect(clash.status).toBe(409);
    expect(f.platform.data.fileAt('alice', 'work/a.txt')).toBeDefined();
    expect((await alice('/media/folders', 'PATCH', { from: 'work/', to: 'work/x/' })).status).toBe(400);
    expect((await alice('/media/folders', 'PATCH', { from: 'nope/', to: 'x/' })).status).toBe(404);
    const renamed = await alice('/media/folders', 'PATCH', {
        from: 'work/',
        to: 'archive/2026/',
    });
    expect(renamed.status).toBe(200);
    expect(await tree()).toEqual([
        'archive/',
        'archive/2026/',
        'archive/2026/deep/',
        'archive/2026/empty/',
        'done/',
        'done/deep/',
        'other/',
    ]);
    expect(f.platform.data.fileAt('alice', 'archive/2026/deep/b.txt')).toBeDefined();

    // Only an empty folder goes without `recursive`.
    expect((await alice('/media/folders?path=archive/2026/empty/', 'DELETE')).status).toBe(200);
    expect((await alice('/media/folders?path=archive/', 'DELETE')).status).toBe(409);
    const deleted = await alice('/media/folders?path=archive/&recursive=1', 'DELETE');
    expect(await deleted.json()).toEqual({ deleted: 2 });
    expect(await tree()).toEqual(['done/', 'done/deep/', 'other/']);
    expect(f.platform.data.usage('alice').files).toBe(2);
    expect((await alice('/media/folders?path=archive/', 'DELETE')).status).toBe(404);
});

it('moves Dots’ folder grants with a renamed folder and ends them with a deleted one (CB-65)', async () => {
    const f = await fixture();
    const alice = await f.as('alice');
    const data = f.platform.data;
    const user = { kind: 'user' as const, userId: 'alice' };
    const dot = { kind: 'dot' as const, userId: 'alice', dotId: f.dot.id };
    const put = (path: string) => data.putFile(user, path, Buffer.from(path), 'text/plain');
    await put('work/deep/b.txt');
    data.setGrant('alice', { dotId: f.dot.id, folder: 'work/', access: 'read' });
    data.setGrant('alice', {
        dotId: f.dot.id,
        folder: 'work/deep/',
        access: 'write',
    });
    const granted = () =>
        data
            .grants('alice')
            .map((grant) => grant.folder)
            .sort();
    const audited = (match: (detail: string) => boolean) =>
        data
            .auditFor('alice')
            .filter((entry) => entry.detail && match(entry.detail))
            .map((entry) => `${entry.action} ${entry.target}`)
            .sort();

    const renamed = await alice('/media/folders', 'PATCH', {
        from: 'work/',
        to: 'archive/2026/',
    });
    expect(renamed.status).toBe(200);
    expect(granted()).toEqual(['archive/2026/', 'archive/2026/deep/']);
    expect((await data.getFile(dot, 'archive/2026/deep/b.txt')).data.toString()).toBe('work/deep/b.txt');
    await data.putFile(dot, 'archive/2026/deep/c.txt', Buffer.from('c'));
    expect(audited((detail) => detail.includes(', from work/'))).toEqual([
        'grant_move archive/2026/',
        'grant_move archive/2026/deep/',
    ]);
    // A new folder at the old path inherits nothing.
    await put('work/new.txt');
    const seen = () => data.listFiles(dot).map((file) => file.path);
    expect(seen()).toEqual(['archive/2026/deep/b.txt', 'archive/2026/deep/c.txt']);

    // A Dot's own folder is no grant, so it keeps its place.
    await data.putFile(dot, 'mine.txt', Buffer.from('mine'));
    for (const from of ['dots/', `dots/${f.dot.id}/`]) {
        expect((await alice('/media/folders', 'PATCH', { from, to: 'elsewhere/' })).status).toBe(400);
    }

    // Deleting the folder ends its grants: the path starts over.
    const deleted = await alice('/media/folders?path=archive/2026/&recursive=1', 'DELETE');
    expect(deleted.status).toBe(200);
    expect(granted()).toEqual([]);
    expect(audited((detail) => detail.endsWith('the folder was deleted'))).toEqual([
        'revoke archive/2026/',
        'revoke archive/2026/deep/',
    ]);
    await put('archive/2026/later.txt');
    expect(seen()).toEqual([`dots/${f.dot.id}/mine.txt`]);
});

it('moves only the person’s own files and folders, never a folder into itself (CB-255)', async () => {
    const f = await fixture();
    const alice = await f.as('alice');
    const bob = await f.as('bob');
    const data = f.platform.data;
    const put = (path: string) =>
        data.putFile({ kind: 'user', userId: 'alice' }, path, Buffer.from(path), 'text/plain');
    await put('work/a.txt');
    await put('work/deep/b.txt');
    await put('other/c.txt');
    data.setGrant('alice', { dotId: f.dot.id, folder: 'work/', access: 'read' });
    const at = (path: string) => data.fileAt('alice', path);
    const file = at('work/a.txt')!;

    // Someone else can't move Alice's file or folder: they aren't theirs.
    expect((await bob(`/media/items/${file.id}`, 'PATCH', { path: 'a.txt' })).status).toBe(404);
    expect((await bob('/media/folders', 'PATCH', { from: 'work/', to: 'other/work/' })).status).toBe(404);
    expect(at('work/a.txt')).toBeDefined();
    expect(at('other/work/deep/b.txt')).toBeUndefined();

    // Not into itself, nor into one of its subfolders; nothing moves.
    for (const to of ['work/work/', 'work/deep/work/']) {
        expect((await alice('/media/folders', 'PATCH', { from: 'work/', to })).status).toBe(400);
    }
    expect(at('work/deep/b.txt')).toBeDefined();
    // Not into Socios as a folder that would pass for a socio's own.
    for (const to of ['dots/work/', 'dots/', `dots/${f.dot.id}/`]) {
        expect((await alice('/media/folders', 'PATCH', { from: 'work/', to })).status).toBe(400);
    }
    // Where it already is: nothing to do.
    expect((await alice('/media/folders', 'PATCH', { from: 'work/', to: 'work/' })).status).toBe(200);

    // A drop on another folder, then back to the top level (Undo).
    const moved = await alice('/media/folders', 'PATCH', {
        from: 'work/',
        to: 'other/work/',
    });
    expect(moved.status).toBe(200);
    expect(at('other/work/deep/b.txt')).toBeDefined();
    expect(data.grants('alice').map((grant) => grant.folder)).toEqual(['other/work/']);
    expect(
        (
            await alice('/media/folders', 'PATCH', {
                from: 'other/work/',
                to: 'work/',
            })
        ).status,
    ).toBe(200);
    expect(at('work/deep/b.txt')).toBeDefined();
    expect(data.grants('alice').map((grant) => grant.folder)).toEqual(['work/']);

    // A file to the top level, and into a socio's folder, keeps its id.
    const top = await alice(`/media/items/${file.id}`, 'PATCH', {
        path: 'a.txt',
    });
    expect(await top.json()).toMatchObject({ path: 'a.txt', folder: '' });
    expect(
        (
            await alice(`/media/items/${file.id}`, 'PATCH', {
                path: `dots/${f.dot.id}/a.txt`,
            })
        ).status,
    ).toBe(200);
    expect(at(`dots/${f.dot.id}/a.txt`)?.id).toBe(file.id);

    // A name taken where it lands is refused, as for any move.
    await put('other/a.txt');
    const clash = await alice(`/media/items/${file.id}`, 'PATCH', {
        path: 'other/a.txt',
    });
    expect(clash.status).toBe(409);
    expect(((await clash.json()) as { error: string }).error).toBe('There is a file at other/a.txt already.');
    await put('elsewhere/work/deep/b.txt');
    expect(
        (
            await alice('/media/folders', 'PATCH', {
                from: 'work/',
                to: 'elsewhere/work/',
            })
        ).status,
    ).toBe(409);
    expect(at('work/deep/b.txt')).toBeDefined();
});
