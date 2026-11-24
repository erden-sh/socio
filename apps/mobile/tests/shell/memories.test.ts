import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import type { EpisodesState, MemoryItem } from '@socio/shared/memory';

import {
    CONFIRMS,
    deleteAllConfirm,
    EMPTY_TITLE,
    episodesView,
    MEMORY_OFF,
    memoryChange,
    type MemoryNames,
    memoriesView,
    profileChange,
    timeZoneHint,
    waitingProposals,
} from '../../src/shell/memories';
import { PROFILE_KEY, type MemoryProfileRow } from '../../src/sync/memories';
import {
    addMemory,
    approveMemory,
    deleteMemory,
    editMemory,
    keepMine,
    MEMORY_REASON,
    MEMORY_WRITE_VIEWS,
    newestMemory,
    saveProfile,
} from '../../src/sync/memory-writes';
import { OUTBOX_COPY } from '../../src/sync/outbox';
import { overlaysOf } from '../../src/sync/outbox-overlay';
import { closePhones, open, type Phone, server, type Server } from '../sync/memory-fakes';

// Memories' view model over the fake server's state (tests/sync/memory-fakes.ts),
// with this device's memory writes on a real outbox laid over: the order, the words, a
// conflicting edit's Keep mine, the editors' changes and the episodes.

afterEach(closePhones);

let ids = 0;
const newId = () => `mm-${++ids}`;

const names: MemoryNames = {
    dotName: (id) => ({ d1: 'Sebas' })[id] ?? null,
    chatTitle: (id) => ({ c1: 'Plans' })[id] ?? null,
};

const profileRow = (srv: Server, timeZoneMoved: string | null = null): MemoryProfileRow => ({
    id: PROFILE_KEY,
    profile: srv.profile,
    timeZoneMoved,
});

/** The screen's view of what the phone holds: the server's rows (as a pull left them) and the outbox. */
function view(srv: Server, phone: Phone | null, extra: Partial<Parameters<typeof memoriesView>[0]> = {}) {
    const rows = srv.stored().map(({ ...item }) => item as MemoryItem);
    return memoriesView({
        rows,
        profileRow: profileRow(srv),
        overlays:
            phone === null
                ? []
                : overlaysOf({
                      rows: phone.outbox.rows(),
                      unsent: phone.outbox.unsent(),
                      kinds: MEMORY_WRITE_VIEWS,
                      scope: phone.outbox,
                  }),
        unsent: phone === null ? [] : phone.outbox.unsent(),
        names,
        memoryAllowed: true,
        timeZone: 'UTC',
        ...extra,
    });
}

describe('Memories’ view', () => {
    it('puts the proposals waiting first, newest first, each saying where it came from', () => {
        const srv = server();
        srv.memory({ text: 'Mine', source: 'person' });
        srv.memory({ text: 'Older proposal', status: 'proposed', source: 'socio', dotId: 'd1', threadId: 'c1' });
        srv.memory({ text: 'From notes', status: 'proposed', source: 'notes', dotId: 'gone', threadId: 'gone' });
        srv.memory({ text: 'Asked', source: 'person', dotId: 'd1', threadId: null });
        const shown = view(srv, null);
        expect(shown.proposals.map((row) => [row.text, row.origin, row.threadId])).toEqual([
            ['From notes', 'Proposed by A socio, from the chat’s notes', null],
            ['Older proposal', 'Proposed by Sebas in Plans', 'c1'],
        ]);
        expect(shown.memories.map((row) => [row.text, row.origin])).toEqual([
            ['Asked', 'You asked Sebas to remember it'],
            ['Mine', 'Added by you'],
        ]);
        expect(shown.memories[0]!.when).toMatch(/^Confirmed Jan 1, 1970$/);
        expect(shown.waiting).toBe(2);
        expect(shown.empty).toBe(false);
        expect(shown.proposals[1]!.accessibilityLabel).toBe(
            'Proposal, Older proposal, Proposed by Sebas in Plans, Jan 1, 1970',
        );
    });

    it('says what is missing: the empty state, memory turned off, no profile, and nothing before the first answer', () => {
        const srv = server();
        const shown = view(srv, null, { memoryAllowed: false });
        expect([shown.loaded, shown.empty, shown.off]).toEqual([true, true, MEMORY_OFF]);
        expect(shown.profile).toMatchObject({ shown: null, rows: [], line: 'Not filled in', pending: null });
        expect(EMPTY_TITLE).toBe('A little context goes a long way.');
        const before = memoriesView({
            rows: [],
            profileRow: null,
            overlays: [],
            unsent: [],
            names,
            memoryAllowed: null,
        });
        expect([before.loaded, before.empty, before.off]).toEqual([false, false, null]);
        expect(waitingProposals([], null, [])).toBeNull();
        // Before the first answer the profile card offers nothing and says nothing about it.
        expect(before.profile).toMatchObject({ shown: null, empty: false, line: null, editable: false });
        expect(shown.profile).toMatchObject({ empty: true, editable: true });
    });

    it('shows the profile’s filled fields in order, the detected time zone and the moved zone’s note', () => {
        const srv = server();
        srv.profile = {
            fields: { timezone: 'Europe/Madrid', name: 'Sam', role: '' },
            shareable: true,
            timezoneDetected: true,
            updatedAt: Date.UTC(2026, 10, 8),
        };
        const shown = memoriesView({
            rows: [],
            profileRow: profileRow(srv, 'Europe/Madrid'),
            overlays: [],
            unsent: [],
            names,
            memoryAllowed: true,
            timeZone: 'UTC',
        });
        expect(shown.profile.rows).toEqual([
            { label: 'Preferred name', value: 'Sam', detected: false },
            { label: 'Time zone', value: 'Europe/Madrid', detected: true },
        ]);
        expect(shown.profile.line).toBe('Your chats and team chats · Updated Nov 8, 2026');
        expect(shown.moved).toBe('Your time zone is now Europe/Madrid (detected from your browser).');
    });
});

