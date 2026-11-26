import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AttachmentView, MediaItem, MediaListing } from '@socio/shared/media-types';

import type { AuthedFetch } from '../../src/net/authed-fetch';
import { NetworkError } from '../../src/net/errors';
import { SnapshotShapeError } from '../../src/sync/errors';
import {
    createMediaListings,
    findAttachmentItem,
    MEDIA_LISTINGS_KIND,
    mediaListing,
    mediaListingKey,
    mediaListingPath,
    parseMediaListingKey,
    readAttachment,
    readMediaItem,
    readMediaListing,
} from '../../src/sync/media-library';

import { syncSetup } from './helpers';

// The Media library's reads (src/sync/media-library.ts, CB-558): the paths the
// web's listMedia asks, a folder's first page kept on a real cache.db for
// offline, a search read online only, one item and one attachment, and which
// library item, if any, stands behind a chat attachment.

type Setup = Awaited<ReturnType<typeof syncSetup>>;
const open: Setup[] = [];
afterEach(async () => {
    for (const s of open.splice(0)) {
        await s.close().catch(() => {});
    }
});

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const item = (fields: Partial<MediaItem> = {}): MediaItem => ({
    id: 'f1',
    path: 'attachments/2026-11/notes.txt',
    name: 'notes.txt',
    folder: 'attachments/2026-11/',
    size: 12,
    mediaType: 'text/plain',
    kind: 'text',
    createdAt: 1,
    updatedAt: 2,
    createdByDotId: null,
    dotName: null,
    attachments: [
        {
            id: 'cbatt_1',
            threadId: 't1',
            threadTitle: 'Plans',
            dotId: 'd1',
            dotName: 'Sebas',
            source: 'web',
            boundAt: 3,
        },
    ],
    ...fields,
});

const listing = (fields: Partial<MediaListing> = {}): MediaListing =>
    ({
        folder: '',
        folders: ['attachments/'],
        tree: ['attachments/', 'attachments/2026-11/'],
        items: [item()],
        usage: { totalBytes: 12 },
        limits: { userMaxBytes: 1000 },
        ...fields,
    }) as MediaListing;

const attachment = (fields: Partial<AttachmentView> = {}): AttachmentView => ({
    id: 'cbatt_1',
    name: 'notes.txt',
    mediaType: 'text/plain',
    size: 12,
    kind: 'text',
    threadId: 't1',
    dotId: 'd1',
    path: 'attachments/2026-11/notes.txt',
    createdAt: 1,
    boundAt: 3,
    source: 'web',
    ...fields,
});

describe('the Media library’s paths', () => {
    it('asks /api/media as the web does: only the parts that are set', () => {
        expect(mediaListingPath({ folder: '' })).toBe('/api/media');
        expect(mediaListingPath({ folder: 'reports/q3/', q: ' plan ', kind: 'pdf', cursor: '100' })).toBe(
            '/api/media?folder=reports%2Fq3%2F&q=plan&kind=pdf&cursor=100',
        );
        expect(mediaListingPath({ folder: '', q: '   ', kind: '' })).toBe('/api/media');
    });

    it('keys a kept folder by its kind filter and its path', () => {
        expect(mediaListingKey('')).toBe('all/');
        expect(mediaListingKey('reports/q3/', 'image')).toBe('image/reports/q3/');
        expect(parseMediaListingKey('all/')).toEqual({ folder: '', kind: '' });
        expect(parseMediaListingKey('image/reports/q3/')).toEqual({ folder: 'reports/q3/', kind: 'image' });
        expect(parseMediaListingKey('video/x/')).toBeNull();
        expect(parseMediaListingKey('all/reports')).toBeNull();
        expect(parseMediaListingKey('nope')).toBeNull();
    });
});

