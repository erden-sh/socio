import {
    type Episode,
    type EpisodesState,
    type MemoryItem,
    PROFILE_FIELD_MAX,
    PROFILE_FIELDS,
    PROFILE_LABELS,
    type ProfileField,
    type ProfileFields,
    type UserProfile,
} from '@socio/shared/memory';
import { ianaTimeZone, movedTimeZoneText } from '@socio/shared/time-zone';

import type { MemoryProfileRow } from '../sync/memories';
import {
    MEMORY_ADD_KIND,
    MEMORY_APPROVE_KIND,
    MEMORY_CONFIRM_KIND,
    MEMORY_DELETE_KIND,
    MEMORY_REASON,
    MEMORY_UPDATE_KIND,
    type MemoryActionPayload,
    PROFILE_CLEAR_KIND,
    PROFILE_SAVE_KIND,
    type ShownMemory,
    shownMemories,
} from '../sync/memory-writes';
import { OUTBOX_COPY, type HoldGroup, type UnsentWrite } from '../sync/outbox';
import type { OverlayItem } from '../sync/outbox-overlay';

import { unsentListRows } from './unsent';

// Memories (the web's MemoriesPage, EpisodesSection and MemoryDialogs):
// what the person's socios know about them. The view model of
// `screens/memories.tsx`, with no React Native, so tests/shell runs it on the fake
// server's state:
// - the proposals waiting first (Remember, Edit, Not now), then the profile,
//   then the memories in use (Still true, Edit, Forget), each with where it
//   came from, all with the memory writes laid over (`shownMemories`) and the
//   outbox's words while one waits;
// - what the server refused on Memories or the profile, in place: Keep mine
//   and Keep theirs for a conflict, else Retry, Copy and Discard;
// - the episodes (read online only, `src/sync/memory-episodes.ts`);
// - the moved time zone's note, and the line when an admin turned memory off.
// The web's order puts the profile before the proposals; on a phone what
// waits for the person comes first.

/** "Oct 12, 2026". */
export const memoryDay = (ms: number, timeZone?: string) =>
    new Date(ms).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        ...(timeZone === undefined ? {} : { timeZone }),
    });

const plural = (n: number, one: string) => `${n.toLocaleString('en-US')} ${one}${n === 1 ? '' : 's'}`;

export const MEMORIES_INTRO =
    'What your socios know about you, in every chat with them: your profile and the memories you approve. Only you see them.';
export const MEMORY_OFF = 'An admin turned memory off for the workspace: socios don’t use these for now.';
export const PROFILE_EMPTY =
    'How to address you, your role, and how you like answers: written once, used in every chat.';
export const EMPTY_TITLE = 'A little context goes a long way.';
export const EMPTY_LINE =
    'Add a preference like “Keep my research briefs short,” or say “remember that” in a chat and approve it here. You can change or forget it anytime.';
export const TEAM_NOTE =
    'Chats with other people in them, such as a Telegram team topic, use it too. Off, it stays in your own chats.';
export const MEMORY_NOTE =
    'Your socios get the memories that bear on what you ask, with your message. Avoid secrets: memories in use go to your model provider.';
export const PROFILE_NOTE = 'Everything is optional. Only your socios read it, in your chats.';

/** The native confirms, in the web's words. */
export const CONFIRMS = {
    forget: {
        title: 'Forget this memory?',
        message:
            'Your socios stop using it in every chat at once. It stays in the workspace’s records and backups, as anything deleted does.',
        action: 'Forget',
    },
    clearProfile: {
        title: 'Clear your profile?',
        message:
            'Your socios stop using it in every chat at once. Earlier versions stay in the workspace’s records and backups.',
        action: 'Clear',
    },
    episode: {
        title: 'Delete this episode?',
        message:
            'Your socios stop recalling it at once, and it is removed from the workspace. Backups keep it until they age out. The chat it came from is not changed.',
        action: 'Delete',
    },
} as const;

/** "Delete all your episodes?", with the count. */
export const deleteAllConfirm = (total: number) => ({
    title: 'Delete all your episodes?',
    message: `All ${plural(total, 'episode')} go at once, and your socios stop recalling them. Your chats and memories are not changed. New ones are kept as your chats go on.`,
    action: 'Delete all',
});

