import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';

import {
    OPS_FILTERS,
    opsSearch,
    readOpsQuery,
    type OperationsSettingsView,
    type OpsQuery,
} from '@socio/shared/operations/operations';
import { DEFAULT_TIME_ZONE } from '@socio/shared/time-zone';

import { api } from '../../lib/api';

/** How often an open section reads its numbers again, while the tab shows. */
export const OPS_REFRESH_MS = 60_000;

const OPS_PARAMS = ['range', 'from', 'to', 'bucket', ...OPS_FILTERS];

/**
 * The range and filters in the page's address (CB-164), the search that
 * keeps them on links (`?range=30d&socio=d1`), and a way to change them:
 * each change is a new history entry, so Back goes to the view before.
 * Values the address can't use are left out.
 */
export function useOpsQuery() {
    const [params, setParams] = useSearchParams();
    const query = useMemo(() => readOpsQuery(params).query, [params]);
    const update = useCallback(
        (patch: Partial<OpsQuery>) => {
            setParams(
                (current) => {
                    const next = new URLSearchParams(current);
                    for (const name of OPS_PARAMS) {
                        next.delete(name);
                    }
                    const merged = readOpsQuery(current).query;
                    const search = new URLSearchParams(opsSearch({ ...merged, ...patch }).slice(1));
                    for (const [name, value] of search) {
                        next.set(name, value);
                    }
                    return next;
                },
                { preventScrollReset: true },
            );
        },
        [setParams],
    );
    return { query, search: opsSearch(query), update };
}

/** The dashboard's settings, loaded once by the layout and saved by its Settings page. */
export interface OpsSettingsState {
    settings: OperationsSettingsView | undefined;
    /** The reporting time zone: the saved one, UTC until it loads. */
    timeZone: string;
    saved: (view: OperationsSettingsView) => void;
}
export const OpsSettings = createContext<OpsSettingsState>({
    settings: undefined,
    timeZone: DEFAULT_TIME_ZONE,
    saved: () => {},
});
export const useOpsSettings = () => useContext(OpsSettings);

export function useOpsSettingsState(): OpsSettingsState {
    const [settings, setSettings] = useState<OperationsSettingsView>();
    useEffect(() => {
        const controller = new AbortController();
        api<OperationsSettingsView>('/operations/settings', 'GET', undefined, controller.signal)
            .then((view) => !controller.signal.aborted && setSettings(view))
            // The time zone stays UTC; each section says what failed.
            .catch(() => undefined);
        return () => controller.abort();
    }, []);
    return {
        settings,
        timeZone: settings?.timeZone ?? DEFAULT_TIME_ZONE,
        saved: setSettings,
    };
}

/**
 * An answer from `/api<path>` (a section's numbers): read when the path
 * changes and every minute while the tab shows. The last answer stays on
 * screen while the next loads, so a new range doesn't blank the page.
 */
export function useOpsAnswer<T>(path: string | null) {
    const [answer, setAnswer] = useState<{ path: string; data: T }>();
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const { timeZone } = useOpsSettings();
    useEffect(() => {
        if (!path) {
            return;
        }
        let controller: AbortController | undefined;
        const read = () => {
            controller?.abort();
            const current = new AbortController();
            controller = current;
            setLoading(true);
            api<T>(path, 'GET', undefined, current.signal)
                .then((data) => {
                    if (current.signal.aborted) {
                        return;
                    }
                    setAnswer({ path, data });
                    setError('');
                })
                .catch((e: unknown) => {
                    if (current.signal.aborted) {
                        return;
                    }
                    setError(e instanceof Error ? e.message : 'Could not load.');
                })
                .finally(() => !current.signal.aborted && setLoading(false));
        };
        read();
        const timer = setInterval(() => {
            if (document.visibilityState === 'visible') {
                read();
            }
        }, OPS_REFRESH_MS);
        return () => {
            clearInterval(timer);
            controller?.abort();
        };
        // A new reporting time zone cuts the answer differently.
    }, [path, timeZone]);
    return {
        data: answer?.data,
        /** The answer on screen is for another path (a new range is loading). */
        stale: !!answer && answer.path !== path,
        error,
        loading,
    };
}
