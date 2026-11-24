import { type ReactElement, useEffect, useRef, useState } from 'react';
import { RefreshControl, type RefreshControlProps } from 'react-native';

import { useColors } from '../theme/scheme';

import { REFRESH_MIN_MS, refreshDone } from './refresh-timing';

// Pull to refresh: the system's RefreshControl (UIRefreshControl under
// the large title on iOS, Material's swipe-refresh circle on Android, in the
// primary) on every list that syncs. A pull runs the screen's own refresh (the
// scheduler's pull of its kinds, a Space's pages, a section's read) and the
// spinner stays until it ends, at least REFRESH_MIN_MS so it never flickers.
// Local-first, the list never waits for it: the rows are the phone's copy.

export function usePullToRefresh(run: () => Promise<unknown>): ReactElement<RefreshControlProps> {
    const colors = useColors();
    const [refreshing, setRefreshing] = useState(false);
    const live = useRef(true);
    useEffect(() => {
        live.current = true;
        return () => {
            live.current = false;
        };
    }, []);
    const onRefresh = () => {
        setRefreshing(true);
        const started = Date.now();
        run()
            .catch((error: unknown) => console.warn('[refresh] not refreshed', error))
            .then(() => refreshDone(started, Date.now()))
            .then(() => {
                if (live.current) {
                    setRefreshing(false);
                }
            })
            .catch(() => {});
    };
    return (
        <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[colors.primary]}
            progressBackgroundColor={colors.card}
        />
    );
}

export { REFRESH_MIN_MS };