/** The outbox's words for a write over a memory or the profile, or null when none waits. */
function pendingWords(state: OverlayItem['state'] | null): string | null {
    switch (state) {
        case null:
        case 'sent':
            return null;
        case 'unconfirmed':
            return OUTBOX_COPY.unconfirmed;
        case 'unsent':
            return 'Couldn’t save';
        default:
            return OUTBOX_COPY.waitingToSend;
    }
}

export interface MemoryNames {
    /** A socio's name by id (`dots`), or null when the workspace doesn't list it. */
    readonly dotName: (id: string) => string | null;
    /** A chat's title by id (`conversations`), or null when the workspace doesn't list it. */
    readonly chatTitle: (id: string) => string | null;
}

export interface MemoryRow {
    readonly id: string;
    readonly text: string;
    /** "Added by you", "Proposed by Sebas in Plans, from the chat’s notes". */
    readonly origin: string;
    /** The chat it came from, for a link; null when none or not listed. */
    readonly threadId: string | null;
    /** "Oct 12, 2026" (a proposal's) or "Confirmed Oct 12, 2026" (a memory's). */
    readonly when: string;
    readonly shareable: boolean;
    /** "Waiting to send", "Couldn’t save"…, or null. */
    readonly pending: string | null;
    /** The row's item as shown: an edit's start, and its base (`stored`, never the overlay). */
    readonly memory: ShownMemory;
    /** The memory as the server last sent it, or null for one added on the phone. */
    readonly stored: MemoryItem | null;
    readonly accessibilityLabel: string;
    readonly testID: string;
}

export interface ProfileRow {
    readonly label: string;
    readonly value: string;
    /** " · detected from your browser" on a detected time zone. */
    readonly detected: boolean;
}

export type ProblemAction = 'keep-mine' | 'keep-theirs' | 'retry' | 'copy' | 'discard';

/** A write the server refused on Memories: what it was, why, and what the person can do. */
export interface MemoryProblem {
    readonly id: string;
    readonly what: string;
    readonly where: string;
    readonly why: string;
    readonly text: string | null;
    readonly actions: readonly ProblemAction[];
    /** Keep mine's `current`: what the server holds now (a memory, or the profile); null when gone. */
    readonly current: Pick<MemoryItem, 'text' | 'shareable'> | Pick<UserProfile, 'fields' | 'shareable'> | null;
    readonly accessibilityLabel: string;
}

export interface MemoriesView {
    /** Whether `/api/memories` has answered once (the profile row is there). */
    readonly loaded: boolean;
    /** The admin's switch is off: the line, else null. */
    readonly off: string | null;
    /** The moved time zone's note, else null. */
    readonly moved: string | null;
    readonly proposals: readonly MemoryRow[];
    readonly memories: readonly MemoryRow[];
    readonly profile: {
        /** The profile as shown (with queued saves), or null when none or cleared. */
        readonly shown: UserProfile | null;
        /** The profile as the server last sent it: a save's base. */
        readonly stored: UserProfile | null;
        readonly rows: readonly ProfileRow[];
        /** Whether to say it isn't filled in (PROFILE_EMPTY): only once `/api/memories` has answered. */
        readonly empty: boolean;
        /** "Your chats only · Updated Oct 12, 2026", or "Not filled in"; null before the first answer. */
        readonly line: string | null;
        /** Add, Edit and Clear: only once `/api/memories` has answered, so nothing is offered on a guess. */
        readonly editable: boolean;
        readonly pending: string | null;
    };
    readonly problems: readonly MemoryProblem[];
    /** The empty state, while there is no memory or proposal. */
    readonly empty: boolean;
    /** Home's count: proposals waiting. */
    readonly waiting: number;
}

export interface MemoriesInput {
    /** The `memories` collection's rows: memories and proposals as the server sent them. */
    readonly rows: readonly MemoryItem[];
    /** The `memory-profile` row, or null before `/api/memories` answered. */
    readonly profileRow: MemoryProfileRow | null;
    /** `overlaysOf` the outbox with `MEMORY_WRITE_VIEWS`. */
    readonly overlays: readonly OverlayItem[];
    /** The outbox's `unsent()` and `holds()` (`useUnsent`). */
    readonly unsent: readonly UnsentWrite[];
    readonly groups?: readonly HoldGroup[];
    readonly names: MemoryNames;
    /** `state.settings.memoryAllowed`, or null before the shell's state came. */
    readonly memoryAllowed: boolean | null;
    readonly timeZone?: string;
}

