import type { VariantName } from './variant.ts';

// The push relay's origin (apps/push-relay), a build constant:
// SOCIO_RELAY_ORIGIN at prebuild, embedded as `extra.relayOrigin` (app.config.ts) and recorded for
// the native builds that read the config again (plugins/build-env.ts). The relay has no host yet,
// so unset is the normal case: the build registers nothing and says so (Technical details). The
// app sends to this origin and no other (src/net/relay-fetch.ts), never one from a setting or a
// server.
//
// An origin only (no path, query or user name), over https; development may also use plain http
// to the local hosts its network config allows, for `wrangler dev` behind `adb reverse`. A value
// that isn't one throws, so a typo fails the build instead of shipping a build without push.

/** The hosts development may reach the relay on over plain http (src/net/address.ts' LOCAL_HTTP_HOSTS). */
export const LOCAL_RELAY_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '10.0.2.2'];

/** Why `value` isn't a relay origin for `variant`, or null when it is one. */
function problem(value: string, variant: VariantName): string | null {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return 'is not a URL';
    }
    if (url.origin !== value) {
        return 'is not an origin alone (scheme, host and port, no path or trailing slash)';
    }
    if (url.protocol === 'https:') {
        return null;
    }
    if (url.protocol === 'http:' && variant === 'development' && LOCAL_RELAY_HOSTS.includes(url.hostname)) {
        return null;
    }
    return `is not https${variant === 'development' ? ', or http to a local host' : ''}`;
}

/** The relay origin SOCIO_RELAY_ORIGIN gives `variant`, or null when unset. Throws on any other value. */
export function relayOrigin(value: string | undefined, variant: VariantName): string | null {
    if (value === undefined || value === '') {
        return null;
    }
    const why = problem(value, variant);
    if (why !== null) {
        throw new Error(`SOCIO_RELAY_ORIGIN "${value}" ${why}: give the relay's origin, or leave it unset.`);
    }
    return value;
}

/** `extra.relayOrigin` as the app reads it: the origin, or null when unset or not one `variant` takes. */
export function embeddedRelayOrigin(value: unknown, variant: VariantName): string | null {
    return typeof value === 'string' && value !== '' && problem(value, variant) === null ? value : null;
}
