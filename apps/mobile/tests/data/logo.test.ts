import { mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BRAND_LOGO_MAX_BYTES } from '@socio/shared/branding';

import {
    commitLogo,
    discardStagedLogos,
    type LogoFiles,
    logoSource,
    stageLogo,
    stagingDirectory,
} from '../../src/data';
import { AbortedError, createPublicFetch } from '../../src/net';
import { createNodeFileSystem } from '../helpers/node-fs';
import { fakeFetch } from '../net/helpers';

// A workspace's logo while it is being added: the default and anything the app
// can't take show the mascot; a data URL or a same-origin image is staged as a
// file, moved into the workspace's directory on commit, and deleted on cancel.

const ORIGIN = 'https://brain.example.test';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 8, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1]);
const dataUrl = (type: string, bytes: Uint8Array) => `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;

let root: string;
let files: LogoFiles;
let names: number;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'socio-logo-'));
    const fs = createNodeFileSystem();
    files = {
        mkdir: fs.mkdir,
        remove: fs.remove,
        write: (path, bytes) => writeFile(path, bytes),
        move: (from, to) => rename(from, to),
    };
    names = 0;
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

const options = (fetch = fakeFetch(), signal?: AbortSignal) => ({
    root,
    files,
    publicFetch: createPublicFetch({ fetch, userAgent: 'Socio/0.0.0 (test)' }),
    randomName: () => `n${(names += 1)}`,
    signal,
});

const staged = async () => {
    try {
        return await readdir(stagingDirectory(root));
    } catch {
        return null;
    }
};

const image = (bytes: Uint8Array, type: string, headers: Record<string, string> = {}) =>
    new Response(new Blob([new Uint8Array(bytes)]), { status: 200, headers: { 'content-type': type, ...headers } });

describe('logoSource', () => {
    it('shows the mascot for the default, no logo and anything not same-origin', () => {
        for (const logo of [
            null,
            '/favicon.svg',
            'https://evil.example/logo.png',
            '//evil.example/logo.png',
            '/\\evil.example/logo.png',
            'logo.png',
            'data:image/svg+xml;base64,PHN2Zz4=',
            'data:image/png,raw',
            'javascript:alert(1)',
        ]) {
            expect(logoSource(logo, ORIGIN), String(logo)).toEqual({ kind: 'mascot' });
        }
    });

    it('takes a PNG, JPEG or WebP data URL, and a same-origin path', () => {
        expect(logoSource('data:image/png;base64,iVBORw==', ORIGIN)).toEqual({
            kind: 'data',
            type: 'image/png',
            base64: 'iVBORw==',
        });
        expect(logoSource('/uploads/logo.png?v=2', ORIGIN)).toEqual({
            kind: 'fetch',
            url: `${ORIGIN}/uploads/logo.png?v=2`,
        });
    });
});

describe('stageLogo', () => {
    it('writes a data URL to the staging directory, a new name each time', async () => {
        for (const [type, bytes, extension] of [
            ['image/png', PNG, 'png'],
            ['image/jpeg', JPEG, 'jpg'],
            ['image/webp', WEBP, 'webp'],
        ] as const) {
            const logo = await stageLogo(dataUrl(type, bytes), ORIGIN, options());
            expect(logo).toEqual({
                kind: 'file',
                path: join(stagingDirectory(root), `logo-n${names}.${extension}`),
                extension,
            });
            expect(new Uint8Array(await readFile(logo.kind === 'file' ? logo.path : ''))).toEqual(bytes);
            // Each stage empties the directory first: only the newest is there.
            expect(await staged()).toEqual([`logo-n${names}.${extension}`]);
        }
    });

    it('shows the mascot, staging nothing, for bytes that are not what the type says or are too big', async () => {
        const big = new Uint8Array(BRAND_LOGO_MAX_BYTES + 1);
        big.set(PNG);
        for (const logo of [dataUrl('image/png', JPEG), dataUrl('image/png', big), 'data:image/png;base64,']) {
            expect(await stageLogo(logo, ORIGIN, options())).toEqual({ kind: 'mascot' });
        }
        expect(await staged()).toBeNull();
    });

    it('fetches a same-origin logo through publicFetch: no cookies, no Origin, redirects handed back', async () => {
        const fetch = fakeFetch(() => image(PNG, 'image/png'));
        const logo = await stageLogo('/uploads/logo.png', ORIGIN, options(fetch));
        expect(logo.kind).toBe('file');
        expect(fetch.calls).toHaveLength(1);
        expect(fetch.calls[0].url).toBe(`${ORIGIN}/uploads/logo.png`);
        expect(fetch.calls[0].init).toMatchObject({ credentials: 'omit', redirect: 'manual' });
        const headers = fetch.calls[0].init.headers as Record<string, string>;
        expect(headers.cookie).toBeUndefined();
        expect(headers.origin).toBeUndefined();
    });

    it('shows the mascot for a redirect, an error, another type, a size over the limit or no answer', async () => {
        const answers: (() => Response)[] = [
            () => new Response(null, { status: 302, headers: { location: 'https://evil.example/logo.png' } }),
            () => new Response('nope', { status: 404 }),
            () => image(PNG, 'image/svg+xml'),
            () => image(PNG, 'image/png', { 'content-length': String(BRAND_LOGO_MAX_BYTES + 1) }),
            () => image(JPEG, 'image/png'),
            () => {
                throw new TypeError('Network request failed');
            },
        ];
        for (const respond of answers) {
            expect(await stageLogo('/uploads/logo.png', ORIGIN, options(fakeFetch(respond)))).toEqual({
                kind: 'mascot',
            });
        }
        expect(await staged()).toBeNull();
    });

    it('rejects with AbortedError once the screen has closed', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(
            stageLogo(
                '/uploads/logo.png',
                ORIGIN,
                options(
                    fakeFetch(() => image(PNG, 'image/png')),
                    controller.signal,
                ),
            ),
        ).rejects.toBeInstanceOf(AbortedError);
    });
});

describe('the staging cleanup', () => {
    it('commit moves the logo into the workspace directory and empties staging', async () => {
        const logo = await stageLogo(dataUrl('image/png', PNG), ORIGIN, options());
        const workspace = join(root, 'socio', 'a'.repeat(64));
        await files.mkdir(workspace);
        expect(await commitLogo(logo, workspace, root, files)).toBe('logo.png');
        expect(new Uint8Array(await readFile(join(workspace, 'logo.png')))).toEqual(PNG);
        expect(await staged()).toBeNull();
    });

    it('commit of the mascot keeps no file name and still empties staging', async () => {
        await stageLogo(dataUrl('image/png', PNG), ORIGIN, options());
        const workspace = join(root, 'socio', 'b'.repeat(64));
        await files.mkdir(workspace);
        expect(await commitLogo({ kind: 'mascot' }, workspace, root, files)).toBeNull();
        expect(await readdir(workspace)).toEqual([]);
        expect(await staged()).toBeNull();
    });

    it('cancel deletes the staging directory, and does nothing when it is already gone', async () => {
        await stageLogo(dataUrl('image/webp', WEBP), ORIGIN, options());
        expect(await staged()).toHaveLength(1);
        await discardStagedLogos(root, files);
        expect(await staged()).toBeNull();
        await discardStagedLogos(root, files);
        expect(await staged()).toBeNull();
    });

    it('stages beside the workspace directories, never as one: launch ignores it', () => {
        expect(stagingDirectory(root)).toBe(join(root, 'socio', 'staging'));
    });
});
