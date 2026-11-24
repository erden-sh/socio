/**
 * What the Activity and Value ETL reads besides turns (CB-190): one port,
 * as `SourceReader`, so a Postgres adapter can replace the SQLite one.
 * Logs are read by keyset in batches of at most `ETL_BATCH`; the small
 * mutable tables whole, after a cheap fingerprint says they changed.
 */

/** An approval event, with its request's chat. */
export interface SourceApproval {
    id: string;
    createdAt: number;
    requestId: string | null;
    threadId: string | null;
    dotId: string;
    userId: string;
    capability: string;
    event: string;
}

export interface SourceReaction {
    threadId: string;
    messageId: string;
    userId: string;
    kind: string;
    createdAt: number;
}

/** A kept page revision: the edit by `authorId` at `replacedAt`. */
export interface SourceRevision {
    id: number;
    pageId: string;
    spaceId: string;
    authorId: string | null;
    replacedAt: number;
}

/**
 * A page as made. `createdBy` is the person it was made for: who made it,
 * or the chat's owner when a socio's create_space_page made it (with no
 * chat). A page with a chat was saved from it: a person's "Save as page",
 * or a socio's draft the person approved (`reviewed`, `page_reviews`).
 */
export interface SourcePage {
    id: string;
    spaceId: string;
    createdAt: number;
    createdBy: string | null;
    sourceThreadId: string | null;
    /** The socio of that chat. */
    socioId: string | null;
    /** 1 when a socio drafted it and a person approved it (`page_reviews`). */
    reviewed: number;
}

export interface SourceMemory {
    id: string;
    threadId: string;
    userId: string | null;
    status: string;
    createdAt: number;
    confirmedAt: number | null;
    deletedAt: number | null;
}

/** A keyset position: after this time, then after this id. */
export type Keyset = [at: number, id: string];

/** Each read is null while the app hasn't made its table (a new database). */
export interface ActivitySourceReader {
    approvalsAfter(after: Keyset, limit: number): SourceApproval[] | null;
    revisionsAfter(id: number, limit: number): SourceRevision[] | null;
    pagesAfter(after: Keyset, limit: number): SourcePage[] | null;
    /** A fingerprint of the reactions: it changes when any is added or removed. */
    reactionsPrint(): string | null;
    reactions(): SourceReaction[];
    memoriesPrint(): string | null;
    memories(): SourceMemory[];
}
