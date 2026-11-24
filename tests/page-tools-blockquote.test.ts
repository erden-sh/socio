import { afterEach, expect, it } from 'vitest';

import { pageAccess, pageTools } from '../src/server/pages/page-tools.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

// CB-201: a socio's page text is saved with Markdown quotes, not HTML.
const cleanup: Array<() => unknown> = [];
afterEach(() => {
    for (const fn of cleanup.splice(0)) {
        fn();
    }
});

it('saves a socio-written <blockquote> as Markdown and tells socios not to write it', async () => {
    const workspace = new WorkspaceStore(testDatabase());
    workspace.recordUser({ id: 'bob', name: 'Bob', role: 'member' });
    cleanup.push(() => workspace.close());
    const space = workspace.spaces()[0].id;
    const dot = workspace.dots()[0];
    workspace.bindThread('t1', dot.id, 'Chat', 'bob');
    const access = pageAccess(workspace, space, 't1', () => {});
    const created = await access.create({
        title: 'Post',
        content: '<blockquote>\nHello **world**\n</blockquote>',
        parentId: null,
    });
    expect(workspace.pages.get(space, created.id).content).toBe('> Hello **world**');
    await access.edit(created.id, {
        content: 'Intro\n\n<blockquote>a<br>b</blockquote>',
        expectedRevision: workspace.pages.get(space, created.id).revision,
    });
    expect(workspace.pages.get(space, created.id).content).toBe('Intro\n\n> a\\\n> b');
    for (const name of ['create_space_page', 'edit_space_page']) {
        expect(pageTools(access).find((tool) => tool.name === name)?.description).toMatch(/Markdown blockquotes?/);
    }
});
