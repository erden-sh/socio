import type { ThemeOutcome } from '../classify.js';

import type { OpsOutcome } from './operations-activity.js';
import type { OpsAnswer } from './operations.js';

/**
 * Operations → Themes (CB-199): what people come to socios for. Each of
 * people's sessions (CB-190's) takes the intent and themes of the
 * earliest labeled turn in it (`classify`'s `intent` and `themes`
 * uses); the outcome is the session's own, by CB-164. Topics are
 * clustered by `topicKey` and counted per week of the reporting time
 * zone.
 *
 * Privacy: a theme is named only when `THEMES_MIN_PEOPLE` different
 * people had sessions on it in the range and filters; the rest are
 * counted together, never named. Intents are an admin's closed list, so
 * they are shown as counts like failure categories.
 */

/** Sessions by outcome. */
export type OpsOutcomeCounts = Record<OpsOutcome, number>;

/** One intent's sessions; `intent` null: sessions with none in force. */
export interface OpsIntentRow extends OpsOutcomeCounts {
    intent: string | null;
    sessions: number;
    people: number;
}

/** A theme: one cluster of topics, named by its most frequent wording. */
export interface OpsThemeRow extends OpsOutcomeCounts {
    key: string;
    topic: string;
    sessions: number;
    people: number;
    /** The model's outcome hints, from the first messages. */
    hints: Record<ThemeOutcome, number>;
    /** Sessions per week, as `OpsThemesFacts.weeks`. */
    weeks: number[];
    /** Its sessions' intents, the most first. */
    intents: { intent: string | null; sessions: number }[];
}

/** One session as the themes' aggregation reads it (both readers make these). */
export interface OpsLabelledSession {
    id: string;
    startedAt: number;
    outcome: OpsOutcome;
    people: readonly string[];
    intent: string | null;
    /** Its topics with their keys; none: no themes in force. */
    topics: readonly { topic: string; key: string }[];
    hint: ThemeOutcome | null;
}

export interface OpsThemesFacts {
    /** People's sessions in the range. */
    sessions: number;
    /** Of them, with an intent and with themes in force. */
    withIntent: number;
    withThemes: number;
    /** The privacy floor in force: people per named theme. */
    minPeople: number;
    /** The weeks of the range (starts, in the reporting time zone). */
    weeks: number[];
    /** Sessions with themes, per week. */
    weekSessions: number[];
    intents: OpsIntentRow[];
    /** Named themes, the most sessions first, at most `OPS_THEMES_SHOWN`. */
    themes: OpsThemeRow[];
    /** Themes under the floor: how many, and sessions on none of the named ones. */
    hidden: { themes: number; sessions: number };
    /** Themes over the floor past `OPS_THEMES_SHOWN`. */
    more: number;
}

export interface OpsThemes extends OpsAnswer {
    sessionGapMinutes: number;
    /** Null while analytics has no answer. */
    facts: OpsThemesFacts | null;
}

/** The most themes an answer names. */
export const OPS_THEMES_SHOWN = 40;

/** Intent's name in Operations: its value, capitalized; none says so. */
export const intentName = (intent: string | null) =>
    intent === null ? 'No intent' : `${intent.slice(0, 1).toUpperCase()}${intent.slice(1)}`;
