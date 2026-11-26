import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AttachmentView, MediaItem, MediaListing } from '@socio/shared/media-types';

import { ROUTES } from '../../src/navigation/routes';
import { mediaFileAction, mediaFolderAction, MORE_ITEMS, moreItemAction } from '../../src/navigation/tabs';
import {
    attachedFrom,
    attachmentFileView,
    bytesLine,
    fileRow,
    fileSource,
    folderCrumbs,
    folderLabel,
    folderParam,
    folderRows,
    hintFileView,
    itemFileView,
    MEDIA_EMPTY,
    MEDIA_INTRO,
    MEDIA_KINDS,
    MEDIA_NOTHING_MATCHES,
    MEDIA_OFFLINE,
    mediaIntro,
    mediaLayout,
    mediaListState,
    mediaTime,
    parentFolder,
    previewKind,
    searchLabel,
    typeLabel,
    typeSymbol,
    usageView,
} from '../../src/shell/media';

// Media's view models (CB-558): the web's MediaPage, MediaGrid, MediaList and
// MediaPreview, under Node, and where the app opens them from.

const src = (path: string) => readFileSync(join(import.meta.dirname, '../../src', path), 'utf8');
const web = (path: string) =>
    readFileSync(join(import.meta.dirname, '../../../../packages/client/src/modules/media', path), 'utf8');

const T = Date.UTC(2026, 10, 9, 15, 30);
const names: Record<string, string> = { d1: 'Sebas' };
const socioName = (id: string) => names[id];

const item = (fields: Partial<MediaItem> = {}): MediaItem => ({
    id: 'f1',
    path: 'reports/q3/plan.pdf',
    name: 'plan.pdf',
    folder: 'reports/q3/',
    size: 3 * 1048576,
    mediaType: 'application/pdf',
    kind: 'pdf',
    createdAt: T,
    updatedAt: T,
    createdByDotId: null,
    dotName: null,
    attachments: [],
    ...fields,
});

const from = (fields: Partial<MediaItem['attachments'][number]> = {}): MediaItem['attachments'][number] => ({
    id: 'cbatt_1',
    threadId: 't1',
    threadTitle: 'Plans',
    dotId: 'd1',
    dotName: 'Sebas',
    source: 'web',
    boundAt: T,
    ...fields,
});

const listing = (fields: Partial<MediaListing> = {}): MediaListing =>
    ({
        folder: '',
        folders: [],
        tree: [],
        items: [],
        usage: { totalBytes: 512 * 1024 },
        limits: { userMaxBytes: 2 * 1048576 },
        ...fields,
    }) as MediaListing;

describe('Media’s folders', () => {
    it('names them as the web does, and says "socio" where the web does', () => {
        expect(folderLabel('', socioName)).toBe('All files');
        expect(folderLabel('attachments/', socioName)).toBe('Chat attachments');
        expect(folderLabel('dots/', socioName)).toBe('Socios');
        expect(folderLabel('dots/d1/', socioName)).toBe('Sebas');
        expect(folderLabel('dots/gone/', socioName)).toBe('A deleted socio');
        expect(folderLabel('reports/q3/', socioName)).toBe('q3');
        // The web's own words (media-api.ts), so the two never drift.
        const api = web('media-api.ts');
        for (const words of ['All files', 'Chat attachments', 'Socios', 'A deleted socio']) {
            expect(api).toContain(`'${words}'`);
        }
    });

    it('walks up and down a path', () => {
        expect(parentFolder('reports/q3/')).toBe('reports/');
        expect(parentFolder('reports/')).toBe('');
        expect(folderCrumbs('')).toEqual([]);
        expect(folderCrumbs('dots/d1/notes/')).toEqual(['dots/', 'dots/d1/', 'dots/d1/notes/']);
        expect(mediaIntro('', socioName)).toBe(MEDIA_INTRO);
        expect(mediaIntro('dots/d1/notes/', socioName)).toBe('All files › Socios › Sebas › notes');
    });

    it('takes a folder from a link as the server wants it', () => {
        expect(folderParam(undefined)).toBe('');
        expect(folderParam('')).toBe('');
        expect(folderParam('reports/q3')).toBe('reports/q3/');
        expect(folderParam('/reports/q3//')).toBe('reports/q3/');
        expect(folderParam(7)).toBe('');
    });

    it('rows carry a label and a testID Maestro can tap', () => {
        expect(folderRows(['attachments/', 'dots/d1/'], socioName)).toEqual([
            { path: 'attachments/', label: 'Chat attachments', testID: 'media-folder-attachments' },
            { path: 'dots/d1/', label: 'Sebas', testID: 'media-folder-dots-d1' },
        ]);
    });
});

