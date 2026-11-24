import type { RunSourceKind } from '../runs/run-sources.js';

import type { OpsIntentRow } from './operations-themes.js';
import type { OpsAnswer } from './operations.js';

/**
 * Operations → Activity and Value (CB-190): who uses which socios, how
 * often and through which channels, and which work gets finished. Every
 * number follows the definitions in the CB-164 design, computed from
 * the analytics store's facts when asked, so a new session gap or time
 * zone re-derives them:
 *
 * - **Activity** is people's messages in turns from a `human` source (the
 *   source registry says which); automation is reported apart.
 * - **A session** is a chat's messages, from anyone in it, with gaps under
 *   the session gap (30 minutes by default, an admin setting). It is a
 *   person's when they wrote in it; workspace totals count it once. A
 *   session is in a window when it starts in it.
 * - **Completed**: its last turn finished, and an outcome signal (a thumbs
 *   up, an approval carried out, a page the socio wrote, a memory kept)
 *   came in it or within 24 hours. **Abandoned**: no message in the chat
 *   for 24 hours after it, and its last turn failed, was interrupted or
 *   stopped, an approval expired, or its last reaction was down, retry or
 *   needs work. **Answered**: the rest; a band of its own, not success.
 */

/** Sessions: the gap that ends one, in minutes (`OPS_SESSION_GAP_MINUTES`). */
export const OPS_SESSION_GAP = { default: 30, min: 1, max: 24 * 60 } as const;

/** How long after a session its outcome may still show (signals, silence). */
export const OPS_OUTCOME_WINDOW_MS = 24 * 3_600_000;
/** A socio's repeat use looks at its people over the last 28 days. */
export const OPS_REPEAT_DAYS = 28;
/** The return rate: a session with the same socio within 7 days after. */
export const OPS_RETURN_DAYS = 7;

export const OPS_OUTCOMES = ['completed', 'answered', 'abandoned'] as const;
export type OpsOutcome = (typeof OPS_OUTCOMES)[number];
export const OPS_OUTCOME_LABELS: Record<OpsOutcome, string> = {
    completed: 'Completed',
    answered: 'Answered',
    abandoned: 'Abandoned',
};

/** A tile: its value in the window and the period before; null: no data. */
export interface OpsValueTile<Id extends string> {
    id: Id;
    value: number | null;
    previous: number | null;
}

/** Activity's tiles. `stickiness` is a share (0 to 1); `length` messages per session. */
export const OPS_ACTIVITY_TILES = ['people', 'returning', 'stickiness', 'sessions', 'chats', 'length'] as const;
export type OpsActivityTileId = (typeof OPS_ACTIVITY_TILES)[number];
export const OPS_ACTIVITY_TILE_LABELS: Record<OpsActivityTileId, string> = {
    people: 'Active people',
    returning: 'Returning people',
    stickiness: 'Stickiness',
    sessions: 'Sessions',
    chats: 'Chats with people',
    length: 'Messages per session',
};

/** Value's tiles. `completedShare` and `resumption` are shares (0 to 1). */
export const OPS_VALUE_TILES = ['completed', 'answered', 'abandoned', 'completedShare', 'resumption'] as const;
export type OpsValueTileId = (typeof OPS_VALUE_TILES)[number];
export const OPS_VALUE_TILE_LABELS: Record<OpsValueTileId, string> = {
    completed: 'Completed sessions',
    answered: 'Answered sessions',
    abandoned: 'Abandoned sessions',
    completedShare: 'Share completed',
    resumption: 'Chats resumed',
};

/** Tiles that are shares, shown as percentages. */
export const OPS_SHARE_TILES = new Set<string>(['stickiness', 'completedShare', 'resumption']);

/** One bucket of Activity's chart. */
export interface OpsActivityPoint {
    at: number;
    people: number;
    sessions: number;
    messages: number;
}

/** Turns and people per source, human and automation apart. */
export interface OpsSourceUse {
    key: string;
    label: string;
    kind: RunSourceKind;
    turns: number;
    messages: number;
    people: number;
}

/** Who takes part in chats: several people, several socios. */
export interface OpsParticipation {
    /** Chats with people's messages in the window. */
    chats: number;
    withSeveralPeople: number;
    withSeveralSocios: number;
    /** Turns a socio started for another socio: collaboration, not use. */
    collaboration: number;
}

