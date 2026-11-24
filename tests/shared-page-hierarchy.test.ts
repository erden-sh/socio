import { expect, it } from 'vitest';

import { pageAncestors, pageChildren, type HierarchyPage } from '@socio/shared/pages/page-hierarchy';

// The page tree the web and the app share.

const p = (id: string, parentId: string | null = null, spaceId = 's1'): HierarchyPage => ({
    id,
    parentId,
    spaceId,
    title: id,
});
it('resolves a root-first three-level trail and direct children without reordering the library', () => {
    const pages = [p('leaf', 'child'), p('other'), p('root'), p('child', 'root')];
    expect(pageAncestors(pages[0]!, pages).map((p) => p.id)).toEqual(['root', 'child']);
    expect(pageChildren(pages[2]!, pages).map((p) => p.id)).toEqual(['child']);
    expect(pageAncestors(pages[2]!, pages)).toEqual([]);
    expect(pages.map((p) => p.id)).toEqual(['leaf', 'other', 'root', 'child']);
});
it('does not fabricate ancestors from missing, cyclic, ambiguous or cross-space records', () => {
    for (const pages of [
        [p('a', 'missing')],
        [p('a', 'a')],
        [p('a', 'b'), p('b', 'a')],
        [p('a', 'b'), p('b', null, 'private')],
        [p('a', 'b'), p('b'), p('b')],
    ]) {
        expect(pageAncestors(pages[0]!, pages)).toEqual([]);
    }
    const cycle = [p('a', 'b'), p('b', 'a')];
    expect(pageChildren(cycle[0]!, cycle)).toEqual([]);
    expect(
        pageChildren(p('a'), [p('private', 'a', 'private'), p('a', 'a'), p('child', 'a'), p('child', 'a')]).map(
            (p) => p.id,
        ),
    ).toEqual(['child']);
});
it('keeps legitimate orphan child navigation scoped to this Space', () => {
    const orphan = p('orphan', 'missing'),
        pages = [orphan, p('child', 'orphan'), p('foreign', 'orphan', 'private')];
    expect(pageChildren(orphan, pages).map((p) => p.id)).toEqual(['child']);
});
