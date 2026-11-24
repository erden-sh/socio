import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { attachmentInfoPath, fileChipView, loadAttachmentInfo } from '../../src/chat/attachment-info';
import type { MessageFile } from '../../src/chat/attachment-tray';
import type { AuthedFetch } from '../../src/net/authed-fetch';

// CB-413: a message's file chip, as the web's FileChip: its size from the
// attachment's record, "Removed" once the file is gone, and a tap that
// downloads it (the content URL with `?download=1`). A copy still on the
// phone asks nothing and opens nothing.

const SRC = join(import.meta.dirname, '../../src');
const read = (file: string) => readFileSync(join(SRC, file), 'utf8');

const answer = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const file = (fields: Partial<MessageFile> = {}): MessageFile => ({
    id: 'cbatt_1',
    name: 'report.pdf',
    mime: 'application/pdf',
    picture: false,
    local: null,
    tone: 'slate',
    extension: 'PDF',
    ...fields,
});

describe('loadAttachmentInfo', () => {
    it('asks the attachment’s record and takes its size', async () => {
        const fetch = vi.fn<AuthedFetch>(async () => answer(200, { id: 'cbatt_1', size: 12_800, path: 'a/b' }));
        expect(await loadAttachmentInfo(fetch, 'cbatt_1')).toEqual({ state: 'there', size: 12_800 });
        expect(fetch).toHaveBeenCalledWith('/api/media/attachments/cbatt_1', undefined);
        expect(attachmentInfoPath('a/b')).toBe('/api/media/attachments/a%2Fb');
    });

    it('says the file is gone on a 404 or a deleted file, and throws on any other failure', async () => {
        expect(await loadAttachmentInfo(async () => answer(404, { error: 'Not found' }), 'x')).toEqual({
            state: 'gone',
        });
        expect(await loadAttachmentInfo(async () => answer(200, { size: 3, path: null }), 'x')).toEqual({
            state: 'gone',
        });
        await expect(loadAttachmentInfo(async () => answer(500, { error: 'boom' }), 'x')).rejects.toMatchObject({
            status: 500,
        });
    });
});

describe('fileChipView', () => {
    it('downloads a stored file, its size beside its name once known (the web’s FileChip)', () => {
        expect(fileChipView(file(), null)).toEqual({
            note: 'PDF',
            removed: false,
            href: '/api/media/attachments/cbatt_1/content?download=1',
            accessibilityLabel: 'Download report.pdf',
        });
        expect(fileChipView(file(), { state: 'there', size: 12_800 })).toMatchObject({
            note: '13 KB',
            href: '/api/media/attachments/cbatt_1/content?download=1',
            accessibilityLabel: 'Download report.pdf, 13 KB',
        });
    });

    it('opens nothing for a removed file or a copy still on the phone', () => {
        expect(fileChipView(file(), { state: 'gone' })).toEqual({
            note: 'Removed',
            removed: true,
            href: null,
            accessibilityLabel: 'report.pdf, removed',
        });
        expect(fileChipView(file(), null, true).href).toBeNull();
        expect(fileChipView(file({ local: 'file:///x/report.pdf', extension: '' }), null)).toEqual({
            note: 'File',
            removed: false,
            href: null,
            accessibilityLabel: 'report.pdf',
        });
    });

    it('is a link the chip opens through useOpenLink, asked once per file (attachments.tsx)', () => {
        const source = read('screens/attachments.tsx');
        expect(source).toContain('fileChipView(file, info, removed)');
        expect(source).toContain('openLink(href)');
        expect(source).toContain("accessibilityRole={href === null ? 'text' : 'link'}");
        expect(source).toContain('loadAttachmentInfo(scope.fetch, id, scope.signal)');
    });
});

describe('links in text open the app’s screens; buttons for the browser don’t (CB-413)', () => {
    it('MarkdownBlock asks for the app, and useOpenLink tries the route table first', () => {
        expect(read('screens/chat-markdown.tsx')).toContain('openLink(href, { app: true })');
        const open = read('screens/open-link.ts');
        expect(open).toContain('how.app === true && how.web !== true ? appPathOf(target) : null');
        expect(open).toContain('openInApp(path)');
        expect(read('navigation/root-navigation.tsx')).toContain(
            'setInAppOpener((path) => externalLinks.openNow(path))',
        );
    });

    it('“Open in your browser” and “Manage on the web” still open the browser', () => {
        for (const file of ['screens/room-menu.tsx', 'screens/room-members.tsx', 'screens/chat-header.tsx']) {
            expect(read(file), file).not.toContain('app: true');
        }
    });
});
