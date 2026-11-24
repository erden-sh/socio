import { expect, it } from 'vitest';

import {
    isChangeNote,
    liveTopicsOf,
    notesForWrite,
    topicMatches,
    type ChangeNote,
} from '@socio/shared/live/change-notes';

// What a write changed, by topic and id, and the topics a view shows that each
// note is for (CB-74).

it('names what a write changed, by topic and the ids in its path', () => {
    const cases: [string, ChangeNote[]][] = [
        ['/conversations', [{ topic: 'conversation' }]],
        ['/conversations/c1', [{ topic: 'conversation', id: 'c1' }]],
        ['/conversations/c1/page', [{ topic: 'conversation', id: 'c1' }, { topic: 'page' }]],
        ['/spaces', [{ topic: 'space' }]],
        ['/spaces/s1/pages', [{ topic: 'page', spaceId: 's1' }]],
        ['/spaces/s1/pages/p1?subpages=true', [{ topic: 'page', id: 'p1', spaceId: 's1' }]],
        ['/spaces/s1/pages/p1/conversation', [{ topic: 'page', id: 'p1', spaceId: 's1' }, { topic: 'conversation' }]],
        ['/memories/m1', [{ topic: 'memory', id: 'm1' }]],
        ['/tasks/t1/schedule', [{ topic: 'task', id: 't1' }, { topic: 'schedule' }]],
        ['/issues/12/comments/k1', [{ topic: 'issue', id: '12' }]],
        ['/issues', [{ topic: 'issue' }]],
        ['/approvals/a1/approve', [{ topic: 'approval', id: 'a1' }]],
        ['/approvals/policies', [{ topic: 'approval' }]],
        ['/schedules/x1/actions', [{ topic: 'schedule' }, { topic: 'task' }]],
        ['/settings', [{ topic: 'settings' }]],
        ['/dots/d1', [{ topic: 'dot', id: 'd1' }]],
        ['/dots/d1/computer/permissions', [{ topic: 'dot', id: 'd1' }]],
        ['/voice/calls/k1/end', [{ topic: 'call', id: 'k1' }]],
        ['/media/folders?path=Private%20notes', [{ topic: 'media' }]],
        ['/data/grants', [{ topic: 'data' }]],
    ];
    for (const [path, notes] of cases) {
        expect(notesForWrite(path), path).toEqual(notes);
    }
});

it('makes no note for writes nobody else shows', () => {
    for (const path of [
        '/auth/logout',
        '/auth/mock/login',
        '/data/views/query',
        '/data/datasets/x/query',
        '/dots/d1/computer/actions',
        '/spaces/s1/pages/p1/used',
        '/apps/a1/launch',
        '/something-new',
    ]) {
        expect(notesForWrite(path), path).toEqual([]);
    }
});

it('drops an id that could be anything but an id', () => {
    expect(notesForWrite(`/conversations/${encodeURIComponent('My plan')}`)).toEqual([{ topic: 'conversation' }]);
    expect(notesForWrite('/memories/%E0%A4%A')).toEqual([{ topic: 'memory' }]);
});

it('accepts a note and nothing more', () => {
    expect(isChangeNote({ topic: 'conversation', id: 'c1' })).toBe(true);
    expect(isChangeNote({ topic: 'page', id: 'p1', spaceId: 's1' })).toBe(true);
    for (const value of [
        { topic: 'conversation', id: 'c1', title: 'Quarterly plan' },
        { topic: 'conversation', id: 'Quarterly plan' },
        { topic: 'secrets' },
        ['conversation'],
        'conversation',
        null,
    ]) {
        expect(isChangeNote(value), JSON.stringify(value)).toBe(false);
    }
});

it('routes a note to the topics tabs show', () => {
    expect(liveTopicsOf({ topic: 'conversation', id: 'c1' })).toEqual(['shell', 'conversation:c1']);
    expect(liveTopicsOf({ topic: 'page', id: 'p1', spaceId: 's1' })).toEqual(['space:s1']);
    expect(liveTopicsOf({ topic: 'issue' })).toEqual(['issues', 'issue:*']);
    expect(liveTopicsOf({ topic: 'memory', id: 'm1' })).toEqual(['shell', 'memories']);
    expect(liveTopicsOf({ topic: 'setup' })).toEqual(['shell', 'setup']);
    expect(topicMatches('issue:12', 'issue:*')).toBe(true);
    expect(topicMatches('space:s2', 'space:s1')).toBe(false);
    expect(topicMatches('shell', '*')).toBe(true);
});
