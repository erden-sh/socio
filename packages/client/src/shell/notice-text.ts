import { useTranslation } from '@socio/i18n/react';

import { isConnectionNotice } from './poll-notice';

/**
 * A notice as people read it: a connection notice's words in the page's
 * language (its key, poll-notice.ts), anything else (the server's words)
 * as it came.
 */
export function useNoticeText() {
    const { t } = useTranslation(['shell']);
    return (message: string) => (isConnectionNotice(message) ? t(message) : message);
}
