import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { copyFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ATTACHMENT_ID } from '@socio/shared/media-types';

import { bubbleAction } from '../../src/chat/composer';
import {
    openUserDb,
    type UserDb,
    USER_MIGRATIONS,
    wipe,
    workspaceKeyName,
    workspaceLayout,
    type WorkspaceLayout,
} from '../../src/data';
import type { AuthedFetch, AuthedRequestInit } from '../../src/net/authed-fetch';
import { NetworkError } from '../../src/net/errors';
import {
    type AttachmentFiles,
    type Attachments,
    DEFAULT_MEDIA_LIMITS,
    enqueueWithAttachments,
    openAttachments,
    type PickedFile,
    REUPLOAD_AFTER_MS,
    reuploadHook,
} from '../../src/sync/attachments';
import { chatDraft, type Drafts, newChatDraft, openDrafts } from '../../src/sync/chat-drafts';
import { enqueueNewChat } from '../../src/sync/new-chat';
import { type Outbox, type OutboxWrite, openOutbox } from '../../src/sync/outbox';
import { createNodeFileSystem } from '../helpers/node-fs';
import { createNodeSqliteDriver } from '../helpers/node-sqlite-driver';
import { addWorkspace, launch, phone } from '../helpers/store';

import { USER_KEY } from './outbox-fakes';

// Attachments (src/sync/attachments.ts) on a
// real user.db (node:sqlite) and a real directory: the copy before the
// picker's file goes, uploads against a fake `/api/media`, sends by
// reference with the draft in one transaction, the 23 h re-upload, Discard,
// migration 2 and the sign-out wipe.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup();
    }
});

const temp = (prefix: string) => {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    return directory;
};

let serial = 0;
const cbatt = () => `cbatt_${String((serial += 1)).padStart(22, 'A')}`;

interface Request {
    readonly method: string;
    readonly path: string;
    readonly init: AuthedRequestInit;
}

/** A fake `/api/media`: uploads answer by the queued statuses (201 by default), limits and DELETE. */
function fakeMedia() {
    const requests: Request[] = [];
    const answers: (number | 'offline' | 'bad-id')[] = [];
    let limits: unknown = { fileMaxBytes: 1000, perMessage: 10, imageModelMaxBytes: 500 };
    /** Each holds one upload's answer until released. */
    const gates: Promise<void>[] = [];
    const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const fetch: AuthedFetch = async (input, init = {}) => {
        const url = new URL(input, 'https://acme.example.test');
        const method = init.method ?? (init.upload ? 'POST' : 'GET');
        requests.push({ method, path: `${url.pathname}${url.search}`, init });
        if (url.pathname === '/api/media/limits') {
            return json(200, limits);
        }
        if (url.pathname === '/api/media/uploads') {
            await gates.shift();
            const next = answers.shift() ?? 201;
            if (next === 'offline') {
                throw new NetworkError('offline');
            }
            if (next === 'bad-id') {
                return json(201, { item: {}, attachment: { id: 'att_1' } });
            }
            if (next !== 201) {
                return json(next, { error: 'no' });
            }
            return json(201, { item: {}, attachment: { id: cbatt(), name: init.upload?.name } });
        }
        if (method === 'DELETE') {
            return json(200, { ok: true });
        }
        return json(404, {});
    };
    return {
        fetch,
        requests,
        answers,
        uploads: () => requests.filter((request) => request.path.startsWith('/api/media/uploads')),
        setLimits: (value: unknown) => {
            limits = value;
        },
        /** Holds the next upload's answer; call the result to let it come. */
        hold: () => {
            let release!: () => void;
            gates.push(new Promise<void>((resolve) => (release = resolve)));
            return () => release();
        },
    };
}

/** The node:fs binding, recording each call in `log` (with setFileProtection's). */
function nodeFiles(log: string[]): AttachmentFiles {
    const fs = createNodeFileSystem();
    return {
        list: fs.list,
        remove: async (path) => {
            log.push(`remove ${path}`);
            await fs.remove(path);
        },
        mkdir: fs.mkdir,
        copy: async (from, to) => {
            log.push(`copy ${from} -> ${to}`);
            await copyFile(from, to);
        },
        body: async (path) => new Uint8Array(await readFile(path)),
    };
}

