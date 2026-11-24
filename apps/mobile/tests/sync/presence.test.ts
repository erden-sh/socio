import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PRESENCE_INPUT_MS } from '@socio/shared/notifications';
import { parsePresence } from '@socio/shared/notifications/presence';

import { openCacheDb, type Store, workspaceKeyName, workspaceLayout } from '../../src/data';
import { presencePath } from '../../src/navigation/presence-path';
import {
    markNoticesSeen,
    NOTICE_SEEN_KIND,
    NOTICE_SEEN_LANE,
    NOTICE_SEEN_MAX,
    NOTICE_STALE_MS,
    noticeSeenKind,
    NOTICES_SHOWN_KEY,
} from '../../src/sync/notices';
import { newTabId, PRESENCE_POLL_MS, presencePathOf } from '../../src/sync/presence';
import { COALESCE_MS, SHELL_POLL_MS } from '../../src/sync/scheduler';
import { openWorkspaceScope, type WorkspaceScope } from '../../src/sync/scope';
import { launch, phone, type Phone } from '../helpers/store';
import { clocks, ORIGIN, T0 } from '../net/helpers';

import { fakeAppState, fakeNetwork, WIFI } from './fakes';
import { fakeWorkspaceServer, type Notice } from './helpers';
import { signedIn, wire } from './wire';

// Presence and in-app notices (src/sync/presence.ts and notices.ts) over
// a real store and the fake workspace server, on fake timers: every /api/state
// pull carries X-CB-Presence (the path only while active and touched in the
// last minute), /api/state goes every 5 s, the away post carries the tab on
// background and on dispose, and each new notice shows once, across a
// restart, marked seen through the outbox.

let device: Phone;
const scopes: WorkspaceScope[] = [];
const stores: Store[] = [];

