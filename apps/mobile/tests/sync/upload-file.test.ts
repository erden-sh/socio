import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { copyFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openUserDb, type UserDb, USER_MIGRATIONS, workspaceLayout, type WorkspaceLayout } from '../../src/data';
import type { AuthedFetch } from '../../src/net/authed-fetch';
import { NetworkError } from '../../src/net/errors';
import { type AttachmentFiles, openAttachments, type PickedFile } from '../../src/sync/attachments';
import { chatDraft } from '../../src/sync/chat-drafts';
import { createImageProcessor, PAGE_IMAGE_PROFILE } from '../../src/sync/image-processing';
import {
    FILE_UPLOAD_COPY,
    type FileUploads,
    openFileUploads,
    SAVED_TO_FILES_KEY,
    SAVED_TO_FILES_NOTE,
} from '../../src/sync/upload-file';
import { createNodeFileSystem } from '../helpers/node-fs';
import { createNodeSqliteDriver } from '../helpers/node-sqlite-driver';

import { USER_KEY } from './outbox-fakes';

// Uploads to the person's Files (src/sync/upload-file.ts) on a real
// user.db and directory, against a fake `/api/media` that stores what it
// takes: the page image profile before anything is written, a unique name,
// `unknown` settled by listing that name (no duplicate on a retry), 413 and
// 415 with words, the write's `prepare`/`resolve`/`forget`, attachments
// leaving these rows alone, and "Saved to your Files" once per workspace.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup();
    }
});

const MB = 1024 * 1024;

const temp = (prefix: string) => {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    return directory;
};

/** How the next upload goes: a status, stored then the answer lost, or no request reaching the server. */
type UploadAnswer = number | 'lost' | 'offline';

/** A fake `/api/media`: stores each upload under its name, and lists by `q`. */
function fakeMedia() {
    const stored: { id: string; name: string; size: number }[] = [];
    const requests: string[] = [];
    const answers: UploadAnswer[] = [];
    const listAnswers: number[] = [];
    const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const fetch: AuthedFetch = async (input, init = {}) => {
        const url = new URL(input, 'https://acme.example.test');
        requests.push(`${init.upload ? 'POST' : (init.method ?? 'GET')} ${url.pathname}${url.search}`);
        if (url.pathname === '/api/media/uploads') {
            const next = answers.shift() ?? 201;
            if (next === 'offline') {
                throw new NetworkError('offline');
            }
            if (next !== 201 && next !== 'lost') {
                return json(next, { error: 'no' });
            }
            const body = init.upload!.body as Uint8Array;
            const item = { id: `item-${stored.length + 1}`, name: init.upload!.name, size: body.byteLength };
            stored.push(item);
            if (next === 'lost') {
                throw new NetworkError('the answer was lost');
            }
            return json(201, { item });
        }
        if (url.pathname === '/api/media') {
            const status = listAnswers.shift() ?? 200;
            if (status !== 200) {
                return json(status, { error: 'no' });
            }
            const q = (url.searchParams.get('q') ?? '').toLowerCase();
            return json(200, {
                folder: '',
                items: stored.filter((item) => item.name.toLowerCase().includes(q)),
            });
        }
        return json(404, {});
    };
    return {
        fetch,
        stored,
        requests,
        answers,
        listAnswers,
        uploads: () => requests.filter((request) => request.startsWith('POST /api/media/uploads')),
        lists: () => requests.filter((request) => request.startsWith('GET /api/media?')),
    };
}

function nodeFiles(): AttachmentFiles {
    const fs = createNodeFileSystem();
    return {
        list: fs.list,
        remove: fs.remove,
        mkdir: fs.mkdir,
        copy: (from, to) => copyFile(from, to),
        body: async (path) => new Uint8Array(await readFile(path)),
    };
}

interface Setup {
    readonly uploads: FileUploads;
    readonly file: UserDb;
    readonly layout: WorkspaceLayout;
    readonly media: ReturnType<typeof fakeMedia>;
    readonly kv: Map<string, string>;
    readonly pickerDir: string;
    readonly pick: (name: string, bytes?: number, mime?: string) => PickedFile;
    readonly reopen: () => Promise<Setup>;
    readonly rows: () => Promise<Record<string, unknown>[]>;
}

