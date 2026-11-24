import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MODULE_IDS } from '@socio/shared/modules';
import { PALETTE_GROUP_LIMIT } from '@socio/shared/search/rank';
import type { State } from '@socio/shared/types';

import { isMoreItem, MORE_ITEMS } from '../../src/navigation/tabs';
import type { ChatRow } from '../../src/shell/chat-list';
import {
    homeSections,
    BOARD_LATER,
    homeTiles,
    RECENT_LIMIT as HOME_RECENT,
    type SocioRow,
    MEMORIES_LATER,
    toggleSection,
} from '../../src/shell/home';
import { moduleEntry } from '../../src/shell/modules';
import { addMemoryAction, RECENT_LIMIT, type SearchLink, type SearchView, searchView } from '../../src/shell/search';

// Home's tiles and sections and the Search tab's view, under Node.

const chat = (id: string, title: string, extra: Partial<ChatRow> = {}): ChatRow => ({
    id,
    title,
    socio: 'Everyday',
    character: 'stoneCrab' as ChatRow['character'],
    room: false,
    roomRole: null,
    unread: null,
    unreadLabel: null,
    accessibilityLabel: title,
    ...extra,
});

const socio = (id: string, name: string): SocioRow => ({
    id,
    name,
    character: 'stoneCrab' as SocioRow['character'],
    characterKind: 'stone crab',
    blurb: 'Ready when you are.',
    state: 'idle',
    stateLabel: 'Idle',
    accessibilityLabel: name,
});

const task = (status: string) => ({ status }) as State['tasks'][number];
const roomsState = (enabled: boolean) => ({ settings: { rooms: { enabled } } }) as unknown as Pick<State, 'settings'>;

describe('Home’s tiles', () => {
    it('are the Board, the Spaces, Scheduled and Memories, in that order, each with its module’s icon and tone', () => {
        const tiles = homeTiles({ spaces: 0, state: null });
        expect(tiles.map((t) => t.label)).toEqual(['Board', 'Spaces', 'Scheduled', 'Memories']);
        const modules = [MODULE_IDS.issues, MODULE_IDS.spaces, MODULE_IDS.activity, MODULE_IDS.memories];
        tiles.forEach((tile, i) => {
            const entry = moduleEntry(modules[i]!);
            expect([tile.icon, tile.tone], tile.key).toEqual([entry.icon, entry.tone]);
        });
    });

    it('count where the scope has the data, and say what comes later where it hasn’t', () => {
        const tiles = homeTiles({
            spaces: 3,
            state: { tasks: [task('scheduled'), task('running'), task('completed'), task('failed')] },
        });
        // Scheduled counts every task in `state.tasks`, finished or not, in the web Home's words (`homeCounts`).
        expect(tiles.map((t) => t.caption)).toEqual([BOARD_LATER, '3 spaces', '4 scheduled tasks', MEMORIES_LATER]);
        expect(
            homeTiles({ spaces: 1, state: { tasks: [task('completed')] }, waitingProposals: 0 }).map((t) => t.caption),
        ).toEqual([BOARD_LATER, '1 space', '1 scheduled task', 'Nothing waiting']);
        expect(homeTiles({ spaces: 0, state: null })[2]!.caption).toBe('0 scheduled tasks');
        expect(tiles[2]!.accessibilityLabel).toBe('Scheduled, 4 scheduled tasks');
        const memories = homeTiles({ spaces: 0, state: null, waitingProposals: 2 })[3]!;
        expect([memories.caption, memories.accessibilityLabel]).toEqual(['2 waiting', 'Memories, 2 waiting']);
        expect(tiles[1]!.accessibilityLabel).toBe('Spaces, 3 spaces');
    });

    it('go to the Board, Spaces and Memories pages, and to Scheduled & activity’s More page', () => {
        expect(homeTiles({ spaces: 0, state: null }).map((t) => t.target)).toEqual([
            { kind: 'page', name: 'Board' },
            { kind: 'page', name: 'Spaces' },
            { kind: 'more', id: MODULE_IDS.activity },
            { kind: 'page', name: 'Memories' },
        ]);
        for (const tile of homeTiles({ spaces: 0, state: null })) {
            if (tile.target.kind === 'more') {
                expect(isMoreItem(tile.target.id), tile.key).toBe(true);
            }
        }
    });
});

