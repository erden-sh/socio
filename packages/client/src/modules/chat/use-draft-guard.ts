import { useCallback, useEffect, useRef } from 'react';
import { useBlocker } from 'react-router';

import { useTranslation } from '@socio/i18n/react';

/**
 * The unsaved-draft guard, on the router: while a page draft has unsaved
 * changes, leaving it (a link, the sidebar, back/forward) asks first, and a
 * reload or closing the tab gets the browser's own prompt. Moving within
 * the same path (a hash, the same page) never asks. Returns the setter the
 * page editor reports its state to, and a reader of it.
 */
export function useDraftGuard() {
    // Its words load as the shell mounts (chat.drafts is in no route's
    // entry); the question is asked only once someone leaves a draft.
    const { t } = useTranslation(['chat.drafts']);
    const dirty = useRef(false);
    const blocker = useBlocker(
        ({ currentLocation, nextLocation }) => dirty.current && currentLocation.pathname !== nextLocation.pathname,
    );
    useEffect(() => {
        if (blocker.state !== 'blocked') {
            return;
        }
        if (window.confirm(t('chat.drafts:leave-page-draft'))) {
            dirty.current = false;
            blocker.proceed();
        } else {
            blocker.reset();
        }
    }, [blocker, t]);
    useEffect(() => {
        const leave = (event: BeforeUnloadEvent) => {
            if (dirty.current) {
                event.preventDefault();
            }
        };
        window.addEventListener('beforeunload', leave);
        return () => window.removeEventListener('beforeunload', leave);
    }, []);
    const setDirty = useCallback((value: boolean) => {
        dirty.current = value;
    }, []);
    const isDirty = useCallback(() => dirty.current, []);
    return { setDirty, isDirty };
}