async function setup(
    options: {
        processImage?: (file: PickedFile) => Promise<PickedFile>;
        media?: ReturnType<typeof fakeMedia>;
        directory?: string;
        kv?: Map<string, string>;
        ids?: { next: number };
        autoPump?: boolean;
    } = {},
): Promise<Setup> {
    const directory = options.directory ?? temp('socio-uploads-');
    const pickerDir = join(directory, '..', `${directory.split('/').pop()}-picker`);
    mkdirSync(pickerDir, { recursive: true });
    cleanups.push(() => rmSync(pickerDir, { recursive: true, force: true }));
    const layout: WorkspaceLayout = {
        ...workspaceLayout('/unused', 'cd'.repeat(32)),
        directory,
        attachments: join(directory, 'attachments'),
    };
    const file = await openUserDb(createNodeSqliteDriver({ keys: new Map() }), directory, USER_KEY);
    const media = options.media ?? fakeMedia();
    const kv = options.kv ?? new Map<string, string>();
    const ids = options.ids ?? { next: 0 };
    const uploads = await openFileUploads({
        db: file.db,
        state: file.state,
        layout,
        files: nodeFiles(),
        setFileProtection: async () => {},
        fetch: media.fetch,
        newId: () => `u${(ids.next += 1)}`,
        processImage: options.processImage,
        viewState: { get: (key) => kv.get(key) ?? null, set: (key, value) => void kv.set(key, value) },
    });
    let closed = false;
    const close = async () => {
        if (!closed) {
            closed = true;
            await uploads.close();
            await file.db.close();
        }
    };
    cleanups.push(close);
    let picks = 0;
    return {
        uploads,
        file,
        layout,
        media,
        kv,
        pickerDir,
        pick: (name, bytes = 3, mime = 'image/png') => {
            const uri = join(pickerDir, `${(picks += 1)}-${name}`);
            writeFileSync(uri, 'x'.repeat(bytes));
            return { uri, name, mime, bytes, temporary: true };
        },
        reopen: async () => {
            await close();
            return setup({ ...options, media, directory, kv, ids });
        },
        rows: () => file.db.all('SELECT id, path, name, lane, state, serverId, error FROM files ORDER BY createdAt'),
    };
}