/** Where a memory came from, in the web's words. */
export function memoryOrigin(memory: MemoryItem, names: MemoryNames): string {
    // Asked of a socio in a chat (CB-172), it is the person's own too.
    const asked = memory.source === 'person' && memory.dotId !== null;
    if (memory.source === 'person' && !asked) {
        return 'Added by you';
    }
    const socio = (memory.dotId === null ? null : names.dotName(memory.dotId)) ?? 'A socio';
    const chat = memory.threadId === null ? null : names.chatTitle(memory.threadId);
    return [
        asked ? `You asked ${socio} to remember it` : `Proposed by ${socio}`,
        chat === null ? '' : ` in ${chat}`,
        memory.source === 'notes' ? ', from the chat’s notes' : '',
    ].join('');
}

const MEMORY_KINDS = new Set<string>([
    MEMORY_ADD_KIND,
    MEMORY_UPDATE_KIND,
    MEMORY_APPROVE_KIND,
    MEMORY_CONFIRM_KIND,
    MEMORY_DELETE_KIND,
]);
const PROFILE_KINDS = new Set<string>([PROFILE_SAVE_KIND, PROFILE_CLEAR_KIND]);

const memoryIdOf = (write: UnsentWrite): string | null => {
    try {
        const payload = JSON.parse(write.payload) as Partial<MemoryActionPayload> | null;
        return typeof payload?.memoryId === 'string' ? payload.memoryId : null;
    } catch {
        return null;
    }
};

/** The refused memory and profile writes, with their actions. */
function problemsOf(input: MemoriesInput): MemoryProblem[] {
    const mine = input.unsent.filter((write) => MEMORY_KINDS.has(write.kind) || PROFILE_KINDS.has(write.kind));
    const rows = unsentListRows(mine, input.groups ?? [], { chatTitle: () => null, resolve: () => null });
    return rows.map((row) => {
        const write = mine.find((item) => item.id === row.id)!;
        const conflict =
            write.reason === MEMORY_REASON.conflict &&
            (write.kind === MEMORY_UPDATE_KIND || write.kind === PROFILE_SAVE_KIND);
        const memoryId = write.kind === MEMORY_UPDATE_KIND ? memoryIdOf(write) : null;
        const current =
            write.kind === PROFILE_SAVE_KIND
                ? (input.profileRow?.profile ?? null)
                : memoryId === null
                  ? null
                  : (input.rows.find((item) => item.id === memoryId) ?? null);
        const actions: ProblemAction[] = conflict
            ? // Keep mine needs what the server holds; a memory gone since leaves Keep theirs.
              [
                  ...(current === null && write.kind === MEMORY_UPDATE_KIND ? [] : (['keep-mine'] as const)),
                  'keep-theirs',
              ]
            : ['retry', ...(row.text === null ? [] : (['copy'] as const)), 'discard'];
        return {
            id: row.id,
            what: row.what,
            where: row.where,
            why: conflict ? `Couldn’t save: ${row.why.charAt(0).toLowerCase()}${row.why.slice(1)}` : row.why,
            text: row.text,
            actions,
            current,
            accessibilityLabel: [row.what, row.where, row.text, row.why].filter(Boolean).join(', '),
        };
    });
}

