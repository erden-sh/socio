import { parseCookieDate } from './cookie-date';
import { sessionCookieName, sessionExpiry } from './session';
import { type Cookie, pathMatches, readSetCookie } from './set-cookie';

// One workspace's cookie jar. The app sends
// every request with `credentials: 'omit'` and the jar's cookies by hand, so the
// system's shared cookie store never mixes workspaces. A jar:
// - belongs to one exact origin, and gives cookies to no other;
// - applies every response's Set-Cookie, whatever the status;
// - keeps each cookie's expiry in the server's clock, with the offset between
//   the device clock and the server's Date header, so an expired session is
//   told from an ended one even when the device clock is wrong;
// - writes itself to its store before the response goes back to the caller,
//   so a session the server has just slid or cleared is on disk when anything
//   reads the answer;
// - keeps the session's last known expiry apart from its cookies, so the
//   server's clearing cookie doesn't make a later 401 look Ended.

/** Where a jar keeps itself: one slot, such as a secure-store key, or memory for a staging jar. */
export interface JarStore {
    /** The jar as last written, or null when there is none. */
    read(): Promise<string | null>;
    /** Replaces the stored jar. */
    write(value: string): Promise<void>;
}

export interface CookieJarOptions {
    /** The workspace's exact origin, as `new URL(address).origin` gives it. */
    origin: string;
    store: JarStore;
    /** The device clock, in milliseconds since the epoch. */
    now?: () => number;
    /** The session cookie's name; by default Better Auth's for the origin (`sessionCookieName`). */
    sessionCookie?: string;
}

/** What a request takes from the jar as it goes, and what the jar knew of the session then. */
export interface Outgoing {
    /** The Cookie header, or null when no cookie goes with the request. */
    readonly cookie: string | null;
    /** The session's last known expiry (`sessionExpiresAt`) as the request went. */
    readonly sessionExpiresAt: number | null;
    /**
     * The jar held the session cookie but kept it back, expired by its clock:
     * the server never saw it, so its 401 says nothing about the session.
     */
    readonly sessionWithheld: boolean;
}

export interface CookieJar {
    readonly origin: string;
    /** The name of the cookie whose expiry is the session's. */
    readonly sessionCookie: string;
    /** The Cookie header for a request to `url`, or null when no cookie goes with it. */
    cookieHeader(url: URL): string | null;
    /** The Cookie header for a request to `url`, with what the jar knew of the session as it went. */
    outgoing(url: URL): Outgoing;
    /**
     * Applies a response's Set-Cookie headers (one per cookie: `setCookieHeaders`
     * splits a joined one) and its Date header, then writes the jar to its store
     * if it changed. Resolves once the store has it.
     */
    apply(url: URL, setCookies: readonly string[], date: string | null): Promise<void>;
    /** The session cookie, kept after it expires (until the server clears it). */
    session(): Cookie | null;
    /**
     * The session's last known expiry, server time: the session cookie's, as
     * `sessionExpiry` (session.ts) takes each Set-Cookie for it. The server's
     * clearing cookie leaves it, so a later 401 is still told apart; only
     * `clear()` empties it. Null when there is none.
     */
    sessionExpiresAt(): number | null;
    /** The server's time now: a response's Date header when given and readable, else the device clock with the offset. */
    serverNow(date?: string | null): number;
    /** Every cookie held, expired ones included, oldest first. */
    cookies(): readonly Cookie[];
    /** The jar's stored form, to copy a staging jar into a workspace's store. */
    serialize(): string;
    /** Drops every cookie and the session's expiry, and writes the empty jar. */
    clear(): Promise<void>;
    /**
     * Takes no more cookies, and resolves once the last write is done (tried
     * once more if it failed), so a wipe deletes what it last wrote. Resolves
     * even when that write fails.
     */
    close(): Promise<void>;
}

/** The stored form's version. */
const VERSION = 1;
/** Cookies a jar keeps (RFC 6265, 6.1, asks for at least 50 per domain). Past it, the oldest go, the session's last. */
const MAX_COOKIES = 50;
/** How far the clock offset may drift from the stored one before a response with no cookie change writes the jar. */
const OFFSET_WRITE_MS = 60_000;

interface StoredJar {
    v: number;
    origin: string;
    /** The server's clock minus the device's, in milliseconds. */
    offset: number;
    cookies: Cookie[];
    /** The session's last known expiry (`sessionExpiresAt`). */
    sessionExpiresAt: number | null;
}

