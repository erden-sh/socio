import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import { issuePath } from '@socio/shared/issues/issue-board';
import { issueKey, type DotRequestNotice, type DotRequestNotices as Notices } from '@socio/shared/issues/issue-types';

import { api } from '../../lib/api';

/** The toast's text for one notice. */
export function noticeText(notice: DotRequestNotice) {
    const key = issueKey(notice.number);
    const by = notice.dots.length ? ` (asked by ${notice.dots.join(', ')})` : '';
    return {
        title:
            notice.status === 'done'
                ? `Socio request done: ${notice.capability}`
                : `Socio request won’t be built: ${notice.capability}`,
        description: `${key}${by}${notice.resolution ? ` · ${notice.resolution}` : ''}`,
    };
}

/**
 * Renders nothing: in the header, so it runs once per visit on every page.
 * Shows the user's unseen notices about Dot requests that closed as
 * toasts, then marks them seen.
 */
export function DotRequestNotices() {
    const navigate = useRef(useNavigate());
    useEffect(() => {
        const controller = new AbortController();
        void api<Notices>('/dot-requests/notices', 'GET', undefined, controller.signal)
            .then(async ({ notices }) => {
                if (controller.signal.aborted || !notices.length) {
                    return;
                }
                for (const notice of notices) {
                    const { title, description } = noticeText(notice);
                    (notice.status === 'done' ? toast.success : toast.info)(title, {
                        description,
                        duration: 15_000,
                        action: {
                            label: 'View',
                            onClick: () => void navigate.current(issuePath(notice.number)),
                        },
                    });
                }
                await api('/dot-requests/notices/seen', 'POST', {
                    ids: notices.map((notice) => notice.id),
                });
            })
            .catch(() => undefined);
        return () => controller.abort();
    }, []);
    return null;
}
