import { describe, expect, it } from 'vitest';

import type { RadarEntry, SpaceRadar } from '@socio/shared/pages/page-radar';
import type { SpaceMemoryState, SpaceMemoryView } from '@socio/shared/space-memory';

import { OPEN_ONLINE } from '../../src/shell/page-reader';
import {
    memoryView,
    provenance,
    radarView,
    sectionStatus,
    SPACE_TABS,
    spaceSectionPath,
    staleAge,
} from '../../src/shell/space-sections';
import type { BoundedItemState } from '../../src/sync/bounded-kind';
import type { SpaceSection } from '../../src/sync/space-sections';

// A Space's radar and memory: the web's tabs, the radar's three
// sections and the memory's proposals and entries in the web's words, and
// where a section stands with no copy, an older one or a fresh one.

const NOV_8 = Date.UTC(2026, 10, 8, 12);
const NOV_9 = Date.UTC(2026, 10, 9, 12);

const entry = (id: string, fields: Partial<RadarEntry> = {}): RadarEntry => ({
    id,
    spaceId: 'everyday',
    parentId: null,
    title: `Page ${id}`,
    excerpt: '',
    revision: 1,
    revisions: 0,
    createdAt: NOV_8,
    updatedAt: NOV_8,
    ageDays: 0,
    ...fields,
});

const RADAR: SpaceRadar = {
    spaceId: 'everyday',
    now: NOV_9,
    staleDays: 30,
    recent: [entry('p1', { title: '  ', excerpt: 'Plans for Q1', revisions: 3 }), entry('p2', { revisions: 1 })],
    open: [{ ...entry('p3', { title: 'Pricing' }), markers: ['decision', 'tbd'] }],
    stale: [entry('p4', { ageDays: 45 })],
    total: 4,
};

const version = (id: string, fields: Partial<SpaceMemoryView> = {}): SpaceMemoryView => ({
    id,
    entryId: `e-${id}`,
    spaceId: 'everyday',
    version: 1,
    text: `Fact ${id}`,
    status: 'active',
    proposedBy: 'u1',
    dotId: null,
    threadId: null,
    supersedes: null,
    createdAt: NOV_8,
    decidedBy: 'u2',
    decidedAt: NOV_9,
    endedBy: null,
    endedAt: null,
    proposedByName: 'Ada',
    dotName: null,
    chatTitle: null,
    decidedByName: 'Grace',
    endedByName: null,
    ...fields,
});

const MEMORY: SpaceMemoryState = {
    spaceId: 'everyday',
    access: 'editor',
    entries: [version('v1'), version('v2', { version: 2, decidedByName: null, decidedAt: null })],
    proposals: [
        version('v3', {
            status: 'proposed',
            supersedes: 'v1',
            dotId: 'd1',
            dotName: 'Mingo',
            threadId: 't1',
            chatTitle: 'Planning',
            decidedBy: null,
            decidedAt: null,
        }),
    ],
    retired: [version('v4', { status: 'retired' })],
    retentionDays: 30,
};

const state = (fields: Partial<BoundedItemState<SpaceSection>>): BoundedItemState<SpaceSection> => ({
    value: null,
    fetchedAt: null,
    loaded: true,
    settled: false,
    refreshing: false,
    failed: false,
    gone: false,
    ...fields,
});

describe('the Space’s tabs', () => {
    it('are the web’s Pages, Memory and Radar, Settings left to the web', () => {
        expect(SPACE_TABS.map((tab) => tab.label)).toEqual(['Pages', 'Memory', 'Radar']);
        expect(spaceSectionPath('every day', 'memory')).toBe('/spaces/every%20day/memory');
    });

    it('say where a section stands: loading, nothing offline, an older copy with its age, or fresh', () => {
        expect(sectionStatus(state({ refreshing: true }))).toEqual({ kind: 'loading' });
        expect(sectionStatus(state({ settled: true, failed: true }))).toEqual({ kind: 'offline', line: OPEN_ONLINE });
        const value: SpaceSection = { section: 'radar', radar: RADAR };
        expect(sectionStatus(state({ value, fetchedAt: NOV_8, settled: true }))).toEqual({ kind: 'shown', note: null });
        const older = sectionStatus(state({ value, fetchedAt: NOV_8, settled: true, failed: true }));
        expect(older).toMatchObject({ kind: 'shown' });
        expect(older.kind === 'shown' ? older.note : null).toMatch(/^Updated Nov 8, /);
    });
});

