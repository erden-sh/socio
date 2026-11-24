// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';

import {
    DRAFT_KEY_PREFIX,
    DRAFTS_KEPT,
    chatDraft,
    forgetDrafts,
    markSending,
    newChatDraft,
    readDraft,
    recentDrafts,
    RECENT_DRAFT_MS,
    SENDS_KEPT,
    settleSending,
    writeDraft,
} from '../src/modules/chat/chat-drafts';

// CB-153: the draft store under the composers.
beforeEach(() => {
    localStorage.clear();
    forgetDrafts();
    vi.useRealTimers();
});

it('keeps one draft per chat and per Dot’s new chat, per person', () => {
    writeDraft('bob', chatDraft('c1'), 'one');
    writeDraft('bob', newChatDraft('d1'), 'two');
    expect(readDraft('bob', chatDraft('c1')).text).toBe('one');
    expect(readDraft('bob', newChatDraft('d1')).text).toBe('two');
    expect(Object.keys(localStorage).sort()).toEqual([
        `${DRAFT_KEY_PREFIX}bob:chat:c1`,
        `${DRAFT_KEY_PREFIX}bob:new:d1`,
    ]);
    // Another person never reads them, and their first use drops them.
    expect(readDraft('alice', chatDraft('c1')).text).toBe('');
    expect(Object.keys(localStorage)).toEqual([]);
});

it('remembers a send until it settles, and gives its text back after what the box holds', () => {
    markSending('bob', chatDraft('c1'), 'm1', 'Hello');
    expect(readDraft('bob', chatDraft('c1'))).toMatchObject({
        text: '',
        sending: [{ id: 'm1', text: 'Hello' }],
    });
    // Another send's settling leaves it.
    settleSending('bob', chatDraft('c1'), 'm0', true);
    expect(readDraft('bob', chatDraft('c1')).sending).toEqual([{ id: 'm1', text: 'Hello' }]);
    settleSending('bob', chatDraft('c1'), 'm1', true);
    expect(readDraft('bob', chatDraft('c1'))).toEqual({
        text: 'Hello',
        at: expect.any(Number),
    });
    writeDraft('bob', chatDraft('c1'), '');
    markSending('bob', chatDraft('c1'), 'm2', 'Again');
    writeDraft('bob', chatDraft('c1'), 'Typed since');
    // Never instead of it (CB-154): after it.
    settleSending('bob', chatDraft('c1'), 'm2', true);
    expect(readDraft('bob', chatDraft('c1')).text).toBe('Typed since\n\nAgain');
    writeDraft('bob', chatDraft('c1'), '');
    markSending('bob', chatDraft('c1'), 'm3', 'Arrived');
    settleSending('bob', chatDraft('c1'), 'm3', false);
    expect(localStorage.length).toBe(0);
});

it(`keeps up to ${SENDS_KEPT} sends at once; an older one's text goes back in the box (CB-154)`, () => {
    const scope = chatDraft('c1');
    markSending('bob', scope, 'a', 'First');
    markSending('bob', scope, 'b', 'Second');
    expect(readDraft('bob', scope).sending!.map((sent) => sent.id)).toEqual(['a', 'b']);
    // A retry keeps what the box holds.
    writeDraft('bob', scope, 'Typing');
    markSending('bob', scope, 'a', 'First', true);
    expect(readDraft('bob', scope)).toMatchObject({
        text: 'Typing',
        sending: [
            { id: 'b', text: 'Second' },
            { id: 'a', text: 'First' },
        ],
    });
    writeDraft('bob', scope, '');
    // One more than it keeps: the oldest's text is in the box, to send again.
    for (let i = 0; i < SENDS_KEPT - 1; i++) {
        markSending('bob', scope, `n${i}`, `More ${i}`);
    }
    expect(readDraft('bob', scope).sending).toHaveLength(SENDS_KEPT);
    expect(readDraft('bob', scope).text).toBe('Second');
});

it('reads a send kept by the first version', () => {
    localStorage.setItem(
        `${DRAFT_KEY_PREFIX}bob:chat:c1`,
        JSON.stringify({ text: '', at: 1, sending: { id: 'm1', text: 'Old' } }),
    );
    expect(readDraft('bob', chatDraft('c1')).sending).toEqual([{ id: 'm1', text: 'Old' }]);
});

it(`keeps a person's newest ${DRAFTS_KEPT} drafts`, () => {
    vi.useFakeTimers();
    for (let i = 0; i <= DRAFTS_KEPT; i++) {
        vi.setSystemTime(1000 + i);
        writeDraft('bob', chatDraft(`c${i}`), `draft ${i}`);
    }
    expect(localStorage.length).toBe(DRAFTS_KEPT);
    expect(localStorage.getItem(`${DRAFT_KEY_PREFIX}bob:chat:c0`)).toBeNull();
    expect(readDraft('bob', chatDraft(`c${DRAFTS_KEPT}`)).text).toBe(`draft ${DRAFTS_KEPT}`);
});

it('reads another tab’s change, and ignores what it cannot read', () => {
    expect(readDraft('bob', chatDraft('c1')).text).toBe('');
    const key = `${DRAFT_KEY_PREFIX}bob:chat:c1`;
    localStorage.setItem(key, JSON.stringify({ text: 'From tab B', at: 2 }));
    window.dispatchEvent(new StorageEvent('storage', { key }));
    expect(readDraft('bob', chatDraft('c1')).text).toBe('From tab B');
    localStorage.setItem(key, '{not json');
    window.dispatchEvent(new StorageEvent('storage', { key }));
    expect(readDraft('bob', chatDraft('c1')).text).toBe('');
});

it('lists only unsent drafts less than a day old, newest first; untimed ones are old (CB-171)', () => {
    const now = 10 * RECENT_DRAFT_MS;
    const put = (scope: string, value: object) =>
        localStorage.setItem(`${DRAFT_KEY_PREFIX}bob:${scope}`, JSON.stringify(value));
    put('chat:fresh', { text: 'hi', at: now - 1000 });
    put('chat:fresher', { text: 'yo', at: now - 10 });
    put('chat:old', { text: 'old', at: now - RECENT_DRAFT_MS - 1 });
    put('chat:untimed', { text: 'from before timestamps' });
    put('chat:blank', { text: '  ', at: now - 5 });
    put('new:d1', {
        text: '',
        at: now - 2000,
        sending: [{ id: 'm', text: 'x' }],
    });
    expect(recentDrafts('bob', now).map((draft) => draft.scope)).toEqual(['chat:fresher', 'chat:fresh', 'new:d1']);
    // Nobody else's.
    expect(recentDrafts('alice', now)).toEqual([]);
});