describe('Media’s list', () => {
    it('keeps the web’s intro, kinds and search words', () => {
        expect(web('MediaPage.tsx')).toContain(MEDIA_INTRO);
        expect(MEDIA_KINDS.map((kind) => kind.label)).toEqual(['All', 'Images', 'Text', 'PDFs', 'Other']);
        for (const kind of MEDIA_KINDS) {
            expect(web('MediaPage.tsx')).toContain(`{ value: '${kind.value}', label: '${kind.label}' }`);
        }
        expect(searchLabel('')).toBe('Search files');
        expect(searchLabel('a/')).toBe('Search this folder');
        expect(mediaLayout(null)).toBe('grid');
        expect(mediaLayout('list')).toBe('list');
        expect(mediaLayout('table')).toBe('grid');
    });

    it('says how much of the person’s space is used, as the web’s bar does', () => {
        expect(usageView(listing())).toEqual({ share: 25, line: '512 KB of 2.0 MB used (25%)' });
        expect(usageView(listing({ limits: { userMaxBytes: 0 } } as Partial<MediaListing>)).share).toBe(100);
    });

    it('shapes a file’s row: type, size, when, where it came from and who saved it', () => {
        const row = fileRow(item(), 'UTC');
        expect(row).toMatchObject({
            id: 'f1',
            name: 'plan.pdf',
            size: '3.0 MB',
            line: 'PDF · 3.0 MB · Nov 9, 2026, 3:30 PM',
            note: null,
            picture: false,
            symbol: 'file-text',
            accessibilityLabel: 'Open plan.pdf, PDF, 3.0 MB',
            testID: 'media-file-plan-pdf',
        });
        const picture = fileRow(
            item({
                name: 'Photo 1.png',
                mediaType: 'image/png',
                kind: 'image',
                createdByDotId: 'd1',
                dotName: 'Sebas',
                attachments: [from()],
            }),
            'UTC',
        );
        expect(picture.picture).toBe(true);
        expect(picture.note).toBe('From Plans · Sebas · Saved by Sebas');
        // An SVG is an image the app never draws: its icon, not a picture.
        expect(fileRow(item({ mediaType: 'image/svg+xml', kind: 'file' })).picture).toBe(false);
    });

    it('says where a file was attached, as the web’s AttachedFrom', () => {
        expect(attachedFrom(item())).toBeNull();
        expect(attachedFrom(item({ attachments: [from()] }))).toEqual({ label: 'Plans · Sebas', threadId: 't1' });
        expect(attachedFrom(item({ attachments: [from({ source: 'telegram', threadTitle: null })] }))).toEqual({
            label: 'Telegram',
            threadId: null,
        });
        expect(attachedFrom(item({ attachments: [from({ threadId: null })] }))?.label).toBe('A chat not sent yet');
        expect(attachedFrom(item({ attachments: [from({ threadTitle: null })] }))?.label).toBe(
            'A deleted conversation',
        );
        expect(attachedFrom(item({ attachments: [from({ source: 'telegram', dotName: null })] }))?.label).toBe(
            'Plans (Telegram)',
        );
    });

    it('names types and picks icons as the web does', () => {
        expect(typeLabel('text/markdown')).toBe('Markdown');
        expect(typeLabel('image/svg+xml')).toBe('SVG');
        expect(typeLabel('image/png')).toBe('PNG');
        expect(typeLabel('text/x-python')).toBe('python');
        expect(typeLabel('application/zip')).toBe('application/zip');
        expect(typeLabel('application/octet-stream')).toBe('File');
        expect(typeSymbol({ kind: 'pdf', mediaType: 'application/pdf' })).toBe('file-text');
        expect(typeSymbol({ kind: 'text', mediaType: 'text/csv' })).toBe('table');
        expect(typeSymbol({ kind: 'file', mediaType: 'application/zip' })).toBe('archive');
        expect(typeSymbol({ kind: 'text', mediaType: 'application/json' })).toBe('file-code');
        // The web's order: an SVG's `xml` reads as code before `image/` is asked.
        expect(typeSymbol({ kind: 'file', mediaType: 'image/svg+xml' })).toBe('file-code');
        expect(typeSymbol({ kind: 'file', mediaType: 'image/tiff' })).toBe('image');
        expect(typeSymbol({ kind: 'text', mediaType: 'text/plain' })).toBe('file-text');
        expect(typeSymbol({ kind: 'file', mediaType: 'application/octet-stream' })).toBe('file');
        expect(mediaTime(T, 'UTC')).toBe('Nov 9, 2026, 3:30 PM');
    });

    it('shows rows, the web’s two empty lines, a wait, or why nothing shows', () => {
        const base = { settled: true, failed: false, searching: false, kind: '' as const, files: 0 };
        expect(mediaListState({ ...base, listing: null, settled: false })).toEqual({ state: 'loading' });
        expect(mediaListState({ ...base, listing: null, failed: true })).toEqual({
            state: 'failed',
            line: MEDIA_OFFLINE,
        });
        expect(mediaListState({ ...base, listing: listing() })).toEqual({ state: 'empty', line: MEDIA_EMPTY });
        expect(mediaListState({ ...base, listing: listing(), kind: 'pdf' })).toEqual({
            state: 'empty',
            line: MEDIA_NOTHING_MATCHES,
        });
        // A folder with only subfolders has rows; a search never lists folders.
        expect(mediaListState({ ...base, listing: listing({ folders: ['a/'] }) })).toEqual({ state: 'rows' });
        expect(mediaListState({ ...base, listing: listing({ folders: ['a/'] }), searching: true })).toEqual({
            state: 'empty',
            line: MEDIA_NOTHING_MATCHES,
        });
        expect(mediaListState({ ...base, listing: listing(), files: 2 })).toEqual({ state: 'rows' });
        // A copy kept from before still shows when the read fails.
        expect(mediaListState({ ...base, listing: listing(), files: 1, failed: true })).toEqual({ state: 'rows' });
        expect(web('MediaPage.tsx')).toContain(MEDIA_NOTHING_MATCHES);
    });
});

