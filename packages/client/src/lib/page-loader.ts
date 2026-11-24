import { useEffect, useRef } from 'react';
import type { ShouldRevalidateFunction } from 'react-router';

import { polledLoadersSkipped } from '../hooks/use-tab-refresh';

/**
 * A page loader's `shouldRevalidate`: it runs again when one of its own
 * `params` changes, when the search does (unless `search` is false: the
 * page's search only picks what it shows), or on `revalidate()` (the same
 * address, as after sign-in). Navigations elsewhere, a child page's
 * included, don't ask: the page's hook keeps its data fresh. `polled`: the
 * page polls, so a revalidation when the tab comes back or another tab
 * wrote (use-tab-refresh.ts) leaves this loader out; its poll re-reads.
 */
export const revalidateOn =
    ({
        params = [],
        search = true,
        polled = false,
    }: {
        params?: string[];
        search?: boolean;
        polled?: boolean;
    } = {}): ShouldRevalidateFunction =>
    ({ currentUrl, nextUrl, currentParams, nextParams, defaultShouldRevalidate }) =>
        defaultShouldRevalidate &&
        !(polled && polledLoadersSkipped()) &&
        (currentUrl.href === nextUrl.href ||
            (search && currentUrl.search !== nextUrl.search) ||
            params.some((name) => currentParams[name] !== nextParams[name]));

/**
 * Calls `apply` with a page's loader data whenever a revalidation brings
 * new data (a new object), not for the data the page started from: the
 * page's hook seeds its state from that itself.
 */
export function useLoaderSeed<T>(data: T | null | undefined, apply: (data: T) => void) {
    const first = useRef(data);
    const latest = useRef(apply);
    useEffect(() => {
        latest.current = apply;
    });
    useEffect(() => {
        if (data === first.current || data === null || data === undefined) {
            return;
        }
        first.current = data;
        latest.current(data);
    }, [data]);
}
