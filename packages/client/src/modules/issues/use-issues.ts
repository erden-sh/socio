import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
    issueExcerpt,
    issueSummary,
    type Issue,
    type IssueDetail,
    type IssueList,
    type IssueSearch,
    type IssueSummary,
} from '@socio/shared/issues/issue-types';
import { foldText } from '@socio/shared/pages/page-search';

import { useSearchAsYouType } from '../../hooks/use-search-as-you-type';
import { api, apiIfChanged, PollTags, UNCHANGED } from '../../lib/api';
import { useLiveTopic } from '../../lib/change-channel';

import { shareIssueCollection, shareIssueLabels, shareIssueUsers } from './issue-collection';
import type { ComponentLabels } from './IssueComponents';
import { useIssuesChanged } from './report';

/** The fields a PATCH can change (`issuePatch` on the server). */
export type IssueChange = Partial<
    Pick<
        Issue,
        | 'title'
        | 'body'
        | 'status'
        | 'priority'
        | 'kind'
        | 'area'
        | 'labels'
        | 'components'
        | 'assigneeId'
        | 'resolution'
    >
>;

/** How often the open board re-reads the list (others may triage too). */
export const ISSUES_POLL_MS = 15_000;

/** A list row with a change on top: a new description as its excerpt. */
function withChange(issue: IssueSummary, change: IssueChange): IssueSummary {
    const { body, ...fields } = change;
    delete fields.resolution;
    return {
        ...issue,
        ...fields,
        ...(body === undefined ? {} : { excerpt: issueExcerpt(body) }),
    };
}

/**
 * The issue list, polled while the page is open, with optimistic updates:
 * a change shows at once, is sent, and rolls back if the server refuses it
 * (the caller shows the error). A poll that lands meanwhile keeps the
 * pending change on top. The list has excerpts, not descriptions (CB-71);
 * `version` counts the server's new answers, for the search.
 */