export function memoriesView(input: MemoriesInput): MemoriesView {
    const { names, timeZone } = input;
    const shown = shownMemories(input.rows, input.profileRow, input.overlays);
    const stored = new Map(input.rows.map((item) => [item.id, item]));
    const row = (memory: ShownMemory, proposal: boolean): MemoryRow => {
        const origin = memoryOrigin(memory, names);
        const when = proposal
            ? memoryDay(memory.createdAt, timeZone)
            : `Confirmed ${memoryDay(memory.confirmedAt ?? memory.updatedAt, timeZone)}`;
        const pending = pendingWords(memory.pending);
        const threadId = memory.threadId !== null && names.chatTitle(memory.threadId) !== null ? memory.threadId : null;
        return {
            id: memory.id,
            text: memory.text,
            origin,
            threadId,
            when,
            shareable: memory.shareable,
            pending,
            memory,
            stored: stored.get(memory.id) ?? null,
            accessibilityLabel: [
                proposal ? 'Proposal' : 'Memory',
                memory.text,
                origin,
                when,
                memory.shareable ? 'Team chats too' : null,
                pending,
            ]
                .filter(Boolean)
                .join(', '),
            testID: `${proposal ? 'memory-proposal' : 'memory'}-${memory.id}`,
        };
    };
    const profile = shown.profile;
    const storedProfile = input.profileRow?.profile ?? null;
    const rows: ProfileRow[] =
        profile === null
            ? []
            : PROFILE_FIELDS.filter((name) => (profile.fields[name] ?? '') !== '').map((name) => ({
                  label: PROFILE_LABELS[name],
                  value: profile.fields[name]!,
                  detected: name === 'timezone' && profile.timezoneDetected === true,
              }));
    const proposals = shown.proposals.map((memory) => row(memory, true));
    const memories = shown.memories.map((memory) => row(memory, false));
    const loaded = input.profileRow !== null;
    return {
        loaded,
        off: input.memoryAllowed === false ? MEMORY_OFF : null,
        moved: shown.timeZoneMoved === null ? null : movedTimeZoneText(shown.timeZoneMoved),
        proposals,
        memories,
        profile: {
            shown: profile,
            stored: storedProfile,
            rows,
            empty: loaded && rows.length === 0,
            line:
                profile === null
                    ? loaded
                        ? 'Not filled in'
                        : null
                    : `${profile.shareable ? 'Your chats and team chats' : 'Your chats only'} · Updated ${memoryDay(profile.updatedAt, timeZone)}`,
            editable: loaded,
            pending: pendingWords(shown.profilePending),
        },
        problems: problemsOf(input),
        empty: input.profileRow !== null && proposals.length === 0 && memories.length === 0,
        waiting: proposals.length,
    };
}

/**
 * Home's Memories tile: the proposals waiting with this device's writes laid
 * over (`shownMemories`, as the screen counts them), or null before
 * `/api/memories` answered once.
 */
export function waitingProposals(
    rows: readonly MemoryItem[],
    profileRow: MemoryProfileRow | null,
    overlays: readonly OverlayItem[],
): number | null {
    return profileRow === null ? null : shownMemories(rows, profileRow, overlays).proposals.length;
}

// ---- The editors ---------------------------------------------------------------

/** A memory edit's change: only what differs from what the row shows. Null when nothing does. */
export function memoryChange(
    shown: Pick<MemoryItem, 'text' | 'shareable'>,
    form: { readonly text: string; readonly shareable: boolean },
): { text?: string; shareable?: boolean } | null {
    const change = {
        ...(form.text.trim() === shown.text.trim() ? {} : { text: form.text }),
        ...(form.shareable === shown.shareable ? {} : { shareable: form.shareable }),
    };
    return Object.keys(change).length === 0 ? null : change;
}

/** A profile save's fields: those that differ from the profile as shown ('' clears one). Null when none does. */
export function profileChange(
    shown: UserProfile | null,
    form: { readonly fields: ProfileFields; readonly shareable: boolean },
): { fields: ProfileFields; shareable?: boolean } | null {
    const fields: ProfileFields = {};
    for (const name of PROFILE_FIELDS) {
        const value = form.fields[name] ?? '';
        if (value !== (shown?.fields[name] ?? '')) {
            fields[name] = value;
        }
    }
    const shareable = form.shareable === (shown?.shareable ?? false) ? undefined : form.shareable;
    if (Object.keys(fields).length === 0 && shareable === undefined) {
        return null;
    }
    return { fields, ...(shareable === undefined ? {} : { shareable }) };
}

/**
 * The profile editor's fields, in order: label, limit, placeholder, whether it
 * is a paragraph, and where the keyboard's Next goes from a one-line field (the
 * field after it; null on the paragraphs, whose Return types a new line, and on
 * a last one-line field, whose key says Done).
 */
