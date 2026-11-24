import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, expect, it } from 'vitest';

import { parseReleaseNotes } from '@socio/shared/updates/release-notes';
import type { Release, ReleasesResponse } from '@socio/shared/updates/releases';

import { createApp } from '../src/server/app.js';
import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import type { ReleaseData } from '../src/server/updates/contract.js';
import { loadReleaseData } from '../src/server/updates/releases.js';

import { Runner } from './helpers/runners.js';
import { Store } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

// CB-165, CB-168: the running version and the release notes, for anyone
// signed in (the contract CB-166 builds on).

const SECRET = 'releases-secret-0123456789abcdef';
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

const DATA: ReleaseData = {
    version: '0.2.0',
    commit: 'abc1234',
    releases: parseReleaseNotes(`## v0.2.0 (2026-10-21)

Newer.

- A highlight (CB-10)

### New

- **The first (CB-10).** Text.

## v0.1.0 (2026-10-07)

The first.

- Everyone signs in

### New

- **Accounts.** Text.
`).releases,
};

async function fixture(releases: () => ReleaseData = () => DATA) {
    const store = new Store(testDatabase());
    cleanup.push(() => store.close());
    const config = { mode: 'live' as const, baseUrl: 'https://model.invalid/v1' };
    const app = createApp({
        store,
        runner: new Runner(store, config),
        config,
        auth: {
            provider: new MockAuthProvider(DEFAULT_MOCK_USERS, SECRET),
            secureCookies: false,
        },
        releases,
    });
    const login = await app.request('/api/auth/mock/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'bob' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const get = (path: string, signedIn = true) => app.request(`/api${path}`, { headers: signedIn ? { cookie } : {} });
    return { get };
}

it('lists the releases newest first, with the running version, to anyone signed in', async () => {
    const { get } = await fixture();
    expect((await get('/releases', false)).status).toBe(401);
    const response = await get('/releases');
    expect(response.status).toBe(200);
    const body = (await response.json()) as ReleasesResponse;
    expect(body.current).toBe('0.2.0');
    expect(body.commit).toBe('abc1234');
    expect(body.releases).toEqual([
        {
            version: '0.2.0',
            tag: 'v0.2.0',
            date: '2026-10-21',
            summary: 'Newer.',
            highlights: [{ title: 'A highlight', issue: 'CB-10' }],
            url: '/releases/v0.2.0',
        },
        expect.objectContaining({ tag: 'v0.1.0' }),
    ]);
    const one = (await (await get('/releases?limit=1')).json()) as ReleasesResponse;
    expect(one.releases.map((release) => release.tag)).toEqual(['v0.2.0']);
    const none = (await (await get('/releases?limit=0')).json()) as ReleasesResponse;
    expect(none).toEqual({ current: '0.2.0', commit: 'abc1234', releases: [] });
    expect((await get('/releases?limit=-1')).status).toBe(400);
    expect((await get('/releases?limit=two')).status).toBe(400);
    expect((await get('/releases?limit=')).status).toBe(400);
    expect((await get('/releases?limit=1.5')).status).toBe(400);
});

it('gives one release with its notes, and 404 for one there isn’t', async () => {
    const { get } = await fixture();
    expect((await get('/releases/v0.1.0', false)).status).toBe(401);
    const release = (await (await get('/releases/v0.1.0')).json()) as Release;
    expect(release).toMatchObject({ tag: 'v0.1.0', summary: 'The first.' });
    expect(release.notesMarkdown).toBe('### New\n\n- **Accounts.** Text.');
    expect((await get('/releases/v9.9.9')).status).toBe(404);
    // Only a v0.1.2 is a release: other paths stay free (CB-166's /seen).
    expect((await get('/releases/seen')).status).toBe(404);
});

it('reads the version and the notes from the source tree outside a build', () => {
    const data = loadReleaseData();
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(data.version).toBe(pkg.version);
    expect(data.releases[0]!.version).toBe(pkg.version);
    expect(data.releases.at(-1)!.tag).toBe('v0.1.0');
});

it('shows no releases, and still the version, when the notes or the build file are broken', () => {
    const dir = mkdtempSync(join(tmpdir(), 'socio-releases-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = (name: string, text: string) => {
        writeFileSync(join(dir, name), text);
        return pathToFileURL(join(dir, name));
    };
    const pkg = [file('package.json', '{"version":"0.7.0"}')];
    const logs: string[] = [];
    const notes = file('NOTES.md', '## Release 2 (2026-10)\n');
    const missing = pathToFileURL(join(dir, 'releases.json'));
    expect(loadReleaseData((line) => logs.push(line), { built: missing, notes, pkg })).toMatchObject({
        version: '0.7.0',
        releases: [],
    });
    const built = file('broken.json', '{"version": "1.6');
    expect(loadReleaseData((line) => logs.push(line), { built, notes, pkg })).toMatchObject({
        version: '0.7.0',
        releases: [],
    });
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(/^Releases: could not read the release notes/);
});

it('pages the releases with a cursor, older ones after (CB-166)', async () => {
    const { get } = await fixture();
    const page = async (path: string) => (await (await get(path)).json()) as ReleasesResponse;
    const first = await page('/releases?limit=1');
    expect(first.releases.map((release) => release.tag)).toEqual(['v0.2.0']);
    expect(first.nextCursor).toBe('v0.2.0');
    const second = await page(`/releases?limit=1&before=${first.nextCursor}`);
    expect(second.releases.map((release) => release.tag)).toEqual(['v0.1.0']);
    expect(second.nextCursor).toBeNull();
    expect((await page('/releases?before=v0.2.0')).releases).toHaveLength(1);
    expect((await page('/releases?limit=5')).nextCursor).toBeNull();
    expect((await page('/releases')).nextCursor).toBeNull();
    // The oldest has nothing after it; a cursor must be a release's tag.
    expect((await page('/releases?limit=1&before=v0.1.0')).releases).toEqual([]);
    for (const bad of ['v9.9.9', 'seen', '0.2.0', '']) {
        expect((await get(`/releases?limit=1&before=${bad}`)).status, bad).toBe(400);
    }
});

it('reaches every release, a page at a time, by following nextCursor (49 releases)', async () => {
    // As many as the app ships today: the Releases page pages through them.
    const many: ReleaseData = {
        version: '0.49.0',
        commit: null,
        releases: Array.from({ length: 49 }, (_, index) => {
            const version = `0.${49 - index}.0`;
            return {
                version,
                tag: `v${version}`,
                date: '2026-10-21',
                summary: `v${version}.`,
                highlights: [],
                url: `/releases/v${version}`,
                notesMarkdown: '',
            };
        }),
    };
    const { get } = await fixture(() => many);
    const all = many.releases.map((release) => release.tag);
    for (const size of [1, 5, 10, 48, 49, 50]) {
        const seen: string[] = [];
        let cursor: string | null | undefined;
        let pages = 0;
        do {
            const body = (await (
                await get(`/releases?limit=${size}${cursor ? `&before=${cursor}` : ''}`)
            ).json()) as ReleasesResponse;
            expect(body.releases.length, `page ${pages} of ${size}`).toBeLessThanOrEqual(size);
            expect(body.releases.length).toBeGreaterThan(0);
            seen.push(...body.releases.map((release) => release.tag));
            // The cursor is the last release on the page, until there is none.
            expect(body.nextCursor ?? null).toBe(seen.length < all.length ? seen.at(-1) : null);
            cursor = body.nextCursor;
            pages += 1;
        } while (cursor);
        expect(seen, `limit=${size}`).toEqual(all);
        expect(pages).toBe(Math.ceil(all.length / size));
    }
    // Without a limit, every release in one answer, with no cursor.
    const whole = (await (await get('/releases')).json()) as ReleasesResponse;
    expect(whole.releases).toHaveLength(49);
    expect(whole.nextCursor).toBeNull();
});
