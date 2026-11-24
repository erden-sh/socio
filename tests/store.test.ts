import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { pageAccess } from '../src/server/pages/page-tools.js';

import { Store, WorkspaceStore } from './helpers/stores.js';
import { testDatabaseFile } from './helpers/test-database.js';

const resources: { store: Store; dir: string }[] = [];
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'company-brain-'));
    const path = testDatabaseFile(join(dir, 'test.sqlite'));
    const store = new Store(path);
    resources.push({ store, dir });
    return { store, path };
}
afterEach(() =>
    resources.splice(0).forEach(({ store, dir }) => {
        store.close();
        rmSync(dir, { recursive: true, force: true });
    }),
);
describe('durable task lifecycle', () => {
    it('persists tasks and settings across connections', async () => {
        const { store, path } = fixture();
        const task = await store.createTask('Compare the sample notebooks', 60, 'owner');
        await store.updateSettings({ name: 'Sam' });
        const reopened = new Store(path);
        expect((await reopened.task(task.id))?.prompt).toBe(task.prompt);
        expect(reopened.settings().name).toBe('Sam');
        reopened.close();
    });
    it('claims each due job once even through separate database connections', async () => {
        const { store, path } = fixture();
        await store.createTask('Research one', null, 'owner');
        const second = new Store(path);
        const firstClaim = await store.claim(1000);
        expect(firstClaim).toBeTruthy();
        expect(await second.claim(1000)).toBeNull();
        second.close();
    });
    it('never overwrites a cancellation with a late result', async () => {
        const { store } = fixture();
        const task = await store.createTask('Research one', null, 'owner');
        const claim = (await store.claim(Date.now()))!;
        await store.action(task.id, 'cancel');
        expect(
            await store.finish(claim, {
                text: 'Late result',
                sources: [],
                sample: true,
            }),
        ).toBe(false);
        expect((await store.task(task.id))?.status).toBe('cancelled');
    });
    it('keeps recurring history and schedules only after completion', async () => {
        const { store } = fixture();
        const task = await store.createTask('Recurring research', 60, 'owner');
        const now = Date.now();
        const claim = (await store.claim(now))!;
        await store.finish(claim, { text: 'First result', sources: [], sample: true }, now);
        expect(await store.claim(now + 59_000)).toBeNull();
        expect((await store.claim(now + 60_001))?.id).toBe(task.id);
        expect((await store.detail(task.id))?.runs).toHaveLength(2);
    });
    it('global pause invalidates running leases and blocks queued jobs', async () => {
        const { store } = fixture();
        const task = await store.createTask('Research one', null, 'owner');
        const claim = (await store.claim(Date.now()))!;
        await store.updateSettings({ paused: true });
        expect(await store.claim(Date.now())).toBeNull();
        expect(
            await store.finish(claim, {
                text: 'Late result',
                sources: [],
                sample: true,
            }),
        ).toBe(false);
        await store.updateSettings({ paused: false });
        expect(await store.claim(Date.now())).toBeNull();
        expect((await store.task(task.id))?.status).toBe('interrupted');
        await store.action(task.id, 'run');
        expect((await store.claim(Date.now()))?.id).toBe(task.id);
    });
    it('holds expired work until the owner retries it', async () => {
        const { store, path } = fixture();
        await store.createTask('Recover me', null, 'owner');
        const now = Date.now();
        const old = (await store.claim(now))!;
        const restarted = new Store(path);
        try {
            expect(await restarted.claim(now + 180_001)).toBeNull();
            expect((await restarted.task(old.id))?.status).toBe('interrupted');
            expect((await restarted.detail(old.id))?.runs[0].status).toBe('interrupted');
            await restarted.action(old.id, 'run');
            const recovered = (await restarted.claim(now + 180_001))!;
            expect(recovered.id).toBe(old.id);
            expect(recovered.lease).not.toBe(old.lease);
            expect(await store.finish(old, { text: 'Old', sources: [], sample: true })).toBe(false);
            expect(
                await restarted.finish(recovered, {
                    text: 'New',
                    sources: [],
                    sample: true,
                }),
            ).toBe(true);
        } finally {
            restarted.close();
        }
    });
    it('claims other queued work while an expired run waits for review', async () => {
        const { store } = fixture();
        const interrupted = await store.createTask('Create the first page', null, 'owner');
        const now = Date.now();
        const old = (await store.claim(now))!;
        const next = await store.createTask('Research another topic', null, 'owner');

        expect((await store.claim(now + 180_001))?.id).toBe(next.id);
        expect((await store.task(interrupted.id))?.status).toBe('interrupted');
        expect((await store.detail(interrupted.id))?.runs[0].status).toBe('interrupted');
        expect(await store.finish(old, { text: 'Late', sources: [], sample: true })).toBe(false);
    });
    it('holds an expired run for review after a local page effect', async () => {
        const { store, path } = fixture();
        const workspace = new WorkspaceStore(path);
        try {
            const dot = workspace.dots()[0];
            workspace.recordUser({ id: 'owner', name: 'Owner', role: 'member' });
            const thread = workspace.bindThread('scheduled-thread', dot.id, 'Scheduled work', 'owner');
            const task = await store.createTask('Create the sample page once', null, 'owner');
            await workspace.bindTask(task.id, thread.id);
            const now = Date.now();
            const old = (await store.claim(now))!;
            const pages = pageAccess(workspace, dot.spaceId, thread.id, () => {});
            await pages.create({
                title: 'Sample',
                content: 'Synthetic fixture body',
            });

            expect(await store.claim(now + 180_001)).toBeNull();
            expect((await store.task(task.id))?.status).toBe('interrupted');
            expect((await store.detail(task.id))?.runs[0].status).toBe('interrupted');
            expect(workspace.pages.list(dot.spaceId)).toHaveLength(1);
            expect(await store.finish(old, { text: 'Late', sources: [], sample: true })).toBe(false);

            await store.action(task.id, 'run');
            expect((await store.claim(now + 180_002))?.id).toBe(task.id);
        } finally {
            workspace.close();
        }
    });
});