interface Setup {
    readonly attachments: Attachments;
    readonly outbox: Outbox;
    readonly drafts: Drafts;
    readonly file: UserDb;
    readonly layout: WorkspaceLayout;
    readonly media: ReturnType<typeof fakeMedia>;
    readonly log: string[];
    readonly clock: { now: number };
    readonly pickerDir: string;
    /** A picked file in the picker's temporary folder. */
    readonly pick: (name: string, bytes?: number, mime?: string) => PickedFile;
    /** Closes everything and opens it again on the same files (a relaunch). */
    readonly reopen: () => Promise<Setup>;
    readonly rows: () => Promise<Record<string, unknown>[]>;
}

async function setup(
    options: {
        serverThread?: (id: string) => string | null;
        processImage?: (file: PickedFile) => Promise<PickedFile>;
        media?: ReturnType<typeof fakeMedia>;
        directory?: string;
        clock?: { now: number };
    } = {},
): Promise<Setup> {
    const directory = options.directory ?? temp('socio-attachments-');
    const pickerDir = options.directory ? join(directory, '..', 'picker') : temp('socio-picker-');
    mkdirSync(pickerDir, { recursive: true });
    const layout: WorkspaceLayout = {
        ...workspaceLayout('/unused', 'ab'.repeat(32)),
        directory,
        attachments: join(directory, 'attachments'),
    };
    const driver = createNodeSqliteDriver({ keys: new Map() });
    const file = await openUserDb(driver, directory, USER_KEY);
    const media = options.media ?? fakeMedia();
    const log: string[] = [];
    const clock = options.clock ?? { now: 1_762_500_000_000 };
    let ids = 0;
    const outbox = await openOutbox({
        db: file.db,
        state: file.state,
        kinds: [],
        fetch: media.fetch,
        random: () => 0.5,
    });
    const drafts = await openDrafts({ db: file.db, state: file.state, outbox, now: () => clock.now });
    const attachments = await openAttachments({
        db: file.db,
        state: file.state,
        layout,
        files: nodeFiles(log),
        setFileProtection: async (path, level) => {
            log.push(`protect ${path} ${level}`);
        },
        fetch: media.fetch,
        newId: () => `f${(ids += 1)}-${clock.now}`,
        serverThread: options.serverThread,
        processImage: options.processImage,
        now: () => clock.now,
    });
    let closed = false;
    const close = async () => {
        if (!closed) {
            closed = true;
            await drafts.close();
            await outbox.dispose();
            await attachments.close();
            await file.db.close();
        }
    };
    cleanups.push(close);
    let picks = 0;
    const self: Setup = {
        attachments,
        outbox,
        drafts,
        file,
        layout,
        media,
        log,
        clock,
        pickerDir,
        pick: (name, bytes = 3, mime = 'image/png') => {
            const uri = join(pickerDir, `${(picks += 1)}-${name}`);
            writeFileSync(uri, 'x'.repeat(bytes));
            return { uri, name, mime, bytes, temporary: true };
        },
        reopen: async () => {
            await close();
            return setup({ ...options, media, directory, clock });
        },
        rows: () =>
            file.db.all(
                'SELECT id, path, name, state, serverId, uploadedAt, draftScope, outboxId, lane, error FROM files ORDER BY createdAt',
            ),
    };
    return self;
}

