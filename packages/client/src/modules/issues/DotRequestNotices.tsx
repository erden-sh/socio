import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import { issuePath } from '@socio/shared/issues/issue-board';
import { issueKey, type DotRequestNotice, type DotRequestNotices as Notices } from '@socio/shared/issues/issue-types';

import { useOnDemand } from '../../i18n/on-demand';
import { api } from '../../lib/api';

/** The toast's text for one notice (issues.slots). */
export function useNoticeText() {
    const { t } = useTranslation(['issues.slots']);
    return (notice: DotRequestNotice) => {
        const key = issueKey(notice.number);
        const by = notice.dots.length ? t('issues.slots:notice.asked-by', { key, dots: notice.dots }) : key;
        return {
            title:
                notice.status === 'done'
                    ? t('issues.slots:notice.done', { capability: notice.capability })
                    : t('issues.slots:notice.wont-fix', { capability: notice.capability }),
            description: notice.resolution
                ? t('issues.slots:notice.resolution', { text: by, resolution: notice.resolution })
                : by,
        };
    };
}

/**
 * Renders nothing: in the header, so it runs once per visit on every page.
 * Shows the user's unseen notices about Dot requests that closed as
 * toasts, then marks them seen. It asks once its words (issues.slots,
 * loaded on demand) are in.
 */
export function DotRequestNotices() {
    const navigate = useRef(useNavigate());
    const worded = useOnDemand(['issues.slots']);
    const { t } = useTranslation(['issues.slots']);
    const noticeText = useNoticeText();
    // The words as they are when the notices arrive.
    const words = useRef({ noticeText, view: t('issues.slots:notice.view') });
    useEffect(() => {
        words.current = { noticeText, view: t('issues.slots:notice.view') };
    });
    useEffect(() => {
        if (!worded) {
            return;
        }
        const controller = new AbortController();
        void api<Notices>('/dot-requests/notices', 'GET', undefined, controller.signal)
            .then(async ({ notices }) => {
                if (controller.signal.aborted || !notices.length) {
                    return;
                }
                for (const notice of notices) {
                    const { title, description } = words.current.noticeText(notice);
                    (notice.status === 'done' ? toast.success : toast.info)(title, {
                        description,
                        duration: 15_000,
                        action: {
                            label: words.current.view,
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
    }, [worded]);
    return null;
}
