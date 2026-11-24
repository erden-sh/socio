import { useEffect } from 'react';
import { useRevalidator } from 'react-router';

import { refreshShown, useLiveTopic } from '../lib/change-channel';

/**
 * A tab coming back (CB-74): shown again or focused again after at least
 * this long away refetches what it shows. A quick alt-tab doesn't.
 */
export const AWAY_MS = 2000;

/**
 * Calls `onReturn` once each time the tab comes back after `awayMs` or
 * more: hidden (another tab, a minimized window) or unfocused (another
 * window). Becoming visible and gaining focus usually come together; the
 * first one counts and the second finds nothing to do. Focus moving into
 * a frame of the page isn't leaving. Returns the unsubscribe.
 */
export function watchReturns(onReturn: () => void, { awayMs = AWAY_MS, now = () => Date.now() } = {}) {
    let awayAt: number | undefined = document.visibilityState === 'hidden' ? now() : undefined;
    const leave = () => {
        awayAt ??= now();
    };
    const back = () => {
        if (document.visibilityState === 'hidden' || awayAt === undefined) {
            return;
        }
        const away = now() - awayAt;
        awayAt = undefined;
        if (away >= awayMs) {
            onReturn();
        }
    };
    const visibility = () => (document.visibilityState === 'hidden' ? leave() : back());
    // The window's own blur and focus: an element's don't bubble up here.
    const blur = () => {
        if (!(document.activeElement instanceof HTMLIFrameElement)) {
            leave();
        }
    };
    document.addEventListener('visibilitychange', visibility);
    globalThis.addEventListener('blur', blur);
    globalThis.addEventListener('focus', back);
    return () => {
        document.removeEventListener('visibilitychange', visibility);
        globalThis.removeEventListener('blur', blur);
        globalThis.removeEventListener('focus', back);
    };
}

// While set, a revalidation leaves out the loaders of what polls (the
// shell, and pages with `revalidateOn({ polled: true })`): their polls
// re-read.
let pagesOnly = false;
// A return is refetching what the tab shows: the pages' revalidation
// comes once, after it (useRevalidateOn waits for that one).
let returning = 0;
// Revalidations that must include the shell (sign-in, sign-out, another
// account): they win over a pages-only one in flight.
let full = 0;

/** Whether the revalidation running now leaves polled loaders out. */
export const polledLoadersSkipped = () => pagesOnly && full === 0;

/** Revalidates every loader, the shell's too. */
export async function revalidateAll(revalidate: () => Promise<void>) {
    full += 1;
    try {
        await revalidate();
    } finally {
        full -= 1;
    }
}

/**
 * Revalidates the loaders of pages that don't poll; the shell's and the
 * polled pages' polls cover theirs. Nothing when a full revalidation is
 * running: it covers them all.
 */
export async function revalidatePages(revalidate: () => Promise<void>) {
    if (full) {
        return;
    }
    pagesOnly = true;
    try {
        await revalidate();
    } finally {
        pagesOnly = false;
    }
}

/**
 * While `enabled` (signed in): when the tab comes back (`watchReturns`),
 * refetch what it shows, the shell first, then revalidate the pages'
 * loaders. One at a time: a return during one does nothing more.
 */
export function useTabRefresh(enabled: boolean) {
    const { revalidate } = useRevalidator();
    useEffect(() => {
        if (!enabled) {
            return;
        }
        let busy = false;
        let active = true;
        const stop = watchReturns(() => {
            if (busy) {
                return;
            }
            busy = true;
            returning += 1;
            void refreshShown()
                .finally(() => {
                    returning -= 1;
                })
                .then(() => (active ? revalidatePages(revalidate) : undefined))
                .finally(() => {
                    busy = false;
                });
        });
        return () => {
            active = false;
            stop();
        };
    }, [enabled, revalidate]);
}

/**
 * A page whose data is its loader's alone (no poll): another tab's note
 * on `topic` revalidates the pages' loaders, as coming back does. The
 * page applies the new data (`useLoaderSeed`).
 */
export function useRevalidateOn(topic: string) {
    const { revalidate } = useRevalidator();
    useLiveTopic(topic, () => (returning ? undefined : revalidatePages(revalidate)));
}
