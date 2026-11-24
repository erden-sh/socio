import { afterEach, expect, it } from 'vitest';

import type { PageLink } from '../src/server/pages/contract.js';
import { pageAccess, pageTools } from '../src/server/pages/page-tools.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

/*
 * CB-328: the page knowledge graph — tags and typed edges on Space pages.
 * Tag names are workspace-global; membership is gated by Space access
 * (pageAccess). Edges are typed and cross-Space; backlinks derive from
 * page_links, not content scraping.
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

// ---- Tags ----------------------------------------------------------------

it('tags a page, lists its tags, and removes one (idempotent)', async () => {
    const { workspace, space, thread } = setup();
    const access = pageAccess(workspace, space, thread.id, () => {});
    const page = await access.create({ title: 'Notes', content: 'Body' });

    const tagged = await access.tag(page.id, 'research', space);
    expect(tagged.tag).toBe('research');
    expect(tagged.createdBy).toBe(`dot:${workspace.dots()[0].id}`);

    // Idempotent: re-tagging keeps the same row (no duplicate, no error).
    const again = await access.tag(page.id, 'research', space);
    expect(again.createdAt).toBe(tagged.createdAt);

    // A second tag coexists.
    await access.tag(page.id, 'ai', space);
    const tags = workspace.pages.tagsOf(space, page.id).map((t) => t.tag);
    expect(tags).toEqual(['ai', 'research']);

    // Untagging one; idempotent the second time.
    expect(await access.untag(page.id, 'research', space)).toBe(true);
    expect(await access.untag(page.id, 'research', space)).toBe(false);
    expect(workspace.pages.tagsOf(space, page.id).map((t) => t.tag)).toEqual(['ai']);
});

it('lists pages by tag across readable Spaces, excluding deleted pages', async () => {
    const { workspace, space, thread } = setup();
    const access = pageAccess(workspace, space, thread.id, () => {});
    const a = await access.create({ title: 'A', content: 'a' });
    const b = await access.create({ title: 'B', content: 'b' });
    await access.tag(a.id, 'topic', space);
    await access.tag(b.id, 'topic', space);

    const found = access
        .pagesByTag('topic')
        .map((p) => p.id)
        .sort();
    expect(found).toEqual([a.id, b.id].sort());

    // A deleted page drops out of the tag listing.
    await workspace.pages.delete(space, a.id, { by: 'bob' });
    expect(access.pagesByTag('topic').map((p) => p.id)).toEqual([b.id]);
});

it('refuses to tag a page in a Space the socio cannot read', async () => {
    const { workspace, space, thread } = setup();
    const access = pageAccess(workspace, 'no-such-space', thread.id, () => {});
    const page = await workspace.pages.create(space, { title: 'P' });
    await expect(access.tag(page.id, 'x', 'no-such-space')).rejects.toThrow(
        'Space access has been revoked or was not granted.',
    );
});

it('exposes tag tools in pageTools', () => {
    const { workspace, space, thread } = setup();
    const access = pageAccess(workspace, space, thread.id, () => {});
    const names = pageTools(access).map((t) => t.name);
    expect(names).toContain('tag_page');
    expect(names).toContain('untag_page');
    expect(names).toContain('list_pages_by_tag');
});

// ---- Links ---------------------------------------------------------------

it('creates a typed edge, lists outgoing and backlinks, and removes it (idempotent)', async () => {
    const { workspace, space, thread } = setup();
    const access = pageAccess(workspace, space, thread.id, () => {});
    const index = await access.create({ title: 'Index' });
    const child = await access.create({ title: 'Child' });

    const edge = await access.link({ spaceId: space, pageId: index.id }, { spaceId: space, pageId: child.id }, 'index');
    expect(edge.kind).toBe('index');
    expect(edge.fromPageId).toBe(index.id);
    expect(edge.toPageId).toBe(child.id);
    expect(edge.createdBy).toBe(`dot:${workspace.dots()[0].id}`);

    // Idempotent: re-linking the same kind keeps the same edge.
    const again = await access.link(
        { spaceId: space, pageId: index.id },
        { spaceId: space, pageId: child.id },
        'index',
    );
    expect(again.id).toBe(edge.id);

    // A different kind is a distinct edge.
    const related = await access.link(
        { spaceId: space, pageId: index.id },
        { spaceId: space, pageId: child.id },
        'related',
    );
    expect(related.id).not.toBe(edge.id);

    const out = access.linksFrom(index.id, space) as PageLink[];
    expect(out.map((l) => l.kind).sort()).toEqual(['index', 'related']);

    const back = access.backlinks(child.id, space) as PageLink[];
    expect(back.map((l) => l.kind).sort()).toEqual(['index', 'related']);

    // Remove one; idempotent.
    expect(
        await access.unlink({ spaceId: space, pageId: index.id }, { spaceId: space, pageId: child.id }, 'index'),
    ).toBe(true);
    expect(
        await access.unlink({ spaceId: space, pageId: index.id }, { spaceId: space, pageId: child.id }, 'index'),
    ).toBe(false);
    expect(access.linksFrom(index.id, space).map((l) => l.kind)).toEqual(['related']);
    expect(access.backlinks(child.id, space).map((l) => l.kind)).toEqual(['related']);
});

it('creates a cross-Space edge (both Spaces must be readable)', async () => {
    const { workspace, space, dot, thread } = setup();
    const second = workspace.createSpace('Other', '').id;
    // Grant the second Space to this socio so `pageAccess` may read it.
    workspace.updateDot(dot.id, {
        name: dot.name,
        researchAllowed: dot.researchAllowed,
        memoryAllowed: dot.memoryAllowed,
        spaceId: space,
        spaceIds: [space, second],
    });
    const access = pageAccess(workspace, space, thread.id, () => {});
    const here = await access.create({ title: 'Here' });
    const there = await workspace.pages.create(second, { title: 'There' });

    const edge = await access.link({ spaceId: space, pageId: here.id }, { spaceId: second, pageId: there.id }, 'cites');
    expect(edge.fromSpaceId).toBe(space);
    expect(edge.toSpaceId).toBe(second);

    // Backlinks from the target's Space see the cross-Space edge.
    const back = access.backlinks(there.id, second) as PageLink[];
    expect(back).toHaveLength(1);
    expect(back[0].fromSpaceId).toBe(space);
});

it('refuses to link a page in a Space the socio cannot read', async () => {
    const { workspace, space, dot, thread } = setup();
    // A second Space this socio is NOT granted (pageAccess will reject it).
    const other = workspace.createSpace('Other', '').id;
    expect(workspace.canAccessSpace(dot.id, other)).toBe(false);
    const access = pageAccess(workspace, space, thread.id, () => {});
    const a = await workspace.pages.create(space, { title: 'A' });
    const b = await workspace.pages.create(other, { title: 'B' });
    await expect(
        access.link({ spaceId: space, pageId: a.id }, { spaceId: other, pageId: b.id }, 'related'),
    ).rejects.toThrow('Space access has been revoked or was not granted.');
});

it('refuses a self-link (fromPageId === toPageId) at the store level', async () => {
    const { workspace, space } = setup();
    const page = await workspace.pages.create(space, { title: 'Self' });
    // The CHECK constraint on page_links rejects a self-edge.
    await expect(
        workspace.pages.linkPages({ spaceId: space, pageId: page.id }, { spaceId: space, pageId: page.id }, 'related'),
    ).rejects.toThrow();
});

it('exposes link tools in pageTools', () => {
    const { workspace, space, thread } = setup();
    const access = pageAccess(workspace, space, thread.id, () => {});
    const names = pageTools(access).map((t) => t.name);
    expect(names).toContain('link_pages');
    expect(names).toContain('unlink_pages');
    expect(names).toContain('list_links');
    expect(names).toContain('backlinks');
});
