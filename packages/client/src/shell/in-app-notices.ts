import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import type { InAppNotice } from '@socio/shared/notifications';

import { api } from '../lib/api';

/**
 * `localStorage` key: the notices some tab of this browser already showed
 * (their ids, the last `SHOWN_KEPT`), so two open tabs don't both show one
 * that arrived in both polls before either marked it seen.
 */
export const SHOWN_NOTICES_KEY = 'socio:in-app-notices';
const SHOWN_KEPT = 50;

function shownIds(): string[] {
    try {
        const ids: unknown = JSON.parse(localStorage.getItem(SHOWN_NOTICES_KEY) ?? '[]');
        return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
    } catch {
        return [];
    }
}
function keepShown(ids: string[]) {
    try {
        localStorage.setItem(SHOWN_NOTICES_KEY, JSON.stringify(ids.slice(-SHOWN_KEPT)));
    } catch {
        // Without storage, only this tab's own memory keeps them apart.
    }
}

/** A path in the brain; anything else opens Home. */
const inApp = (link: string) => (link.startsWith('/') && !link.startsWith('//') ? link : '/');

const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

/**
 * A Dot's notification while its person is in the brain (CB-114): the
 * server keeps it for them instead of sending it, and `/api/state` lists
 * it (`state.notices`) until it is seen. Each one shows once as a toast,
 * with Open for its link; then it is marked seen, which drops it from
 * every tab's next poll. Only a tab in view shows them: one in the
 * background leaves them for the tab the person is looking at.
 */
export function useInAppNotices(notices: readonly InAppNotice[] | undefined, open: (link: string) => void) {
    const { t } = useTranslation(['shell']);
    const openLabel = t('shell:notices.open');
    const shown = useRef(new Set<string>());
    // Shown again: notices that came while hidden show now.
    const [inView, setInView] = useState(visible);
    useEffect(() => {
        const update = () => setInView(visible());
        document.addEventListener('visibilitychange', update);
        return () => document.removeEventListener('visibilitychange', update);
    }, []);
    const go = useEffectEvent((link: string) => open(link));
    useEffect(() => {
        if (!inView || !notices?.length) {
            return;
        }
        const elsewhere = new Set(shownIds());
        const fresh = notices.filter((notice) => !shown.current.has(notice.id) && !elsewhere.has(notice.id));
        // Seen here or in another tab: seen either way (again, if a mark was lost).
        const ids = notices.filter((notice) => !shown.current.has(notice.id)).map((notice) => notice.id);
        if (!ids.length) {
            return;
        }
        for (const id of ids) {
            shown.current.add(id);
        }
        keepShown([...elsewhere, ...fresh.map((notice) => notice.id)]);
        for (const notice of fresh) {
            toast(notice.title, {
                id: `in-app-${notice.id}`,
                description: notice.body,
                duration: 15_000,
                closeButton: true,
                action: { label: openLabel, onClick: () => go(inApp(notice.link)) },
            });
        }
        void api('/notifications/in-app/seen', 'POST', { ids }).catch(() => undefined);
    }, [notices, inView, openLabel]);
}