beforeEach(() => {
    device = phone(mkdtempSync(join(tmpdir(), 'socio-presence-')));
    vi.useFakeTimers({ now: T0, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});
afterEach(async () => {
    for (const scope of scopes.splice(0)) {
        await scope.dispose();
    }
    for (const store of stores.splice(0)) {
        await store.registry.close().catch(() => {});
    }
    vi.useRealTimers();
    rmSync(device.root, { recursive: true, force: true });
});

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
async function turns(count = 10) {
    for (let turn = 0; turn < count; turn += 1) {
        await new Promise<void>((resolve) => {
            setImmediate(resolve);
        });
    }
}

async function setup() {
    const { store } = await launch(device);
    stores.push(store);
    const clock = clocks();
    const server = fakeWorkspaceServer(clock);
    const net = wire(new Map([[ORIGIN, server]]));
    const id = await signedIn(store, ORIGIN, server, clock);
    const appState = fakeAppState('active');
    const network = fakeNetwork(WIFI);
    const errors: unknown[] = [];
    let ids = 0;
    const open = async () => {
        const scope = await openWorkspaceScope({
            store,
            workspaceId: id,
            fetch: net.fetch,
            userAgent: 'Socio/0.1.0 (Pixel 4; Android 13)',
            variant: 'production',
            appState,
            network,
            onError: (error) => errors.push(error),
            random: () => 0.5,
            newId: () => `id-${(ids += 1)}`,
            outboxKinds: [noticeSeenKind()],
        });
        scopes.push(scope);
        return scope;
    };
    const started = async (scope: WorkspaceScope) => {
        scope.start();
        await advance(COALESCE_MS);
        await scope.scheduler.idle();
        await turns();
    };
    return { store, id, clock, server, net, appState, errors, open, started };
}

const notice = (id: string, createdAt: number): Notice => ({
    id,
    title: `Sebas: ${id}`,
    body: 'You were mentioned.',
    link: `/chats/room-${id}`,
    createdAt,
});

const statePulls = (s: Awaited<ReturnType<typeof setup>>) =>
    s.server.requests.filter((request) => request.path === '/api/state');
const posts = (s: Awaited<ReturnType<typeof setup>>, path: string) =>
    s.server.requests.filter((request) => request.path === path);

describe('the presence header', () => {
    it('makes 22-character tab ids the server takes, and keeps paths it parses', () => {
        const tab = newTabId();
        expect(tab).toMatch(/^[A-Za-z0-9_-]{22}$/);
        expect(newTabId(() => new Uint8Array(16).fill(255))).toBe('_____________________w');
        expect(newTabId()).not.toBe(tab);
        expect(presencePathOf('/chats/a%20b')).toBe('/chats/a%20b');
        expect(presencePathOf('/chats/a b')).toBe('/');
        expect(presencePathOf('chats')).toBe('/');
        expect(presencePathOf(`/${'x'.repeat(600)}`)).toHaveLength(501);
        expect(parsePresence(`${tab} ${presencePathOf(`/${'x'.repeat(600)}`)}`)?.tab).toBe(tab);
    });

    it('carries the path only while the app is active and was touched in the last minute', async () => {
        const s = await setup();
        const scope = await s.open();
        scope.presence.screen('/chats/c1');
        scope.presence.touch();
        await s.started(scope);
        const tab = scope.presence.tab;
        // Each /api/state pull, and only those, carries it.
        expect(statePulls(s).map((pull) => pull.presence)).toEqual([`${tab} /chats/c1`]);
        expect(s.server.requests.find((request) => request.path === '/api/workspace')?.presence).toBeUndefined();
        expect(parsePresence(statePulls(s)[0]!.presence)).toEqual({ tab, path: '/chats/c1' });

        // Another screen.
        scope.presence.screen('/settings');
        await advance(PRESENCE_POLL_MS);
        await scope.scheduler.idle();
        expect(statePulls(s).at(-1)?.presence).toBe(`${tab} /settings`);

        // A minute with no touch: no path.
        await advance(PRESENCE_INPUT_MS);
        await scope.scheduler.idle();
        expect(statePulls(s).at(-1)?.presence).toBe(`${tab} -`);
        scope.presence.touch();
        await advance(PRESENCE_POLL_MS);
        await scope.scheduler.idle();
        expect(statePulls(s).at(-1)?.presence).toBe(`${tab} /settings`);

        // 'inactive' (Control Center, the app switcher) is the foreground, but not in use.
        s.appState.set('inactive');
        await advance(PRESENCE_POLL_MS);
        await scope.scheduler.idle();
        expect(statePulls(s).at(-1)?.presence).toBe(`${tab} -`);
        expect(s.errors).toEqual([]);
    });

    it('polls /api/state every 5 s in the foreground, conditionally, and /api/workspace every 15 s', async () => {
        const s = await setup();
        const scope = await s.open();
        await s.started(scope);
        const at = s.server.requests.length;
        await advance(SHELL_POLL_MS);
        await scope.scheduler.idle();
        const later = s.server.requests.slice(at);
        expect(later.filter((request) => request.path === '/api/state')).toHaveLength(3);
        expect(later.filter((request) => request.path === '/api/workspace')).toHaveLength(1);
        // Conditional: the ETag goes back, and an unchanged state answers 304.
        expect(later.filter((request) => request.path === '/api/state').map((request) => request.status)).toEqual([
            304, 304, 304,
        ]);
        expect(later.every((request) => request.ifNoneMatch !== undefined)).toBe(true);
        // Nothing in the background.
        s.appState.set('background');
        await turns();
        const before = statePulls(s).length;
        await advance(SHELL_POLL_MS * 2);
        expect(statePulls(s)).toHaveLength(before);
    });

    it('posts away with its tab on going to the background and on a switch, once per report', async () => {
        const s = await setup();
        const scope = await s.open();
        // Nothing reported yet: nothing to end.
        s.appState.set('background');
        await turns();
        expect(posts(s, '/api/notifications/away')).toEqual([]);
        s.appState.set('active');
        await s.started(scope);
        const tab = scope.presence.tab;

        s.appState.set('background');
        await turns();
        expect(posts(s, '/api/notifications/away').map((post) => post.body)).toEqual([{ tab }]);
        // Back within 10 s: the poll resumes and reports again; the next background ends it again.
        s.appState.set('active');
        await advance(PRESENCE_POLL_MS);
        await scope.scheduler.idle();
        s.appState.set('background');
        await turns();
        expect(posts(s, '/api/notifications/away').map((post) => post.body)).toEqual([{ tab }, { tab }]);

        // A switch (dispose) after a report sends it for its tab too.
        s.appState.set('active');
        await advance(PRESENCE_POLL_MS);
        await scope.scheduler.idle();
        await scope.dispose();
        await turns();
        expect(posts(s, '/api/notifications/away').map((post) => post.body)).toEqual([{ tab }, { tab }, { tab }]);

        // The next scope is another tab.
        const next = await s.open();
        expect(next.presence.tab).not.toBe(tab);
        expect(s.errors).toEqual([]);
    });
});

describe('in-app notices', () => {
    it('shows each new notice once, oldest first, marks it seen, and never again after a restart', async () => {
        const s = await setup();
        const scope = await s.open();
        await s.started(scope);
        expect(scope.notices.current()).toBeNull();

        s.server.change('state', (data) => {
            data.notices.push(notice('n2', T0 + 2), notice('n1', T0 + 1));
        });
        await advance(PRESENCE_POLL_MS);
        await scope.scheduler.idle();
        await turns();
        expect(scope.notices.current()?.id).toBe('n1');
        const shown = scope.notices.current();
        // The same object until it changes.
        expect(scope.notices.current()).toBe(shown);
        scope.notices.dismiss('n1');
        expect(scope.notices.current()?.id).toBe('n2');
        await advance(COALESCE_MS);
        await turns();
        // Each marked seen as it showed: the server stops listing them.
        expect(
            posts(s, '/api/notifications/in-app/seen').flatMap((post) => (post.body as { ids: string[] }).ids),
        ).toEqual(['n1', 'n2']);
        expect(s.server.data.notices).toEqual([]);
        expect(JSON.parse(scope.viewState.get(NOTICES_SHOWN_KEY) ?? '[]')).toEqual(['n1', 'n2']);
        await scope.dispose();

        // A restart: the device still holds both (for the Inbox), and shows neither.
        const again = await s.open();
        await s.started(again);
        expect(again.collections.notices.size).toBe(2);
        expect(again.notices.current()).toBeNull();
        expect(s.errors).toEqual([]);
    });

    it('counts what a scope already holds as shown the first time, and shows nothing on a scope not started', async () => {
        const s = await setup();
        s.server.change('state', (data) => {
            data.notices.push(notice('old', T0));
        });
        const first = await s.open();
        await s.started(first);
        // The first open's cache was empty: the notice is news.
        expect(first.notices.current()?.id).toBe('old');
        await first.dispose();

        // A cache.db from before this build (no shown key) holding a notice: not news.
        const directory = workspaceLayout(s.store.root, s.id).directory;
        const cache = await openCacheDb(
            s.store.driver,
            directory,
            (await s.store.keys.read(workspaceKeyName(s.id, 'cache'))) ?? '',
        );
        await cache.db.run('DELETE FROM kv WHERE key = ?', [NOTICES_SHOWN_KEY]);
        await cache.db.close();
        const s2 = await s.open();
        expect(s2.notices.current()).toBeNull();
        s.server.change('state', (data) => {
            data.notices.push(notice('new', T0 + 5));
        });
        // Not started (a locked copy): nothing shows even once the rows are there.
        expect(s2.notices.current()).toBeNull();
        await s.started(s2);
        expect(s2.notices.current()?.id).toBe('new');
    });

    it('folds marks into a queued row up to the server’s 20, and drops a stale or refused one', async () => {
        const rows: { id: string; lane: string; kind: string; state: string; payload: string }[] = [];
        let ids = 0;
        const outbox = {
            rows: () => rows as never,
            revisionOf: () => 1,
            enqueue: async (write: { id: string; lane: string; kind: string; payload: string }) => {
                rows.push({ ...write, state: 'queued' });
                return write as never;
            },
            update: async (id: string, change: { payload: string }) => {
                const row = rows.find((candidate) => candidate.id === id);
                if (row === undefined) {
                    return false;
                }
                row.payload = change.payload;
                return true;
            },
        };
        const newId = () => `r${(ids += 1)}`;
        await markNoticesSeen(outbox, [{ id: 'a', createdAt: 1 }], newId);
        await markNoticesSeen(outbox, [{ id: 'b', createdAt: 3 }], newId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ lane: NOTICE_SEEN_LANE, kind: NOTICE_SEEN_KIND });
        expect(JSON.parse(rows[0]!.payload)).toEqual({ ids: ['a', 'b'], newest: 3 });
        const many = Array.from({ length: NOTICE_SEEN_MAX - 1 }, (_, index) => ({ id: `m${index}`, createdAt: 2 }));
        await markNoticesSeen(outbox, many, newId);
        expect(rows).toHaveLength(2);
        // One in flight takes no more.
        rows[1]!.state = 'inflight';
        await markNoticesSeen(outbox, [{ id: 'c', createdAt: 4 }], newId);
        expect(rows).toHaveLength(3);

        const kind = noticeSeenKind({ now: () => T0 });
        const calls: unknown[] = [];
        const context = (status: number) => ({
            fetch: async (_path: string, init?: { json?: unknown }) => {
                calls.push(init?.json);
                return new Response(JSON.stringify(status === 200 ? { ok: true } : { error: 'No.' }), { status });
            },
            signal: new AbortController().signal,
            resolve: () => null,
            claimed: () => false,
        });
        const write = (newest: number) => ({
            row: {} as never,
            payload: { ids: ['a'], newest },
        });
        expect(await kind.send(write(T0 - NOTICE_STALE_MS - 1), context(200) as never)).toEqual({ action: 'done' });
        expect(calls).toEqual([]);
        expect(await kind.send(write(T0), context(200) as never)).toEqual({ action: 'done' });
        expect(calls).toEqual([{ ids: ['a'] }]);
        // Refused: dropped, never the Unsent list's.
        expect(await kind.send(write(T0), context(400) as never)).toEqual({ action: 'done' });
        // The server away: again later.
        expect((await kind.send(write(T0), context(502) as never)).action).toBe('retry');
    });
});

describe('the presence path', () => {
    it('names the topmost route with a path: a chat under its sheets, a static path, else /', () => {
        expect(presencePath(undefined)).toBe('/');
        expect(presencePath({ index: 0, routes: [{ name: 'Tabs' }] })).toBe('/');
        expect(
            presencePath({
                index: 2,
                routes: [{ name: 'Tabs' }, { name: 'Chat', params: { id: 'a b/c' } }, { name: 'TurnTrace' }],
            }),
        ).toBe('/chats/a%20b%2Fc');
        expect(presencePath({ index: 1, routes: [{ name: 'Tabs' }, { name: 'Settings' }] })).toBe('/settings');
        expect(
            presencePath({ index: 2, routes: [{ name: 'Tabs' }, { name: 'Settings' }, { name: 'TechnicalDetails' }] }),
        ).toBe('/settings');
        expect(presencePath({ index: 1, routes: [{ name: 'Tabs' }, { name: 'Account' }] })).toBe('/');
    });

    it("names a chat pushed inside a tab's own stack, and only the tab that shows", () => {
        const chats = (top: number) => ({
            index: top,
            routes: [{ name: 'ChatsRoot' }, { name: 'Chat', params: { id: 'c1' } }],
        });
        const tabs = (index: number) => ({
            index,
            type: 'tab',
            routes: [
                { name: 'Home', state: { index: 0, routes: [{ name: 'HomeRoot' }] } },
                { name: 'Chats', state: chats(1) },
            ],
        });
        expect(presencePath({ index: 0, routes: [{ name: 'Tabs', state: tabs(1) }] })).toBe('/chats/c1');
        // A sheet over the tabs still names the chat under it.
        expect(presencePath({ index: 1, routes: [{ name: 'Tabs', state: tabs(1) }, { name: 'TurnTrace' }] })).toBe(
            '/chats/c1',
        );
        // Home shows: the chat kept in the Chats tab beside it isn't in view.
        expect(presencePath({ index: 0, routes: [{ name: 'Tabs', state: tabs(0) }] })).toBe('/');
        // The Spaces list, the Spaces tab's root (CB-459), at its web path.
        expect(
            presencePath({
                index: 0,
                routes: [
                    {
                        name: 'Tabs',
                        state: {
                            index: 0,
                            type: 'tab',
                            routes: [{ name: 'Spaces', state: { index: 0, routes: [{ name: 'SpacesRoot' }] } }],
                        },
                    },
                ],
            }),
        ).toBe('/spaces');
        // Popped back to the chat list.
        expect(
            presencePath({
                index: 0,
                routes: [
                    {
                        name: 'Tabs',
                        state: { ...tabs(1), routes: [tabs(1).routes[0]!, { name: 'Chats', state: chats(0) }] },
                    },
                ],
            }),
        ).toBe('/');
    });
});
