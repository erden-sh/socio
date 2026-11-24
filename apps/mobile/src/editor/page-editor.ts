import type { Page } from '@socio/shared/pages/page-library';

import type { OutboxRow, UnsentWrite } from '../sync/outbox';
import type { EditorDraft } from '../sync/page-drafts';
import {
    decodeSave,
    PAGE_CREATE_KIND,
    PAGE_SAVE_KIND,
    pageConflictLane,
    type PageCreateText,
    pageWriteLanes,
} from '../sync/page-save';

// The page editor's view models, with no React Native: where the
// editor starts, and the save line under the title. tests/editor/page-editor.test.ts.

/** What the outbox holds that the editor reads (the open scope's). */
export interface EditorOutbox {
    rows(): OutboxRow[];
    unsent(): UnsentWrite[];
    resolve(kind: string, localId: string): string | null;
}

const parse = <T>(text: string): T | null => {
    try {
        return JSON.parse(text) as T;
    } catch {
        return null;
    }
};

/**
 * Where the editor opens, newest first: the editor draft a kill or a dead
 * WebView left (the draft's `stored`), then the page's newest save still in the
 * outbox (its draft, on the base that row stands on), then a create made on
 * the phone that hasn't gone, then the body the phone holds. Null when there
 * is none (offline, never opened): the screen says to open it online. A
 * refused save (a conflict) is never where it opens: the page shows theirs
 * under the banner, as the reader does.
 */
export function editorStart(
    stored: EditorDraft | undefined,
    outbox: EditorOutbox,
    pageId: string,
    body: Page | null,
): EditorDraft | null {
    if (stored !== undefined) {
        return stored;
    }
    const lanes = pageWriteLanes(outbox, pageId);
    const writes = outbox.rows().filter((row) => lanes.has(row.lane));
    for (const row of [...writes].reverse()) {
        if (row.kind === PAGE_SAVE_KIND) {
            try {
                const save = decodeSave(row.payload);
                return {
                    spaceId: save.spaceId,
                    revision: save.base.revision,
                    title: save.draft.title,
                    content: save.draft.content,
                };
            } catch {
                continue;
            }
        }
        if (row.kind === PAGE_CREATE_KIND) {
            const create = parse<PageCreateText>(row.payload);
            if (create !== null && typeof create.title === 'string' && typeof create.content === 'string') {
                return { spaceId: create.spaceId, revision: 1, title: create.title, content: create.content };
            }
        }
    }
    return body === null
        ? null
        : { spaceId: body.spaceId, revision: body.revision, title: body.title, content: body.content };
}

export const SAVED = 'Saved';
export const SAVING = 'Saving…';
export const WAITING_TO_SEND = 'Waiting to send';
export const COULDNT_SAVE = 'Couldn’t save';

export type SaveLineTone = 'muted' | 'destructive';

export interface SaveLine {
    readonly text: string;
    readonly tone: SaveLineTone;
    /** The draft's own problem (a page's limits, the web's words), under the line. */
    readonly detail: string | null;
}

export interface SaveLineInput {
    readonly outbox: Pick<EditorOutbox, 'rows' | 'unsent' | 'resolve'>;
    readonly pageId: string;
    /** The draft's `error()`: a draft over a page's limits never queues. */
    readonly draftError: string | undefined;
    /** Changed within the draft's debounce (the session's `editing`). */
    readonly editing: boolean;
    /** False only when NetInfo says there is no network. */
    readonly connected: boolean;
    /** The outbox holds every lane for a sign-in (a 401), or writes wait for an update. */
    readonly held: boolean;
}

/**
 * The editor's save line, from the outbox's state (the web's "Saving…" and
 * "Could not save", with the phone's "Waiting to send"): a refused save of the
 * page, or a draft over a page's limits, is "Couldn't save"; a row in flight
 * "Saving…"; a row waiting while offline or held "Waiting to send"; typing not
 * yet handed to the outbox "Saving…"; otherwise "Saved".
 */
export function saveLine(input: SaveLineInput): SaveLine {
    const { outbox, pageId } = input;
    if (input.draftError !== undefined) {
        return { text: COULDNT_SAVE, tone: 'destructive', detail: input.draftError };
    }
    const lanes = pageWriteLanes(outbox, pageId);
    for (const lane of [...lanes]) {
        if (lane.startsWith('page:')) {
            lanes.add(pageConflictLane(lane.slice('page:'.length)));
        }
    }
    const saves = (write: { readonly lane: string; readonly kind: string }) =>
        lanes.has(write.lane) && (write.kind === PAGE_SAVE_KIND || write.kind === PAGE_CREATE_KIND);
    if (outbox.unsent().some(saves)) {
        return { text: COULDNT_SAVE, tone: 'destructive', detail: null };
    }
    const rows = outbox.rows().filter(saves);
    if (rows.some((row) => row.state === 'inflight')) {
        return { text: SAVING, tone: 'muted', detail: null };
    }
    if (rows.length > 0) {
        return {
            text: input.connected && !input.held ? SAVING : WAITING_TO_SEND,
            tone: 'muted',
            detail: null,
        };
    }
    if (input.editing) {
        return { text: input.connected && !input.held ? SAVING : WAITING_TO_SEND, tone: 'muted', detail: null };
    }
    return { text: SAVED, tone: 'muted', detail: null };
}

export const REVIEW_EDITS_HERE = 'Your edits stay on this phone until you save the review.';
export const REVIEW_CANT_SAVE = 'Can’t save yet';

/**
 * A page review's editor's line: nothing goes until the review's Save, so it
 * says where the edits are, or what keeps them from saving (a page's limits
 * and the review's: some text).
 */
export function reviewEditLine(draftError: string | undefined): SaveLine {
    return draftError === undefined
        ? { text: REVIEW_EDITS_HERE, tone: 'muted', detail: null }
        : { text: REVIEW_CANT_SAVE, tone: 'destructive', detail: draftError };
}

/** Advanced mode's line: the editor's base revision, the base the queued save stands on, and its lane. */
export function advancedLine(outbox: EditorOutbox, pageId: string, revision: number): string {
    const lanes = pageWriteLanes(outbox, pageId);
    const row = outbox
        .rows()
        .filter((each) => lanes.has(each.lane) && each.kind === PAGE_SAVE_KIND)
        .at(-1);
    let base = '–';
    if (row !== undefined) {
        try {
            base = String(decodeSave(row.payload).base.revision);
        } catch {
            base = '?';
        }
    }
    const lane = row?.lane ?? [...lanes][0] ?? '';
    return `Revision ${revision} · base ${base} · lane ${lane}`;
}
