import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { appsSettingsFromEnv } from '@socio/foundation/apps/settings';
import {
    PLUGIN_RELEASE_HISTORY_MAX,
    PLUGIN_RELEASE_NOTE_BYTES,
    PLUGIN_RELEASE_NOTES_MAX,
    parsePluginReleaseNotes,
} from '@socio/shared/plugins/plugin-release-notes';
import type { User } from '@socio/shared/types';
import {
    PLUGIN_RELEASE_NOTES_PATH,
    WHATS_NEW_PATH,
    WHATS_NEW_SEEN_PATH,
    WHATS_NEW_SEEN_MAX_PLUGINS,
    seenRequestBatches,
    seenRequestFor,
    type PluginReleaseNotesResponse,
    type WhatsNewResponse,
} from '@socio/shared/updates/whats-new';

import { MockAuthProvider } from '../src/server/auth/mock.js';
import { loadCatalog, parseManifest } from '../src/server/plugins/catalog.js';
import type { ReleaseData } from '../src/server/updates/contract.js';

import { updateAcked } from './helpers/plugin-update.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-527: plugins' release notes, read from the catalog manifest at install
// and update, shown to whoever may open the plugin now, with a What's new
// modal once per person per change set.

const SECRET = 'plugin-release-notes-secret-0123456789';
const IMAGE = `socio-plugin-bookings@sha256:${'b'.repeat(64)}`;
const USERS: User[] = [
    { id: 'alice', name: 'Alice', role: 'admin' },
    { id: 'bob', name: 'Bob', role: 'member' },
];

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const RELEASES: ReleaseData = {
    version: '0.6.1',
    commit: null,
    releases: [
        {
            version: '0.6.1',
            tag: 'v0.6.1',
            date: '2026-10-22',
            summary: 'Steadier.',
            highlights: [{ title: 'Steadier' }],
            url: '/releases/v0.6.1',
            notesMarkdown: '### Fixed\n\n- Steadier.',
        },
        {
            version: '0.6.0',
            tag: 'v0.6.0',
            date: '2026-10-20',
            summary: 'Steering.',
            highlights: [],
            url: '/releases/v0.6.0',
            notesMarkdown: '### New\n\n- Steering.',
        },
    ],
};

const note = (version: string, notes = `Changes in ${version}.`) => ({ version, date: '2026-11-01', notes });

const bookings = (version: string, releaseNotes?: unknown[]) => ({
    id: 'bookings',
    name: 'Reference bookings',
    version,
    author: 'Socio tests',
    description: 'Bookings',
    display: 'tab',
    permissions: [],
    service: { image: IMAGE, port: 8080 },
    ...(releaseNotes ? { releaseNotes } : {}),
});

