// The APNs provider token, reused. Ported from T3 Code's
// infra/relay/src/agentActivity/ApnsProviderTokens.ts (MIT, T3 Tools Inc; see vendor/t3code/SYNC.md),
// as a class with an injected clock instead of an Effect service, and with the token shared
// between isolates through D1.
//
// Apple ("Establishing a token-based connection to APNs"): refresh the token no more than once
// every 20 minutes and no less than once every 60. More often answers 429
// TooManyProviderTokenUpdates; older than 60 minutes answers 403 ExpiredProviderToken. Apple
// documents the 20-minute rule per provider (team and key), not per connection, and doesn't say
// whether tokens with the same `iat` but different signatures count as one update. Upstream
// sidesteps that by signing deterministically (RFC 6979 via @noble) for a quantized `iat`, so every
// isolate presents the very same string. WebCrypto's ECDSA is randomized, so that would need a
// dependency or hand-written curve code. Instead the whole fleet shares one signed token:
//
// - each isolate keeps the token in memory while it is younger than 50 minutes;
// - an isolate without one reads the shared row in D1 (`apns_provider_tokens`), and uses it while
//   it is younger than 50 minutes;
// - only when the row is missing or older does it sign, then compare-and-swap the row, so when two
//   isolates race, one token wins and both use it;
// - if D1 fails, the isolate signs its own and keeps it, as before: a push is worth more.
//
// So the fleet signs about once per 50 minutes, with one D1 read per isolate per token and one
// write per token. The row holds the signed JWT (a bearer valid for at most an hour) and its `iat`,
// never the private key. Its own key column is a hash, but the JWT itself is readable: its header
// carries the key id (`kid`) and its claims the team id (`iss`), so anyone who can read D1 can read
// both, and can use the bearer until it expires.

import { apnsProviderTokenCacheKey, makeApnsJwt, type ApnsCredentials } from './apns-jwt';
import { fingerprint } from './pem';
import type { Database } from './registrations';

/** How long one signed token is reused: most of its 60-minute validity. */
export const APNS_JWT_REUSE_S = 50 * 60;
/** Another isolate's clock may run a little ahead: a token issued this far in the future is still taken. */
const SKEW_S = 60;

export interface ProviderToken {
    jwt: string;
    issuedAtS: number;
}

/** Where isolates share the provider token: D1 in the Worker, the same D1 fake in tests. */
export interface SharedTokens {
    read(key: string): Promise<ProviderToken | null>;
    /**
     * Stores `fresh` only if the stored token is still `previous` (null: none stored), and returns
     * whatever is stored afterwards: `fresh`, or the token another isolate stored first.
     */
    swap(key: string, previous: string | null, fresh: ProviderToken): Promise<ProviderToken | null>;
    /** Drops the stored token if it is still `jwt`. */
    drop(key: string, jwt: string): Promise<void>;
}

/** The shared token over D1 (migrations/0003_apns_provider_tokens.sql). */
export function d1SharedTokens(db: Database): SharedTokens {
    const read = async (key: string) => {
        const row = await db
            .prepare('SELECT jwt, issued_at FROM apns_provider_tokens WHERE key = ?')
            .bind(key)
            .first<{ jwt: string; issued_at: number }>();
        return row ? { jwt: row.jwt, issuedAtS: row.issued_at } : null;
    };
    return {
        read,
        async swap(key, previous, fresh) {
            await db
                .prepare(
                    'INSERT INTO apns_provider_tokens (key, jwt, issued_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET jwt = excluded.jwt, issued_at = excluded.issued_at WHERE apns_provider_tokens.jwt = ?',
                )
                // With no previous token, the update never matches: an existing row wins.
                .bind(key, fresh.jwt, fresh.issuedAtS, previous ?? '')
                .run();
            return read(key);
        },
        async drop(key, jwt) {
            await db.prepare('DELETE FROM apns_provider_tokens WHERE key = ? AND jwt = ?').bind(key, jwt).run();
        },
    };
}

const usable = (token: ProviderToken, nowS: number) =>
    nowS - token.issuedAtS < APNS_JWT_REUSE_S && token.issuedAtS - nowS <= SKEW_S;

export class ApnsProviderTokens {
    private readonly cache = new Map<string, ProviderToken>();
    /** Fetching or signing in progress per key, so a burst of pushes in one isolate does it once. */
    private readonly pending = new Map<string, Promise<ProviderToken>>();

    constructor(private readonly log: (event: string) => void = () => {}) {}

    /**
     * The token to send at `nowMs`: this isolate's while it is younger than 50 minutes, else the
     * shared one while it is, else a new one, shared.
     */
    async get(credentials: ApnsCredentials, nowMs: number, shared?: SharedTokens): Promise<string> {
        const nowS = Math.floor(nowMs / 1000);
        const key = await apnsProviderTokenCacheKey(credentials);
        const cached = this.cache.get(key);
        if (cached && usable(cached, nowS)) {
            return cached.jwt;
        }
        let pending = this.pending.get(key);
        if (!pending) {
            pending = this.fetchOrSign(credentials, key, nowS, shared);
            this.pending.set(key, pending);
            pending
                .then((token) => this.cache.set(key, token))
                .catch(() => {})
                .finally(() => this.pending.delete(key));
        }
        return (await pending).jwt;
    }

    private async fetchOrSign(
        credentials: ApnsCredentials,
        key: string,
        nowS: number,
        shared: SharedTokens | undefined,
    ): Promise<ProviderToken> {
        // The row's key: a hash of team, key id and key fingerprint. (The stored JWT still carries
        // the key id and team id in the clear; only the private key never reaches D1.)
        const rowKey = shared ? await fingerprint(key) : '';
        let stored: ProviderToken | null = null;
        if (shared) {
            try {
                stored = await shared.read(rowKey);
            } catch {
                this.log('apns token store failed');
                shared = undefined;
            }
            if (stored && usable(stored, nowS)) {
                return stored;
            }
        }
        const fresh = { jwt: await makeApnsJwt(credentials, nowS), issuedAtS: nowS };
        if (!shared) {
            return fresh;
        }
        try {
            const winner = await shared.swap(rowKey, stored?.jwt ?? null, fresh);
            return winner && usable(winner, nowS) ? winner : fresh;
        } catch {
            this.log('apns token store failed');
            return fresh;
        }
    }

    /**
     * Drops a token APNs says is expired (ExpiredProviderToken), here and in the shared row, so
     * the next push signs a new one; a newer one stays. Never for InvalidProviderToken: a wrong
     * key id or team id isn't fixed by signing again, and re-signing on every push would trip
     * TooManyProviderTokenUpdates.
     */
    async expire(credentials: ApnsCredentials, jwt: string, shared?: SharedTokens): Promise<void> {
        const key = await apnsProviderTokenCacheKey(credentials);
        if (this.cache.get(key)?.jwt === jwt) {
            this.cache.delete(key);
        }
        if (shared) {
            try {
                await shared.drop(await fingerprint(key), jwt);
            } catch {
                this.log('apns token store failed');
            }
        }
    }
}
