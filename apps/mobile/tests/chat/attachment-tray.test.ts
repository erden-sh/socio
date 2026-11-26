import type { Message } from '@ag-ui/core';
import { describe, expect, it } from 'vitest';

import { attachmentPart } from '@socio/shared/media/refs';
import { NO_LIVE_TURN } from '@socio/shared/rooms/live-turn';

import {
    addProblemsLine,
    carriedFiles,
    extensionLabel,
    fileUrl,
    messageFiles,
    mimeOf,
    PASTE_FAILED,
    pasteImages,
    type PasteTarget,
    pickedDocuments,
    pickedImages,
    trayItems,
    failedTileAction,
    viewerImages,
} from '../../src/chat/attachment-tray';
import { transcriptRows } from '../../src/chat/transcript';
import type { AddProblem, Attachment, PickedFile } from '../../src/sync/attachments';

// Attachments in the composer and the transcript (src/chat/attachment-tray.ts):
// the tray's tiles and their states, the pickers' answers as picked
// files (each the picker's temporary copy), the line for files the tray
// didn't take, and a message's files, from the server's ids or the phone's copies.

const LIMITS = { fileMaxBytes: 25 * 1024 * 1024, perMessage: 10 };

const file = (fields: Partial<Attachment>): Attachment => ({
    id: 'f-1',
    name: 'photo.jpg',
    mime: 'image/jpeg',
    bytes: 2048,
    kind: 'image',
    state: 'ready',
    error: null,
    serverId: null,
    uploadedAt: null,
    draftScope: 'chat:c1',
    outboxId: null,
    lane: 'chat:c1',
    path: '/data/socio/w/attachments/f-1.jpg',
    createdAt: 1,
    ...fields,
});

const att = (n: number) => `cbatt_${String(n).padStart(22, 'A')}`;

describe('the tray', () => {
    it('shows a picture’s copy, a file’s tone and extension, and each one’s state', () => {
        const items = trayItems([
            file({ state: 'uploading' }),
            file({ id: 'f-2', name: 'notes.txt', mime: 'text/plain', kind: 'text', path: '/x/f-2.txt' }),
            file({
                id: 'f-3',
                name: 'big.pdf',
                mime: 'application/pdf',
                kind: 'file',
                state: 'failed',
                error: 'too-large',
            }),
            file({ id: 'f-4', name: 'gone.png', mime: 'image/png', state: 'failed', error: 'missing' }),
            file({ id: 'f-5', name: 'a.heic', mime: 'image/heic' }),
        ]);
        expect(items[0]).toMatchObject({
            picture: 'file:///data/socio/w/attachments/f-1.jpg',
            uploading: true,
            failed: false,
            tone: 'sky',
            label: 'photo.jpg, 2 KB, uploading',
        });
        expect(items[1]).toMatchObject({ picture: null, extension: 'TXT', tone: 'amber', uploading: false });
        expect(items[2]).toMatchObject({
            failed: true,
            retry: true,
            problem: 'Too large to attach',
            tone: 'indigo',
            label: 'big.pdf, 2 KB, Too large to attach',
        });
        // A copy that is gone can't be uploaded again: Remove only.
        expect(items[3]).toMatchObject({ failed: true, retry: false, problem: 'The file is gone from this phone' });
        // Its cover removes it (it once did nothing); a copy still there retries; a good tile has none.
        expect(failedTileAction(items[3]!)).toEqual({
            action: 'remove',
            label: 'Remove',
            accessibilityLabel: `Remove ${items[3]!.name}. The file is gone from this phone`,
        });
        expect(failedTileAction(items[2]!)).toMatchObject({ action: 'retry', label: 'Retry' });
        expect(failedTileAction(items[1]!)).toBeNull();
        // Only the model's types show as pictures.
        expect(items[4]?.picture).toBeNull();
    });

    it('words the files it didn’t take, naming the first', () => {
        expect(addProblemsLine([], LIMITS)).toBeNull();
        expect(addProblemsLine([{ name: 'movie.mov', reason: 'too-large' }], LIMITS)).toBe(
            'movie.mov is over 25.0 MB, too large to attach.',
        );
        expect(
            addProblemsLine(
                [
                    { name: 'a', reason: 'too-many' },
                    { name: 'b', reason: 'too-many' },
                ],
                LIMITS,
            ),
        ).toBe('A message takes at most 10 files.');
        expect(
            addProblemsLine(
                [
                    { name: 'empty.txt', reason: 'empty' },
                    { name: 'b', reason: 'empty' },
                ],
                LIMITS,
            ),
        ).toBe('empty.txt (and 1 more) is empty.');
        expect(addProblemsLine([{ name: 'x', reason: 'read-only' }], LIMITS)).toBe('Update Socio to attach files.');
        expect(addProblemsLine([{ name: 'x', reason: 'copy-failed' }], LIMITS)).toBe(
            'x couldn’t be attached. Try again.',
        );
    });
});

