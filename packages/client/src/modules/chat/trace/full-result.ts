import { useEffect, useState, useSyncExternalStore } from 'react';

/**
 * Long tool results of older turns come as a preview (CB-136): the chat
 * that shows them registers each with the way to fetch the whole result
 * (`useFullResults`), and a step fetches it when it is opened
 * (`useFullResult`). Tool call ids are unique, so one registry serves
 * every chat in the tab.
 */
interface Preview {
    /** The whole result's length. */
    size: number;
    load: () => Promise<string>;
}
const previews = new Map<string, Preview>();
const listeners = new Set<() => void>();
const notify = () => {
    for (const listener of listeners) {
        listener();
    }
};
const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
};

/**
 * Registers a chat's previews (call id to whole length) while it shows
 * them, with `load` to fetch one whole.
 */
export function useFullResults(
    light: ReadonlyMap<string, number>,
    load: ((toolCallId: string) => Promise<string>) | undefined,
) {
    // The same previews keep their entries as the chat re-renders.
    const key = [...light].map(([id, size]) => `${id}:${size}`).join('\n');
    useEffect(() => {
        if (!load || !key) {
            return;
        }
        const added = key.split('\n').map((entry): [string, Preview] => {
            const at = entry.lastIndexOf(':');
            const id = entry.slice(0, at);
            return [id, { size: Number(entry.slice(at + 1)), load: () => load(id) }];
        });
        for (const [id, preview] of added) {
            previews.set(id, preview);
        }
        notify();
        return () => {
            for (const [id, preview] of added) {
                if (previews.get(id) === preview) {
                    previews.delete(id);
                }
            }
            notify();
        };
    }, [key, load]);
}

/**
 * A step's result to show: the whole one once it came, the preview until
 * then. `loading` while it comes; `failed` if it couldn't, with `retry`.
 */
export function useFullResult(toolCallId: string, preview?: string) {
    const found = useSyncExternalStore(
        subscribe,
        () => previews.get(toolCallId),
        () => undefined,
    );
    const [full, setFull] = useState<string>();
    const [failed, setFailed] = useState(false);
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        if (!found) {
            return;
        }
        let active = true;
        setFailed(false);
        found.load().then(
            (content) => {
                if (active) {
                    setFull(content);
                }
            },
            () => {
                if (active) {
                    setFailed(true);
                }
            },
        );
        return () => {
            active = false;
        };
    }, [found, attempt]);
    const cut = !!found && full === undefined;
    return {
        result: full ?? preview,
        /** The whole result's length, while a preview shows. */
        size: cut ? found.size : undefined,
        loading: cut && !failed,
        failed: cut && failed,
        retry: () => setAttempt((value) => value + 1),
    };
}
