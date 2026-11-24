import { afterEach, expect, it } from 'vitest';

import type { SpaceRadar } from '@socio/shared/pages/page-radar';

import { staticAuth } from './fixtures/static-auth.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

/** Signed in as the owner (admin) for every request (staticAuth). */
async function fixture() {
    const {
        workspace: ws,
        platform,
        app,
        dispose,
    } = await makeTestRuntime({
        config: { baseUrl: 'https://example.com', runtimeUrl: '' },
        app: { auth: staticAuth() },
    });
    cleanup.push(dispose);
    return { ws, platform, app };
}

const DAY = 24 * 60 * 60_000;
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;

/** Creates a page in the Space, optionally with backdated timestamps. */
async function makePage(
    app: Awaited<ReturnType<typeof fixture>>['app'],
    space: string,
    opts: { title: string; content?: string; parentId?: string | null } = {
        title: 'Page',
    },
) {
    const res = await app.request(`/api/spaces/${space}/pages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            title: opts.title,
            content: opts.content ?? '',
            parentId: opts.parentId ?? null,
        }),
    });
    return (await res.json()) as { id: string; updatedAt: number };
}

it('renders recent changes, flags stale pages by age, links to pages, and is read-gated', async () => {
    const { ws, app } = await fixture();
    const space = ws.spaces()[0].id;

    // A fresh page (today) that carries an open-decision marker.
    const open = await makePage(app, space, {
        title: 'Launch decision',
        content: 'We need to decide on the launch date. TBD next week.',
    });
    // A stale page: backdate its updatedAt through the store so the radar
    // sees it as old without waiting.
    const stale = await makePage(app, space, {
        title: 'Old research notes',
        content: 'Notes from the first spike.',
    });
    const fresh = await makePage(app, space, {
        title: 'Current sprint',
        content: 'In progress.',
    });
    // Backdate the stale page's updatedAt to 60 days ago.
    // Direct SQL backdate: the radar reads `updatedAt` from the row, and the
    // store has no public way to backdate — poke it for the test only.
    ws.db.prepare('UPDATE pages SET updatedAt = ? WHERE id = ?').run(Date.now() - 60 * DAY, stale.id);

    // The radar view for the Space.
    const radar = await json<SpaceRadar>(app.request(`/api/spaces/${space}/radar`));
    expect(radar.spaceId).toBe(space);
    expect(radar.total).toBe(3);

    // Recent changes: all three pages, newest first (limit is 12).
    const recentIds = radar.recent.map((p) => p.id);
    expect(recentIds).toContain(fresh.id);
    expect(recentIds).toContain(open.id);
    expect(recentIds).toContain(stale.id);
    // The newest page (created last) comes before the stale one.
    expect(recentIds.indexOf(fresh.id)).toBeLessThan(recentIds.indexOf(stale.id));

    // Open decisions: the launch-decision page is flagged with markers.
    const openHit = radar.open.find((p) => p.id === open.id);
    expect(openHit, 'open-decision page should be flagged').toBeDefined();
    expect(openHit!.markers).toEqual(expect.arrayContaining(['decision', 'decide', 'tbd']));
    // The plain pages are not flagged.
    expect(radar.open.find((p) => p.id === fresh.id)).toBeUndefined();

    // Stale: the backdated page is older than the threshold, oldest first.
    const staleHit = radar.stale.find((p) => p.id === stale.id);
    expect(staleHit, 'stale page should be flagged').toBeDefined();
    expect(staleHit!.ageDays).toBeGreaterThanOrEqual(60);
    // The fresh page is not stale.
    expect(radar.stale.find((p) => p.id === fresh.id)).toBeUndefined();

    // Every recent entry has a non-empty title and a recent updatedAt.
    for (const entry of radar.recent) {
        expect(entry.title).toBeTruthy();
        expect(entry.updatedAt).toBeGreaterThan(0);
    }

    // Read-gate: an unknown Space is a 404 (same word as a missing one).
    const missing = await app.request('/api/spaces/does-not-exist/radar');
    expect(missing.status).toBe(404);
});

it('scopes the radar to a subtree when a root page is given', async () => {
    const { ws, app } = await fixture();
    const space = ws.spaces()[0].id;
    const parent = await makePage(app, space, { title: 'Project root' });
    const child = await makePage(app, space, {
        title: 'Child experiment',
        content: 'An experiment to try.',
        parentId: parent.id,
    });
    // A sibling outside the subtree.
    await makePage(app, space, { title: 'Unrelated page' });

    const radar = await json<SpaceRadar>(
        app.request(`/api/spaces/${space}/radar?root=${encodeURIComponent(parent.id)}`),
    );
    expect(radar.total).toBe(2);
    const ids = [...radar.recent.map((p) => p.id), ...radar.open.map((p) => p.id)];
    expect(ids).toContain(parent.id);
    expect(ids).toContain(child.id);
    // The sibling is out of scope.
    expect(radar.recent.some((p) => p.title === 'Unrelated page')).toBe(false);
    // The child carries the experiment marker.
    expect(radar.open.find((p) => p.id === child.id)?.markers).toContain('experiment');
});

it('respects a custom staleDays threshold', async () => {
    const { ws, app } = await fixture();
    const space = ws.spaces()[0].id;
    const page = await makePage(app, space, { title: 'Slightly old' });
    // Backdate to 5 days ago.
    ws.db.prepare('UPDATE pages SET updatedAt = ? WHERE id = ?').run(Date.now() - 5 * DAY, page.id);
    // Default threshold (30 days): not stale.
    const def = await json<SpaceRadar>(app.request(`/api/spaces/${space}/radar`));
    expect(def.stale.find((p) => p.id === page.id)).toBeUndefined();
    // Custom threshold (3 days): stale.
    const tight = await json<SpaceRadar>(app.request(`/api/spaces/${space}/radar?staleDays=3`));
    expect(tight.staleDays).toBe(3);
    expect(tight.stale.find((p) => p.id === page.id)).toBeDefined();
});