describe('the pickers’ answers', () => {
    const sizeOf = async () => 4321;

    it('names a camera shot by the time, measures what the picker didn’t, and marks each as the picker’s copy', async () => {
        const now = new Date(2026, 10, 8, 14, 32, 5);
        const files = await pickedImages(
            [
                { uri: 'file:///cache/ImagePicker/1A2B.jpeg', fileName: null, mimeType: 'image/jpeg', fileSize: null },
                { uri: 'file:///cache/ImagePicker/x.HEIC', fileName: 'IMG_7.HEIC', mimeType: null, fileSize: 99 },
                { uri: 'file:///cache/ImagePicker/23.jpg', fileName: '23.jpg', mimeType: 'image/jpeg', fileSize: 5 },
            ],
            sizeOf,
            now,
        );
        expect(files).toEqual([
            {
                uri: 'file:///cache/ImagePicker/1A2B.jpeg',
                name: 'photo-20261108-143205.jpeg',
                mime: 'image/jpeg',
                bytes: 4321,
                temporary: true,
            },
            {
                uri: 'file:///cache/ImagePicker/x.HEIC',
                name: 'IMG_7.HEIC',
                mime: 'image/heic',
                bytes: 99,
                temporary: true,
            },
            // A media id for a name: a dated one, a second on.
            {
                uri: 'file:///cache/ImagePicker/23.jpg',
                name: 'photo-20261108-143207.jpg',
                mime: 'image/jpeg',
                bytes: 5,
                temporary: true,
            },
        ]);
    });

    it('keeps a document’s name and type, from its extension when the picker doesn’t say', async () => {
        const files = await pickedDocuments(
            [
                {
                    uri: 'file:///cache/DocumentPicker/u/Report%201.pdf',
                    name: 'Report 1.pdf',
                    mimeType: 'application/pdf',
                    size: 10,
                },
                { uri: 'file:///cache/DocumentPicker/u/notes.md', name: 'notes.md', mimeType: null, size: 0 },
            ],
            sizeOf,
        );
        expect(files.map(({ name, mime, bytes, temporary }) => ({ name, mime, bytes, temporary }))).toEqual([
            { name: 'Report 1.pdf', mime: 'application/pdf', bytes: 10, temporary: true },
            { name: 'notes.md', mime: 'text/markdown', bytes: 4321, temporary: true },
        ]);
        expect(mimeOf('weird.xyz')).toBe('application/octet-stream');
        expect(mimeOf('x.bin', 'not a type')).toBe('application/octet-stream');
        expect(extensionLabel('a.final.Pdf')).toBe('PDF');
        expect(fileUrl('/a b/c.jpg')).toBe('file:///a%20b/c.jpg');
        expect(fileUrl('file:///a.jpg')).toBe('file:///a.jpg');
    });
});