describe('the manifest field', () => {
    const parse = (releaseNotes: unknown, version = '1.1.0') =>
        parseManifest(bookings(version, releaseNotes as unknown[]), 'catalog.json', () => {});

    it('keeps valid notes, newest first, and leaves the field out when absent', () => {
        const manifest = parse([{ ...note('1.1.0'), title: ' Faster sync ' }, note('1.0.0')]);
        expect(manifest.releaseNotes).toEqual([{ ...note('1.1.0'), title: 'Faster sync' }, note('1.0.0')]);
        expect(parseManifest(bookings('1.0.0'), 'catalog.json', () => {}).releaseNotes).toBeUndefined();
    });

    it('refuses notes that break the limits or the order', () => {
        expect(() => parse([note('1.0.0')])).toThrow(/start with 1.0.0, but the manifest's version is 1.1.0/);
        expect(() => parse([note('1.0.0'), note('1.1.0')], '1.0.0')).toThrow(/newest first/);
        expect(() => parse([note('1.1.0'), note('1.1.0')])).toThrow(/newest first/);
        expect(() => parse([note('v1.1.0')], 'v1.1.0')).toThrow(/SemVer/);
        expect(() => parse([{ ...note('1.1.0'), date: '2026-02-30' }])).toThrow(/YYYY-MM-DD/);
        expect(() => parse([{ ...note('1.1.0'), html: '<b>' }])).toThrow(/field html is not allowed/);
        expect(() => parse([{ ...note('1.1.0'), title: 'two\nlines' }])).toThrow(/one line/);
        expect(() => parse([{ version: '1.1.0', date: '2026-11-01', notes: ' ' }])).toThrow(/needs notes/);
        expect(() => parse([])).toThrow(/1 to 20/);
        const many = Array.from({ length: PLUGIN_RELEASE_NOTES_MAX + 1 }, (_, index) => note(`1.${30 - index}.0`));
        expect(() => parse(many, '1.30.0')).toThrow(/1 to 20/);
        // Bytes, not characters: 3 bytes each.
        expect(() => parse([note('1.1.0', '€'.repeat(PLUGIN_RELEASE_NOTE_BYTES / 3 + 1))])).toThrow(/8192 bytes/);
        expect(parse([note('1.1.0', 'a'.repeat(PLUGIN_RELEASE_NOTE_BYTES))]).releaseNotes).toHaveLength(1);
        const big = Array.from({ length: 9 }, (_, index) => note(`1.${10 - index}.0`, 'a'.repeat(8000)));
        expect(() => parse(big, '1.10.0')).toThrow(/65536 bytes in all/);
    });

    it('splits a seen request into batches the server takes', () => {
        const plugins = Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`p${index}`, '1.0.0']));
        const batches = seenRequestBatches({ workspace: '0.6.1', plugins });
        expect(batches.map((batch) => Object.keys(batch.plugins ?? {}).length)).toEqual([
            WHATS_NEW_SEEN_MAX_PLUGINS,
            WHATS_NEW_SEEN_MAX_PLUGINS,
            1,
        ]);
        expect(batches.map((batch) => batch.workspace)).toEqual(['0.6.1', undefined, undefined]);
        expect(Object.assign({}, ...batches.map((batch) => batch.plugins))).toEqual(plugins);
        expect(seenRequestBatches({ workspace: '0.6.1' })).toEqual([{ workspace: '0.6.1' }]);
        expect(seenRequestBatches({})).toEqual([]);
    });

    it('is the same check in shared code, for Socio Mobile', () => {
        expect(() => parsePluginReleaseNotes('notes', 'x', '1.0.0')).toThrow(/a list/);
    });
});

