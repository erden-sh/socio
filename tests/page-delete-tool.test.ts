import { afterEach, expect, it } from 'vitest';

import { pageAccess, pageTools } from '../src/server/pages/page-tools.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

/*
 * CB-328: the socio's `delete_space_page` tool. Soft-deletes a page the
 * person it acts for created (or one in a Space they may edit). Refuses
 * a page with subpages unless `subpages` is set. Refuses a page someone
 * else created.
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
    workspace.recordUser({ id: 'dave', name: 'Dave', role: 'member' });
    const space = workspace.spaces()[0].id;
    const dot = workspace.dots()[0];
    const bobThread = workspace.bindThread('t-bob', dot.id, 'Chat', 'bob');
    const daveThread = workspace.bindThread('t-dave', dot.id, 'Chat', 'dave');
    return { workspace, space, dot, bobThread, daveThread };
}

it('deletes a page the person created, and refuses one someone else created', async () => {
    const { workspace, space, bobThread, daveThread } = setup();
    const bob = pageAccess(workspace, space, bobThread.id, () => {});
    const dave = pageAccess(workspace, space, daveThread.id, () => {});

    const bobs = await bob.create({ title: "Bob's notes" });
    expect(bobs.createdBy).toBe('bob');
    // Bob can delete his own page.
    const result = await bob.delete(bobs.id, space);
    expect(result.deleted).toEqual([bobs.id]);
    expect(() => workspace.pages.get(space, bobs.id)).toThrow('This page was deleted.');

    // Dave creates a page; bob may not delete it.
    const daves = await dave.create({ title: "Dave's plan" });
    expect(daves.createdBy).toBe('dave');
    await expect(bob.delete(daves.id, space)).rejects.toThrow(
        'Only an admin or the person who created this page can delete it.',
    );
    // Dave can.
    expect((await dave.delete(daves.id, space)).deleted).toEqual([daves.id]);
});

it('refuses a page with subpages unless subpages is true', async () => {
    const { workspace, space, bobThread } = setup();
    const bob = pageAccess(workspace, space, bobThread.id, () => {});
    const root = await bob.create({ title: 'Root' });
    const child = await bob.create({ title: 'Child', parentId: root.id });
    expect(child.createdBy).toBe('bob');

    await expect(bob.delete(root.id, space)).rejects.toThrow('subpage');
    // With subpages, both go.
    const result = await bob.delete(root.id, space, true);
    expect(result.deleted.sort()).toEqual([root.id, child.id].sort());
});

it('exposes the delete tool in pageTools', () => {
    const { workspace, space, bobThread } = setup();
    const access = pageAccess(workspace, space, bobThread.id, () => {});
    expect(pageTools(access).map((t) => t.name)).toContain('delete_space_page');
});
