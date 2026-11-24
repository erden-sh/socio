import { useEffect, useEffectEvent, useRef, useState } from 'react';

/** How long after the last keystroke the server is asked (as on Media). */
export const SEARCH_DELAY_MS = 250;
/** Answers kept while the search is open, so backspacing doesn't ask again. */
const KEEP = 20;

/**
 * Asks the server as the user types: `SEARCH_DELAY_MS` after `key` last
 * changed, aborting the request in flight when it changes again, the
 * search closes (`active` false) or the component goes. `key` is null
 * when there is nothing to ask. The last 20 answers are kept until the
 * search closes. `answer` is only ever the current key's: an answer to an
 * older query is never shown for a newer one.
 */
export function useSearchAsYouType<T>(key: string | null, fetch: (signal: AbortSignal) => Promise<T>, active = true) {
    const cache = useRef(new Map<string, T>());
    const [state, setState] = useState<{ key: string; answer: T } | null>(null);
    // The key whose request failed: nothing is coming for it.
    const [failed, setFailed] = useState<string | null>(null);
    const run = useEffectEvent(fetch);
    useEffect(() => {
        if (!active) {
            cache.current.clear();
        }
    }, [active]);
    useEffect(() => {
        if (!active || key === null) {
            return;
        }
        const kept = cache.current.get(key);
        if (kept !== undefined) {
            setState({ key, answer: kept });
            return;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => {
            run(controller.signal)
                .then((answer) => {
                    if (controller.signal.aborted) {
                        return;
                    }
                    cache.current.delete(key);
                    cache.current.set(key, answer);
                    if (cache.current.size > KEEP) {
                        cache.current.delete(cache.current.keys().next().value!);
                    }
                    setState({ key, answer });
                })
                .catch(() => {
                    // Failed: nothing to add; the instant results stay.
                    if (!controller.signal.aborted) {
                        setFailed(key);
                    }
                });
        }, SEARCH_DELAY_MS);
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [key, active]);
    return {
        answer: state && state.key === key ? state.answer : undefined,
        /** The current key's answer is still to come. */
        pending: active && key !== null && state?.key !== key && failed !== key,
    };
}
