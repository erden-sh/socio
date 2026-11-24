/**
 * What grounded a turn (CB-194): the pages, search results, datasets and
 * recalled parts of the chat a socio read while it answered, recorded as
 * references only (ids, kind and Space), never their content.
 *
 * - `page`: a page it read (`read_space_page`).
 * - `search`: a page a page search showed it, with its excerpt.
 * - `context`: the page the chat is about, in the turn's note.
 * - `dataset`: a dataset it queried (`data_query`); datasets have no Space.
 * - `recall`: a part of its own chat it read again (`recall` by ref). It
 *   re-reads the chat itself, so the Space heatmap leaves it out.
 */
export const RUN_REF_KINDS = ['page', 'search', 'context', 'dataset', 'recall'] as const;
export type RunRefKind = (typeof RUN_REF_KINDS)[number];

/** The kinds a Space's grounding counts: pages, by any route. */
export const SPACE_REF_KINDS: readonly RunRefKind[] = ['page', 'search', 'context'];

/** The longest reference kept; longer ones are not recorded. */
export const RUN_REF_MAX = 200;

/** One reference a turn read. */
export interface RunRef {
    kind: RunRefKind;
    /** The page's Space; null for datasets and recalls. */
    spaceId: string | null;
    /** The page's, dataset's or recalled part's id. */
    refId: string;
}

/** How a turn records what it read; never throws. */
export type RunRefRecorder = (refs: RunRef | readonly RunRef[]) => void;
