import type { Conversation } from './types.js';

/**
 * The "Ask a socio" panel (CB-26): what a screen is about. `general` is a
 * screen with no item of its own (home, chats, settings): the panel is
 * then a quick conversation with no item context.
 */
export const ASK_CONTEXT_KINDS = ['page', 'issue', 'dataset', 'schedule', 'general'] as const;
export type AskContextKind = (typeof ASK_CONTEXT_KINDS)[number];

/** A screen's item, as the panel asks for it (from the route's params). */
export interface AskContextRef {
    kind: AskContextKind;
    /** The page, issue (`CB-12`), dataset or schedule id; empty for `general`. */
    id: string;
}

/**
 * The item as the viewer may see it now (the server checked): its name for
 * the panel and the path back to it. Never more than the viewer's own view.
 */
export interface AskContext extends AskContextRef {
    /** Null for `general`. */
    title: string | null;
    /** Null for `general`. */
    path: string | null;
}

/** `GET /api/ask/conversation`: the context, the socio, and the thread if any. */
export interface AskLookup {
    context: AskContext;
    /** The socio this answer is for: the one asked for, else the person's last used. */
    dotId: string | null;
    /** The person's thread with that socio about this item, once they asked. */
    conversation: Conversation | null;
}

/** `POST /api/ask/conversation`: the thread, created on first use. */
export interface AskOpened {
    context: AskContext;
    conversation: Conversation;
}

/** The context's label in sentences ("this issue"). */
export const askContextNoun: Record<AskContextKind, string> = {
    page: 'page',
    issue: 'issue',
    dataset: 'dataset',
    schedule: 'schedule',
    general: 'screen',
};
