// The relay's quotas, all per minute. Pushes: per registration, per VAPID key (one workspace) and
// global. Registration writes (`POST` and `PUT /v1/registrations`, which need no account): per
// client address when Cloudflare gives one, through the binding as a cheap first filter; then the
// D1 write budget (src/write-budget.ts), which is global as the binding can't be (it counts per
// location), so nobody can fill D1 or use up its writes.
//
// In the Worker they are Cloudflare's Workers Rate Limiting binding (`[[ratelimits]]`), so a push
// writes nothing. Its limits live in wrangler.toml, its period is 10 or 60 seconds
// only, its windows are fixed and aligned to the clock, and it counts per Cloudflare location and
// is eventually consistent. So the quotas are approximate and there is no daily quota. The operator
// must confirm the binding is available on the account's plan. Tests use a fake binding with an
// injected clock (tests/fakes/rate-limit.ts); nothing under Node can test the binding itself.

/** The starting numbers; wrangler.toml holds them, with a period of 60 seconds each. */
export const QUOTAS = {
    /** One phone in one workspace. A busy room pushes about once per message. */
    registration: { binding: 'RL_REGISTRATION', limit: 30, period: 60 },
    /** One workspace's server, across all its people's phones. */
    vapidKey: { binding: 'RL_VAPID_KEY', limit: 600, period: 60 },
    /** Every workspace together: a ceiling on cost and on what reaches APNs and FCM. */
    global: { binding: 'RL_GLOBAL', limit: 10_000, period: 60 },
    /**
     * Registration writes from one client address (an IPv6 address counts by its /64). A phone
     * registers once per workspace and refreshes daily; an office behind one NAT shares this.
     */
    registerClient: { binding: 'RL_REGISTER_CLIENT', limit: 20, period: 60 },
    /**
     * Every caller of the registration routes together, before anything reads D1 (keys `write`
     * for `POST` and `PUT`, `delete` for `DELETE`, so a flood of one never blocks the other, and
     * a revocation never waits on the write budget). It bounds the D1 reads the routes can cost
     * before auth: per location, as the binding counts, so approximate.
     */
    registryGlobal: { binding: 'RL_REGISTRY_GLOBAL', limit: 600, period: 60 },
} as const;

/** What a limited push answers in `Retry-After`: the binding's window, which it doesn't report. */
export const RETRY_AFTER_S = 60;

export interface Quotas {
    /**
     * A push's quotas come in the order the relay can check them, so the broad ones hold before
     * any D1 read and a push to an unknown id costs nothing past them:
     * 1. the global push quota, before the VAPID signature is even checked;
     * 2. the VAPID key's, once its signature checks (so nobody can spend another workspace's by
     *    putting its public key in `k`), still before the lookup;
     * 3. the registration's, after the lookup.
     * Each is false when its quota is used up.
     */
    takeGlobalPush(): Promise<boolean>;
    takeVapidKey(vapidKey: string): Promise<boolean>;
    takeRegistrationPush(registrationId: string): Promise<boolean>;
    /**
     * Counts one call to a registration route, before anything reads D1: against the client's
     * quota (when there is an address) and everyone's, each kept apart for writes (`POST`, `PUT`)
     * and deletes, so a flood of writes never blocks a revocation. False when either is used up.
     * The D1 write budget comes after this, for writes. `client` is the caller's address
     * (CF-Connecting-IP), or null when there is none; it is only ever hashed into the limiter's
     * key, never logged or stored.
     */
    takeRegistry(call: { client: string | null; kind: 'write' | 'delete' }): Promise<boolean>;
}

export interface RateLimitBindings {
    RL_REGISTRATION: RateLimit;
    RL_VAPID_KEY: RateLimit;
    RL_GLOBAL: RateLimit;
    RL_REGISTER_CLIENT: RateLimit;
    RL_REGISTRY_GLOBAL: RateLimit;
}

/**
 * The part of a client address one person controls: an IPv4 address whole, an IPv6 address's /64
 * (one home or phone gets a whole /64), and an IPv4-mapped IPv6 address as IPv4. Null for anything
 * that isn't an address.
 */
export function clientPrefix(address: string | null): string | null {
    const text = address?.trim().toLowerCase();
    if (!text) {
        return null;
    }
    const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
    if (v4) {
        return v4[1].split('.').every((part) => Number(part) <= 255) ? v4[1] : null;
    }
    if (!/^[0-9a-f:]+$/.test(text) || text.split('::').length > 2) {
        return null;
    }
    const [head, tail] = text.split('::');
    const left = head ? head.split(':') : [];
    const right = tail === undefined ? [] : tail ? tail.split(':') : [];
    const missing = 8 - left.length - right.length;
    if ((tail === undefined && missing !== 0) || (tail !== undefined && missing < 1)) {
        return null;
    }
    const groups = [...left, ...Array<string>(tail === undefined ? 0 : missing).fill('0'), ...right];
    if (groups.some((group) => group.length === 0 || group.length > 4)) {
        return null;
    }
    return `${groups
        .slice(0, 4)
        .map((group) => group.replace(/^0+(?=.)/, ''))
        .join(':')}::/64`;
}

/** The limiter's key for a client: a hash of its prefix, so not even the binding holds the address. */
async function clientKey(prefix: string, kind: 'write' | 'delete') {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(prefix)));
    return `${kind === 'write' ? 'c' : 'd'}:${Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function allowed(checks: [RateLimit, string][], log: (event: string) => void) {
    for (const [limiter, key] of checks) {
        try {
            const { success } = await limiter.limit({ key });
            if (!success) {
                return false;
            }
        } catch {
            log('rate limiter failed');
        }
    }
    return true;
}

/**
 * Quotas over the bindings, broadest first (see `Quotas`): a push that a broad quota refuses never
 * reaches D1. The cost: a push its registration's quota refuses has already counted against its
 * workspace's and everyone's. A binding that throws lets the push through (logged): the
 * quotas are approximate anyway, and a lost push is worse than one over the limit.
 */
export function rateLimitQuotas(bindings: RateLimitBindings, log: (event: string) => void): Quotas {
    return {
        takeGlobalPush: () => allowed([[bindings.RL_GLOBAL, 'global']], log),
        takeVapidKey: (vapidKey) => allowed([[bindings.RL_VAPID_KEY, `k:${vapidKey}`]], log),
        takeRegistrationPush: (registrationId) => allowed([[bindings.RL_REGISTRATION, `r:${registrationId}`]], log),
        async takeRegistry({ client, kind }) {
            const prefix = clientPrefix(client);
            return allowed(
                [
                    ...(prefix
                        ? [[bindings.RL_REGISTER_CLIENT, await clientKey(prefix, kind)] as [RateLimit, string]]
                        : []),
                    [bindings.RL_REGISTRY_GLOBAL, kind],
                ],
                log,
            );
        },
    };
}
