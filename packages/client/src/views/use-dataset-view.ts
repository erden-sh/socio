import { useCallback, useEffect, useState } from 'react';

import { VIEW_NO_ACCESS_CODE, type ViewDraft, type ViewQueryResult } from '@socio/shared/dataset-view';

import { ApiError, api } from '../lib/api';
import type { DatasetViewPage } from '../modules/pages/editor/dataset-view-context';

export type ViewState =
    | { status: 'incomplete' }
    | { status: 'loading'; result?: ViewQueryResult }
    | { status: 'ready'; result: ViewQueryResult }
    | { status: 'denied'; message: string }
    | { status: 'error'; message: string; result?: ViewQueryResult };

/**
 * A view's data, read for the signed-in viewer (`POST /data/views/query`).
 * While it reloads (a refresh, a changed query) the last result stays on
 * screen. `refresh` skips the server's short cache; `spec.refresh` reloads
 * on a timer while the tab is visible.
 */
export function useDatasetView(
    page: DatasetViewPage | null,
    spec: Pick<ViewDraft, 'datasetId' | 'query' | 'params' | 'refresh'>,
) {
    const [state, setState] = useState<ViewState>({ status: 'incomplete' });
    // A reload: `fresh` (the Refresh button) skips the server's cache; the
    // timer's reloads share it with everyone else looking at the page.
    const [tick, setTick] = useState({ n: 0, fresh: false });
    const complete = !!(page && spec.datasetId && spec.query.trim());
    const key = JSON.stringify([page?.spaceId, page?.pageId, spec.datasetId, spec.query, spec.params ?? []]);
    useEffect(() => {
        if (!complete || !page) {
            setState({ status: 'incomplete' });
            return;
        }
        const controller = new AbortController();
        setState((previous) => ({
            status: 'loading',
            result: 'result' in previous ? previous.result : undefined,
        }));
        api<ViewQueryResult>(
            '/data/views/query',
            'POST',
            {
                spaceId: page.spaceId,
                pageId: page.pageId,
                datasetId: spec.datasetId,
                query: spec.query,
                ...(spec.params?.length ? { params: spec.params } : {}),
                ...(tick.fresh ? { fresh: true } : {}),
            },
            controller.signal,
        ).then(
            (result) => setState({ status: 'ready', result }),
            (error: unknown) => {
                if (controller.signal.aborted) {
                    return;
                }
                if (error instanceof ApiError && error.code === VIEW_NO_ACCESS_CODE) {
                    setState({ status: 'denied', message: error.message });
                } else {
                    setState((previous) => ({
                        status: 'error',
                        message: error instanceof Error ? error.message : 'Could not load the view.',
                        result: 'result' in previous ? previous.result : undefined,
                    }));
                }
            },
        );
        return () => controller.abort();
        // `key` stands for page and spec; `tick` is a reload.
        // `key` serializes page and spec: it is the trigger, not their identities.
        // oxlint-disable-next-line react-hooks/exhaustive-deps
    }, [key, tick, complete]);
    useEffect(() => {
        if (!complete || !spec.refresh) {
            return;
        }
        const timer = window.setInterval(() => {
            if (!document.hidden) {
                setTick(({ n }) => ({ n: n + 1, fresh: false }));
            }
        }, spec.refresh * 1000);
        return () => window.clearInterval(timer);
    }, [complete, spec.refresh]);
    const refresh = useCallback(() => setTick(({ n }) => ({ n: n + 1, fresh: true })), []);
    return { state, refresh };
}