describe('overlays', () => {
    it('an added memory shows at once, waiting; an approval moves a proposal; a delete hides it', async () => {
        const srv = server();
        const proposal = srv.memory({ text: 'A proposal', status: 'proposed', source: 'socio', dotId: 'd1' });
        const kept = srv.memory({ text: 'To forget' });
        const phone = await open(srv);
        const offline = Array.from({ length: 50 }, () => 'offline' as const);
        srv.script('POST memories', ...offline);
        srv.script('GET memories', ...offline);
        srv.script('POST approve', ...offline);
        srv.script('DELETE memory', ...offline);
        await addMemory(phone.outbox, {
            text: ' Tea, not coffee ',
            newId,
            after: newestMemory(srv.stored()),
            serverAt: null,
        });
        await approveMemory(phone.outbox, { memoryId: proposal.id, newId });
        await deleteMemory(phone.outbox, { memoryId: kept.id, newId });
        await phone.settle();
        const shown = view(srv, phone);
        expect(shown.proposals).toEqual([]);
        // Newest first: the memory added now, then the proposal approved.
        expect(shown.memories.map((row) => [row.text, row.pending])).toEqual([
            ['Tea, not coffee', OUTBOX_COPY.waitingToSend],
            ['A proposal', OUTBOX_COPY.waitingToSend],
        ]);
        expect(shown.memories.find((row) => row.text === 'Tea, not coffee')!.stored).toBeNull();
        expect(shown.waiting).toBe(0);
        // Home's tile counts as the screen does, the queued approval laid over.
        const overlays = overlaysOf({
            rows: phone.outbox.rows(),
            unsent: phone.outbox.unsent(),
            kinds: MEMORY_WRITE_VIEWS,
            scope: phone.outbox,
        });
        const rows = srv.stored().map(({ ...item }) => item as MemoryItem);
        expect(waitingProposals(rows, profileRow(srv), overlays)).toBe(0);
        expect(waitingProposals(rows, profileRow(srv), [])).toBe(1);
    });

    it('a queued profile save shows its fields at once', async () => {
        const srv = server();
        srv.profile = { fields: { name: 'Sam', role: 'Design' }, shareable: false, updatedAt: 1 };
        const phone = await open(srv);
        srv.script('PUT profile', ...Array.from({ length: 50 }, () => 'offline' as const));
        srv.script('GET memories', ...Array.from({ length: 50 }, () => 'offline' as const));
        const change = profileChange(srv.profile, {
            fields: { name: 'Sam', role: '', pronouns: 'she/her' },
            shareable: false,
        });
        expect(change).toEqual({ fields: { pronouns: 'she/her', role: '' } });
        await saveProfile(phone.outbox, { ...change!, base: srv.profile, newId });
        await phone.settle();
        const shown = view(srv, phone);
        expect(shown.profile.rows.map((row) => row.value)).toEqual(['Sam', 'she/her']);
        expect(shown.profile.pending).toBe(OUTBOX_COPY.waitingToSend);
    });
});

describe('a conflicting edit', () => {
    it('shows "Couldn’t save" in place with Keep mine and Keep theirs; Keep mine sends it over what the server holds', async () => {
        const srv = server();
        const memory = srv.memory({ text: 'Meetings on Mondays' });
        const phone = await open(srv);
        const seen = view(srv, phone).memories[0]!;
        // Someone changes it on the web before the phone's edit goes.
        srv.items.get(memory.id)!.text = 'Meetings on Tuesdays';
        const change = memoryChange(seen.memory, { text: 'Meetings on Fridays', shareable: false });
        expect(change).toEqual({ text: 'Meetings on Fridays' });
        await editMemory(phone.outbox, {
            memoryId: memory.id,
            change: change!,
            base: { text: seen.stored!.text, shareable: seen.stored!.shareable },
            newId,
        });
        await phone.until(() => phone.outbox.unsent().length === 1);
        expect(phone.outbox.unsent()[0]!.reason).toBe(MEMORY_REASON.conflict);
        const shown = view(srv, phone);
        expect(shown.memories[0]).toMatchObject({ text: 'Meetings on Tuesdays', pending: 'Couldn’t save' });
        const [problem] = shown.problems;
        expect(problem).toMatchObject({
            what: 'Edited memory',
            where: 'Memories',
            text: 'Meetings on Fridays',
            why: 'Couldn’t save: it changed somewhere else first',
            actions: ['keep-mine', 'keep-theirs'],
            current: expect.objectContaining({ text: 'Meetings on Tuesdays' }),
        });
        expect(await keepMine(phone.outbox, { id: problem!.id, current: problem!.current, newId })).toBe(true);
        await phone.until(() => phone.outbox.rows().length === 0 && phone.outbox.unsent().length === 0);
        expect(srv.items.get(memory.id)!.text).toBe('Meetings on Fridays');
        expect(view(srv, phone).problems).toEqual([]);
    });

    it('a refusal that isn’t a conflict offers Retry, Copy and Discard', async () => {
        const srv = server();
        const phone = await open(srv);
        srv.script('POST memories', { status: 400 });
        await addMemory(phone.outbox, { text: 'Too odd', newId, after: null, serverAt: null });
        await phone.until(() => phone.outbox.unsent().length === 1);
        expect(view(srv, phone).problems.map((problem) => problem.actions)).toEqual([['retry', 'copy', 'discard']]);
    });
});

