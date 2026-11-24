import { PRESENCE_AWAY_PATH, PRESENCE_HEADER, PRESENCE_INPUT_MS } from '@socio/shared/notifications';

/**
 * Whether this tab is in use (CB-114), for the server's presence
 * (src/server/notifications/presence.ts): a Dot's notification goes to
 * the person's channels only when no tab of theirs is. The shell's
 * `/api/state` poll carries `presenceHeader()` every 3 s; hiding or
 * closing the tab sends the away beacon at once, so a notification right
 * after doesn't wait for the server's report to go stale.
 *
 * In use means visible, focused, and a key, pointer, touch, wheel or
 * scroll in the last minute: a tab left open on a screen nobody looks at
 * stops counting after `PRESENCE_INPUT_MS`.
 */

/** `sessionStorage` key: this tab's id, kept over reloads. */
export const PRESENCE_TAB_KEY = 'socio:presence-tab';
/** The server takes paths up to this long (presence.ts, `parsePresence`). */
const MAX_PATH = 501;

let tab: string | undefined;
let lastInput = Number.NEGATIVE_INFINITY;

/** 22 random base64url characters (the server takes 8 to 64 of them). */
function newTabId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

/**
 * This tab's id: one per tab, the same after a reload (so a reload doesn't
 * leave the old id counted for a few seconds). Without storage it lives
 * as long as the page. A duplicated tab starts with a copy of the
 * original's storage, so the two share an id; each poll says what one of
 * them shows, which only shortens how long either counts as in use.
 */
export function presenceTab() {
    if (tab) {
        return tab;
    }
    try {
        const stored = sessionStorage.getItem(PRESENCE_TAB_KEY);
        if (stored && /^[A-Za-z0-9_-]{8,64}$/.test(stored)) {
            return (tab = stored);
        }
        tab = newTabId();
        sessionStorage.setItem(PRESENCE_TAB_KEY, tab);
    } catch {
        tab ??= newTabId();
    }
    return tab;
}

/** Whether the person is using this tab now. */
export function inUse(now = Date.now()) {
    return document.visibilityState === 'visible' && document.hasFocus() && now - lastInput < PRESENCE_INPUT_MS;
}

/** The presence header's value: `<tab> <path>` in use, `<tab> -` otherwise. */
export function presenceHeader(now = Date.now()) {
    return `${presenceTab()} ${inUse(now) ? location.pathname.slice(0, MAX_PATH) : '-'}`;
}

/** The headers the shell's `/api/state` poll adds. */
export const presenceHeaders = (now = Date.now()) => ({
    [PRESENCE_HEADER]: presenceHeader(now),
});

/** Tells the server this tab isn't in use any more (hidden or closing). */
export function sendAway() {
    if (typeof navigator.sendBeacon !== 'function') {
        return;
    }
    navigator.sendBeacon(
        PRESENCE_AWAY_PATH,
        new Blob([JSON.stringify({ tab: presenceTab() })], {
            type: 'application/json',
        }),
    );
}

const INPUTS = ['keydown', 'pointerdown', 'touchstart', 'wheel'] as const;

/**
 * Starts watching input and visibility (entry.client.tsx, once). Scrolls
 * are caught on the way down (`capture`), since a scroll inside a panel
 * doesn't bubble. Returns the stop, for tests.
 */
export function installPresence(now = () => Date.now()) {
    const input = () => {
        lastInput = now();
    };
    const hidden = () => {
        if (document.visibilityState === 'hidden') {
            sendAway();
        }
    };
    const options = { capture: true, passive: true };
    for (const type of INPUTS) {
        document.addEventListener(type, input, options);
    }
    document.addEventListener('scroll', input, options);
    document.addEventListener('visibilitychange', hidden);
    globalThis.addEventListener('pagehide', sendAway);
    return () => {
        for (const type of INPUTS) {
            document.removeEventListener(type, input, options);
        }
        document.removeEventListener('scroll', input, options);
        document.removeEventListener('visibilitychange', hidden);
        globalThis.removeEventListener('pagehide', sendAway);
        lastInput = Number.NEGATIVE_INFINITY;
    };
}
