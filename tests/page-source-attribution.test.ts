import { afterEach, expect, it } from 'vitest';

import { pageAccess } from '../src/server/pages/page-tools.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

/*
 * CB-328: structured source attribution on pages. `sourceUrl` and
 * `sourceTitle` are stored columns (migration v13) so "which pages came
 * from this source" is a query, not a content scan.
 */

const cleanup: Array<() => unknown> = [];
afterEach(() => {
    for (const fn of cleanup.splice(0)) {
        fn();
    }
});

function setup() {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    workspace.recordUser({ id: 'bob', name: 'Bob', role: 'member' });
    const space = workspace.spaces()[0].id;
    const dot = workspace.dots()[0];
    const thread = workspace.bindThread('t1', dot.id, 'Chat', 'bob');
    return { workspace, space, dot, thread };
}

it('stores sourceUrl and sourceTitle on a page and reads them back', async () => {
    const { workspace, space, thread } = setup();
    const access = pageAccess(workspace, space, thread.id, () => {});
    const page = await access.create({
        title: 'A post',
        content: 'Body',
        sourceUrl: 'https://example.com/post',
        sourceTitle: 'A post',
    });
    expect(page.sourceUrl).toBe('https://example.com/post');
    expect(page.sourceTitle).toBe('A post');

    const reread = await access.read(page.id, space);
    expect(reread.sourceUrl).toBe('https://example.com/post');
    expect(reread.sourceTitle).toBe('A post');
});

it('defaults sourceUrl and sourceTitle to null when not given', async () => {
    const { workspace, space, thread } = setup();
    const access = pageAccess(workspace, space, thread.id, () => {});
    const page = await access.create({ title: 'Plain', content: 'x' });
    expect(page.sourceUrl).toBeNull();
    expect(page.sourceTitle).toBeNull();
});

it('finds pages by sourceUrl via a direct query (not a content scan)', async () => {
    const { workspace, space, thread } = setup();
    const access = pageAccess(workspace, space, thread.id, () => {});
    await access.create({
        title: 'From a file',
        content: 'x',
        sourceUrl: 'file://uploads/notes.md',
        sourceTitle: 'notes.md',
    });
    const rows = workspace.db
        .prepare('SELECT id, title, sourceUrl, sourceTitle FROM pages WHERE sourceUrl=?')
        .all('file://uploads/notes.md');
    expect(rows).toHaveLength(1);
    expect(String(rows[0].sourceTitle)).toBe('notes.md');
});
