import type { Memory } from './types.js';

/**
 * A person's own context for their socios (CB-106, docs/MEMORY.md): their
 * profile, written by them, and their memories, each added by them or
 * proposed by a socio and approved by them. Both are theirs alone: a turn
 * gets only its own person's, and a chat with several people only what
 * its owner marked for team chats.
 */

/** `proposed`: a socio suggested it, waiting for the person; `active`: in use. */
export type MemoryStatus = 'proposed' | 'active';
/**
 * Where a memory came from: the person added it (`person`), a socio
 * proposed it (`socio`), or a socio proposed a fact from a chat's notes
 * (`notes`, CB-134's fact store). A memory the person asked a socio to
 * save about themselves (CB-172) is theirs, `person`, with the socio and
 * the chat they asked in.
 */
export type MemorySource = 'person' | 'socio' | 'notes';

/** One memory, with its owner's controls and where it came from. */
export interface MemoryItem extends Memory {
    status: MemoryStatus;
    source: MemorySource;
    /** Used in chats with several people (a team topic); off by default. */
    shareable: boolean;
    /**
     * The socio that proposed it, or that the person asked to save it, and
     * the chat it came from; null for one they added in Memories.
     */
    dotId: string | null;
    threadId: string | null;
    updatedAt: number;
    /** When the person last said it holds: added, approved or confirmed; null while proposed. */
    confirmedAt: number | null;
}

/** The profile's fields, in the order the page and the turn show them. */
export const PROFILE_FIELDS = ['name', 'pronouns', 'role', 'timezone', 'language', 'style', 'instructions'] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

/** What each field is called, on the page and in the turn's note. */
export const PROFILE_LABELS: Record<ProfileField, string> = {
    name: 'Preferred name',
    pronouns: 'Pronouns',
    role: 'Role and team',
    timezone: 'Time zone',
    language: 'Language',
    style: 'How I like answers',
    instructions: 'Standing instructions',
};

/** The longest a field may be: a line for most, a paragraph for the last two. */
export const PROFILE_FIELD_MAX: Record<ProfileField, number> = {
    name: 80,
    pronouns: 40,
    role: 160,
    timezone: 64,
    language: 64,
    style: 600,
    instructions: 1200,
};

export type ProfileFields = Partial<Record<ProfileField, string>>;

/** A person's profile: only the fields they filled in. */
export interface UserProfile {
    fields: ProfileFields;
    /** Used in chats with several people; off by default. */
    shareable: boolean;
    /**
     * The time zone was detected from the person's browser (CB-159), not
     * written by them; set only then.
     */
    timezoneDetected?: true;
    updatedAt: number;
}

/** `GET /api/memories`: the person's profile, memories and the proposals waiting. */
export interface MemoriesState {
    profile: UserProfile | null;
    memories: MemoryItem[];
    proposals: MemoryItem[];
    /**
     * The zone the person's detected time zone moved to (CB-176), until the
     * page has shown its quiet note once.
     */
    timeZoneMoved?: string;
}

export const MEMORY_TEXT_MAX = 2000;
/** At most this many proposals wait for a person; a socio can't add more. */
export const PROPOSALS_WAITING_MAX = 50;

/**
 * Where an episode came from (CB-180): a fact one of the person's chats
 * pinned in its notes when it was compacted (`fact`), or that chat's
 * running summary (`summary`, one per chat, the latest).
 */
export type EpisodeKind = 'fact' | 'summary';

/**
 * An episode (CB-180, docs/MEMORY.md): what happened in one of the
 * person's own chats (a decision, a result, a goal, what the chat was
 * about), kept so their socios can recall it in their other chats. Not a
 * memory: captured automatically, never approved, and never used in a
 * chat with other people in it. The person sees, searches and deletes
 * them on the Memories page; deleting one removes it.
 */
export interface Episode {
    id: string;
    kind: EpisodeKind;
    /** The fact's kind as the notes wrote it ("Decision", "Result"…); null for none. */
    label: string | null;
    text: string;
    /** The socio of the chat it came from; null if unknown. */
    dotId: string | null;
    /** The chat it came from. */
    threadId: string;
    /**
     * When it happened: the time the chat's newest folded turn was told,
     * else when it was captured. Pinned again later, it moves on.
     */
    occurredAt: number;
    createdAt: number;
}

/** `GET /api/memories/episodes`: the person's episodes, newest first, or those matching `q`. */
export interface EpisodesState {
    episodes: Episode[];
    /** How many the person has in all. */
    total: number;
    /** How long one is kept after it last came up (Settings, CB-180). */
    retentionDays: number;
}

/** The most episodes one page of `GET /api/memories/episodes` gives. */
export const EPISODES_PAGE_MAX = 100;