describe('a file’s page', () => {
    const attachment = (fields: Partial<AttachmentView> = {}): AttachmentView => ({
        id: 'cbatt_1',
        name: 'plan.pdf',
        mediaType: 'application/pdf',
        size: 2048,
        kind: 'file',
        threadId: 't1',
        dotId: 'd1',
        path: 'attachments/2026-11/plan.pdf',
        createdAt: T,
        boundAt: T,
        source: 'web',
        ...fields,
    });

    it('reads its source from the route’s params: one id, an item first', () => {
        expect(fileSource({ item: 'f1' })).toEqual({ kind: 'item', id: 'f1' });
        expect(fileSource({ attachment: 'cbatt_1', name: 'a.pdf' })).toEqual({ kind: 'attachment', id: 'cbatt_1' });
        expect(fileSource({ issueFile: 'i1' })).toEqual({ kind: 'issue', id: 'i1' });
        expect(fileSource({ name: 'a.pdf' })).toBeNull();
        expect(fileSource({ item: '' })).toBeNull();
    });

    it('previews by kind: a picture, text, a PDF, or a file another app opens', () => {
        expect(previewKind({ kind: 'image', mediaType: 'image/png' })).toBe('image');
        expect(previewKind({ kind: 'file', mediaType: 'image/svg+xml' })).toBe('other');
        expect(previewKind({ kind: 'text', mediaType: 'text/x-python' })).toBe('text');
        expect(previewKind({ kind: 'pdf', mediaType: 'application/pdf' })).toBe('pdf');
        expect(previewKind({ kind: 'file', mediaType: 'application/zip' })).toBe('other');
        // From a hint alone (a chip's media type): the same four.
        expect(previewKind({ mediaType: 'image/jpeg' })).toBe('image');
        expect(previewKind({ mediaType: 'text/markdown; charset=utf-8' })).toBe('text');
        expect(previewKind({ mediaType: 'application/pdf' })).toBe('pdf');
        expect(previewKind({ mediaType: '' })).toBe('other');
    });

    it('shows a library item as the web’s preview does, and where it is in Media', () => {
        const view = itemFileView(
            item({ attachments: [from()], createdByDotId: 'd1', dotName: 'Sebas' }),
            socioName,
            'UTC',
        );
        expect(view).toMatchObject({
            name: 'plan.pdf',
            preview: 'pdf',
            url: '/api/media/items/f1/content',
            cacheKey: `item-f1-${T}`,
        });
        expect(view.details.map((detail) => [detail.label, detail.value])).toEqual([
            ['Type', 'PDF (application/pdf)'],
            ['Size', '3.0 MB'],
            ['From', 'Plans · Sebas'],
            ['Saved by', 'Sebas'],
            ['Updated', 'Nov 9, 2026, 3:30 PM'],
            ['In Media', 'q3'],
        ]);
        expect(view.details.find((detail) => detail.label === 'From')?.threadId).toBe('t1');
        expect(view.details.find((detail) => detail.label === 'In Media')?.folder).toBe('reports/q3/');
        // The web's rows, by its own labels.
        for (const label of ['Type', 'Size', 'From', 'Saved by', 'Updated']) {
            expect(web('MediaPreview.tsx')).toContain(`>${label}</dt>`);
        }
    });

    it('keeps an attachment’s own bytes when the library has its item', () => {
        const view = itemFileView(item(), socioName, 'UTC', 'cbatt_1');
        expect(view.url).toBe('/api/media/attachments/cbatt_1/content');
        expect(view.cacheKey).toBe('att-cbatt_1');
        // The same key the page began to download under, from the chip's hint.
        expect(hintFileView({ kind: 'attachment', id: 'cbatt_1' }, { name: 'plan.pdf' }).cacheKey).toBe('att-cbatt_1');
    });

    it('shows an attachment that isn’t in the library by its own record', () => {
        const view = attachmentFileView(attachment(), (id) => (id === 't1' ? 'Team room' : null), 'UTC');
        expect(view).toMatchObject({
            name: 'plan.pdf',
            preview: 'pdf',
            symbol: 'file-text',
            url: '/api/media/attachments/cbatt_1/content',
            cacheKey: 'att-cbatt_1',
        });
        expect(view.details.map((detail) => [detail.label, detail.value])).toEqual([
            ['Type', 'PDF (application/pdf)'],
            ['Size', '2 KB'],
            ['From', 'Team room'],
            ['Attached', 'Nov 9, 2026, 3:30 PM'],
        ]);
        // A chat the phone doesn't hold names no chat.
        expect(attachmentFileView(attachment(), () => null, 'UTC').details.map((detail) => detail.label)).toEqual([
            'Type',
            'Size',
            'Attached',
        ]);
        expect(attachmentFileView(attachment({ kind: 'image', mediaType: 'image/png' }), () => null).preview).toBe(
            'image',
        );
    });

    it('draws from the caller’s hint before any answer, and that is all an issue’s file has', () => {
        const issue = hintFileView({ kind: 'issue', id: 'i 1' }, { name: 'log.txt', mediaType: 'text/plain' });
        expect(issue).toMatchObject({
            name: 'log.txt',
            preview: 'text',
            size: -1,
            url: '/api/issue-attachments/i%201',
            cacheKey: 'issue-i 1',
        });
        expect(issue.details.map((detail) => detail.label)).toEqual(['Type']);
        const listed = hintFileView(
            { kind: 'item', id: 'f1' },
            { name: 'a.png', mediaType: 'image/png', size: 5, updatedAt: T },
        );
        expect(listed.cacheKey).toBe(itemFileView(item({ updatedAt: T }), socioName).cacheKey);
        expect(hintFileView({ kind: 'item', id: 'f1' }, {}).name).toBe('File');
    });

    it('says what the bytes are doing while there is no copy', () => {
        expect(bytesLine({ state: 'ready', uri: 'file:///x' })).toBeNull();
        expect(bytesLine({ state: 'loading' })).toBe('Downloading…');
        expect(bytesLine({ state: 'gone' })).toBe('This file was removed.');
        expect(bytesLine({ state: 'too-large' })).toBe('This file is too large to open here.');
        expect(bytesLine({ state: 'failed' })).toBe('This file shows once you’re online.');
    });
});