describe('the editors', () => {
    it('a memory edit sends only what changed, and nothing when nothing did', () => {
        const shown = { text: 'Short answers', shareable: false };
        expect(memoryChange(shown, { text: ' Short answers ', shareable: false })).toBeNull();
        expect(memoryChange(shown, { text: 'Short answers', shareable: true })).toEqual({ shareable: true });
    });

    it('a profile save clears a field with an empty one, and sends the sharing only when it changed', () => {
        const shown = { fields: { name: 'Sam', style: 'Brief' }, shareable: true, updatedAt: 1 };
        expect(profileChange(shown, { fields: { name: 'Sam', style: 'Brief' }, shareable: true })).toBeNull();
        expect(profileChange(shown, { fields: { name: 'Sam', style: '' }, shareable: false })).toEqual({
            fields: { style: '' },
            shareable: false,
        });
        expect(profileChange(null, { fields: {}, shareable: false })).toBeNull();
    });

    it('the time zone is checked with shared’s ianaTimeZone, as the profile write checks it before queuing', () => {
        expect(timeZoneHint('Europe/Madrid', false).error).toBe(false);
        expect(timeZoneHint('Mars/Olympus', false)).toMatchObject({ error: true });
        expect(timeZoneHint('', false).error).toBe(false);
        expect(timeZoneHint('Europe/Madrid', true).text).toMatch(/^Detected/);
    });

    it('the confirms keep the web’s words', () => {
        expect(CONFIRMS.forget.title).toBe('Forget this memory?');
        expect(deleteAllConfirm(1).message).toMatch(/^All 1 episode go at once/);
    });
});

describe('the episodes', () => {
    const state = (episodes: EpisodesState['episodes'], total = episodes.length): EpisodesState => ({
        episodes,
        total,
        retentionDays: 90,
    });
    const episode = (id: string, extra: Partial<EpisodesState['episodes'][number]> = {}) => ({
        id,
        kind: 'fact' as const,
        label: null,
        text: `Episode ${id}`,
        dotId: 'd1',
        threadId: 'c1',
        occurredAt: Date.UTC(2026, 9, 12),
        createdAt: 1,
        ...extra,
    });

    it('lists each with its chat, socio and day, a summary badged', () => {
        const shown = episodesView(
            state([episode('e1'), episode('e2', { kind: 'summary', threadId: 'gone', dotId: null })]),
            names,
            'UTC',
        );
        expect(shown.intro).toMatch(/Each is deleted after 90 days without coming up\.$/);
        expect(shown.count).toBe('2 episodes');
        expect(shown.rows.map((row) => [row.badge, row.line, row.threadId])).toEqual([
            [null, 'From Plans with Sebas · Oct 12, 2026', 'c1'],
            ['What the chat was about', 'From a chat with A socio · Oct 12, 2026', null],
        ]);
    });

    it('says none yet, or none matching a search', () => {
        expect(episodesView(state([]), names).empty).toMatch(/^Nothing yet/);
        expect(episodesView(state([], 3), names)).toMatchObject({
            empty: 'No episode matches. Try other words.',
            count: '3 episodes',
        });
        expect(episodesView(null, names)).toMatchObject({ empty: null, count: null, rows: [] });
    });
});

describe('the Memories screen’s wiring', () => {
    const screen = readFileSync(new URL('../../src/screens/memories.tsx', import.meta.url), 'utf8');

    it('reads whether the server is away when a delete is confirmed, never the value of the render that asked', () => {
        expect(screen).toContain('reconnectingNow.current = reconnecting;');
        expect(screen).not.toMatch(/online\(reconnecting\)/);
        expect(screen.match(/online\(reconnectingNow\.current\)/g)).toHaveLength(2);
    });

    it('offers the profile’s actions and its empty line only once /api/memories has answered', () => {
        expect(screen).toContain('{profile.editable ? (');
        expect(screen).toContain('profile.empty ? (');
        expect(screen).toContain('{profile.line === null ? null : (');
    });
});