/**
 * The jar `store` holds for `origin`, or an empty one. Unreadable contents
 * give an empty jar; a jar stored for another origin throws, since its
 * cookies must never go to this one.
 */
export async function openCookieJar(options: CookieJarOptions): Promise<CookieJar> {
    const jar = new Jar(options);
    await jar.load();
    return jar;
}

/** A store in memory, for a staging jar (a sign-in before it commits) and for tests. */
export function memoryJarStore(initial: string | null = null): JarStore & { readonly value: string | null } {
    let value = initial;
    return {
        get value() {
            return value;
        },
        read: async () => value,
        write: async (next) => {
            value = next;
        },
    };
}

class Jar implements CookieJar {
    readonly origin: string;
    readonly sessionCookie: string;
    private readonly store: JarStore;
    private readonly now: () => number;
    private list: Cookie[] = [];
    private offset = 0;
    private storedOffset = 0;
    private lastSessionExpiry: number | null = null;
    /** The last write failed, so the store is behind: the next response writes, changed or not. */
    private unsaved = false;
    private writing: Promise<void> = Promise.resolve();
    private closed = false;

    constructor({ origin, store, now = Date.now, sessionCookie = sessionCookieName(origin) }: CookieJarOptions) {
        const url = new URL(origin);
        if (url.origin !== origin || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
            throw new TypeError(`A cookie jar needs an exact http or https origin, not "${origin}".`);
        }
        this.origin = origin;
        this.store = store;
        this.now = now;
        this.sessionCookie = sessionCookie;
    }

    async load(): Promise<void> {
        const text = await this.store.read();
        const stored = text === null ? null : parseStored(text);
        if (stored === null) {
            return;
        }
        if (stored.origin !== this.origin) {
            throw new Error(`This jar store holds ${stored.origin}'s cookies, not ${this.origin}'s.`);
        }
        this.list = stored.cookies;
        this.offset = stored.offset;
        this.storedOffset = stored.offset;
        this.lastSessionExpiry = stored.sessionExpiresAt ?? this.session()?.expiresAt ?? null;
    }

    cookieHeader(url: URL): string | null {
        return this.outgoing(url).cookie;
    }

    outgoing(url: URL): Outgoing {
        const sessionExpiresAt = this.lastSessionExpiry;
        if (url.origin !== this.origin) {
            return { cookie: null, sessionExpiresAt, sessionWithheld: false };
        }
        const now = this.serverNow();
        const https = url.protocol === 'https:';
        const matching = this.list
            .map((cookie, index) => ({ cookie, index }))
            .filter(({ cookie }) => (!cookie.secure || https) && pathMatches(cookie.path, url.pathname));
        const live = matching.filter(({ cookie }) => cookie.expiresAt === null || cookie.expiresAt > now);
        const isSession = ({ cookie }: { cookie: Cookie }) => cookie.name === this.sessionCookie;
        const sessionWithheld = matching.some(isSession) && !live.some(isSession);
        // Longer paths first, then the older cookie (RFC 6265, 5.4); the index keeps the sort stable.
        live.sort((a, b) => b.cookie.path.length - a.cookie.path.length || a.index - b.index);
        const cookie = live.length === 0 ? null : live.map(({ cookie: c }) => `${c.name}=${c.value}`).join('; ');
        return { cookie, sessionExpiresAt, sessionWithheld };
    }

    async apply(url: URL, setCookies: readonly string[], date: string | null): Promise<void> {
        if (this.closed) {
            throw new Error(`The cookie jar for ${this.origin} is closed.`);
        }
        if (url.origin !== this.origin) {
            throw new Error(`The cookie jar for ${this.origin} takes no cookies from ${url.origin}.`);
        }
        const deviceNow = this.now();
        const serverDate = date === null ? null : parseCookieDate(date);
        if (serverDate !== null) {
            this.offset = serverDate - deviceNow;
        }
        const serverNow = deviceNow + this.offset;
        let changed = false;
        for (const header of setCookies) {
            const cookie = readSetCookie(header, url, serverNow);
            if (cookie !== null) {
                changed = this.put(cookie, serverNow) || changed;
            }
        }
        if (changed || this.unsaved || Math.abs(this.offset - this.storedOffset) >= OFFSET_WRITE_MS) {
            await this.write();
        }
    }

    session(): Cookie | null {
        return this.list.find((cookie) => cookie.name === this.sessionCookie) ?? null;
    }