async function until(check: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
    const end = Date.now() + ms;
    while (!(await check())) {
        if (Date.now() > end) {
            throw new Error('timed out');
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

const settled = (s: Setup, id: string) => () => s.uploads.get(id)?.state !== 'uploading';

describe('uploads to the person’s Files', () => {
    it('runs a 7 MB HEIC through the page profile, copies, commits and uploads it as a file under a unique name', async () => {
        const rendered: string[] = [];
        let pickerDir = '';
        // The fake renderer writes a real JPEG-sized file: 7.4 MB at 4096, then 5.2, then 3.6.
        const processImage = createImageProcessor({
            profile: PAGE_IMAGE_PROFILE,
            render: async (_uri, { maxSide }) => {
                const side = Math.min(6000, maxSide);
                const uri = join(pickerDir, `render-${rendered.length + 1}.jpg`);
                const bytes = Math.round(side * 0.0018 * MB);
                writeFileSync(uri, Buffer.alloc(bytes));
                rendered.push(uri);
                return { uri, width: side, height: side, bytes };
            },
            remove: async (uri) => rmSync(uri, { force: true }),
        });
        const s = await setup({ processImage });
        pickerDir = s.pickerDir;
        const picked = s.pick('IMG_0001.HEIC', 7 * MB, 'image/heic');
        const added = await s.uploads.add(picked, 'cover');
        expect('upload' in added).toBe(true);
        const upload = 'upload' in added ? added.upload : null!;
        expect(upload.name).toBe('cover-u1.jpg');
        expect(upload.mime).toBe('image/jpeg');
        expect(upload.bytes).toBeLessThanOrEqual(5 * MB);
        await until(settled(s, upload.id));
        expect(s.media.uploads()).toEqual(['POST /api/media/uploads?purpose=file']);
        expect(s.media.stored).toEqual([{ id: 'item-1', name: 'cover-u1.jpg', size: upload.bytes }]);
        expect(s.uploads.get(upload.id)).toMatchObject({ state: 'ready', serverId: 'item-1', error: null });
        expect(s.uploads.resolve(upload.id)).toBe('item-1');
        expect(await s.rows()).toEqual([
            {
                id: 'u1',
                path: 'attachments/cover-u1.jpg',
                name: 'cover-u1.jpg',
                lane: 'upload:u1',
                state: 'ready',
                serverId: 'item-1',
                error: null,
            },
        ]);
        // The picker's file and every rendering are gone; the copy stays until the write is done.
        expect(readdirSync(s.pickerDir)).toEqual([]);
        expect(existsSync(upload.path)).toBe(true);
    });

    it('refuses what the profile leaves outside a cover’s types or size, with words, writing nothing', async () => {
        const s = await setup();
        expect(await s.uploads.add(s.pick('IMG.HEIC', 10, 'image/heic'), 'cover')).toEqual({ problem: 'type' });
        expect(await s.uploads.add(s.pick('big.png', 5 * MB + 1), 'image')).toEqual({ problem: 'too-large' });
        expect(await s.uploads.add(s.pick('empty.png', 0), 'cover')).toEqual({ problem: 'empty' });
        expect(FILE_UPLOAD_COPY.type).toBe('Use a PNG, JPEG or WebP image.');
        expect(FILE_UPLOAD_COPY['too-large']).toBe('Images can be at most 5 MB.');
        expect(await s.rows()).toEqual([]);
        expect(s.media.requests).toEqual([]);
        expect(readdirSync(s.pickerDir)).toEqual([]);
    });

    it('names a pasted image `image-<id>` with its own extension', async () => {
        const s = await setup();
        const added = await s.uploads.add(s.pick('paste.webp', 20, 'image/webp'), 'image');
        const upload = 'upload' in added ? added.upload : null!;
        expect(upload.name).toBe('image-u1.webp');
        await until(settled(s, upload.id));
        expect(s.uploads.get(upload.id)?.purpose).toBe('image');
    });

    it('fails a 413 and a 415 with words, never the server’s text, and refuses the write that names them', async () => {
        const s = await setup();
        s.media.answers.push(413, 415);
        const one = await s.uploads.add(s.pick('a.png'), 'cover');
        const two = await s.uploads.add(s.pick('b.png'), 'cover');
        const a = 'upload' in one ? one.upload.id : '';
        const b = 'upload' in two ? two.upload.id : '';
        await until(() => settled(s, a)() && settled(s, b)());
        expect(s.uploads.get(a)).toMatchObject({ state: 'failed', error: 'too-large' });
        expect(s.uploads.get(b)).toMatchObject({ state: 'failed', error: 'type' });
        expect(await s.uploads.prepare(a)).toEqual({ action: 'unsent', reason: 'upload-failed' });
        expect(s.uploads.resolve(a)).toBeNull();
        // Kept across a relaunch, and Retry uploads again.
        const again = await s.reopen();
        expect(again.uploads.get(a)).toMatchObject({ state: 'failed', error: 'too-large' });
        again.uploads.retry(a);
        await until(settled(again, a));
        expect(again.uploads.get(a)).toMatchObject({ state: 'ready' });
    });

    it('settles a lost answer by listing its name: found is uploaded, with no second upload', async () => {
        const s = await setup();
        s.media.answers.push('lost');
        const added = await s.uploads.add(s.pick('a.png'), 'cover');
        const id = 'upload' in added ? added.upload.id : '';
        await until(() => s.media.uploads().length === 1);
        await until(async () => (await s.rows())[0]?.state === 'unknown');
        expect(s.uploads.get(id)?.state).toBe('uploading');
        // A relaunch (or the next pump) lists first.
        const again = await s.reopen();
        again.uploads.pump();
        await until(settled(again, id));
        expect(again.media.lists()).toEqual(['GET /api/media?q=cover-u1.png&limit=200']);
        expect(again.media.uploads()).toHaveLength(1);
        expect(again.media.stored).toHaveLength(1);
        expect(again.uploads.get(id)).toMatchObject({ state: 'ready', serverId: 'item-1' });
        expect(await again.uploads.prepare(id)).toBeNull();
    });

    it('uploads again when the listing doesn’t have it, and waits while the listing can’t say', async () => {
        const s = await setup();
        s.media.answers.push('offline', 502);
        const added = await s.uploads.add(s.pick('a.png'), 'cover');
        const id = 'upload' in added ? added.upload.id : '';
        await until(() => s.media.uploads().length === 1);
        await until(async () => (await s.rows())[0]?.state === 'unknown');
        // The listing fails: nothing is uploaded.
        s.media.listAnswers.push(500);
        expect(await s.uploads.prepare(id)).toEqual({ action: 'retry', reason: 'uploading' });
        expect(s.media.uploads()).toHaveLength(1);
        // It answers, without the file: one upload, answered 502 (a proxy's: it may be stored).
        expect(await s.uploads.prepare(id)).toEqual({ action: 'retry', reason: 'uploading' });
        expect(s.media.uploads()).toHaveLength(2);
        expect(s.media.stored).toHaveLength(0);
        // The next one lists, then uploads: exactly one file on the server.
        expect(await s.uploads.prepare(id)).toBeNull();
        expect(s.media.lists()).toHaveLength(3);
        expect(s.media.stored).toEqual([{ id: 'item-1', name: 'cover-u1.png', size: 3 }]);
    });

    it('uploads again with no listing after a 429, 408 or 401, which stored nothing', async () => {
        const s = await setup();
        s.media.answers.push(429);
        const added = await s.uploads.add(s.pick('a.png'), 'cover');
        const id = 'upload' in added ? added.upload.id : '';
        await until(() => s.media.uploads().length === 1);
        await until(async () => (await s.rows())[0]?.state === 'uploading');
        expect(await s.uploads.prepare(id)).toBeNull();
        expect(s.media.lists()).toEqual([]);
        expect(s.media.stored).toHaveLength(1);
    });

    it('refuses a write naming an upload this device doesn’t have; forget drops the row and the copy, not the file', async () => {
        const s = await setup();
        expect(await s.uploads.prepare('nope')).toEqual({ action: 'unsent', reason: 'upload-missing' });
        const added = await s.uploads.add(s.pick('a.png'), 'cover');
        const upload = 'upload' in added ? added.upload : null!;
        await until(settled(s, upload.id));
        await s.uploads.forget(upload.id);
        expect(s.uploads.get(upload.id)).toBeNull();
        expect(await s.rows()).toEqual([]);
        expect(existsSync(upload.path)).toBe(false);
        expect(s.media.stored).toHaveLength(1);
    });

    it('fails an upload whose copy is gone as `missing`, which Retry leaves', async () => {
        const s = await setup();
        s.media.answers.push(503);
        const added = await s.uploads.add(s.pick('a.png'), 'cover');
        const upload = 'upload' in added ? added.upload : null!;
        await until(async () => (await s.rows())[0]?.state === 'unknown' && s.media.uploads().length === 1);
        await until(() => s.media.requests.length === 1);
        rmSync(upload.path);
        s.uploads.pump();
        await until(settled(s, upload.id));
        expect(s.uploads.get(upload.id)).toMatchObject({ state: 'failed', error: 'missing' });
        s.uploads.retry(upload.id);
        expect(s.uploads.get(upload.id)?.state).toBe('failed');
    });

    it('lives beside attachments: they never read, upload or delete its rows or copies', async () => {
        const s = await setup();
        const added = await s.uploads.add(s.pick('a.png'), 'cover');
        const upload = 'upload' in added ? added.upload : null!;
        await until(settled(s, upload.id));
        const attachments = await openAttachments({
            db: s.file.db,
            state: s.file.state,
            layout: s.layout,
            files: nodeFiles(),
            setFileProtection: async () => {},
            fetch: s.media.fetch,
            newId: () => 'att-1',
        });
        attachments.pump();
        await attachments.sweep();
        expect(attachments.trays()).toEqual([]);
        expect(attachments.list(chatDraft('c1'))).toEqual([]);
        await attachments.close();
        expect(existsSync(upload.path)).toBe(true);
        expect(s.media.uploads()).toHaveLength(1);
        expect(await s.rows()).toHaveLength(1);
        // No migration for uploads: `files` is still migration 2's (later ones, such as `prefs`, never touch it).
        expect(
            USER_MIGRATIONS.slice(2)
                .flatMap((migration) => migration.statements)
                .filter((statement) => /\bfiles\b/.test(statement)),
        ).toEqual([]);
    });

    it('says “Saved to your Files” once per workspace', async () => {
        const s = await setup();
        expect(s.uploads.takeSavedNote()).toBe(SAVED_TO_FILES_NOTE);
        expect(SAVED_TO_FILES_NOTE).toBe('Saved to your Files');
        expect(s.uploads.takeSavedNote()).toBeNull();
        expect(s.kv.get(SAVED_TO_FILES_KEY)).toBe('1');
        const again = await s.reopen();
        expect(again.uploads.takeSavedNote()).toBeNull();
    });

    it('refuses to add on a read-only user.db', async () => {
        const s = await setup();
        const readOnly = await openFileUploads({
            db: s.file.db,
            state: { writable: false, reason: 'newer' } as never,
            layout: s.layout,
            files: nodeFiles(),
            setFileProtection: async () => {},
            fetch: s.media.fetch,
            newId: () => 'x',
        });
        expect(await readOnly.add(s.pick('a.png'), 'cover')).toEqual({ problem: 'read-only' });
        await readOnly.close();
    });
});
