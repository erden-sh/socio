import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { copyFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { pageImageMarkdown } from '@socio/shared/page-image';

import { openUserDb, workspaceLayout, type WorkspaceLayout } from '../../src/data';
import { toWeb } from '../../src/editor/bridge';
import {
    addPastedImage,
    cleanDataUri,
    dataUriBytes,
    PASTE_CANT_EDIT,
    PASTE_FAILED,
    PASTE_NEEDS_CONNECTION,
    type PasteImageOptions,
    pastedName,
    spaceImagesPath,
} from '../../src/editor/paste-image';
import type { AuthedFetch } from '../../src/net/authed-fetch';
import { NetworkError } from '../../src/net/errors';
import type { AttachmentFiles, PickedFile } from '../../src/sync/attachments';
import { FILE_UPLOAD_COPY, openFileUploads } from '../../src/sync/upload-file';
import { createNodeFileSystem } from '../helpers/node-fs';
import { createNodeSqliteDriver } from '../helpers/node-sqlite-driver';
import { USER_KEY } from '../sync/outbox-fakes';

// Pasting a picture into a page (src/editor/paste-image.ts; CB-358) on the
// real uploads to Files (user.db and a directory) against a fake server: the
// picture to the person's Files, the Space's image of it, the block's id and
// size; offline, refusals and a lost answer in words; the phone's copy gone
// either way.

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

const EMBED = 'cbemb_0123456789abcdef';
/** A 1×1 PNG. */
const PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

type Answer = number | 'offline';

/** `/api/media/uploads` and `/api/spaces/:id/images`, with what each was asked. */
function fakeServer() {
    const requests: { method: string; path: string; json?: unknown; bytes?: number }[] = [];
    const uploads: Answer[] = [];
    const images: Answer[] = [];
    /** While set, the next upload waits for it before it answers (and `onHold` says it waits). */
    const gate = { hold: null as Promise<void> | null, onHold: null as (() => void) | null };
    const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const fetch: AuthedFetch = async (input, init = {}) => {
        const url = new URL(input, 'https://acme.example.test');
        const method = init.upload ? 'POST' : (init.method ?? 'GET');
        requests.push({
            method,
            path: url.pathname,
            ...(init.json === undefined ? {} : { json: init.json }),
            ...(init.upload ? { bytes: (init.upload.body as Uint8Array).byteLength } : {}),
        });
        if (url.pathname === '/api/media/uploads') {
            const hold = gate.hold;
            if (hold !== null) {
                gate.hold = null;
                gate.onHold?.();
                await hold;
            }
            const next = uploads.shift() ?? 201;
            if (next === 'offline') {
                throw new NetworkError('offline');
            }
            return next === 201
                ? json(201, { item: { id: 'file-1', name: init.upload!.name } })
                : json(next, { error: 'no' });
        }
        if (url.pathname === '/api/media') {
            return json(200, { folder: '', items: [] });
        }
        if (url.pathname === spaceImagesPath('s1')) {
            const next = images.shift() ?? 201;
            if (next === 'offline') {
                throw new NetworkError('offline');
            }
            return next === 201
                ? json(201, { embedId: EMBED, url: `/api/media/embeds/${EMBED}/content` })
                : json(next, { error: 'no' });
        }
        return json(404, {});
    };
    return { fetch, requests, uploads, images, gate };
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

async function setup(options: { online?: () => boolean } = {}) {
    const directory = temp('socio-paste-');
    const pasted = temp('socio-pasted-');
    const layout: WorkspaceLayout = {
        ...workspaceLayout('/unused', 'ab'.repeat(32)),
        directory,
        attachments: join(directory, 'attachments'),
    };
    const file = await openUserDb(createNodeSqliteDriver({ keys: new Map() }), directory, USER_KEY);
    const server = fakeServer();
    let ids = 0;
    const uploads = await openFileUploads({
        db: file.db,
        state: file.state,
        layout,
        files: nodeFiles(),
        setFileProtection: async () => {},
        fetch: server.fetch,
        newId: () => `p${(ids += 1)}`,
    });
    cleanups.push(async () => {
        await uploads.close();
        await file.db.close();
    });
    const measured: string[] = [];
    const paste: PasteImageOptions = {
        spaceId: 's1',
        connected: options.online ?? (() => true),
        uploads,
        fetch: server.fetch,
        writeTemporary: async (image, name): Promise<PickedFile> => {
            const uri = join(pasted, name);
            mkdirSync(pasted, { recursive: true });
            const bytes = Buffer.from(image.dataUri.slice(image.dataUri.indexOf(',') + 1), 'base64');
            writeFileSync(uri, bytes);
            return { uri, name, mime: image.mimeType, bytes: bytes.byteLength, temporary: true };
        },
        measure: async (path) => {
            measured.push(path);
            return { width: 1600, height: 1200 };
        },
        now: () => new Date(2026, 10, 15, 14, 32, 5),
    };
    const rows = () => file.db.all<{ id: string }>('SELECT id FROM files');
    const left = () => ({
        pasted: readdirSync(pasted),
        copies: (() => {
            try {
                return readdirSync(layout.attachments);
            } catch {
                return [];
            }
        })(),
    });
    return { uploads, server, paste, rows, left, measured };
}

describe('pasting a picture into a page', () => {
    it('uploads it to Files, makes it an image of the Space and gives the block, leaving nothing behind', async () => {
        const s = await setup();
        const result = await addPastedImage(s.paste, { mimeType: 'image/png', dataUri: PNG });
        expect(result).toEqual({ kind: 'added', image: { id: EMBED, width: 1600, height: 1200 } });
        expect(s.server.requests).toEqual([
            { method: 'POST', path: '/api/media/uploads', bytes: dataUriBytes(PNG) },
            { method: 'POST', path: '/api/spaces/s1/images', json: { fileId: 'file-1' } },
        ]);
        // Measured on the uploaded copy, before it goes.
        expect(s.measured).toEqual([expect.stringMatching(/attachments\/image-p1\.png$/)]);
        expect(await s.rows()).toEqual([]);
        expect(s.left()).toEqual({ pasted: [], copies: [] });
        if (result.kind === 'added') {
            expect(pageImageMarkdown(result.image)).toContain(`"id": "${EMBED}"`);
        }
    });

    it('asks nothing offline', async () => {
        const s = await setup({ online: () => false });
        expect(await addPastedImage(s.paste, { mimeType: 'image/png', dataUri: PNG })).toEqual({
            kind: 'refused',
            text: PASTE_NEEDS_CONNECTION,
        });
        expect(s.server.requests).toEqual([]);
        expect(await s.rows()).toEqual([]);
    });

    it("refuses a type the Files upload's profile won't take before anything is written", async () => {
        const s = await setup();
        const gif = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
        expect(await addPastedImage(s.paste, { mimeType: 'image/gif', dataUri: gif })).toEqual({
            kind: 'refused',
            text: FILE_UPLOAD_COPY.type,
        });
        expect(s.server.requests).toEqual([]);
        expect(s.left().pasted).toEqual([]);
    });

    it("says the upload's and the image's refusals in their words", async () => {
        const s = await setup();
        s.server.uploads.push(413);
        expect(await addPastedImage(s.paste, { mimeType: 'image/png', dataUri: PNG })).toEqual({
            kind: 'refused',
            text: FILE_UPLOAD_COPY['too-large'],
        });
        s.server.images.push(403);
        expect(await addPastedImage(s.paste, { mimeType: 'image/png', dataUri: PNG })).toEqual({
            kind: 'refused',
            text: PASTE_CANT_EDIT,
        });
        s.server.images.push(500);
        expect(await addPastedImage(s.paste, { mimeType: 'image/png', dataUri: PNG })).toEqual({
            kind: 'refused',
            text: PASTE_FAILED,
        });
        expect(await s.rows()).toEqual([]);
        expect(s.left().copies).toEqual([]);
    });

    // The first try is `add`'s own, and `prepare` joins a try in flight
    // rather than starting one. Under load the instant fake answer sometimes
    // came after the paste began to wait (as a real network's always does), so
    // only one more try went. Both orders are made here by events, not time:
    // the first answer comes after the paste waits on the upload, or before
    // `add` returns.
    it.each([
        { first: 'answered after the paste waits', hold: true },
        { first: 'answered before add returns', hold: false },
    ])('tries again, listing first, when the upload had no answer, then gives up ($first)', async ({ hold }) => {
        const s = await setup();
        s.server.uploads.push('offline', 'offline', 'offline');
        let firstTryOver = Promise.resolve();
        if (hold) {
            let answer = () => {};
            s.server.gate.hold = new Promise<void>((resolve) => {
                answer = resolve;
            });
            const sent = new Promise<void>((resolve) => {
                s.server.gate.onHold = resolve;
            });
            // The first answer waits until the paste waits on the upload (either call), its try sent.
            const real = s.paste.uploads;
            let waiting = false;
            const answerOnce = (id: string) => {
                if (!waiting) {
                    waiting = true;
                    void sent.then(answer);
                }
                return id;
            };
            s.paste = {
                ...s.paste,
                uploads: {
                    ...real,
                    settled: (id) => real.settled(answerOnce(id)),
                    prepare: (id) => real.prepare(answerOnce(id)),
                },
            };
        } else {
            // `add`'s try has settled before the paste waits on it.
            const real = s.paste.uploads;
            s.paste = {
                ...s.paste,
                uploads: {
                    ...real,
                    add: async (...args) => {
                        const added = await real.add(...args);
                        if ('upload' in added) {
                            firstTryOver = real.settled(added.upload.id);
                            await firstTryOver;
                        }
                        return added;
                    },
                },
            };
        }
        expect(await addPastedImage(s.paste, { mimeType: 'image/png', dataUri: PNG })).toEqual({
            kind: 'refused',
            text: PASTE_FAILED,
        });
        await firstTryOver;
        const asked = s.server.requests.map((r) => `${r.method} ${r.path}`);
        // Each try after one with no answer lists by the upload's unique name first: no duplicate in Files.
        expect(asked).toEqual([
            'POST /api/media/uploads',
            'GET /api/media',
            'POST /api/media/uploads',
            'GET /api/media',
            'POST /api/media/uploads',
        ]);
        expect(await s.rows()).toEqual([]);
        s.server.uploads.push('offline');
        expect((await addPastedImage(s.paste, { mimeType: 'image/png', dataUri: PNG })).kind).toBe('added');
        expect(await s.rows()).toEqual([]);
    });

    it('names the pasted file by its type and time', () => {
        const at = new Date(2026, 10, 15, 14, 32, 5);
        expect(pastedName('image/png', at)).toBe('pasted-20261115-143205.png');
        expect(pastedName('image/jpeg', at)).toBe('pasted-20261115-143205.jpg');
        expect(dataUriBytes('data:image/png;base64,AAAA')).toBe(3);
        expect(dataUriBytes('data:image/png;base64,AA==')).toBe(1);
    });

    it("takes Android's clipboard image, base64 in lines, as the bridge takes it", () => {
        const lines = 'data:image/png;base64,iVBORw0K\nGgoAAAAN\r\nSUhEUg==\n';
        const clean = cleanDataUri(lines);
        expect(clean).toBe('data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==');
        expect(() => toWeb({ type: 'socio-images', payload: { cbemb_0123456789abcdef: lines } })).toThrow();
        expect(toWeb({ type: 'socio-images', payload: { cbemb_0123456789abcdef: clean } }).type).toBe('socio-images');
    });
});