export function useIssues() {
    const [issues, setIssues] = useState<IssueSummary[]>();
    const [users, setUsers] = useState<Record<string, string>>({});
    // How the listed issues' components read (CB-442), like `users`.
    const [components, setComponents] = useState<ComponentLabels>({});
    const [error, setError] = useState('');
    const [version, setVersion] = useState(0);
    const pending = useRef(new Map<number, IssueChange>());
    // The list's tag: a poll with no change is a 304 (api.ts).
    const [tags] = useState(() => new PollTags());
    // The issues the server listed last (a 304 says they are still those).
    const served = useRef<IssueSummary[] | undefined>(undefined);
    const load = useCallback(async (): Promise<IssueSummary[] | undefined> => {
        try {
            const answer = await apiIfChanged<IssueList>('/issues', tags.get('/issues'));
            if (answer === UNCHANGED) {
                setError('');
                return served.current;
            }
            const next = answer.data;
            tags.set('/issues', answer.tag);
            const snapshot = shareIssueCollection(served.current, next.issues);
            served.current = snapshot;
            const shown = snapshot.map((issue) => {
                const change = pending.current.get(issue.number);
                return change ? withChange(issue, change) : issue;
            });
            setIssues((current) => shareIssueCollection(current, shown));
            setUsers((current) => shareIssueUsers(current, next.users));
            setComponents((current) => shareIssueLabels(current, next.components ?? {}));
            setVersion((count) => count + 1);
            setError('');
            return snapshot;
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            return undefined;
        }
    }, [tags]);
    // A note (or the tab coming back) reaches the list and the open issue
    // together: they share one read, which the open issue waits for before
    // asking for itself (one deleted elsewhere has left the list by then).
    const noted = useRef<Promise<IssueSummary[] | undefined> | undefined>(undefined);
    const reread = useCallback(
        () =>
            (noted.current ??= load().finally(() => {
                noted.current = undefined;
            })),
        [load],
    );
    useEffect(() => {
        void load();
        const timer = setInterval(() => {
            if (document.visibilityState !== 'hidden') {
                void load();
            }
        }, ISSUES_POLL_MS);
        return () => clearInterval(timer);
    }, [load]);
    useIssuesChanged(load);
    // Another tab changed an issue, or this one came back into view.
    useLiveTopic('issues', reread);

    /** Puts a fresh copy of one issue in the list (from a detail response). */
    const replace = useCallback((detail: IssueDetail) => {
        const fresh = issueSummary(detail.issue);
        const upsert = (current: IssueSummary[] | undefined, row: IssueSummary) =>
            shareIssueCollection(
                current,
                current?.some((issue) => issue.number === row.number)
                    ? current.map((issue) => (issue.number === row.number ? row : issue))
                    : [row, ...(current ?? [])],
            );
        served.current = upsert(served.current, fresh);
        const change = pending.current.get(fresh.number);
        setIssues((current) => upsert(current, change ? withChange(fresh, change) : fresh));
        setUsers((current) => shareIssueUsers(current, { ...current, ...detail.users }));
        setComponents((current) => shareIssueLabels(current, { ...current, ...detail.components }));
    }, []);
    const remove = useCallback((number: number) => {
        pending.current.delete(number);
        served.current = served.current?.filter((issue) => issue.number !== number);
        setIssues(
            (current) =>
                current &&
                shareIssueCollection(
                    current,
                    current.filter((issue) => issue.number !== number),
                ),
        );
    }, []);

    /** Changes one issue optimistically; throws (after rolling back) on failure. */
    const update = useCallback(
        async (number: number, change: IssueChange): Promise<IssueDetail> => {
            let before: IssueSummary | undefined;
            setIssues(
                (current) =>
                    current &&
                    shareIssueCollection(
                        current,
                        current.map((issue) => {
                            if (issue.number !== number) {
                                return issue;
                            }
                            before = issue;
                            return withChange(issue, change);
                        }),
                    ),
            );
            pending.current.set(number, {
                ...pending.current.get(number),
                ...change,
            });
            try {
                const detail = await api<IssueDetail>(`/issues/${number}`, 'PATCH', change);
                pending.current.delete(number);
                replace(detail);
                return detail;
            } catch (e) {
                pending.current.delete(number);
                // A poll or detail response may have refreshed votes/text while the move waited.
                // Roll back only to the latest known server row, and never resurrect a removed row.
                const previous =
                    served.current === undefined ? before : served.current.find((issue) => issue.number === number);
                if (served.current !== undefined || previous) {
                    setIssues(
                        (current) =>
                            current &&
                            shareIssueCollection(
                                current,
                                previous
                                    ? current.map((issue) => (issue.number === number ? previous : issue))
                                    : current.filter((issue) => issue.number !== number),
                            ),
                    );
                } else {
                    void load();
                }
                throw e;
            }
        },
        [load, replace],
    );

    return {
        issues,
        users,
        components,
        error,
        version,
        reload: load,
        reread,
        replace,
        remove,
        update,
    };
}
export type IssuesData = ReturnType<typeof useIssues>;

/**
 * The board's search (CB-71): the numbers the server finds for `query` in
 * keys, titles and descriptions, asked as the user types and again when
 * the list changes (`version`). Undefined until the first answer for this
 * query: the board then matches keys, titles and excerpts itself. A new
 * list keeps the last answer for the same query until the next arrives.
 */
export function useIssueSearch(query: string, version: number) {
    const folded = foldText(query);
    const search = useSearchAsYouType<IssueSearch>(folded ? `${version} ${folded}` : null, (signal) =>
        api<IssueSearch>(`/issues/search?${new URLSearchParams({ q: query })}`, 'GET', undefined, signal),
    );
    const [kept, setKept] = useState<{ folded: string; answer: IssueSearch }>();
    if (search.answer && kept?.answer !== search.answer) {
        setKept({ folded, answer: search.answer });
    }
    const answer = kept?.folded === folded ? kept.answer : undefined;
    return useMemo(() => answer && new Set(answer.numbers), [answer]);
}
