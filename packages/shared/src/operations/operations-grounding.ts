import type { RunRefKind } from '../runs/run-refs.js';

import type { OpsAnswer } from './operations.js';

/**
 * Operations → grounding (CB-194): what socios read to answer, by Space
 * and per chat, from the references turns recorded (`run-refs.ts`). Only
 * ids, kinds, Space names and page titles or dataset names, the same as
 * Knowledge's lists show; never what a page, dataset or chat says.
 */

/** The most pages the "grounded most" list shows. */
export const OPS_GROUNDING_TOP_PAGES = 10;
/** The most references a chat's grounding lists. */
export const OPS_CHAT_GROUNDING_MAX = 200;

/** References of one kind in the range. */
export interface OpsGroundingKind {
    kind: RunRefKind;
    /** References: a turn and what it read, each once per turn. */
    refs: number;
    /** Turns that read any of this kind. */
    runs: number;
}

/**
 * A Space's pages grounding turns in the range: `reads` counts each turn
 * and page once, however the turn reached it (a search, a read, the
 * chat's page).
 */
export interface OpsGroundingSpace {
    spaceId: string;
    /** Null for a Space the dimensions don't hold (deleted since). */
    name: string | null;
    reads: number;
    /** Distinct pages read. */
    pages: number;
    /** Distinct chats they grounded. */
    chats: number;
}

/** One heatmap cell: a Space's reads in one bucket. Empty ones are left out. */
export interface OpsGroundingCell {
    spaceId: string;
    at: number;
    reads: number;
}

/** A page that grounded the most chats in the range. */
export interface OpsGroundingPage {
    pageId: string;
    spaceId: string | null;
    spaceName: string | null;
    /** Null for a page deleted since. */
    title: string | null;
    reads: number;
    chats: number;
    lastAt: number;
}

export interface OpsGrounding {
    /** Turns that read anything, and their chats. */
    runs: number;
    chats: number;
    /** Every kind, in `RUN_REF_KINDS` order, recalls and datasets too. */
    kinds: OpsGroundingKind[];
    /** The window's bucket starts, the heatmap's columns. */
    buckets: number[];
    /** Spaces with reads, most first: the heatmap's rows. */
    spaces: OpsGroundingSpace[];
    cells: OpsGroundingCell[];
    /** Most chats first, at most `OPS_GROUNDING_TOP_PAGES`. */
    pages: OpsGroundingPage[];
}

/** `GET /api/operations/knowledge/grounding`. */
export interface OpsGroundingView extends OpsAnswer {
    /** Null while analytics has no answer. */
    grounding: OpsGrounding | null;
}

/** One thing a chat's turns read, with how often and when. */
export interface OpsChatRef {
    kind: RunRefKind;
    spaceId: string | null;
    spaceName: string | null;
    refId: string;
    /** A page's title or a dataset's name; null when gone, and for recalls. */
    title: string | null;
    /** Turns that read it. */
    runs: number;
    firstAt: number;
    lastAt: number;
}

/** `GET /api/operations/chats/:threadId/grounding`: newest first. */
export interface OpsChatGrounding {
    refs: OpsChatRef[];
    /** More than `OPS_CHAT_GROUNDING_MAX` references; the oldest left out. */
    more: boolean;
}
