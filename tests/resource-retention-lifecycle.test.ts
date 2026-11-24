import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it } from 'vitest';

import { makeTestRuntime } from './helpers/test-runtime.js';

const DAY = 86_400_000;
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) {
        await close();
    }
});

async function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'cb193-lifecycle-'));
    const database = join(dir, 'workspace.sqlite');
    // A connection each: the store's close must leave the workspace's open.
    const { store, workspace, dispose } = await makeTestRuntime({
        database: { store: join(dir, 'store.sqlite'), workspace: database },
        config: {
            data: { userDataDir: join(dir, 'userdata') },
            operations: { resources: { pageSearchDays: 9 } },
        },
    });
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    cleanup.push(dispose);
    const space = workspace.spaces()[0]!;
    await workspace.pages.create(space.id, {
        title: 'Retention lifecycle runbook',
        content: 'A searchable page.',
    });
    const oldDay = new Date(Date.now() - 5 * DAY).toISOString().slice(0, 10);
    const seedOld = () =>
        workspace.db
            .prepare(
                "INSERT OR REPLACE INTO page_search_daily(day,queries,empty,corrected,trigram,maxMs,histogram,sizes) VALUES (?,1,0,0,0,1,'{}','{}')",
            )
            .run(oldDay);
    const search = () =>
        workspace.pages.search({
            query: 'runbook',
            spaces: [space.id],
            now: Date.now(),
        });
    const retained = () => !!workspace.db.prepare('SELECT 1 FROM page_search_daily WHERE day=?').get(oldDay);
    const policy = (days: number) =>
        store.updateSettings({
            operations: { resources: { pageSearchDays: days } },
        });
    return {
        store,
        workspace,
        database,
        oldDay,
        seedOld,
        search,
        retained,
        policy,
    };
}

it('applies retention changes live rather than freezing the policy at platform creation', async () => {
    const f = await fixture();
    f.seedOld();
    await f.policy(0);
    f.search();
    f.workspace.pages.flushSearchStats();
    expect(f.retained()).toBe(true);
    await f.policy(1);
    f.search();
    f.workspace.pages.flushSearchStats();
    expect(f.retained()).toBe(false);
});

it.each([0, 1])('flushes after Store closes using the final %i-day policy', async (days) => {
    const f = await fixture();
    f.seedOld();
    f.search();
    // No policy consumer runs between this change and close: the final setting,
    // not the platform's default or the previous search's policy, must apply.
    await f.policy(days);
    f.store.close();
    expect(() => f.store.settings()).toThrow('database is not open');
    expect(() => f.workspace.close()).not.toThrow();
    const persisted = new DatabaseSync(f.database);
    try {
        expect(!!persisted.prepare('SELECT 1 FROM page_search_daily WHERE day=?').get(f.oldDay)).toBe(days === 0);
        expect(
            Number(persisted.prepare('SELECT SUM(queries) AS n FROM page_search_daily WHERE day<>?').get(f.oldDay)?.n),
        ).toBeGreaterThanOrEqual(1);
    } finally {
        persisted.close();
    }
});