/** A capability's use (tools a module's capability brings, or a lone tool). */
export interface OpsFeatureUse {
    /** The capability's id, or `tool:<name>` for a tool no capability declares. */
    id: string;
    label: string;
    tools: string[];
    calls: number;
    people: number;
    socios: number;
    errors: number;
    refusals: number;
}

/** Writes to a Space's pages, by people and by socios, and who uses its socios. */
export interface OpsSpaceUse {
    spaceId: string;
    name: string | null;
    writesByPeople: number;
    writesBySocios: number;
    pages: number;
    /** People who wrote to the Space's socios. */
    people: number;
    /** The Space's socios that had turns. */
    socios: number;
    turns: number;
}

/** The tool → capability map the app's registry gives (the analytics process has none). */
export interface OpsToolCapability {
    tool: string;
    capability: string;
}

/** What the analytics store answers for Activity, before tools are labeled. */
export interface OpsActivityFacts {
    tiles: OpsValueTile<OpsActivityTileId>[];
    points: OpsActivityPoint[];
    sources: OpsSourceUse[];
    participation: OpsParticipation;
    /** Grouped by capability id (or `tool:<name>`); labels added by the app. */
    features: Omit<OpsFeatureUse, 'label'>[];
    spaces: OpsSpaceUse[];
}

export interface OpsActivity extends OpsAnswer, OpsActivityFacts {
    features: OpsFeatureUse[];
    sessionGapMinutes: number;
}

/** One bucket of Value's chart: sessions by outcome. */
export interface OpsValuePoint {
    at: number;
    completed: number;
    answered: number;
    abandoned: number;
}

/** The approvals funnel of one capability (its approval id). */
export interface OpsApprovalFunnel {
    capability: string;
    requested: number;
    /** By the person, by their auto policy, or bypassed. */
    approved: number;
    denied: number;
    expired: number;
    executed: number;
    failed: number;
}

/** Reactions to socios' messages, with how many messages got one. */
export interface OpsReactionUse {
    socioMessages: number;
    reacted: number;
    up: number;
    down: number;
    retry: number;
    needsWork: number;
}

export interface OpsValueFacts {
    tiles: OpsValueTile<OpsValueTileId>[];
    points: OpsValuePoint[];
    approvals: OpsApprovalFunnel[];
    reactions: OpsReactionUse;
    /** Sessions' outcomes by intent (CB-199), no intent last. */
    intents: OpsIntentRow[];
}

export interface OpsValue extends OpsAnswer, OpsValueFacts {
    sessionGapMinutes: number;
}

/** A person in Activity's list: their use in the window, last active first. */
export interface OpsPersonRow {
    personId: string;
    name: string | null;
    messages: number;
    sessions: number;
    chats: number;
    socios: number;
    activeDays: number;
    toolCalls: number;
    completed: number;
    lastAt: number;
}

/** A socio's use and usefulness in the window, last active first. */
export interface OpsSocioRow {
    socioId: string;
    name: string | null;
    people: number;
    sessions: number;
    chats: number;
    /** People's messages to it. */
    messages: number;
    turns: number;
    /** Messages per chat, everyone's. */
    perChat: number;
    /** Share of its people of the last 28 days who came on 2 or more days. */
    repeatUse: number | null;
    collaboration: number;
    completed: number;
    answered: number;
    abandoned: number;
    /** Share of its people who had another session with it within 7 days. */
    returnRate: number | null;
    lastAt: number;
}

/** A chat in the window: who took part and how long, last active first. */
export interface OpsChatRow {
    threadId: string;
    socioId: string | null;
    socioName: string | null;
    /** A shared Telegram topic is a team's; a room is its own (CB-218). */
    ownerKind: 'person' | 'team' | 'room' | null;
    people: number;
    socios: number;
    messages: number;
    sessions: number;
    activeDays: number;
    /** People wrote in it on 2 or more days. */
    resumed: boolean;
    lastAt: number;
}

/** A session, newest first, with its outcome. */
export interface OpsSessionRow {
    /** `<threadId>@<startedAt>`. */
    id: string;
    threadId: string;
    socioId: string | null;
    socioName: string | null;
    source: string;
    startedAt: number;
    endedAt: number;
    messages: number;
    people: number;
    socios: number;
    outcome: OpsOutcome;
}
