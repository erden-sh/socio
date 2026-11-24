import { UNREADABLE_RESPONSE } from '../lib/api';

/**
 * The connection notice while the server is away or restarting, as during
 * a deploy (CB-108), instead of the browser's or the proxy's error. It
 * goes once a poll is answered again.
 */
export const UPDATING_NOTICE = 'Socio is updating. Reconnecting…';
/**
 * The connection notice while the browser says it is offline: the server
 * isn't updating, this device has no network. It reconnects the same way.
 */
export const OFFLINE_NOTICE = 'You’re offline. Reconnecting when you’re back online.';

export interface Notices {
    refresh: string;
    capture: string;
    action: string;
}

export interface PollFailure {
    ok: false;
    status?: number;
    code?: string;
    message: string;
    /** The browser said it was offline when it failed (`browserOffline`). */
    offline?: boolean;
}

// A failure that carries no HTTP status did not come from the API, so it is a
// network failure (fetch throws a TypeError whose text differs by browser).
// A draining server's refusal is one too: the next server answers.
function isTransportFailure(result: PollFailure): boolean {
    return (
        result.status === undefined ||
        result.status === 502 ||
        result.status === 504 ||
        result.code === 'draining' ||
        result.message === UNREADABLE_RESPONSE
    );
}

/** The notice for a transport failure: offline, or the server updating. */
function connectionNotice(result: PollFailure) {
    return result.offline && result.status === undefined ? OFFLINE_NOTICE : UPDATING_NOTICE;
}

export function visibleNotice(notices: Notices): string {
    return notices.action || notices.refresh || notices.capture;
}

export function dismissNotice(notices: Notices): Notices {
    if (notices.action) {
        return { ...notices, action: '' };
    }
    if (notices.refresh) {
        return { ...notices, refresh: '' };
    }
    if (notices.capture) {
        return { ...notices, capture: '' };
    }
    return notices;
}

/** Clears the notices showing `message` (its toast closed); unchanged otherwise. */
export function clearNotice(notices: Notices, message: string): Notices {
    const keys = (['action', 'refresh', 'capture'] as const).filter((key) => notices[key] === message);
    if (!keys.length) {
        return notices;
    }
    const next = { ...notices };
    for (const key of keys) {
        next[key] = '';
    }
    return next;
}

export function applyRefreshResult(current: Notices, result: { ok: true } | PollFailure): Notices {
    if (result.ok) {
        return current.refresh ? { ...current, refresh: '' } : current;
    }
    if (result.status === 401) {
        return current;
    }
    const message = isTransportFailure(result) ? connectionNotice(result) : result.message;
    if (current.refresh === message) {
        return current;
    }
    return { ...current, refresh: message };
}

export function applyCaptureResult(current: Notices, result: { ok: true } | PollFailure): Notices {
    if (result.ok) {
        return current.capture ? { ...current, capture: '' } : current;
    }
    // 404: the chat is gone (deleted in another tab, say). The chat page
    // says so itself once the shell re-reads; a capture error adds nothing.
    if (result.status === 401 || result.status === 404) {
        return current;
    }
    if (isTransportFailure(result)) {
        const notice = connectionNotice(result);
        if (current.capture === notice) {
            return current;
        }
        return { ...current, capture: notice };
    }
    if (current.action === result.message) {
        return current;
    }
    return { ...current, action: result.message };
}