    sessionExpiresAt(): number | null {
        return this.lastSessionExpiry;
    }

    serverNow(date: string | null = null): number {
        return (date === null ? null : parseCookieDate(date)) ?? this.now() + this.offset;
    }

    cookies(): readonly Cookie[] {
        return [...this.list];
    }

    serialize(): string {
        const stored: StoredJar = {
            v: VERSION,
            origin: this.origin,
            offset: this.offset,
            cookies: this.list,
            sessionExpiresAt: this.lastSessionExpiry,
        };
        return JSON.stringify(stored);
    }

    async clear(): Promise<void> {
        if (this.closed) {
            throw new Error(`The cookie jar for ${this.origin} is closed.`);
        }
        this.list = [];
        this.lastSessionExpiry = null;
        // Written even when it looks empty: after a failed write the store may still hold what memory doesn't.
        await this.write();
    }

    async close(): Promise<void> {
        this.closed = true;
        await this.writing.catch(() => undefined);
        // A failed write left the store behind (a cleared session in it, say): one last try, so what a
        // relaunch opens or a wipe deletes is what the jar last held. Closing goes ahead if it fails.
        if (this.unsaved) {
            await this.write().catch(() => undefined);
        }
    }

    /** Sets, replaces or deletes one cookie; whether the jar changed. */
    private put(given: Cookie, serverNow: number): boolean {
        const index = this.list.findIndex((held) => held.name === given.name && held.path === given.path);
        const held = index === -1 ? undefined : this.list[index];
        if (given.expiresAt !== null && given.expiresAt <= serverNow) {
            // A delete. The session's last known expiry stays, for the 401s still to come.
            if (held === undefined) {
                return false;
            }
            this.list.splice(index, 1);
            return true;
        }
        const isSession = given.name === this.sessionCookie;
        // The session cookie set again without a slide keeps its expiry (`sessionExpiry`).
        const cookie = isSession && held !== undefined ? { ...given, expiresAt: sessionExpiry(held, given) } : given;
        let changed = false;
        if (isSession && cookie.expiresAt !== this.lastSessionExpiry) {
            this.lastSessionExpiry = cookie.expiresAt;
            changed = true;
        }
        if (held !== undefined) {
            if (held.value === cookie.value && held.secure === cookie.secure && held.expiresAt === cookie.expiresAt) {
                return changed;
            }
            // A replaced cookie keeps its place, and so its age (RFC 6265, 5.3, step 11).
            this.list[index] = cookie;
            return true;
        }
        this.list.push(cookie);
        if (this.list.length > MAX_COOKIES) {
            const oldest = this.list.findIndex((held) => held.name !== this.sessionCookie);
            this.list.splice(oldest, 1);
        }
        return true;
    }

    /** Queues a write of the jar as it is now; writes land in order. */
    private write(): Promise<void> {
        const text = this.serialize();
        const offset = this.offset;
        const write = this.writing
            .catch(() => undefined)
            .then(() => this.store.write(text))
            .then(
                () => {
                    this.storedOffset = offset;
                    this.unsaved = false;
                },
                (error: unknown) => {
                    this.unsaved = true;
                    throw error;
                },
            );
        this.writing = write;
        return write;
    }
}

/** The stored jar, or null when `text` isn't one this version wrote. Cookies that don't read back are dropped. */
function parseStored(text: string): StoredJar | null {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return null;
    }
    if (typeof value !== 'object' || value === null) {
        return null;
    }
    const { v, origin, offset, cookies, sessionExpiresAt } = value as Partial<Record<keyof StoredJar, unknown>>;
    if (v !== VERSION || typeof origin !== 'string' || typeof offset !== 'number' || !Array.isArray(cookies)) {
        return null;
    }
    return {
        v,
        origin,
        offset: Number.isFinite(offset) ? offset : 0,
        cookies: cookies.filter(isCookie),
        sessionExpiresAt:
            typeof sessionExpiresAt === 'number' && Number.isFinite(sessionExpiresAt) ? sessionExpiresAt : null,
    };
}

function isCookie(value: unknown): value is Cookie {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const { name, value: text, path, secure, expiresAt } = value as Partial<Record<keyof Cookie, unknown>>;
    return (
        typeof name === 'string' &&
        name !== '' &&
        typeof text === 'string' &&
        typeof path === 'string' &&
        typeof secure === 'boolean' &&
        (expiresAt === null || (typeof expiresAt === 'number' && Number.isFinite(expiresAt)))
    );
}
