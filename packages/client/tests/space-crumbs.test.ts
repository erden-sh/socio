import { getI18n } from 'react-i18next';
import { expect, it } from 'vitest';

import type { HierarchyPage } from '@socio/shared/pages/page-hierarchy';

import { spaceHandle } from '../src/modules/spaces/handle';
import type { CrumbContext } from '../src/shell/shell-context';

const p = (id: string, parentId: string | null = null, spaceId = 's1'): HierarchyPage => ({
    id,
    parentId,
    spaceId,
    title: id,
});
const context = (extra: Partial<CrumbContext> = {}): CrumbContext => ({
    workspace: {
        spaces: [{ id: 's1', name: 'Everyday' }],
    } as CrumbContext['workspace'],
    admin: false,
    dot: {} as CrumbContext['dot'],
    params: { spaceId: 's1', pageId: 'leaf' },
    // The en-US instance tests/setup/en-us-i18n.ts sets up.
    t: getI18n().t,
    data: {
        spaceId: 's1',
        pages: [p('root'), p('child', 'root'), p('leaf', 'child')],
    },
    ...extra,
});
it('builds ancestor breadcrumb links from loader data, then uses scoped live renamed/draft ancestry', () => {
    expect(spaceHandle.crumb!(context())).toEqual([
        { label: 'Everyday', to: '/spaces/s1' },
        { label: 'root', to: '/spaces/s1/pages/root' },
        { label: 'child', to: '/spaces/s1/pages/child' },
        { label: 'leaf' },
    ]);
    expect(
        spaceHandle.crumb!(
            context({
                title: {
                    key: 'leaf',
                    title: 'New title',
                    ancestry: {
                        spaceId: 's1',
                        pages: [{ id: 'renamed', title: 'Renamed parent' }],
                    },
                },
            }),
        ),
    ).toEqual([
        { label: 'Everyday', to: '/spaces/s1' },
        { label: 'Renamed parent', to: '/spaces/s1/pages/renamed' },
        { label: 'New title' },
    ]);
});
it('ignores stale page/Space ancestry and never reads a foreign loader title', () => {
    for (const title of [
        {
            key: 'other',
            title: 'Stale',
            ancestry: { spaceId: 's1', pages: [{ id: 'secret', title: 'Secret' }] },
        },
        {
            key: 'leaf',
            title: 'Leaf',
            ancestry: {
                spaceId: 'private',
                pages: [{ id: 'secret', title: 'Secret' }],
            },
        },
    ]) {
        expect(spaceHandle.crumb!(context({ title })).some((c) => c.label === 'Secret')).toBe(false);
    }
    expect(spaceHandle.crumb!(context({ data: { pages: [p('leaf', null, 'private')] } })).at(-1)?.label).toBe('Pages');
});

it('keeps the Space library breadcrumb safe before any title is published', () => {
    expect(spaceHandle.crumb!(context({ params: { spaceId: 's1' }, data: null }))).toEqual([
        { label: 'Everyday', to: '/spaces/s1' },
        { label: 'Pages' },
    ]);
});