async function world() {
    const dir = mkdtempSync(join(tmpdir(), 'socio-plugin-release-notes-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const catalog = join(dir, 'catalog.json');
    writeFileSync(catalog, JSON.stringify({ plugins: [bookings('1.0.0', [note('1.0.0')])] }));
    const running = {
        id: 'bookings',
        service: 'socio-plugin-bookings',
        image: IMAGE,
        replicas: 1,
        running: 1,
        state: 'running' as const,
    };
    const { app, platform, dispose } = await makeTestRuntime({
        config: {
            sessionSecret: SECRET,
            data: { userDataDir: dir },
            apps: appsSettingsFromEnv({ APPS_HOST: 'apps.example' }, 'https://socio.example'),
            appsRuntime: { url: 'http://127.0.0.1:9', token: SECRET, ingress: { host: '127.0.0.1', port: 9 } },
            plugins: {
                catalogs: [{ kind: 'file', path: catalog }],
                runtime: {
                    provisionService: async () => running,
                    scaleService: async () => running,
                    removeService: async () => {},
                    serviceStatus: async () => running,
                },
            },
        },
        app: {
            config: { mode: 'live' as const, baseUrl: '' },
            releases: () => RELEASES,
            auth: { provider: new MockAuthProvider(USERS, SECRET), secureCookies: false },
        },
    });
    cleanup.push(dispose);
    platform.context.log = () => {};
    const plugins = platform.plugins;
    (plugins as unknown as { options: { log: (line: string) => void } }).options.log = () => {};
    plugins.useActiveUsers(() => USERS);
    const cookies = new Map<string, string>();
    const send = async (userId: string, method: string, path: string, body?: unknown) => {
        let cookie = cookies.get(userId);
        if (!cookie) {
            const login = await app.request('/api/auth/mock/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId }),
            });
            cookie = login.headers.get('set-cookie')!.split(';')[0]!;
            cookies.set(userId, cookie);
        }
        const response = await app.request(path, {
            method,
            headers: { cookie, 'Content-Type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, body: (await response.json()) as unknown };
    };
    const whatsNew = async (userId: string) => (await send(userId, 'GET', WHATS_NEW_PATH)).body as WhatsNewResponse;
    const cards = async (userId: string) =>
        ((await send(userId, 'GET', PLUGIN_RELEASE_NOTES_PATH)).body as PluginReleaseNotesResponse).plugins;
    const dismiss = async (userId: string) =>
        (await send(userId, 'POST', WHATS_NEW_SEEN_PATH, seenRequestFor(await whatsNew(userId))))
            .body as WhatsNewResponse;
    const publish = async (version: string, releaseNotes?: unknown[]) => {
        writeFileSync(catalog, JSON.stringify({ plugins: [bookings(version, releaseNotes)] }));
        (plugins as unknown as { catalog: unknown }).catalog = loadCatalog([{ kind: 'file', path: catalog }]);
        await updateAcked(plugins, 'bookings', 'alice');
    };
    return { plugins, send, whatsNew, cards, dismiss, publish };
}

describe('the workspace and its plugins', () => {
    it('shows no modal for an install, then one per person per update, until they dismiss it', async () => {
        const w = await world();
        await w.plugins.install('bookings');
        // A first visit starts at the running workspace version: nothing new.
        expect(await w.whatsNew('alice')).toEqual({ apiVersion: 1, show: false, workspace: null, plugins: [] });
        expect(await w.cards('alice')).toEqual([
            {
                id: 'bookings',
                name: 'Reference bookings',
                version: '1.0.0',
                lastSeen: '1.0.0',
                releases: [note('1.0.0')],
            },
        ]);

        await w.publish('1.1.0', [note('1.1.0'), note('1.0.0')]);
        const shown = await w.whatsNew('alice');
        expect(shown.show).toBe(true);
        expect(shown.plugins).toEqual([
            {
                id: 'bookings',
                name: 'Reference bookings',
                from: '1.0.0',
                to: '1.1.0',
                releases: [note('1.1.0')],
                count: 1,
            },
        ]);
        // Asked again (another device) before dismissing: the same.
        expect(await w.whatsNew('alice')).toEqual(shown);
        expect((await w.dismiss('alice')).show).toBe(false);
        expect((await w.whatsNew('alice')).show).toBe(false);
        expect((await w.cards('alice'))[0]).toMatchObject({ version: '1.1.0', lastSeen: '1.1.0' });
    });

    it('keeps the history across updates, at most 50 versions', async () => {
        const w = await world();
        await w.plugins.install('bookings');
        for (let minor = 1; minor <= 55; minor++) {
            await w.publish(`1.${minor}.0`, [note(`1.${minor}.0`)]);
        }
        const [card] = await w.cards('alice');
        expect(card!.releases).toHaveLength(PLUGIN_RELEASE_HISTORY_MAX);
        expect(card!.releases[0]!.version).toBe('1.55.0');
        expect(card!.releases.at(-1)!.version).toBe('1.6.0');
        const modal = await w.whatsNew('alice');
        expect(modal.plugins[0]).toMatchObject({ from: '1.0.0', to: '1.55.0', count: 50 });
        expect(modal.plugins[0]!.releases).toHaveLength(3);
    });

    it('moves the seen version only forward, and only to a version the plugin has', async () => {
        const w = await world();
        await w.plugins.install('bookings');
        await w.publish('1.1.0', [note('1.1.0'), note('1.0.0')]);
        await w.cards('alice');
        // A future version, or one it never had, changes nothing.
        await w.send('alice', 'POST', WHATS_NEW_SEEN_PATH, { plugins: { bookings: '9.0.0' } });
        await w.send('alice', 'POST', WHATS_NEW_SEEN_PATH, { plugins: { bookings: '1.0.5' } });
        expect((await w.whatsNew('alice')).plugins[0]).toMatchObject({ from: '1.0.0', to: '1.1.0' });
        await w.send('alice', 'POST', WHATS_NEW_SEEN_PATH, { plugins: { bookings: '1.1.0' } });
        await w.send('alice', 'POST', WHATS_NEW_SEEN_PATH, { plugins: { bookings: '1.0.0' } });
        expect((await w.cards('alice'))[0]!.lastSeen).toBe('1.1.0');
        // Malformed requests are refused.
        for (const body of [{ plugins: { bookings: 'latest' } }, { workspace: 'v0.6.1' }, { other: 1 }, []]) {
            expect((await w.send('alice', 'POST', WHATS_NEW_SEEN_PATH, body)).status).toBe(400);
        }
    });

    it('shows the workspace releases since the last seen, and its dismissal keeps', async () => {
        const w = await world();
        await w.whatsNew('alice');
        await w.send('alice', 'POST', '/api/releases/seen', { version: '0.6.0' });
        // Already at 0.6.1: it never moves back.
        expect((await w.whatsNew('alice')).workspace).toBeNull();
        await w.send('bob', 'POST', '/api/releases/seen', { version: '0.6.0' });
        const modal = await w.whatsNew('bob');
        expect(modal.workspace).toMatchObject({ from: '0.6.0', to: '0.6.1', count: 1 });
        expect(modal.workspace!.releases[0]).not.toHaveProperty('notesMarkdown');
        expect((await w.dismiss('bob')).show).toBe(false);
        // A release the build doesn't have can't be marked seen.
        await w.send('bob', 'POST', '/api/releases/seen', { version: '0.6.0' });
        expect((await w.send('bob', 'POST', WHATS_NEW_SEEN_PATH, { workspace: '9.0.0' })).status).toBe(200);
        expect((await w.send('bob', 'GET', '/api/releases/seen')).body).toEqual({ lastSeen: '0.6.1' });
    });
});

describe('who sees a plugin’s notes', () => {
    it('shows a plugin’s card and modal section only to people who may open it, on the server', async () => {
        const w = await world();
        await w.plugins.install('bookings');
        await w.publish('1.1.0', [note('1.1.0'), note('1.0.0')]);
        // Admins only: Bob gets no card and no modal section, from either endpoint.
        expect(await w.cards('bob')).toEqual([]);
        expect(await w.whatsNew('bob')).toMatchObject({ show: false, plugins: [] });
        // Marking it seen without access does nothing.
        await w.send('bob', 'POST', WHATS_NEW_SEEN_PATH, { plugins: { bookings: '1.1.0' } });
        expect(await w.cards('bob')).toEqual([]);
        expect((await w.whatsNew('alice')).plugins).toHaveLength(1);
    });

    it('gives someone who gains access the stored history, with no modal for updates before', async () => {
        const w = await world();
        await w.plugins.install('bookings');
        await w.publish('1.1.0', [note('1.1.0'), note('1.0.0')]);
        await w.plugins.setAudience('bookings', 'members');
        expect(await w.cards('bob')).toEqual([
            expect.objectContaining({ version: '1.1.0', lastSeen: '1.1.0', releases: [note('1.1.0'), note('1.0.0')] }),
        ]);
        expect((await w.whatsNew('bob')).show).toBe(false);
        // An update after they gained access is new to them, even before they look again.
        await w.publish('1.2.0', [note('1.2.0'), note('1.1.0')]);
        expect((await w.whatsNew('bob')).plugins[0]).toMatchObject({ from: '1.1.0', to: '1.2.0' });
    });

    it('stops showing it to someone who loses access, and starts them over when they regain it', async () => {
        const w = await world();
        await w.plugins.install('bookings');
        await w.plugins.setAudience('bookings', 'members');
        expect(await w.cards('bob')).toHaveLength(1);
        await w.plugins.setAudience('bookings', 'admins');
        expect(await w.cards('bob')).toEqual([]);
        // Updated while Bob can't open it, then opened to members again.
        await w.publish('1.1.0', [note('1.1.0'), note('1.0.0')]);
        await w.plugins.setAudience('bookings', 'members');
        expect((await w.whatsNew('bob')).show).toBe(false);
        expect((await w.cards('bob'))[0]).toMatchObject({ lastSeen: '1.1.0' });
        // A disabled plugin is no one's.
        await w.plugins.setEnabled('bookings', false);
        expect(await w.cards('alice')).toEqual([]);
        expect(await w.cards('bob')).toEqual([]);
    });

    it('forgets a plugin’s notes when it is uninstalled', async () => {
        const w = await world();
        await w.plugins.install('bookings');
        await w.publish('1.1.0', [note('1.1.0'), note('1.0.0')]);
        await w.plugins.uninstall('bookings');
        expect(await w.cards('alice')).toEqual([]);
        await w.publish('1.1.0', [note('1.1.0'), note('1.0.0')]).catch(() => undefined);
        await w.plugins.install('bookings');
        expect(await w.whatsNew('alice')).toMatchObject({ show: false });
        expect((await w.cards('alice'))[0]!.releases).toEqual([note('1.1.0'), note('1.0.0')]);
    });
});