/** Waits until `check` holds (uploads settle on their own). */
async function until(check: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
    const end = Date.now() + ms;
    while (!(await check())) {
        if (Date.now() > end) {
            throw new Error('timed out');
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

const settled = (s: Setup, scope: string) => () =>
    s.attachments.list(scope).every((file) => file.state !== 'uploading');

describe('attachments', () => {
    it('copies into attachments/ after giving it its class, commits, then deletes the picker’s file and uploads', async () => {
        const s = await setup();
        const picked = s.pick('photo.png');
        const { added, problems } = await s.attachments.add(chatDraft('c1'), [picked]);
        expect(problems).toEqual([]);
        const copy = join(s.layout.attachments, `${added[0]!.id}.png`);
        expect(s.log.slice(0, 3)).toEqual([
            `protect ${s.layout.attachments} completeUntilFirstUserAuthentication`,
            `copy ${picked.uri} -> ${copy}`,
            `remove ${picked.uri}`,
        ]);
        expect(existsSync(picked.uri)).toBe(false);
        expect(readFileSync(copy, 'utf8')).toBe('xxx');

        await until(settled(s, chatDraft('c1')));
        const [file] = s.attachments.list(chatDraft('c1'));
        expect(file).toMatchObject({ state: 'ready', kind: 'image', uploadedAt: s.clock.now });
        expect(file!.serverId).toMatch(ATTACHMENT_ID);
        const [upload] = s.media.uploads();
        expect(upload!.path).toBe('/api/media/uploads?purpose=attachment&threadId=c1');
        expect(upload!.init.upload).toMatchObject({ name: 'photo.png', type: 'image/png' });
        expect(Buffer.from(upload!.init.upload!.body as Uint8Array).toString()).toBe('xxx');
        expect(await s.rows()).toEqual([
            expect.objectContaining({
                path: `attachments/${file!.id}.png`,
                state: 'ready',
                serverId: file!.serverId,
                draftScope: 'chat:c1',
            }),
        ]);
    });

    it('uploads without threadId for a new chat’s draft and a local-id chat', async () => {
        const s = await setup({ serverThread: (id) => (id.startsWith('local-') ? null : id) });
        await s.attachments.add(newChatDraft('dot-1'), [s.pick('a.png')]);
        await s.attachments.add(chatDraft('local-7'), [s.pick('b.png')]);
        await until(() => s.media.uploads().length === 2);
        expect(s.media.uploads().map((request) => request.path)).toEqual([
            '/api/media/uploads?purpose=attachment',
            '/api/media/uploads?purpose=attachment',
        ]);
    });

    it.each([
        [413, 'too-large'],
        [415, 'type'],
        [403, 'refused'],
        ['bad-id', 'bad-answer'],
    ] as const)('a %s answer fails the file with %s; Retry uploads it again', async (answer, error) => {
        const s = await setup();
        s.media.answers.push(answer);
        await s.attachments.add(chatDraft('c1'), [s.pick('a.png')]);
        await until(settled(s, chatDraft('c1')));
        const [file] = s.attachments.list(chatDraft('c1'));
        expect(file).toMatchObject({ state: 'failed', error, serverId: null });
        expect(await s.rows()).toEqual([expect.objectContaining({ state: 'failed', error })]);

        s.attachments.retry(file!.id);
        await until(settled(s, chatDraft('c1')));
        expect(s.attachments.list(chatDraft('c1'))[0]).toMatchObject({ state: 'ready', error: null });
    });

    it('stays uploading with no answer or a 5xx, and goes on the next pump, across a relaunch too', async () => {
        const s = await setup();
        s.media.answers.push('offline', 503);
        await s.attachments.add(chatDraft('c1'), [s.pick('a.png')]);
        await until(() => s.media.uploads().length === 1);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(s.attachments.list(chatDraft('c1'))[0]).toMatchObject({ state: 'uploading' });
        s.attachments.pump();
        await until(() => s.media.uploads().length === 2);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(s.attachments.list(chatDraft('c1'))[0]).toMatchObject({ state: 'uploading' });

        const again = await s.reopen();
        expect(again.attachments.list(chatDraft('c1'))).toEqual([expect.objectContaining({ state: 'uploading' })]);
        again.attachments.pump();
        await until(settled(again, chatDraft('c1')));
        expect(again.attachments.list(chatDraft('c1'))[0]).toMatchObject({ state: 'ready' });
    });

    it('takes the server’s limits and at most 10 per tray; refuses empty and too large files', async () => {
        const s = await setup();
        const picks = Array.from({ length: 11 }, (_, index) => s.pick(`p${index}.png`));
        const { added, problems } = await s.attachments.add(chatDraft('c1'), [
            s.pick('empty.png', 0),
            s.pick('big.png', 1001),
            ...picks,
        ]);
        expect(added).toHaveLength(10);
        expect(problems).toEqual([
            { name: 'empty.png', reason: 'empty' },
            { name: 'big.png', reason: 'too-large' },
            { name: 'p10.png', reason: 'too-many' },
        ]);
        // Refused files are the picker's temporaries: they go too.
        expect(readdirSync(s.pickerDir)).toEqual([]);
        expect(s.media.requests.filter((request) => request.path === '/api/media/limits')).toHaveLength(1);
    });

    it('falls back to the web’s defaults when the limits don’t come', async () => {
        const media = fakeMedia();
        media.setLimits('nonsense');
        const s = await setup({ media });
        expect(await s.attachments.limits()).toEqual(DEFAULT_MEDIA_LIMITS);
    });

    it('runs the injected image processor and deletes its output once copied', async () => {
        const s = await setup({
            processImage: async (file) => {
                const uri = `${file.uri}.jpg`;
                writeFileSync(uri, 'jpeg');
                return { uri, name: 'photo.jpg', mime: 'image/jpeg', bytes: 4, temporary: true };
            },
        });
        const { added } = await s.attachments.add(chatDraft('c1'), [s.pick('photo.heic', 3, 'image/heic')]);
        expect(added[0]).toMatchObject({ name: 'photo.jpg', mime: 'image/jpeg', bytes: 4 });
        expect(readFileSync(added[0]!.path, 'utf8')).toBe('jpeg');
        expect(readdirSync(s.pickerDir)).toEqual([]);
    });

    it('Discard deletes the server’s pending upload, the copy and the row', async () => {
        const s = await setup();
        const { added } = await s.attachments.add(chatDraft('c1'), [s.pick('a.png')]);
        await until(settled(s, chatDraft('c1')));
        const serverId = s.attachments.list(chatDraft('c1'))[0]!.serverId!;
        await s.attachments.discard(added[0]!.id);
        expect(s.media.requests.at(-1)).toMatchObject({ method: 'DELETE', path: `/api/media/attachments/${serverId}` });
        expect(existsSync(added[0]!.path)).toBe(false);
        expect(await s.rows()).toEqual([]);
        expect(s.attachments.list(chatDraft('c1'))).toEqual([]);
    });

    it('deletes a copy a kill left before its row committed, at the next open', async () => {
        const s = await setup();
        await s.attachments.add(chatDraft('c1'), [s.pick('kept.png')]);
        writeFileSync(join(s.layout.attachments, 'orphan.png'), 'x');
        const again = await s.reopen();
        expect(readdirSync(again.layout.attachments)).toEqual([
            `${again.attachments.list(chatDraft('c1'))[0]!.id}.png`,
        ]);
    });
});

describe('sending by reference', () => {
    const build = (text: string, refs: readonly unknown[]) => ({
        id: 'm1',
        lane: 'chat:c1',
        kind: 'chat-message',
        payload: JSON.stringify({ text, attachments: refs }),
        payloadVersion: 1,
        idempotencyKey: 'k1',
    });

    it('moves the tray to the row with the draft in one transaction; the payload names local ids, resolved as it goes', async () => {
        const s = await setup();
        s.drafts.write(chatDraft('c1'), 'look');
        const { added } = await s.attachments.add(chatDraft('c1'), [s.pick('a.png')]);
        await until(settled(s, chatDraft('c1')));
        const row = await enqueueWithAttachments(s.drafts, s.attachments, chatDraft('c1'), build);
        expect(row?.id).toBe('m1');
        const payload = JSON.parse(row!.payload) as { attachments: { id: string }[] };
        expect(payload.attachments).toEqual([
            { id: added[0]!.id, name: 'a.png', mediaType: 'image/png', size: 3, kind: 'image' },
        ]);
        expect(s.attachments.list(chatDraft('c1'))).toEqual([]);
        expect(s.attachments.carried('m1')).toHaveLength(1);
        expect(await s.rows()).toEqual([
            expect.objectContaining({ draftScope: null, outboxId: 'm1', lane: 'chat:c1' }),
        ]);
        const serverId = s.attachments.carried('m1')[0]!.serverId;
        expect(s.attachments.resolve(payload.attachments as never)).toEqual([
            expect.objectContaining({ id: serverId }),
        ]);

        const again = await s.reopen();
        expect(again.drafts.read(chatDraft('c1')).text).toBe('');
        expect(again.attachments.carried('m1')).toHaveLength(1);
        expect(await again.attachments.prepare('m1')).toBeNull();
    });

    it('an upload that answers during the send never puts the file back in the tray, across a relaunch', async () => {
        const s = await setup();
        s.drafts.write(chatDraft('c1'), 'look');
        const release = s.media.hold();
        const { added } = await s.attachments.add(chatDraft('c1'), [s.pick('a.png')]);
        await until(() => s.media.uploads().length === 1);
        const row = await enqueueWithAttachments(s.drafts, s.attachments, chatDraft('c1'), (text, refs) => {
            // The answer lands while the draft's transaction is under way.
            release();
            return build(text, refs);
        });
        expect(row?.id).toBe('m1');
        await until(() => s.attachments.carried('m1')[0]?.state === 'ready');
        const serverId = s.attachments.carried('m1')[0]!.serverId;

        const again = await s.reopen();
        expect(await again.rows()).toEqual([
            expect.objectContaining({ id: added[0]!.id, state: 'ready', serverId, draftScope: null, outboxId: 'm1' }),
        ]);
        expect(again.attachments.list(chatDraft('c1'))).toEqual([]);
        expect(again.attachments.carried('m1')).toHaveLength(1);
    });

    it('a tray re-keyed during the send leaves the files the send moves, across a relaunch', async () => {
        const s = await setup();
        await s.attachments.add(chatDraft('c1'), [s.pick('a.png')]);
        await until(settled(s, chatDraft('c1')));
        const send = s.attachments.forSend(chatDraft('c1'));
        await s.file.db.transaction(async (tx) => {
            await send.statements(
                () => 'm1',
                () => 'chat:c1',
            )(tx);
            // A create resolving mid-send (chats.subscribe): its write lands after the move.
            s.attachments.rekey(chatDraft('c1'), chatDraft('srv-1'));
            await new Promise((resolve) => setTimeout(resolve, 20));
        });
        send.committed('m1', 'chat:c1');
        expect(s.attachments.carried('m1')).toHaveLength(1);
        expect(s.attachments.list(chatDraft('srv-1'))).toEqual([]);

        const again = await s.reopen();
        expect(await again.rows()).toEqual([
            expect.objectContaining({ draftScope: null, outboxId: 'm1', lane: 'chat:c1' }),
        ]);
        expect(again.attachments.carried('m1')).toHaveLength(1);
    });

    it('Discard leaves a file a send is moving, and takes it again once a send fails', async () => {
        const s = await setup();
        s.drafts.write(chatDraft('c1'), 'look');
        const { added } = await s.attachments.add(chatDraft('c1'), [s.pick('a.png')]);
        await until(settled(s, chatDraft('c1')));
        const id = added[0]!.id;
        let discarded: Promise<void> | undefined;
        await enqueueWithAttachments(s.drafts, s.attachments, chatDraft('c1'), (text, refs) => {
            discarded = s.attachments.discard(id);
            return build(text, refs);
        });
        await discarded;
        expect(s.attachments.carried('m1').map((file) => file.id)).toEqual([id]);
        expect(existsSync(added[0]!.path)).toBe(true);
        expect(await s.rows()).toEqual([expect.objectContaining({ id, outboxId: 'm1' })]);

        // A send that fails hands its files back to the tray's Discard.
        s.drafts.write(chatDraft('c2'), 'again');
        const other = (await s.attachments.add(chatDraft('c2'), [s.pick('b.png')])).added[0]!;
        await until(settled(s, chatDraft('c2')));
        await expect(enqueueWithAttachments(s.drafts, s.attachments, chatDraft('c2'), build)).rejects.toThrow();
        await s.attachments.discard(other.id);
        expect(s.attachments.list(chatDraft('c2'))).toEqual([]);
        expect(existsSync(other.path)).toBe(false);
    });

    it('a row naming a local id with no file goes to unsent instead of waiting forever', async () => {
        const s = await setup();
        const gone = { id: 'f-gone', name: 'a.png', mediaType: 'image/png', size: 3, kind: 'image' as const };
        expect(await s.attachments.prepare('m9', [gone])).toEqual({ action: 'unsent', reason: 'attachment-failed' });
        // Server ids pass as they are; no refs keeps the old answer.
        expect(await s.attachments.prepare('m9', [{ ...gone, id: cbatt() }])).toBeNull();
        expect(await s.attachments.prepare('m9')).toBeNull();
    });

    it('a failed insert leaves the files in the tray and the text in the box', async () => {
        const s = await setup();
        s.drafts.write(chatDraft('c1'), 'look');
        await s.attachments.add(chatDraft('c1'), [s.pick('a.png')]);
        await until(settled(s, chatDraft('c1')));
        await s.outbox.enqueue(build('first', []));
        await expect(enqueueWithAttachments(s.drafts, s.attachments, chatDraft('c1'), build)).rejects.toThrow();
        expect(s.attachments.list(chatDraft('c1'))).toHaveLength(1);
        expect(await s.rows()).toEqual([expect.objectContaining({ draftScope: 'chat:c1', outboxId: null })]);
        expect(s.drafts.read(chatDraft('c1')).text).toBe('look');
    });

    it('sends files with no text; holds the row while they upload; unsent when one fails for good', async () => {
        const s = await setup();
        s.media.answers.push('offline');
        await s.attachments.add(chatDraft('c1'), [s.pick('a.png')]);
        await until(() => s.media.uploads().length === 1);
        const row = await enqueueWithAttachments(s.drafts, s.attachments, chatDraft('c1'), build);
        expect(row).not.toBeNull();
        expect(s.attachments.resolve(JSON.parse(row!.payload).attachments)).toBeNull();
        // The row's turn: the upload goes again and lands.
        expect(await s.attachments.prepare('m1')).toBeNull();
        expect(s.attachments.resolve(JSON.parse(row!.payload).attachments)).not.toBeNull();

        s.media.answers.push('offline');
        s.attachments.reupload('m1');
        expect(await s.attachments.prepare('m1')).toEqual({ action: 'retry', reason: 'uploading' });
        s.media.answers.push(413);
        expect(await s.attachments.prepare('m1')).toEqual({ action: 'unsent', reason: 'attachment-failed' });
    });

    it('uploads again a file older than about 23 h before its message goes', async () => {
        const s = await setup();
        await s.attachments.add(chatDraft('c1'), [s.pick('a.png')]);
        await until(settled(s, chatDraft('c1')));
        await enqueueWithAttachments(s.drafts, s.attachments, chatDraft('c1'), build);
        const first = s.attachments.carried('m1')[0]!.serverId;
        s.clock.now += REUPLOAD_AFTER_MS - 1;
        expect(await s.attachments.prepare('m1')).toBeNull();
        expect(s.media.uploads()).toHaveLength(1);
        s.clock.now += 2;
        expect(await s.attachments.prepare('m1')).toBeNull();
        expect(s.media.uploads()).toHaveLength(2);
        const second = s.attachments.carried('m1')[0]!;
        expect(second.serverId).not.toBe(first);
        expect(second.uploadedAt).toBe(s.clock.now);
        expect(await s.rows()).toEqual([
            expect.objectContaining({ serverId: second.serverId, uploadedAt: s.clock.now }),
        ]);
    });

    it('re-uploads once after a 400: a rewrite with reuploaded and a fresh key, the files up again', async () => {
        const s = await setup();
        await s.attachments.add(chatDraft('c1'), [s.pick('a.png')]);
        await until(settled(s, chatDraft('c1')));
        const row = (await enqueueWithAttachments(s.drafts, s.attachments, chatDraft('c1'), build))!;
        const hook = reuploadHook<{ text: string; reuploaded?: true }>(s.attachments, () => 'k2', 1);
        const write: OutboxWrite<{ text: string }> = { row, payload: JSON.parse(row.payload) };
        const outcome = await hook(write);
        expect(outcome).toMatchObject({ action: 'rewrite', idempotencyKey: 'k2', payloadVersion: 1 });
        expect(JSON.parse((outcome as { payload: string }).payload)).toMatchObject({ text: '', reuploaded: true });
        expect(s.attachments.carried('m1')[0]).toMatchObject({ state: 'uploading', serverId: null });
        expect(await s.attachments.prepare('m1')).toBeNull();
        expect(s.media.uploads()).toHaveLength(2);
    });

    it('deletes a row’s files once the row has left the outbox and unsent', async () => {
        const s = await setup();
        await s.attachments.add(chatDraft('c1'), [s.pick('a.png')]);
        await until(settled(s, chatDraft('c1')));
        await enqueueWithAttachments(s.drafts, s.attachments, chatDraft('c1'), build);
        const path = s.attachments.carried('m1')[0]!.path;
        await s.attachments.sweep();
        expect(existsSync(path)).toBe(true);
        await s.outbox.remove('m1', s.outbox.revisionOf('m1'));
        await s.attachments.sweep();
        expect(existsSync(path)).toBe(false);
        expect(await s.rows()).toEqual([]);
        expect(s.attachments.carried('m1')).toEqual([]);
    });
});

describe('a pending message’s buttons (bubbleAction)', () => {
    const build = (text: string, refs: readonly unknown[]) => ({
        id: 'm1',
        lane: 'chat:c1',
        kind: 'chat-message',
        payload: JSON.stringify({ text, attachments: refs }),
        payloadVersion: 1,
        idempotencyKey: 'k1',
    });

    it('Edit puts the text and the files back in the box before the row goes; the sweep leaves them', async () => {
        const s = await setup();
        s.drafts.write(chatDraft('c1'), 'look');
        const { added } = await s.attachments.add(chatDraft('c1'), [s.pick('a.png'), s.pick('b.png')]);
        await until(settled(s, chatDraft('c1')));
        await enqueueWithAttachments(s.drafts, s.attachments, chatDraft('c1'), build);
        expect(s.attachments.list(chatDraft('c1'))).toEqual([]);

        await bubbleAction(s, { writeId: 'm1', text: 'look' }, 'edit', chatDraft('c1'), () => 'k2');
        await s.attachments.sweep();
        expect(await s.file.db.all('SELECT id FROM outbox')).toEqual([]);
        expect(s.drafts.read(chatDraft('c1')).text).toBe('look');
        expect(s.attachments.list(chatDraft('c1')).map((file) => file.id)).toEqual(added.map((file) => file.id));
        expect(s.attachments.carried('m1')).toEqual([]);
        expect(added.every((file) => existsSync(file.path))).toBe(true);

        const again = await s.reopen();
        expect(await again.rows()).toEqual([
            expect.objectContaining({ draftScope: 'chat:c1', outboxId: null, lane: 'chat:c1', state: 'ready' }),
            expect.objectContaining({ draftScope: 'chat:c1', outboxId: null, lane: 'chat:c1', state: 'ready' }),
        ]);
        expect(again.attachments.list(chatDraft('c1'))).toHaveLength(2);
    });

    it('Retry after “A file didn’t upload” uploads the failed files again before the row goes again', async () => {
        const s = await setup();
        await s.attachments.add(chatDraft('c1'), [s.pick('a.png')]);
        await until(settled(s, chatDraft('c1')));
        await enqueueWithAttachments(s.drafts, s.attachments, chatDraft('c1'), build);
        s.attachments.reupload('m1');
        s.media.answers.push(413);
        expect(await s.attachments.prepare('m1')).toEqual({ action: 'unsent', reason: 'attachment-failed' });
        expect(s.attachments.carried('m1')[0]).toMatchObject({ state: 'failed' });

        let atRetry: string | undefined;
        const outbox = {
            ...s.outbox,
            unsent: () => [],
            retryUnsent: async (id: string, key: string) => {
                atRetry = `${id} ${key} ${s.attachments.carried(id)[0]?.state}`;
                return true;
            },
        } as Outbox;
        await bubbleAction({ ...s, outbox }, { writeId: 'm1', text: '' }, 'retry', chatDraft('c1'), () => 'k2');
        expect(atRetry).toBe('m1 k2 uploading');
        expect(await s.attachments.prepare('m1')).toBeNull();
        expect(s.media.uploads()).toHaveLength(3);
    });
});

describe('a new chat', () => {
    it('takes the tray with its first message by local id; a failed file stays in the chat’s tray, which follows the server id', async () => {
        const s = await setup();
        s.media.answers.push(201, 415);
        await s.attachments.add(newChatDraft('dot-1'), [s.pick('a.png'), s.pick('b.png')]);
        await until(settled(s, newChatDraft('dot-1')));
        let ids = 0;
        const sent = await enqueueNewChat({
            drafts: s.drafts,
            dotId: 'dot-1',
            newId: () => `n${(ids += 1)}`,
            after: null,
            files: s.attachments,
        });
        expect(sent).not.toBeNull();
        const { localId, row } = sent!;
        const ready = s.attachments.carried(row.id);
        expect(ready.map((file) => file.name)).toEqual(['a.png']);
        expect(JSON.parse(row.payload).attachments).toEqual([expect.objectContaining({ id: ready[0]!.id })]);
        expect(await s.rows()).toEqual([
            expect.objectContaining({ name: 'a.png', outboxId: row.id, lane: `chat:${localId}`, draftScope: null }),
            expect.objectContaining({ name: 'b.png', outboxId: null, draftScope: `chat:${localId}` }),
        ]);
        expect(s.attachments.trays()).toEqual([`chat:${localId}`]);
        s.attachments.rekey(`chat:${localId}`, 'chat:srv-1');
        expect(s.attachments.list('chat:srv-1').map((file) => file.name)).toEqual(['b.png']);
    });
});

describe('user.db migration 2', () => {
    it('adds the columns to a migration-1 file and keeps its rows; an older build still reads the file', async () => {
        const directory = temp('socio-files-migrate-');
        const driver = createNodeSqliteDriver({ keys: new Map() });
        const old = await openUserDb(driver, directory, USER_KEY, USER_MIGRATIONS.slice(0, 1));
        expect(old.state).toEqual({ writable: true, version: 1 });
        await old.db.run('INSERT INTO files VALUES (?, ?, ?, ?, ?)', [
            'f1',
            'attachments/f1.png',
            'image/png',
            3,
            'chat:c1',
        ]);
        await old.db.close();

        const current = await openUserDb(driver, directory, USER_KEY, USER_MIGRATIONS.slice(0, 2));
        expect(current.state).toEqual({ writable: true, version: 2 });
        expect(await current.db.all('SELECT * FROM files')).toEqual([
            {
                id: 'f1',
                path: 'attachments/f1.png',
                mime: 'image/png',
                bytes: 3,
                lane: 'chat:c1',
                name: '',
                state: 'uploading',
                serverId: null,
                uploadedAt: null,
                draftScope: null,
                outboxId: null,
                error: null,
                createdAt: 0,
            },
        ]);
        await current.db.run(
            "UPDATE files SET state = 'ready', serverId = 'cbatt_x', draftScope = 'chat:c1' WHERE id = 'f1'",
        );
        await current.db.close();

        // A build at migration 1 opens it read-only and reads the columns it knows.
        const older = await openUserDb(driver, directory, USER_KEY, USER_MIGRATIONS.slice(0, 1));
        expect(older.state).toMatchObject({ writable: false, reason: 'newer', version: 2 });
        expect(await older.db.all('SELECT id, path, mime, bytes, lane FROM files')).toEqual([
            { id: 'f1', path: 'attachments/f1.png', mime: 'image/png', bytes: 3, lane: 'chat:c1' },
        ]);
        await older.db.close();
    });

    it('reads a file’s rows from a read-only user.db and adds nothing to it', async () => {
        const s = await setup();
        await s.attachments.add(chatDraft('c1'), [s.pick('a.png')]);
        await until(settled(s, chatDraft('c1')));
        const ro = await openAttachments({
            db: s.file.db,
            state: { writable: false, reason: 'newer', version: 3, message: 'Update Socio to send these' },
            layout: s.layout,
            files: nodeFiles([]),
            setFileProtection: async () => {},
            fetch: s.media.fetch,
            newId: () => 'never',
        });
        expect(ro.list(chatDraft('c1'))).toHaveLength(1);
        expect(await ro.add(chatDraft('c1'), [s.pick('b.png')])).toEqual({
            added: [],
            problems: [{ name: 'b.png', reason: 'read-only' }],
        });
        await ro.close();
    });
});

describe('signing out', () => {
    it('leaves no copy, no row and no picker file of the workspace after the wipe', async () => {
        const root = temp('socio-attachments-wipe-');
        const { store } = await launch(phone(root));
        cleanups.push(() => store.registry.close());
        const ada = await addWorkspace(store, 'https://acme.example.test', 'u-ada');
        const layout = workspaceLayout(root, ada.id);
        const media = fakeMedia();
        const userKey = await store.keys.read(workspaceKeyName(ada.id, 'user'));
        const file = await openUserDb(store.driver, layout.directory, userKey!);
        const attachments = await openAttachments({
            db: file.db,
            state: file.state,
            layout,
            files: nodeFiles([]),
            setFileProtection: async () => {},
            fetch: media.fetch,
            newId: () => 'f1',
        });
        const picker = temp('socio-picker-');
        const uri = join(picker, 'a.png');
        writeFileSync(uri, 'png');
        await attachments.add(chatDraft('c1'), [{ uri, name: 'a.png', mime: 'image/png', bytes: 3, temporary: true }]);
        await until(() => attachments.list(chatDraft('c1'))[0]?.state === 'ready');
        expect(readdirSync(layout.attachments)).toEqual(['f1.png']);
        expect(readdirSync(picker)).toEqual([]);

        await attachments.close();
        await wipe(store, ada.id, 'sign-out');
        expect(existsSync(layout.directory)).toBe(false);
    });
});
