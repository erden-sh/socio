import { formatNumber } from '@socio/shared/locale';
import { characterOf, LOCAL_NAMES, type LocalId } from '@socio/shared/mascot';
import { MODULE_IDS } from '@socio/shared/modules';
import type { Dot, State } from '@socio/shared/types';

import type { ToneName } from '../theme/theme';

import { type ChatRow, roomsOn } from './chat-list';
import { type ModuleIconName, moduleEntry } from './modules';

// Home's socios (the web's shell/Home.tsx and shell/dot-state.tsx, CB-308):
// each socio that isn't archived, oldest first, with what it is doing as far
// as the shell knows. Paused while the workspace's settings pause every
// socio, Working while one of its scheduled tasks runs (`State.tasks`), else
// Idle. With no state row yet, Idle. No React Native, so tests/shell runs it
// under Node.

export type SocioState = 'idle' | 'working' | 'paused';

export const SOCIO_STATE_LABEL: Readonly<Record<SocioState, string>> = {
    idle: 'Idle',
    working: 'Working',
    paused: 'Paused',
};

/** The web's line for a socio with no instructions. */
export const NO_INSTRUCTIONS = 'Ready when you are.';

export interface SocioRow {
    readonly id: string;
    readonly name: string;
    readonly character: LocalId;
    /** What the character is ("stone crab"). */
    readonly characterKind: string;
    /** Its instructions, or NO_INSTRUCTIONS. */
    readonly blurb: string;
    readonly state: SocioState;
    readonly stateLabel: string;
    readonly accessibilityLabel: string;
}

export function socioState(dotId: string, state: Pick<State, 'settings' | 'tasks'> | null | undefined): SocioState {
    if (state === null || state === undefined) {
        return 'idle';
    }
    if (state.settings.paused) {
        return 'paused';
    }
    return state.tasks.some((task) => task.dotId === dotId && task.status === 'running') ? 'working' : 'idle';
}

/** A string with something in it, else null: a row from the server may lack a field. */
const text = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value : null);

/** Oldest first, as the server lists them, then by id. */
const byOldest = (a: Dot, b: Dot) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function homeSocios(
    dots: readonly Dot[],
    state: Pick<State, 'settings' | 'tasks'> | null | undefined,
): SocioRow[] {
    return dots
        .filter((dot) => dot.archivedAt === undefined || dot.archivedAt === null)
        .sort(byOldest)
        .map((dot) => {
            const now = socioState(dot.id, state);
            const character = characterOf(dot);
            return {
                id: dot.id,
                name: dot.name,
                character,
                characterKind: LOCAL_NAMES[character].kind,
                blurb: text(dot.instructions) ?? NO_INSTRUCTIONS,
                state: now,
                stateLabel: SOCIO_STATE_LABEL[now],
                accessibilityLabel: `${dot.name}, ${SOCIO_STATE_LABEL[now]}`,
            };
        });
}

// Home's tiles and sections (Slack's Home): a horizontal row of
// tiles, each a module with a count where the scope has the data, then
// collapsible sections: the socios, the rooms (only while the workspace has
// them on) and the recent chats.

/** Where a tile goes: a page pushed over the tabs, or a More module's page. */
export type HomeTarget =
    | { readonly kind: 'page'; readonly name: 'Board' | 'Spaces' | 'Memories' }
    | { readonly kind: 'more'; readonly id: typeof MODULE_IDS.activity };

export interface HomeTile {
    readonly key: 'board' | 'spaces' | 'scheduled' | 'memories';
    readonly label: string;
    /** `3 spaces`; or, where the app has no data yet, what the tile will hold. */
    readonly caption: string;
    readonly icon: ModuleIconName;
    readonly tone: ToneName;
    readonly target: HomeTarget;
    readonly testID: string;
    readonly accessibilityLabel: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The Board tile's line while the phone holds no issue yet (the web's header line before its list). */
export const BOARD_LATER = 'The team’s issue tracker';

/** What a tile says until its module's data comes to the app. */
export const TILE_LATER = 'Coming soon';

/** The Memories tile's line before `/api/memories` has answered once (the module's description). */
export const MEMORIES_LATER = 'What your socios know about you';

/**
 * The tiles, in Slack's place for Threads, Huddles, To-dos and Saved: the
 * Board (its open issues), the Spaces (their count),
 * Scheduled (every task in `State.tasks`, in the web Home's words: "1 scheduled
 * task") and Memories (the proposals waiting). With no state row yet,
 * Scheduled counts none.
 */