describe('Home’s sections', () => {
    const socios = [socio('d1', 'Everyday'), socio('d2', 'Sebas')];
    const chats = [chat('c1', 'Plans'), chat('r1', 'Team room', { room: true }), chat('c2', 'Budget')];
    const ids = (sections: ReturnType<typeof homeSections>) => sections.map((s) => s.id);

    it('are Socios, Rooms while they’re on, and Recent chats, rooms and chats apart', () => {
        const on = homeSections({ socios, chats, state: roomsState(true), collapsed: new Set() });
        expect(ids(on)).toEqual(['socios', 'rooms', 'recent']);
        expect(on.map((s) => s.title)).toEqual(['Socios', 'Rooms', 'Recent chats']);
        const [s, rooms, recent] = on;
        expect(s!.id === 'socios' && s!.socios.map((x) => x.id)).toEqual(['d1', 'd2']);
        expect(rooms!.id === 'rooms' && rooms!.chats.map((x) => x.id)).toEqual(['r1']);
        expect(recent!.id === 'recent' && recent!.chats.map((x) => x.id)).toEqual(['c1', 'c2']);

        expect(ids(homeSections({ socios, chats, state: roomsState(false), collapsed: new Set() }))).toEqual([
            'socios',
            'recent',
        ]);
        expect(ids(homeSections({ socios, chats, state: null, collapsed: new Set() }))).toEqual(['socios', 'recent']);
    });

    it('list the recent chats up to the limit, counting the rest for the Chats tab', () => {
        const many = Array.from({ length: HOME_RECENT + 3 }, (_, i) => chat(`c${i}`, `Chat ${i}`));
        const recent = homeSections({ socios: [], chats: many, state: null, collapsed: new Set() }).at(-1)!;
        expect(recent.id === 'recent' && [recent.chats.length, recent.more]).toEqual([HOME_RECENT, 3]);
    });

    it('collapse to their heading alone, and open again', () => {
        let collapsed = toggleSection(new Set(), 'socios');
        collapsed = toggleSection(collapsed, 'recent');
        const shut = homeSections({ socios, chats, state: roomsState(true), collapsed });
        expect(shut.map((s) => [s.id, s.collapsed])).toEqual([
            ['socios', true],
            ['rooms', false],
            ['recent', true],
        ]);
        expect(shut[0]!.id === 'socios' && shut[0]!.socios).toEqual([]);
        expect(shut[2]!.id === 'recent' && [shut[2]!.chats, shut[2]!.more]).toEqual([[], 0]);
        expect([...toggleSection(collapsed, 'socios')]).toEqual(['recent']);
    });
});

describe('a collapsed Home section', () => {
    // Read as source: home-parts.tsx draws with React Native.
    const parts = readFileSync(join(import.meta.dirname, '../../src/screens/home-parts.tsx'), 'utf8');
    const view = parts.slice(parts.indexOf('export function SectionView'));

    it('leaves no hole under its heading: every section (Socios, Rooms, Recent chats) pulls the next one up', () => {
        expect(parts).toContain('export const COLLAPSED_SECTION_PULL = 12;');
        expect(view).toContain('style={section.collapsed ? { marginBottom: -COLLAPSED_SECTION_PULL } : undefined}');
        // The pull is the empty half under the label in the 44-point heading (min-h-11, text-sm's 20-point line).
        expect(view).toContain('className="min-h-11 flex-row items-center');
        expect((44 - 20) / 2).toBe(12);
        // Its rows are gone, not hidden, so nothing else takes room.
        expect(view).toContain('{section.collapsed ? null : (');
    });
});

