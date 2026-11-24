import { expect, it } from 'vitest';

import { PALETTE_GROUP_LIMIT, type RankedEntry, searchCommands } from '@socio/shared/search/rank';

// The palette's ranking, shared by the web's ⌘K palette and the app's search.
// Moved from the client's suite.
interface Entry extends RankedEntry {
    id: string;
}

const entry = (label: string, extra: Partial<Entry> = {}): Entry => ({
    id: label,
    label,
    group: 'Things',
    ...extra,
});

it('searches by every word, best matches first', () => {
    const entries = [
        entry('Go to Memories', { group: 'Go to', keywords: ['preferences'] }),
        entry('Café notes', {
            group: 'Pages',
            hint: 'Everyday',
            searchOnly: true,
        }),
        entry('Login fails on Safari', {
            group: 'Issues',
            hint: 'CB-12',
            keywords: ['CB-12', 'open'],
            searchOnly: true,
        }),
        entry('Crash in CB-120 export', {
            group: 'Issues',
            hint: 'CB-120',
            keywords: ['CB-120'],
            searchOnly: true,
        }),
        entry('New chat with Fulano', { group: 'Socios', keywords: ['Fulano'] }),
    ];
    const labels = (query: string) => searchCommands(entries, query).map((item) => item.label);
    // Nothing typed: everything but search-only entries, in order.
    expect(labels('')).toEqual(['Go to Memories', 'New chat with Fulano']);
    // An issue by its key: the exact key first.
    expect(labels('cb-12')).toEqual(['Login fails on Safari', 'Crash in CB-120 export']);
    // Case, accents, keywords and hints; every word must match.
    expect(labels('cafe')).toEqual(['Café notes']);
    expect(labels('everyday notes')).toEqual(['Café notes']);
    expect(labels('preferences')).toEqual(['Go to Memories']);
    expect(labels('fulano chat')).toEqual(['New chat with Fulano']);
    expect(labels('safari export')).toEqual([]);
    // A prefix of the label ranks above a match inside it.
    expect(labels('n')[0]).toBe('New chat with Fulano');
    // Each group is capped while searching.
    const many = Array.from({ length: 20 }, (_, index) => entry(`Page ${index}`, { group: 'Pages' }));
    expect(searchCommands(many, 'page')).toHaveLength(PALETTE_GROUP_LIMIT);
});

it('ranks a word start above a match inside the label, and keeps ties in order', () => {
    const entries = [entry('Unread replies'), entry('Reading list'), entry('Weekly read-out'), entry('Thread view')];
    const labels = (query: string) => searchCommands(entries, query).map((item) => item.label);
    // "read": the prefix, then word starts in list order, then the match inside "Unread"/"Thread".
    expect(labels('read')).toEqual(['Reading list', 'Weekly read-out', 'Unread replies', 'Thread view']);
});

it('gives back the caller’s own objects', () => {
    const entries = [entry('Board', { id: 'issues' })];
    const [found] = searchCommands(entries, 'board');
    expect(found).toBe(entries[0]);
    expect(found?.id).toBe('issues');
});
