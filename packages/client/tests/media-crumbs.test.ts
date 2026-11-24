import { expect, it } from 'vitest';

import { collapseCrumbs } from '../src/modules/media/media-api';

it('keeps short breadcrumb trails whole', () => {
    expect(collapseCrumbs([])).toEqual({ hidden: [], shown: [] });
    expect(collapseCrumbs(['a/', 'a/b/', 'a/b/c/'])).toEqual({
        hidden: [],
        shown: ['a/', 'a/b/', 'a/b/c/'],
    });
});

it('collapses the earlier folders of a long trail', () => {
    expect(collapseCrumbs(['a/', 'a/b/', 'a/b/c/', 'a/b/c/d/'])).toEqual({
        hidden: ['a/', 'a/b/'],
        shown: ['a/b/c/', 'a/b/c/d/'],
    });
});
