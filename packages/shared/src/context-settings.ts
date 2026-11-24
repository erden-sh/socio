/**
 * How long chats keep their running notes (CB-129): an admin's choice in
 * Settings → General → Long chats, over `CONTEXT_SUMMARY_MODEL` and
 * `CONTEXT_SELECTION`.
 *
 * - `summaryModel` (CB-137): which model writes the notes when a chat's
 *   oldest turns are folded in: the shared model (the workspace's default
 *   backend, with its one-shot options, as titles use) or the chat's own.
 * - `selection` (CB-134): which pinned facts a prompt carries. `age`, the
 *   newest that fit; `relevance`, those that match the current request
 *   first, then the newest; `pointer`, only what the person is working on,
 *   their goals and latest decisions, with the rest found by `search_notes`.
 *   Every fact stays stored whichever is chosen.
 */
export const SUMMARY_MODELS = ['shared', 'chat'] as const;
export type SummaryModel = (typeof SUMMARY_MODELS)[number];
export const NOTES_SELECTIONS = ['age', 'relevance', 'pointer'] as const;
export type NotesSelection = (typeof NOTES_SELECTIONS)[number];

export interface ContextSettings {
    summaryModel: SummaryModel;
    selection: NotesSelection;
}

/**
 * What a server without the variables starts with: both measured on
 * synthetic long chats (scripts/experiments).
 */
export const DEFAULT_CONTEXT_SETTINGS: ContextSettings = {
    summaryModel: 'shared',
    selection: 'relevance',
};

export const SUMMARY_MODEL_LABELS: Record<SummaryModel, string> = {
    shared: 'The shared model',
    chat: 'The chat’s own model',
};

export const NOTES_SELECTION_LABELS: Record<NotesSelection, string> = {
    age: 'The newest facts',
    relevance: 'The facts that match each request',
    pointer: 'A short core, the rest on search',
};

/** Characters per token of prose (user and assistant text). */
export const PROSE_CHARS = 4;

/** The characters of memories a turn gets in all (CB-106). */
export const TURN_MEMORY_CHARS = 4_000;

/**
 * The recall budget (CB-173): about how many tokens of recalled context a
 * turn's note carries, the admin's in Settings → General → Socio replies
 * over `TURN_RECALL_TOKENS`. Unset, it is what the turn took before it
 * could be set: `TURN_MEMORY_CHARS` of memories, at `PROSE_CHARS` a token.
 * The memories get it all (and as many more or fewer of them), and the
 * pinned facts that match the request (`fit.ts`) grow and shrink in step.
 * Only the turn's note changes with it, never the system prompt.
 */
export const DEFAULT_TURN_RECALL_TOKENS = TURN_MEMORY_CHARS / PROSE_CHARS;

/** The recall budget as a share of the default: 1 unless an admin moved it. */
export const recallScale = (tokens = DEFAULT_TURN_RECALL_TOKENS) => tokens / DEFAULT_TURN_RECALL_TOKENS;