describe('a folder’s first page', () => {
    async function setup() {
        const s = await syncSetup();
        open.push(s);
        const asked: string[] = [];
        let answer: (path: string) => Response = () => json(listing());
        const make = () =>
            createMediaListings({
                db: s.db,
                fetch: async (input) => {
                    asked.push(input);
                    return answer(input);
                },
                signal: s.scope.signal,
            });
        return Object.assign(s, {
            asked,
            make,
            answer: (next: (path: string) => Response) => {
                answer = next;
            },
        });
    }

    it('is read as its screen holds it, kept on disk, and shown offline by a new store with its age', async () => {
        const s = await setup();
        const listings = s.make();
        const root = mediaListing(listings, '');
        const release = root.use();
        await vi.waitFor(() => expect(root.state.value).toEqual(listing()));
        expect(s.asked).toEqual(['/api/media']);
        const pictures = mediaListing(listings, 'reports/', 'image');
        const releasePictures = pictures.use();
        await vi.waitFor(() => expect(pictures.state.settled).toBe(true));
        expect(s.asked).toEqual(['/api/media', '/api/media?folder=reports%2F&kind=image']);
        release();
        releasePictures();
        await listings.flush();
        const kept = await s.db.all<{ key: string }>('SELECT key FROM rows WHERE collection = ?', [
            MEDIA_LISTINGS_KIND,
        ]);
        expect(kept.map((row) => row.key).sort()).toEqual(['all/', 'image/reports/']);
        await listings.close();

        s.answer(() => {
            throw new NetworkError('offline');
        });
        const cold = s.make();
        const again = mediaListing(cold, '');
        const releaseAgain = again.use();
        await vi.waitFor(() => expect(again.state.settled).toBe(true));
        expect(again.state).toMatchObject({ failed: true, value: listing() });
        expect(again.state.fetchedAt).not.toBeNull();
        releaseAgain();
        await cold.close();
    });

    it('keeps nothing of an answer that isn’t a listing', async () => {
        const s = await setup();
        s.answer(() => json({ folder: '', folders: [], tree: [], items: [{ id: 1 }] }));
        const listings = s.make();
        const root = mediaListing(listings, '');
        const release = root.use();
        await vi.waitFor(() => expect(root.state.settled).toBe(true));
        expect(root.state).toMatchObject({ failed: true, value: null });
        release();
        await listings.close();
    });
});

describe('reads that are never kept', () => {
    it('reads a search online and throws on a refusal or another shape', async () => {
        const asked: string[] = [];
        const fetch: AuthedFetch = async (input) => {
            asked.push(input);
            return json(listing({ folders: [] }));
        };
        expect((await readMediaListing(fetch, { folder: 'a/', q: 'plan' })).items).toHaveLength(1);
        expect(asked).toEqual(['/api/media?folder=a%2F&q=plan']);
        await expect(
            readMediaListing(async () => json({ error: 'Invalid request.' }, 400), { folder: '' }),
        ).rejects.toMatchObject({ status: 400 });
        await expect(readMediaListing(async () => json({ items: [] }), { folder: '' })).rejects.toBeInstanceOf(
            SnapshotShapeError,
        );
    });

    it('reads one item and one attachment, each gone on a 404', async () => {
        const asked: string[] = [];
        const fetch: AuthedFetch = async (input) => {
            asked.push(input);
            return input.includes('/attachments/') ? json(attachment()) : json(item());
        };
        expect(await readMediaItem(fetch, 'f 1')).toEqual({ state: 'there', value: item() });
        expect(await readAttachment(fetch, 'cbatt_1')).toEqual({ state: 'there', value: attachment() });
        expect(asked).toEqual(['/api/media/items/f%201', '/api/media/attachments/cbatt_1']);
        const missing: AuthedFetch = async () => json({ error: 'Attachment not found.' }, 404);
        expect(await readMediaItem(missing, 'f1')).toEqual({ state: 'gone' });
        expect(await readAttachment(missing, 'cbatt_1')).toEqual({ state: 'gone' });
        await expect(readAttachment(async () => json({ id: 'x' }), 'cbatt_1')).rejects.toBeInstanceOf(
            SnapshotShapeError,
        );
        await expect(readMediaItem(async () => json({ error: 'boom' }, 500), 'f1')).rejects.toMatchObject({
            status: 500,
        });
    });
});

describe('the library item behind a chat attachment', () => {
    it('is the file at the attachment’s path that names it, asked from its folder', async () => {
        const asked: string[] = [];
        const fetch: AuthedFetch = async (input) => {
            asked.push(input);
            return json(listing({ folder: 'attachments/2026-11/', folders: [] }));
        };
        expect(await findAttachmentItem(fetch, attachment())).toEqual(item());
        expect(asked).toEqual(['/api/media?folder=attachments%2F2026-11%2F&q=notes.txt']);
    });

    it('is none for someone else’s file in a room, a deleted file, or a file of the reader’s at the same path', async () => {
        // Someone else's attachment: the reader's library lists nothing at its path.
        const empty: AuthedFetch = async () => json(listing({ items: [], folders: [] }));
        expect(await findAttachmentItem(empty, attachment())).toBeNull();
        // The reader has a file at that very path, attached elsewhere: never taken for this one.
        const other: AuthedFetch = async () =>
            json(listing({ items: [item({ attachments: [{ ...item().attachments[0]!, id: 'cbatt_other' }] })] }));
        expect(await findAttachmentItem(other, attachment())).toBeNull();
        // A deleted file has no path: nothing is asked.
        const never = vi.fn<AuthedFetch>();
        expect(await findAttachmentItem(never, attachment({ path: null }))).toBeNull();
        expect(never).not.toHaveBeenCalled();
    });
});
