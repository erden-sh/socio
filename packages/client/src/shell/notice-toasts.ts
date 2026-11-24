import { useEffect, useEffectEvent } from 'react';
import { toast } from 'sonner';

import { clearNotice, OFFLINE_NOTICE, UPDATING_NOTICE, visibleNotice, type Notices } from './poll-notice';

/** The one toast the shell's error notices share. */
export const NOTICE_TOAST = 'shell-notice';

/**
 * Shows the shell's error notice (`poll-notice.ts`) as a Sonner toast
 * instead of the old banner. A failed action closes on its own; a lost
 * connection stays until the next poll succeeds. Closing the toast clears
 * its notice. Persistent states (paused) stay banners in the shell.
 * While the server is away or restarting (CB-108) it says so, with a
 * spinner rather than as an error; offline, it says that, quietly.
 */
export function useNoticeToasts(notices: Notices, setNotices: (update: (current: Notices) => Notices) => void) {
    const message = visibleNotice(notices);
    const connection = !!message && !notices.action;
    const clear = useEffectEvent((text: string) => setNotices((current) => clearNotice(current, text)));
    useEffect(() => {
        if (!message) {
            toast.dismiss(NOTICE_TOAST);
            return;
        }
        (message === UPDATING_NOTICE ? toast.loading : message === OFFLINE_NOTICE ? toast.message : toast.error)(
            message,
            {
                id: NOTICE_TOAST,
                duration: connection ? Infinity : 8000,
                closeButton: true,
                onDismiss: () => clear(message),
                onAutoClose: () => clear(message),
            },
        );
    }, [message, connection]);
    useEffect(() => () => void toast.dismiss(NOTICE_TOAST), []);
}
