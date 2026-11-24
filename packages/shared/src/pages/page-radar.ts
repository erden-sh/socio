/**
 * A Space's project change radar (CB-282): a read-only synthesis view over
 * its existing pages and revisions. Three signals, computed from current
 * data — no new persistent state.
 *
 * - **Recent changes**: the Space's pages most recently updated, newest
 *   first, with `updatedAt`, a revision count, and a link.
 * - **Open decisions/experiments**: a heuristic signal. A page is flagged
 *   when its title or content carries a marker the radar recognizes. The
 *   markers are simple, documented below, and kept to a short list — this
 *   is not NLP, just a grep the owner can reason about.
 * - **Stale items**: pages whose `updatedAt` is older than `staleDays`
 *   from now (so a lone page in a quiet Space is still flagged), with
 *   their age in days.
 *
 * Each entry links to the underlying page. The view is opt-in
 * (`/spaces/:id/radar`) and read-gated the same way pages are (CB-181): a
 * Space the person may not read is a 404, not a hint it exists.
 */

/** One page as the radar lists it, across all three signals. */
export interface RadarEntry {
    id: string;
    spaceId: string;
    parentId: string | null;
    title: string;
    /** The start of the page as a card shows it (same excerpt as the library). */
    excerpt: string;
    /** The page's current revision number. */
    revision: number;
    /** How many earlier states are kept for this page (`page_revisions`). */
    revisions: number;
    createdAt: number;
    updatedAt: number;
    /** Whole days since `updatedAt` (0 for anything touched today). */
    ageDays: number;
}

/** An open decision/experiment signal: which markers matched a page. */
export interface RadarOpenEntry extends RadarEntry {
    /** The marker phrases that matched the page's title or content. */
    markers: string[];
}

/**
 * A Space's change radar. `staleDays` is the threshold actually used, so
 * the view can show it. `now` is the moment the radar was computed.
 */
export interface SpaceRadar {
    spaceId: string;
    now: number;
    /** The stale threshold in days the radar used. */
    staleDays: number;
    /** Most recently updated pages, newest first. */
    recent: RadarEntry[];
    /** Pages flagged as carrying an open decision/experiment marker. */
    open: RadarOpenEntry[];
    /** Pages older than the stale threshold, oldest first. */
    stale: RadarEntry[];
    /** How many live pages the Space has (the radar's scope). */
    total: number;
}

/**
 * The markers the open-decision heuristic looks for, case-insensitive, as
 * whole words at the start of a line or after punctuation/whitespace. A
 * page is flagged when any of these appears in its title or content.
 * Deliberately short and plain so the owner can predict what it catches.
 */
export const RADAR_OPEN_MARKERS = [
    'todo',
    'decision',
    'decide',
    'experiment',
    'question',
    'open question',
    'tbd',
    'pending',
    'unresolved',
    'follow up',
    'followup',
] as const;

/**
 * The default stale threshold: a page older than this (in whole days
 * from now) is flagged as stale. Absolute from now, not relative to the
 * newest page, so a quiet Space with one old page still flags it.
 */
export const RADAR_STALE_DAYS = 30;

/** How many recent changes and stale entries the radar lists. */
export const RADAR_LIMIT = 12;
