import { PRESENCE_AWAY_PATH, PRESENCE_HEADER, PRESENCE_INPUT_MS } from '@socio/shared/notifications';

import type { AuthedFetch } from '../net/authed-fetch';

import type { AppStateSource } from './triggers';

// Whether the person is using the app (CB-114), for the server's
// presence (src/server/notifications/presence.ts): a socio's notification goes
// to the person's channels, push included, only while no tab or app of theirs
// is in use. The web's packages/client/src/shell/presence.ts, for a phone:
// - each open scope is one "tab", with a random id of 22 base64url characters
//   (the server takes 8 to 64);
// - every `/api/state` request carries `X-CB-Presence: <tab> <path>` while the
//   app is active (not 'inactive': Control Center, the app switcher) and was
//   touched in the last PRESENCE_INPUT_MS (60 s, the web's minute), else
//   `<tab> -`. The path is the screen's web path (`/chats/<id>` for a chat,
//   which the server matches to hold a push back for the chat shown);
// - the shell's `/api/state` poll runs every PRESENCE_POLL_MS in the
//   foreground (scheduler.ts), since the server counts a report for 10 s;
// - going to the background, and the scope's `dispose()`, send
//   `POST /api/notifications/away {tab}` at once: best effort, never queued,
//   and only after a header went since the last one.
// No React Native: the platform hands in the app's state, and tests/sync runs
// it under Node.

/** How often `/api/state` goes in the foreground: the server counts a tab's report for 10 s. */
export const PRESENCE_POLL_MS = 5_000;
/** The server takes paths up to this long (shared's `parsePresence`). */
const MAX_PATH = 501;
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** `bytes` in base64url, unpadded. */
export function base64url(bytes: Uint8Array): string {
    let out = '';
    for (let index = 0; index < bytes.length; index += 3) {
        const a = bytes[index]!;
        const b = bytes[index + 1];
        const c = bytes[index + 2];
        out += BASE64URL[a >> 2]! + BASE64URL[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
        if (b !== undefined) {
            out += BASE64URL[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
        }
        if (c !== undefined) {
            out += BASE64URL[c & 63]!;
        }
    }
    return out;
}

const randomBytesDefault = (length: number) => globalThis.crypto.getRandomValues(new Uint8Array(length));

/** A new tab id: 16 random bytes, 22 base64url characters. */
export const newTabId = (randomBytes: (length: number) => Uint8Array = randomBytesDefault) =>
    base64url(randomBytes(16));

/** A path the server takes: `/` and no whitespace, at most MAX_PATH characters; `/` otherwise. */
export function presencePathOf(path: string): string {
    return path.startsWith('/') && !/\s/.test(path) ? path.slice(0, MAX_PATH) : '/';
}

export interface Presence {
    /** This scope's tab id. */
    readonly tab: string;
    /** The header's value now, `<tab> <path>` in use, else `<tab> -`. */
    value(): string;
    /** The headers `/api/state` carries: counts as a report, so the next background or dispose sends away. */
    headers(): Record<string, string>;
    /** The person touched or typed in the app. */
    touch(): void;
    /** The screen shown, as its web path (`/chats/<id>`). */
    screen(path: string): void;
    /** Tells the server this tab isn't in use: never rejects, and sends nothing when no report went since the last. */
    away(): Promise<void>;
}

export interface PresenceOptions {
    /** The scope's authedFetch. */
    readonly fetch: AuthedFetch;
    readonly appState: AppStateSource;
    /** The timers' clock: input counts for PRESENCE_INPUT_MS. */
    readonly now?: () => number;
    readonly randomBytes?: (length: number) => Uint8Array;
}

export function createPresence({
    fetch,
    appState,
    now = Date.now,
    randomBytes = randomBytesDefault,
}: PresenceOptions): Presence {
    const tab = newTabId(randomBytes);
    let path = '/';
    let lastInput = Number.NEGATIVE_INFINITY;
    let reported = false;
    const inUse = () => appState.current() === 'active' && now() - lastInput < PRESENCE_INPUT_MS;
    const value = () => `${tab} ${inUse() ? path : '-'}`;
    return {
        tab,
        value,
        headers() {
            reported = true;
            return { [PRESENCE_HEADER]: value() };
        },
        touch() {
            lastInput = now();
        },
        screen(next) {
            path = presencePathOf(next);
        },
        async away() {
            if (!reported) {
                return;
            }
            reported = false;
            try {
                await fetch(PRESENCE_AWAY_PATH, { method: 'POST', json: { tab } });
            } catch {
                // Best effort: the server's report goes stale in 10 s anyway.
            }
        },
    };
}