describe('the Search tab’s view', () => {
    const BASE = { query: '', chats: [], socios: [], role: 'admin' as const };
    const keys = (view: SearchView, id: string) =>
        view.sections.find((section) => section.id === id)?.items.map((item) => item.key) ?? [];
    const links = (view: SearchView) =>
        view.sections.flatMap((section) => section.items).filter((item): item is SearchLink => item.kind === 'link');
    const chats = [
        ...Array.from({ length: RECENT_LIMIT + 2 }, (_, i) => chat(`c${i}`, `Chat ${i}`)),
        chat('old', 'Quarterly budget', { socio: 'Sebas' }),
    ];
    const input = { ...BASE, chats, socios: [socio('d1', 'Everyday'), socio('d2', 'Sebas')] };

    it('opens on Actions, then Go to (the modules), then the socios and the recent chats and rooms', () => {
        const view = searchView({ ...input, newChatWith: { id: 'd2', name: 'Sebas' } });
        expect(view.sections.map((s) => [s.id, s.title])).toEqual([
            ['actions', 'Actions'],
            ['modules', 'Go to'],
            ['socios', 'Socios'],
            ['recent', 'Recent'],
        ]);
        expect(keys(view, 'actions')).toEqual(['new-chat', 'add-memory', 'file-issue']);
        expect(keys(view, 'recent')).toHaveLength(RECENT_LIMIT + 1);
        expect(keys(view, 'recent').at(-1)).toBe('all-chats');
        expect(keys(view, 'modules')).toEqual(['spaces', 'board', ...MORE_ITEMS]);
        expect(searchView(BASE).sections.map((s) => s.id)).toEqual(['actions', 'modules']);
        // No socio to start with, no New chat.
        expect(keys(searchView(input), 'actions')).toEqual(['add-memory', 'file-issue']);
    });

    it('starts the new chat with the default socio, named as the web’s hint, and Add memory goes to Memories', () => {
        const view = searchView({ ...input, newChatWith: { id: 'd2', name: 'Sebas' } });
        const [newChat, addMemory, fileIssue] = links(view);
        expect(newChat).toMatchObject({
            label: 'New chat',
            subtitle: 'Sebas',
            icon: 'Plus',
            tone: moduleEntry(MODULE_IDS.chat).tone,
            target: { kind: 'new-chat', socioId: 'd2' },
            accessibilityLabel: 'New chat with Sebas',
        });
        expect(addMemory).toMatchObject({
            label: 'Add memory',
            icon: 'Plus',
            tone: moduleEntry(MODULE_IDS.memories).tone,
            target: { kind: 'add-memory' },
        });
        expect(fileIssue).toMatchObject({ label: 'File an issue', icon: 'Bug', target: { kind: 'file-issue' } });
    });

    it('opens Memories with its Add sheet up for Add memory, not the list to find the button on', () => {
        expect(addMemoryAction()).toEqual({ type: 'NAVIGATE', payload: { name: 'Memories', params: { add: true } } });
        const src = (file: string) => readFileSync(join(import.meta.dirname, '../../src', file), 'utf8');
        expect(src('screens/search.tsx')).toMatch(/case 'add-memory':\s*navigation\.dispatch\(addMemoryAction\(\)\);/);
        const memories = src('screens/memories.tsx');
        expect(memories).toContain('<Memories add={route.params?.add === true} />');
        expect(memories).toMatch(
            /if \(add\) \{\s*setEditing\(\{ kind: 'add' \}\);\s*navigation\.setParams\(\{ add: undefined \}/,
        );
    });

    it('finds the actions by the web palette’s words', () => {
        const typed = (query: string) =>
            keys(searchView({ ...input, newChatWith: { id: 'd2', name: 'Sebas' }, query }), 'actions');
        expect(typed('new chat')).toEqual(['new-chat']);
        expect(typed('message')).toEqual(['new-chat']);
        expect(typed('preference')).toEqual(['add-memory']);
        expect(typed('bug')).toEqual(['file-issue']);
        expect(typed('memory')).toEqual(['add-memory']);
    });

    it('narrows every section, ignoring case and extra spaces, across the whole chat list, at most a group’s limit each', () => {
        const view = searchView({ ...input, query: '  SEBAS ' });
        expect(keys(view, 'socios')).toEqual(['socio-d2']);
        expect(keys(view, 'recent')).toEqual(['chat-old']);
        expect(view.sections.find((s) => s.id === 'recent')?.title).toBe('Chats');
        expect(keys(searchView({ ...input, query: 'chat' }), 'recent')).toHaveLength(PALETTE_GROUP_LIMIT);
        expect(keys(searchView({ ...input, query: 'budget' }), 'recent')).toEqual(['chat-old']);
        expect(keys(searchView({ ...input, query: 'sched' }), 'modules')).toEqual([
            MODULE_IDS.activity,
            MODULE_IDS.schedules,
        ]);
    });

    it('lists the Spaces whose name holds a search, each opening its library, and none before one', () => {
        const spaces = [
            { id: 'ops', name: 'Ops runbooks', description: null, private: false, accessibilityLabel: 'Ops runbooks' },
            { id: 'hr', name: 'People', description: null, private: true, accessibilityLabel: 'People, private' },
        ];
        expect(keys(searchView({ ...input, spaces }), 'spaces')).toEqual([]);
        const view = searchView({ ...input, spaces, query: 'peop' });
        expect(view.sections.map((section) => section.id)).toEqual(['spaces']);
        const [hr] = links(view);
        expect(hr).toMatchObject({
            label: 'People',
            accessibilityLabel: 'People, private',
            target: { kind: 'space', id: 'hr' },
        });
    });

    it('says when nothing matches, and a blank search is no search', () => {
        expect(searchView({ ...input, query: 'zzz' })).toEqual({ sections: [], noMatches: true, serverLine: null });
        expect(searchView({ ...input, query: '   ' })).toEqual(searchView(input));
    });

    it('sends All chats to the Chats tab, Spaces and the Board to their pages, the rest to More’s', () => {
        const targets = Object.fromEntries(links(searchView(input)).map((l) => [l.key, l.target]));
        expect(targets['all-chats']).toEqual({ kind: 'chats' });
        expect(targets.spaces).toEqual({ kind: 'page', name: 'Spaces' });
        expect(targets.board).toEqual({ kind: 'page', name: 'Board' });
        expect(targets[MODULE_IDS.runs]).toEqual({ kind: 'more', id: MODULE_IDS.runs, label: 'Runs' });
    });
});
