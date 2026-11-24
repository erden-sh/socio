import { expect, it } from 'vitest';

import type { Page } from '@socio/shared/pages/page-library';

import { mergePageSnapshot } from '../../packages/client/src/modules/pages/page-snapshots';

const base: Page = {
    id: 'existing',
    spaceId: 'space',
    parentId: null,
    title: 'Existing',
    content: '',
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
    sourceThreadId: null,
    createdBy: null,
    cover: null,
    sourceUrl: null,
    sourceTitle: null,
};
it('retains a newly created document when an earlier list response arrives after creation', async () => {
    let resolve!: (pages: Page[]) => void;
    const olderRead = new Promise<Page[]>((done) => {
        resolve = done;
    });
    let pages = [base];
    const created = { ...base, id: 'new-page', title: 'New page' };
    const pending = olderRead.then((snapshot) => {
        pages = mergePageSnapshot(pages, snapshot, {
            fresh: new Set([created.id]),
        });
    });
    pages = [...pages, created];
    const selectedId = created.id;
    resolve([base]);
    await pending;
    expect(pages.find((page) => page.id === selectedId)).toBe(created);
    expect(pages).toHaveLength(2);
});
it('retains locally saved revisions while accepting newer remote pages', () => {
    const local = { ...base, revision: 3, content: 'Saved locally' };
    const remote = { ...base, id: 'remote', content: 'Other page' };
    expect(mergePageSnapshot([local], [base, remote])).toEqual([local, remote]);
    expect(mergePageSnapshot([local], [{ ...base, revision: 4, content: 'Latest' }])[0].content).toBe('Latest');
});
it('drops a page deleted elsewhere and never brings back one deleted here', () => {
    const other = { ...base, id: 'other' };
    const mine = { ...base, id: 'mine' };
    // Someone else deleted `other`: the poll no longer has it.
    expect(mergePageSnapshot([base, other], [base])).toEqual([base]);
    // A poll in flight while `mine` was deleted here still lists it.
    expect(mergePageSnapshot([base], [base, mine], { deleted: new Set(['mine']) })).toEqual([base]);
    // Keeps the server's order, and fresh pages only while they are missing.
    const created = { ...base, id: 'created' };
    expect(
        mergePageSnapshot([created, base], [base], {
            fresh: new Set(['created']),
        }).map((page) => page.id),
    ).toEqual(['existing', 'created']);
});
it('takes a cover changed elsewhere at the same revision, and keeps one changed here (CB-308)', () => {
    const covered: Page = { ...base, updatedAt: 5, cover: { id: 'emb', url: '/api/media/embeds/emb/content' } };
    // Another tab set a cover: not a revision, but a newer change.
    expect(mergePageSnapshot([base], [covered])).toEqual([covered]);
    // A poll from before this tab's change doesn't undo it.
    expect(mergePageSnapshot([covered], [base])).toEqual([covered]);
    // Removed here: the local copy, as new as the poll, stays.
    const removed = { ...covered, cover: null };
    expect(mergePageSnapshot([removed], [covered])).toEqual([removed]);
});