export const PROFILE_FORM: readonly {
    readonly name: ProfileField;
    readonly label: string;
    readonly maxLength: number;
    readonly placeholder: string;
    readonly long: boolean;
    readonly next: ProfileField | null;
}[] = PROFILE_FIELDS.map((name, index) => ({
    name,
    label: PROFILE_LABELS[name],
    maxLength: PROFILE_FIELD_MAX[name],
    placeholder: (
        {
            name: 'Sam',
            pronouns: 'she/her',
            role: 'Design lead, growth team',
            timezone: 'Europe/Madrid',
            language: 'English, Spanish for chit-chat',
            style: 'Short answers, bullet points, no preamble.',
            instructions: 'Ask before scheduling anything on Fridays.',
        } as const
    )[name],
    long: profileFieldLong(name),
    next: profileFieldLong(name) ? null : (PROFILE_FIELDS[index + 1] ?? null),
}));

function profileFieldLong(name: ProfileField): boolean {
    return name === 'style' || name === 'instructions';
}

/**
 * The time zone field's line (the web's TimeZoneField): detected, not a zone
 * (shared's `ianaTimeZone`, the check `saveProfile` makes before
 * queuing), or what it is for.
 */
export function timeZoneHint(value: string, detected: boolean): { readonly text: string; readonly error: boolean } {
    if (detected) {
        return {
            text: 'Detected from your browser. Change it if it’s wrong: your socios give you times in it.',
            error: false,
        };
    }
    if (value.trim() !== '' && ianaTimeZone(value.trim()) === undefined) {
        return {
            text: 'Not a time zone name your socios can use. Pick one like Europe/Madrid.',
            error: true,
        };
    }
    return { text: 'A time zone name. Your socios give you times in it.', error: false };
}

// ---- Episodes ------------------------------------------------------------------

export interface EpisodeRow {
    readonly id: string;
    readonly text: string;
    /** "What the chat was about" for a chat's summary, else null. */
    readonly badge: string | null;
    /** "From Plans with Sebas · Oct 12, 2026". */
    readonly line: string;
    readonly threadId: string | null;
    readonly accessibilityLabel: string;
}

export interface EpisodesView {
    readonly intro: string;
    /** "12 episodes", with Search and Delete all, while there is any. */
    readonly count: string | null;
    readonly rows: readonly EpisodeRow[];
    /** What shows with no row: none yet, or none matching. */
    readonly empty: string | null;
}

const EPISODES_INTRO =
    'What your socios keep of your own chats once they get long: decisions, results and what each chat was about. They recall them in your other chats of your own, never in team chats or rooms.';
export const EPISODES_OFFLINE = 'Your episodes show when you’re online.';
export const EPISODES_FAILED = 'Couldn’t load your episodes.';

/** The episodes section from the last answer (null before one). */
export function episodesView(state: EpisodesState | null, names: MemoryNames, timeZone?: string): EpisodesView {
    const rows = (state?.episodes ?? []).map((episode: Episode): EpisodeRow => {
        const chat = names.chatTitle(episode.threadId);
        const socio = (episode.dotId === null ? null : names.dotName(episode.dotId)) ?? 'A socio';
        const line = `${chat === null ? 'From a chat' : `From ${chat}`} with ${socio} · ${memoryDay(episode.occurredAt, timeZone)}`;
        const badge = episode.kind === 'summary' ? 'What the chat was about' : null;
        return {
            id: episode.id,
            text: episode.text,
            badge,
            line,
            threadId: chat === null ? null : episode.threadId,
            accessibilityLabel: [badge, episode.text, line].filter(Boolean).join(', '),
        };
    });
    const total = state?.total ?? 0;
    return {
        intro:
            state === null
                ? EPISODES_INTRO
                : `${EPISODES_INTRO} Each is deleted after ${plural(state.retentionDays, 'day')} without coming up.`,
        count: total > 0 ? plural(total, 'episode') : null,
        rows,
        empty:
            state === null || rows.length > 0
                ? null
                : total > 0
                  ? 'No episode matches. Try other words.'
                  : 'Nothing yet. Episodes come from your own chats once they are long enough to be compacted, or when you send /compact.',
    };
}

/** Memories' route param that opens its Add sheet as the screen shows (Search's Add memory). */
export type MemoriesParams = {
    readonly add?: true;
};
