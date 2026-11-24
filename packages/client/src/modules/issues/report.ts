import { useEffect, useSyncExternalStore } from 'react';

import type { IssueArea, IssueKind, IssuePriority } from '@socio/shared/issues/issue-types';

/** What the report form opens with (a failed run fills it in). */
export interface ReportDraft {
    title?: string;
    body?: string;
    kind?: IssueKind;
    priority?: IssuePriority;
    area?: IssueArea;
    /**
     * Components to start with (CB-442), e.g. the plugin whose page it was
     * opened on. The form keeps only those among the reader's options.
     */
    components?: string[];
    /** The failed run it is about: the filed item is linked to it (CB-194). */
    runId?: string;
}

/**
 * The one "Report an issue" dialog lives in the header (`ReportIssue`), so
 * every page has it. Anything in the module opens it here: the Issues
 * page's "New issue", the palette's "File an issue", "File issue" on a
 * failed run.
 */
let request: ReportRequest | undefined;
export interface ReportRequest {
    draft: ReportDraft;
    /** Tells requests apart: the form starts afresh for each. */
    at: number;
    /** Where the focus goes back on closing, when a menu that has gone opened it. */
    returnFocus?: HTMLElement | null;
}
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};
const emit = () => {
    for (const listener of listeners) {
        listener();
    }
};

let counter = 0;
export function openReport(draft: ReportDraft = {}, options: { returnFocus?: HTMLElement | null } = {}) {
    request = { draft, at: ++counter, returnFocus: options.returnFocus };
    emit();
}
export function closeReport() {
    request = undefined;
    emit();
}
/** The open request, while the dialog is open. */
export const useReportRequest = () =>
    useSyncExternalStore(
        subscribe,
        () => request,
        () => undefined,
    );

/** An issue was filed or changed outside the Issues page: reload it. */
const changed = new Set<() => void>();
export function notifyIssuesChanged() {
    for (const listener of changed) {
        listener();
    }
}
export function useIssuesChanged(listener: () => void) {
    useEffect(() => {
        changed.add(listener);
        return () => {
            changed.delete(listener);
        };
    }, [listener]);
}
