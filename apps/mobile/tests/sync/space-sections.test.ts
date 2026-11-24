import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SpaceRadar } from '@socio/shared/pages/page-radar';
import type { SpaceMemoryState } from '@socio/shared/space-memory';

import { NetworkError } from '../../src/net/errors';
import { createPagesStore, type PagesStore } from '../../src/sync/page-store';
import {
    parseSpaceSectionKey,
    SPACE_SECTIONS_KIND,
    spaceSection,
    spaceSectionKey,
} from '../../src/sync/space-sections';

import { syncSetup } from './helpers';

// A Space's radar and memory, against a real cache.db: read as their
// tab holds them, kept for offline with their age, a 404 drops the copy, and a
// Space the person lost drops them with its pages, also when only they were
// left on disk after a kill.

type Setup = Awaited<ReturnType<typeof syncSetup>>;
const open: Setup[] = [];
afterEach(async () => {
    for (const s of open.splice(0)) {
        await s.close().catch(() => {});
    }
});

const RADAR: SpaceRadar = {
    spaceId: 'everyday',
    now: 1_700_000_000_000,
    staleDays: 30,
    recent: [],
    open: [],
    stale: [],
    total: 0,
};

const MEMORY: SpaceMemoryState = {
    spaceId: 'everyday',
    access: 'reader',
    entries: [],
    proposals: [],
    retired: [],
    retentionDays: 30,
};

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function setup() {
    const s = await syncSetup();
    open.push(s);
    const asked: string[] = [];
    let answer: (path: string) => Response = (path) => json(path.endsWith('/radar') ? RADAR : MEMORY);
    const stores: PagesStore[] = [];
    const makeStore = () => {
        const store = createPagesStore({
            scopeId: `test-${stores.length}`,
            db: s.db,
            fetch: async (input, init) => {
                if (/^\/api\/spaces\/[^/]+\/(radar|memory)$/.test(input)) {
                    asked.push(input);
                    return answer(input);
                }
                return s.authed(input, init);
            },
            signal: s.scope.signal,
            cache: s.cache,
            scheduler: () => null,
            viewState: { get: () => null, set: () => {} },
            outbox: () => null,
        });
        stores.push(store);
        return store;
    };
    const close = s.close.bind(s);
    s.close = async (options) => {
        for (const store of stores) {
            await store.close();
        }
        await close(options);
    };
    await s.workspace.pull('', null);
    const onDisk = async () =>
        (await s.db.all<{ key: string }>('SELECT key FROM rows WHERE collection = ?', [SPACE_SECTIONS_KIND])).map(
            (row) => row.key,
        );
    return Object.assign(s, {
        makeStore,
        asked,
        onDisk,
        answer: (next: (path: string) => Response) => {
            answer = next;
        },
    });
}

describe('a Space’s radar and memory', () => {
    it('keys each by the Space’s body prefix and the section', () => {
        expect(spaceSectionKey('every day', 'radar')).toBe('every%20day/radar');
        expect(parseSpaceSectionKey('every%20day/memory')).toEqual({ spaceId: 'every day', section: 'memory' });
        expect(parseSpaceSectionKey('everyday/p1')).toBeNull();
        expect(parseSpaceSectionKey('a/b/radar')).toBeNull();
    });

    it('reads each as its tab holds it, keeps it on disk, and shows it offline in a new store with its age', async () => {
        const s = await setup();
        const pages = s.makeStore();
        const radar = spaceSection(pages.sections, 'everyday', 'radar');
        const release = radar.use();
        await vi.waitFor(() => expect(radar.state.value).toEqual({ section: 'radar', radar: RADAR }));
        expect(s.asked).toEqual(['/api/spaces/everyday/radar']);
        const memory = spaceSection(pages.sections, 'everyday', 'memory');
        const releaseMemory = memory.use();
        await vi.waitFor(() => expect(memory.state.value).toEqual({ section: 'memory', memory: MEMORY }));
        expect(s.asked).toEqual(['/api/spaces/everyday/radar', '/api/spaces/everyday/memory']);
        release();
        releaseMemory();
        await pages.flush();
        expect((await s.onDisk()).sort()).toEqual(['everyday/memory', 'everyday/radar']);

        s.answer(() => {
            throw new NetworkError('offline');
        });
        const cold = s.makeStore();
        const again = spaceSection(cold.sections, 'everyday', 'radar');
        const releaseAgain = again.use();
        await vi.waitFor(() => expect(again.state.settled).toBe(true));
        expect(again.state).toMatchObject({ failed: true, value: { section: 'radar', radar: RADAR } });
        expect(again.state.fetchedAt).not.toBeNull();
        releaseAgain();
    });

    it('drops the copy when the server says the Space isn’t there (404)', async () => {
        const s = await setup();
        const pages = s.makeStore();
        const memory = spaceSection(pages.sections, 'everyday', 'memory');
        let release = memory.use();
        await vi.waitFor(() => expect(memory.state.value).not.toBeNull());
        release();
        await pages.flush();
        expect(await s.onDisk()).toEqual(['everyday/memory']);

        s.answer(() => json({ error: 'Space not found.' }, 404));
        release = memory.use();
        await vi.waitFor(() => expect(memory.state.gone).toBe(true));
        expect(memory.state.value).toBeNull();
        release();
        await pages.flush();
        expect(await s.onDisk()).toEqual([]);
    });

    it('takes no body that isn’t its section', async () => {
        const s = await setup();
        const pages = s.makeStore();
        s.answer(() => json({ entries: [] }));
        const memory = spaceSection(pages.sections, 'everyday', 'memory');
        const release = memory.use();
        await vi.waitFor(() => expect(memory.state.settled).toBe(true));
        expect(memory.state.value).toBeNull();
        expect(memory.state.failed).toBe(true);
        release();
    });

    it('drops a lost Space’s radar and memory with its pages', async () => {
        const s = await setup();
        const pages = s.makeStore();
        for (const section of ['radar', 'memory'] as const) {
            const item = spaceSection(pages.sections, 'everyday', section);
            const release = item.use();
            await vi.waitFor(() => expect(item.state.value).not.toBeNull());
            release();
        }
        await pages.flush();
        expect(await s.onDisk()).toHaveLength(2);

        s.server.change('workspace', (data) => {
            data.spaces = [];
        });
        await s.workspace.pull('', s.workspace.cursor());
        await vi.waitFor(async () => expect(await s.onDisk()).toEqual([]));
    });

    it('drops them as the store opens when the Space went while the app was killed', async () => {
        const s = await setup();
        const pages = s.makeStore();
        const item = spaceSection(pages.sections, 'everyday', 'radar');
        const release = item.use();
        await vi.waitFor(() => expect(item.state.value).not.toBeNull());
        release();
        await pages.close();
        expect(await s.onDisk()).toEqual(['everyday/radar']);

        // The workspace stops listing it before any store hears the change.
        s.server.change('workspace', (data) => {
            data.spaces = [];
        });
        await s.workspace.pull('', s.workspace.cursor());
        await s.cache.flush();
        const next = s.makeStore();
        await next.flush();
        await vi.waitFor(async () => expect(await s.onDisk()).toEqual([]));
    });
});