describe('pasted images', () => {
    const now = new Date(2026, 10, 9, 9, 5, 0);
    const ios = 'file:///tmp/C39A352F-0000-4000-8000-000000000001.png';
    const android = 'file:///data/user/0/app/cache/1794196239780_0.jpg';

    /** A tray holding `count` files that takes what it's given unless `answer` says otherwise. */
    function target(count: number, answer?: (files: readonly PickedFile[]) => readonly AddProblem[] | Error) {
        const added: PickedFile[][] = [];
        const removed: string[] = [];
        const errors: unknown[] = [];
        const tray: PasteTarget = {
            limits: async () => LIMITS,
            count: () => count,
            add: async (files) => {
                added.push([...files]);
                const result = answer?.(files) ?? [];
                if (result instanceof Error) {
                    throw result;
                }
                return { problems: result };
            },
            sizeOf: async (uri) => (uri.endsWith('.png') ? 116658 : 18916),
            remove: async (uri) => {
                removed.push(uri);
            },
            onError: (error) => errors.push(error),
        };
        return { tray, added, removed, errors };
    }

    it('names, types and measures each from its URI, as a picked photo, then deletes the pasted files', async () => {
        const { tray, added, removed } = target(0);
        expect(await pasteImages([ios, android], tray, now)).toBeNull();
        expect(added).toEqual([
            [
                { uri: ios, name: 'pasted-20261109-090500.png', mime: 'image/png', bytes: 116658, temporary: true },
                { uri: android, name: 'pasted-20261109-090501.jpg', mime: 'image/jpeg', bytes: 18916, temporary: true },
            ],
        ]);
        expect(removed).toEqual([ios, android]);
    });

    it('takes no more than the tray has room for, says so, and deletes the rest too', async () => {
        const { tray, added, removed } = target(9);
        expect(await pasteImages([ios, android], tray, now)).toBe('A message takes at most 10 files.');
        expect(added.map((files) => files.map((file) => file.uri))).toEqual([[ios]]);
        expect(removed).toEqual([ios, android]);

        const full = target(10);
        expect(await pasteImages([ios], full.tray, now)).toBe('A message takes at most 10 files.');
        expect(full.added).toEqual([]);
        expect(full.removed).toEqual([ios]);
    });

    it('words what the tray refused, and deletes a file whose copy failed (a paste has no retry)', async () => {
        const { tray, removed } = target(0, (files) => [{ name: files[0]!.name, reason: 'copy-failed' }]);
        expect(await pasteImages([ios], tray, now)).toBe('pasted-20261109-090500.png couldn’t be attached. Try again.');
        expect(removed).toEqual([ios]);
    });

    it('says it didn’t paste when adding throws, and still deletes every pasted file', async () => {
        const { tray, removed, errors } = target(0, () => new Error('store closed'));
        expect(await pasteImages([ios, android], tray, now)).toBe(PASTE_FAILED);
        expect(errors).toHaveLength(1);
        expect(removed).toEqual([ios, android]);
    });
});

describe('a message’s files', () => {
    const content = [
        { type: 'text', text: 'Look' },
        { type: 'binary', id: att(1), mimeType: 'image/png', filename: 'shot.png' },
        { type: 'binary', id: att(2), mimeType: 'application/pdf', filename: 'spec.pdf' },
        // Inline bytes and local ids aren't references.
        { type: 'binary', id: 'local', mimeType: 'image/png' },
        { type: 'binary', id: att(3), mimeType: 'image/png', data: 'AAAA' },
    ];

    it('reads the references by the server’s id: pictures to view, the rest as chips', () => {
        const files = messageFiles({ content } as unknown as Message);
        expect(files).toMatchObject([
            { id: att(1), name: 'shot.png', picture: true, local: null, tone: 'sky' },
            { id: att(2), name: 'spec.pdf', picture: false, extension: 'PDF', tone: 'indigo' },
        ]);
        expect(viewerImages(files)).toEqual([{ id: att(1), name: 'shot.png', local: null }]);
        expect(messageFiles({ content: 'text' } as Message)).toEqual([]);
        // The AG-UI 1.0 media parts the server and the apps write now read the same.
        const written = [
            { type: 'text', text: 'Look' },
            attachmentPart({ id: att(1), mimeType: 'image/png', filename: 'shot.png' }),
            attachmentPart({ id: att(2), mimeType: 'application/pdf', filename: 'spec.pdf' }),
            // Bytes inline, or a file another provider issued: not references.
            { type: 'image', source: { type: 'data', value: 'AAAA', mimeType: 'image/png' } },
            { type: 'image', source: { type: 'file', value: att(3), provider: 'openai', mimeType: 'image/png' } },
        ];
        expect(messageFiles({ content: written } as unknown as Message)).toEqual(files);
    });

    it('draws a message with files and no text, and a pending one from its copies', () => {
        const rows = transcriptRows(
            [
                {
                    seq: 1,
                    prev: null,
                    runId: 'run-1',
                    status: 'finished',
                    startedAt: 1000,
                    finishedAt: 1500,
                    messages: [{ id: 'u1', role: 'user', content: content.slice(1, 2) } as unknown as Message],
                    times: { messages: [], tools: [], reasoning: [] },
                    light: {},
                    size: 100,
                } as never,
            ],
            NO_LIVE_TURN,
        );
        expect(rows).toMatchObject([{ kind: 'user', id: 'u1', text: '', files: [{ id: att(1) }] }]);
        expect(carriedFiles([file({})])).toEqual([
            {
                id: 'f-1',
                name: 'photo.jpg',
                mime: 'image/jpeg',
                picture: true,
                local: 'file:///data/socio/w/attachments/f-1.jpg',
                tone: 'sky',
                extension: 'JPG',
            },
        ]);
    });
});
