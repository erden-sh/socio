import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CorpusExportError, exportPages, USER_AGENT } from '../../scripts/corpus-export.mts';
import { DEVICE_FILE, MARKER } from '../../scripts/corpus-folder.mts';

// The live corpus's export (scripts/corpus-export.mts), against
// a fake server handed in as `fetch`: nothing leaves the machine. Each export
// replaces the last, so a page gone since, and the old device payload, never
// stay to be tested or pushed.

const BASE = 'https://socio.invalid';

/** A fake server: Spaces of pages, each page's content; every request logged. */
function fakeServer(spaces: Record<string, Record<string, string>>) {
    const requests: { url: string; init: RequestInit }[] = [];
    const json = (body: unknown, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json', ...headers },
        });
    const send = (async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = String(input);
        requests.push({ url, init });
        const path = url.slice(BASE.length);
        if (path === '/api/auth/sign-in/email') {
            return json({}, { 'Set-Cookie': 'session=s1; Path=/; HttpOnly' });
        }
        if (path === '/api/auth/logout') {
            return json({});
        }
        if (path === '/api/workspace') {
            return json({ spaces: Object.keys(spaces).map((id) => ({ id })) });
        }
        const list = /^\/api\/spaces\/([^/]+)\/pages$/.exec(path);
        if (list) {
            return json(Object.keys(spaces[list[1]!] ?? {}).map((id) => ({ id })));
        }
        const page = /^\/api\/spaces\/([^/]+)\/pages\/([^/]+)$/.exec(path);
        const content = page ? spaces[page[1]!]?.[page[2]!] : undefined;
        return content === undefined ? new Response('{}', { status: 404 }) : json({ content });
    }) as typeof fetch;
    return { send, requests };
}

let root: string;
let folder: string;

beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'corpus-export-')));
    folder = join(root, 'corpus');
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

const run = (send: typeof fetch) =>
    exportPages({ base: BASE, email: 'smoke@socio.invalid', password: 'secret', folder, fetch: send });

describe('exporting the live corpus', () => {
    it('writes each page as <spaceId>/<pageId>.md in a marked folder, with only a generic User-Agent', async () => {
        const server = fakeServer({ s1: { p1: '# One', p2: '# Two' }, s2: { p3: '# Three' } });
        expect(await run(server.send)).toEqual({ pages: 3, skipped: 0 });
        expect([...readdirSync(folder)].sort()).toEqual([MARKER, 's1', 's2']);
        expect(readFileSync(join(folder, 's1', 'p2.md'), 'utf8')).toBe('# Two');
        for (const { url, init } of server.requests) {
            expect(url.startsWith(BASE)).toBe(true);
            expect((init.headers as Record<string, string>)['User-Agent']).toBe(USER_AGENT);
        }
        expect(server.requests.at(-1)!.url).toBe(`${BASE}/api/auth/logout`);
    });

    it('replaces the last export: a page removed since and the old device payload are gone', async () => {
        await run(fakeServer({ s1: { p1: '# One', p2: '# Two' }, s2: { p3: '# Three' } }).send);
        writeFileSync(join(folder, DEVICE_FILE), '[{"name":"old"}]');

        expect(await run(fakeServer({ s1: { p1: '# One, edited' } }).send)).toEqual({ pages: 1, skipped: 0 });
        expect(existsSync(join(folder, 's1', 'p2.md'))).toBe(false);
        expect(existsSync(join(folder, 's2'))).toBe(false);
        expect(existsSync(join(folder, DEVICE_FILE))).toBe(false);
        expect(readFileSync(join(folder, 's1', 'p1.md'), 'utf8')).toBe('# One, edited');
        expect(existsSync(join(folder, MARKER))).toBe(true);
    });

    it('keeps nothing of an export that fails part way', async () => {
        await run(fakeServer({ s1: { p1: '# One' } }).send);
        const failing = fakeServer({ s1: { p1: '# One' } });
        const send = (async (input: string | URL | Request, init?: RequestInit) =>
            String(input).endsWith('/pages/p1')
                ? new Response('{}', { status: 500 })
                : failing.send(input, init)) as typeof fetch;
        await expect(run(send)).rejects.toThrow(CorpusExportError);
        expect(readdirSync(folder)).toEqual([MARKER]);
        expect(failing.requests.at(-1)!.url).toBe(`${BASE}/api/auth/logout`);
    });

    it('skips and counts a page or Space that answers 403 or 404, and goes on', async () => {
        const server = fakeServer({ s1: { p1: '# One', gone: '# Gone', p2: '# Two' }, s2: { p3: '# Three' } });
        const send = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            if (url.endsWith('/pages/gone')) {
                return new Response('{}', { status: 404 });
            }
            if (url.endsWith('/spaces/s2/pages')) {
                return new Response('{}', { status: 403 });
            }
            return server.send(input, init);
        }) as typeof fetch;
        expect(await run(send)).toEqual({ pages: 2, skipped: 2 });
        expect([...readdirSync(join(folder, 's1'))].sort()).toEqual(['p1.md', 'p2.md']);
        expect(existsSync(join(folder, 's2'))).toBe(false);
        expect(server.requests.at(-1)!.url).toBe(`${BASE}/api/auth/logout`);
    });

    it('signs out after a failure, and a failed sign-out never hides the export’s own error', async () => {
        const server = fakeServer({ s1: { p1: '# One' } });
        let signOuts = 0;
        const send = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            if (url.endsWith('/api/workspace')) {
                return new Response('{}', { status: 500 });
            }
            if (url.endsWith('/api/auth/logout')) {
                signOuts += 1;
                throw new TypeError('network down');
            }
            return server.send(input, init);
        }) as typeof fetch;
        await expect(run(send)).rejects.toThrow(/answered 500/);
        expect(signOuts).toBe(1);
    });

    it('fails a good export whose sign-out fails, keeping the pages', async () => {
        const server = fakeServer({ s1: { p1: '# One' } });
        const send = (async (input: string | URL | Request, init?: RequestInit) =>
            String(input).endsWith('/api/auth/logout')
                ? new Response('{}', { status: 503 })
                : server.send(input, init)) as typeof fetch;
        await expect(run(send)).rejects.toThrow(/signing out failed/);
        expect(readFileSync(join(folder, 's1', 'p1.md'), 'utf8')).toBe('# One');
    });

    it('words a failed sign-in with its status, never the account’s email or password', async () => {
        const server = fakeServer({ s1: { p1: '# One' } });
        const send = (async (input: string | URL | Request, init?: RequestInit) =>
            String(input).endsWith('/api/auth/sign-in/email')
                ? new Response('{}', { status: 401 })
                : server.send(input, init)) as typeof fetch;
        const error = await run(send).then(
            () => null,
            (failure: unknown) => failure,
        );
        expect(error).toBeInstanceOf(CorpusExportError);
        const { message } = error as CorpusExportError;
        expect(message).toMatch(/^Sign-in answered 401:/);
        expect(message).not.toContain('smoke@socio.invalid');
        expect(message).not.toContain('smoke@');
        expect(message).not.toContain('secret');
        expect(readdirSync(folder)).toEqual([MARKER]);
    });

    it('refuses an id that isn’t a plain name, and writes nothing outside the folder', async () => {
        await expect(run(fakeServer({ '..': { p1: '# One' } }).send)).rejects.toThrow(/plain name/);
        await expect(run(fakeServer({ s1: { '../escape': '# One' } }).send)).rejects.toThrow(/plain name/);
        expect(readdirSync(root)).toEqual(['corpus']);
        expect(readdirSync(folder)).toEqual([MARKER]);
    });
});