describe('where Media opens', () => {
    it('is a More row that opens its own page at the web’s path, the file page with no path', () => {
        expect(MORE_ITEMS).toContain('media');
        expect(moreItemAction('media', 'Media')).toEqual({ type: 'NAVIGATE', payload: { name: 'Media' } });
        expect(ROUTES.Media).toMatchObject({ linking: 'media', tab: 'More' });
        expect(ROUTES.MediaFile).toMatchObject({ tab: 'More' });
        expect('linking' in ROUTES.MediaFile).toBe(false);
    });

    it('pushes a folder over its parent and a file over whatever opened it, so Back returns', () => {
        expect(mediaFolderAction('reports/')).toEqual({
            type: 'PUSH',
            payload: { name: 'Media', params: { folder: 'reports/' } },
        });
        expect(mediaFileAction({ attachment: 'cbatt_1', name: 'plan.pdf' })).toEqual({
            type: 'PUSH',
            payload: { name: 'MediaFile', params: { attachment: 'cbatt_1', name: 'plan.pdf' } },
        });
    });

    it('never opens a browser from the list or the file page, and builds no stubs for the web’s other actions', () => {
        for (const file of ['screens/media.tsx', 'screens/media-file.tsx', 'platform/media-files.ts']) {
            const source = src(file);
            expect(source).not.toContain('expo-web-browser');
            expect(source).not.toContain('useOpenLink');
            expect(source).not.toContain('Linking');
        }
        // Every request goes through the scope's authedFetch.
        expect(src('screens/media.tsx')).toContain('readMediaListing(scope.fetch,');
        expect(src('screens/media-file.tsx')).toContain('readAttachment(scope.fetch, source.id, signal)');
        expect(src('platform/media-files.ts')).toContain('fetch: scope.fetch,');
        for (const word of ['Upload', 'New folder', 'Delete', 'Rename', 'Move']) {
            expect(src('screens/media.tsx')).not.toContain(`'${word}`);
            expect(src('screens/media-file.tsx')).not.toContain(`'${word}`);
        }
    });

    it('shares and saves the downloaded copy through the system, and previews it natively', () => {
        const files = src('platform/media-files.ts');
        expect(files).toContain('Sharing.shareAsync(uri,');
        expect(files).toContain('previewFile(uri, mimeType, name, contentUri)');
        expect(files).toContain('saveFile(uri, mimeType, name)');
        const page = src('screens/media-file.tsx');
        for (const id of ['media-file-open', 'media-file-share', 'media-file-save', 'media-file-details']) {
            expect(page).toContain(`testID="${id}"`);
        }
    });
});
