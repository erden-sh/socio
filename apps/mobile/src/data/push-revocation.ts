import { type Keys, workspaceKeyName } from './keys';

// The push revocation record: every wipe, for every reason, first copies the
// workspace's push relay registration (its id and secret, `socio.<id>.relay`)
// to a record of its own, so the
// registration outlives the wipe until the relay is told: its `DELETE` needs
// no cookie, and its 410 then makes the workspace's server drop the
// subscription at its next send.
//
// - **Its name is `socio.revoke-push.<32 hex>`**, the registration id's 16
//   bytes, so a wipe run again after a kill writes the same record. Older
//   builds' `socio.revoke.<32 hex>` pattern (sign-out.ts) doesn't match it, so
//   they neither read nor drop it, and it is no workspace key, so the wipe and
//   launch's reconcile leave it (keys.ts).
// - **It holds the registration id, its secret and the relay's origin it was
//   made at:** `{v, id, secret, origin}`, no cookie, workspace or workspace
//   origin. The relay origin is the one the registration was made with
//   (`socio.<id>.relay` keeps it), so a build with another relay, or none,
//   still revokes at the old one. A record or registration kept before they
//   held an origin has none: it was made at the build's own relay.
// - src/push/revocation.ts tries it at once, then at launch and on each return
//   to the foreground, and drops it on the relay's own settling answer (2xx,
//   410, its 403 problem). No cleanup deletes it (store.ts).

/** The server's push subscriptions (`POST` to make one, `DELETE …/:id` to drop it). */
export const PUSH_SUBSCRIPTIONS_PATH = '/api/notifications/push/subscriptions';

/** The names push revocation records take: `socio.revoke-push.<32 hex>`. */
export const PUSH_REVOCATION_PREFIX = 'socio.revoke-push.';

const PUSH_REVOCATION_NAME = /^socio\.revoke-push\.[0-9a-f]{32}$/;
/** The record's stored form's version. */
const PUSH_REVOCATION_VERSION = 1;
/** A registration id as src/push makes it: 16 random bytes in base64url, 22 characters. */
const REGISTRATION_ID = /^[A-Za-z0-9_-]{22}$/;
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** A relay registration the phone wiped but the relay hasn't been told about: all a record holds. */
export interface PushRevocation {
    /** The relay's registration id (the push's `s`). */
    readonly id: string;
    /** The registration's secret, the relay's only credential. */
    readonly secret: string;
    /** The relay's origin the registration was made at; absent in one kept before records held it (the build's own). */
    readonly origin?: string;
}

/** Whether `value` is an origin alone (scheme, host and port), as relay-origin.ts takes one. */
export function isRelayOrigin(value: string): boolean {
    try {
        const url = new URL(value);
        return url.origin === value && (url.protocol === 'https:' || url.protocol === 'http:');
    } catch {
        return false;
    }
}

/** Whether `name` is a push revocation record's. */
export function isPushRevocationKey(name: string): boolean {
    return PUSH_REVOCATION_NAME.test(name);
}

/**
 * The record's name for registration `id`: its 16 bytes in hex. Null for an id
 * src/push doesn't make (not 22 base64url characters).
 */
export function pushRevocationName(id: string): string | null {
    if (!REGISTRATION_ID.test(id)) {
        return null;
    }
    let bits = 0;
    let held = 0;
    let hex = '';
    for (const char of id) {
        held = (held << 6) | BASE64URL.indexOf(char);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            hex += ((held >> bits) & 0xff).toString(16).padStart(2, '0');
            held &= (1 << bits) - 1;
        }
    }
    return `${PUSH_REVOCATION_PREFIX}${hex}`;
}

/** The record's stored form: `{v, id, secret, origin}`, `origin` left out when the registration had none kept. */
export function formatPushRevocation(record: PushRevocation): string {
    return JSON.stringify({
        v: PUSH_REVOCATION_VERSION,
        id: record.id,
        secret: record.secret,
        ...(record.origin === undefined ? {} : { origin: record.origin }),
    });
}

/** The record (or a workspace's kept registration, which has the same fields) in `text`, its relay origin with it,, or null when it can't be read. */
export function parsePushRevocation(text: string | null): PushRevocation | null {
    if (text === null) {
        return null;
    }
    let stored: unknown;
    try {
        stored = JSON.parse(text);
    } catch {
        return null;
    }
    if (typeof stored !== 'object' || stored === null) {
        return null;
    }
    const { id, secret, origin } = stored as Record<string, unknown>;
    if (typeof id !== 'string' || typeof secret !== 'string' || id === '' || secret === '') {
        return null;
    }
    if (origin === undefined || origin === null) {
        return { id, secret };
    }
    // An origin that isn't one can't be revoked anywhere: the record can't be read.
    return typeof origin === 'string' && isRelayOrigin(origin) ? { id, secret, origin } : null;
}

/**
 * Copies workspace `id`'s relay registration to its revocation record, the
 * wipe's step before its push keys go. Resolves the record's name, or null
 * when the workspace has no registration kept (or one this build can't name).
 * Writing it again after a kill writes the same record.
 */
export async function recordPushRevocation(keys: Keys, id: string): Promise<string | null> {
    const kept = parsePushRevocation(await keys.read(workspaceKeyName(id, 'relay')));
    const name = kept === null ? null : pushRevocationName(kept.id);
    if (kept === null || name === null) {
        return null;
    }
    await keys.write(name, formatPushRevocation(kept));
    return name;
}