export function homeTiles(input: {
    readonly spaces: number;
    /** The board's open issues (`openIssueCount`), or null while the phone holds none yet. */
    readonly openIssues?: number | null;
    readonly state: Pick<State, 'tasks'> | null | undefined;
    /** The proposals waiting (`waitingProposals`), or null before `/api/memories` answered once. */
    readonly waitingProposals?: number | null;
}): HomeTile[] {
    // Every task the shell holds, as the web's Home counts them (`homeCounts`' `state.tasks.length`).
    const scheduled = input.state?.tasks.length ?? 0;
    const ISSUES = moduleEntry(MODULE_IDS.issues);
    const SPACES = moduleEntry(MODULE_IDS.spaces);
    const ACTIVITY = moduleEntry(MODULE_IDS.activity);
    const MEMORIES = moduleEntry(MODULE_IDS.memories);
    const tile = (fields: Omit<HomeTile, 'accessibilityLabel'>): HomeTile => ({
        ...fields,
        accessibilityLabel: `${fields.label}, ${fields.caption}`,
    });
    return [
        tile({
            key: 'board',
            label: 'Board',
            caption: input.openIssues == null ? BOARD_LATER : `${input.openIssues} open`,
            icon: ISSUES.icon,
            tone: ISSUES.tone,
            target: { kind: 'page', name: 'Board' },
            testID: 'home-tile-board',
        }),
        tile({
            key: 'spaces',
            label: SPACES.title,
            caption: plural(input.spaces, 'space'),
            icon: SPACES.icon,
            tone: SPACES.tone,
            target: { kind: 'page', name: 'Spaces' },
            testID: 'home-tile-spaces',
        }),
        tile({
            key: 'scheduled',
            label: 'Scheduled',
            caption: `${formatNumber(scheduled)} ${scheduled === 1 ? 'scheduled task' : 'scheduled tasks'}`,
            icon: ACTIVITY.icon,
            tone: ACTIVITY.tone,
            target: { kind: 'more', id: MODULE_IDS.activity },
            testID: 'home-tile-scheduled',
        }),
        tile({
            key: 'memories',
            label: MEMORIES.title,
            caption:
                input.waitingProposals == null
                    ? MEMORIES_LATER
                    : input.waitingProposals === 0
                      ? 'Nothing waiting'
                      : `${input.waitingProposals} waiting`,
            icon: MEMORIES.icon,
            tone: MEMORIES.tone,
            target: { kind: 'page', name: 'Memories' },
            testID: 'home-tile-memories',
        }),
    ];
}

/** The recent chats Home lists; the Chats tab has them all. */
export const RECENT_LIMIT = 8;

export type HomeSectionId = 'socios' | 'rooms' | 'recent';

export type HomeSection =
    | { readonly id: 'socios'; readonly title: string; readonly collapsed: boolean; readonly socios: SocioRow[] }
    | {
          readonly id: 'rooms' | 'recent';
          readonly title: string;
          readonly collapsed: boolean;
          readonly chats: ChatRow[];
          /** The chats past RECENT_LIMIT, which only the Chats tab shows; 0 for the rooms. */
          readonly more: number;
      };

/**
 * Home's sections: Socios, then Rooms while the workspace has them on (every
 * room, newest first, as the chat list orders them), then Recent chats (the
 * other chats, at most RECENT_LIMIT). A collapsed section keeps its heading
 * and holds no rows.
 */
export function homeSections(input: {
    readonly socios: readonly SocioRow[];
    /** The chat list's rows (chat-list.ts), which hold rooms only while they're on. */
    readonly chats: readonly ChatRow[];
    readonly state: Pick<State, 'settings'> | null | undefined;
    readonly collapsed: ReadonlySet<HomeSectionId>;
}): HomeSection[] {
    const shut = (id: HomeSectionId) => input.collapsed.has(id);
    const rooms = input.chats.filter((chat) => chat.room);
    const chats = input.chats.filter((chat) => !chat.room);
    const sections: HomeSection[] = [
        { id: 'socios', title: 'Socios', collapsed: shut('socios'), socios: shut('socios') ? [] : [...input.socios] },
    ];
    if (roomsOn(input.state)) {
        sections.push({
            id: 'rooms',
            title: 'Rooms',
            collapsed: shut('rooms'),
            chats: shut('rooms') ? [] : rooms,
            more: 0,
        });
    }
    sections.push({
        id: 'recent',
        title: 'Recent chats',
        collapsed: shut('recent'),
        chats: shut('recent') ? [] : chats.slice(0, RECENT_LIMIT),
        more: shut('recent') ? 0 : Math.max(0, chats.length - RECENT_LIMIT),
    });
    return sections;
}

/** The set with `id` collapsed if it was open, open if it was collapsed. */
export function toggleSection(collapsed: ReadonlySet<HomeSectionId>, id: HomeSectionId): ReadonlySet<HomeSectionId> {
    const next = new Set(collapsed);
    if (!next.delete(id)) {
        next.add(id);
    }
    return next;
}