describe('the radar', () => {
    it('lists recent changes, open decisions and stale pages in the web’s order and words', () => {
        const view = radarView(RADAR);
        expect(view.scope).toBe(
            '4 live pages in this Space. Stale is older than 30 days. Markers are a simple heuristic, not a deep scan.',
        );
        expect(view.sections.map((section) => section.title)).toEqual([
            'Recent changes',
            'Open decisions & experiments',
            'Potentially stale',
        ]);
        const [recent, open, stale] = view.sections;
        expect(recent?.rows).toEqual([
            {
                id: 'p1',
                title: 'Untitled page',
                excerpt: 'Plans for Q1',
                meta: 'Nov 8, 2026 · 3 revisions kept',
                accessibilityLabel: 'Untitled page, Nov 8, 2026 · 3 revisions kept',
            },
            {
                id: 'p2',
                title: 'Page p2',
                excerpt: null,
                meta: 'Nov 8, 2026 · 1 revision kept',
                accessibilityLabel: 'Page p2, Nov 8, 2026 · 1 revision kept',
            },
        ]);
        expect(open?.rows[0]).toMatchObject({ title: 'Pricing', meta: 'decision, tbd · Nov 8, 2026' });
        expect(stale?.rows[0]).toMatchObject({ meta: '45 days since the last edit' });
    });

    it('says the age as the web does, and each empty section in its words', () => {
        expect(staleAge(0)).toBe('Updated today');
        expect(staleAge(1)).toBe('1 day since the last edit');
        const empty = radarView({ ...RADAR, recent: [], open: [], stale: [], total: 1 });
        expect(empty.scope).toMatch(/^1 live page in this Space\./);
        expect(empty.sections.map((section) => [section.rows.length, section.empty])).toEqual([
            [0, 'No pages yet.'],
            [
                0,
                'Nothing flagged. A page shows here when its title or excerpt carries a marker like todo, decision, experiment, tbd or unresolved.',
            ],
            [0, 'Nothing stale. Every page was updated within 30 days.'],
        ]);
    });
});

describe('the memory', () => {
    it('says who proposed a version, for whom, in which chat and when', () => {
        expect(provenance(version('a'))).toBe('Proposed by Ada · Nov 8, 2026');
        expect(provenance(MEMORY.proposals[0]!)).toBe('Proposed by Mingo for Ada in Planning · Nov 8, 2026');
        // A chat's title without its id isn't named, as on the web.
        expect(provenance(version('b', { chatTitle: 'Planning' }))).toBe('Proposed by Ada · Nov 8, 2026');
    });

    it('lists an editor’s proposals waiting, then the entries in use, with no retired ones', () => {
        const view = memoryView(MEMORY, false);
        expect(view.audience).toBe(
            'Everyone in the workspace reads this Space’s memory. Socios with this Space use matching entries in ' +
                'chats, and in a chat with other people only when every one of them can read it. Socios’ proposals ' +
                'wait for you or another editor.',
        );
        expect(view.proposalsTitle).toBe('Waiting for approval');
        expect(view.proposals).toEqual([
            {
                id: 'v3',
                text: 'Fact v3',
                changes: 'Changes: “Fact v1”',
                version: null,
                proposed: 'Proposed by Mingo for Ada in Planning · Nov 8, 2026',
                approved: null,
                accessibilityLabel: 'Changes: “Fact v1”, Fact v3, Proposed by Mingo for Ada in Planning · Nov 8, 2026',
            },
        ]);
        expect(view.entries.map((row) => [row.text, row.version, row.approved])).toEqual([
            ['Fact v1', null, 'Approved by Grace · Nov 9, 2026'],
            ['Fact v2', 'Version 2', 'Approved by an editor'],
        ]);
    });

    it('tells a reader of a private Space who reads it, and that their proposals wait', () => {
        const view = memoryView({ ...MEMORY, access: 'reader', proposals: [] }, true);
        expect(view.audience).toMatch(/^This Space is private: only its people and workspace admins read its memory\./);
        expect(view.audience).toMatch(/What you propose waits for its editors\.$/);
        expect(view.proposalsTitle).toBe('Your proposals');
        expect(view.proposals).toEqual([]);
    });

    it('names a change of an entry it doesn’t hold as an earlier entry', () => {
        const view = memoryView({ ...MEMORY, entries: [] }, false);
        expect(view.proposals[0]?.changes).toBe('Changes: “an earlier entry”');
    });
});
