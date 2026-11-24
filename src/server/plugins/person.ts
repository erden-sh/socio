/**
 * Who is using a service plugin (CB-254), for a plugin whose manifest asks
 * for `person:read`. The apps proxy adds it on every request it forwards,
 * after stripping any `x-cb-*` header the browser sent. It is signed with
 * the plugin's ingress proof (`CB_PLUGIN_PROOF`, which only Socio, the
 * runtime ingress and that plugin's tasks know), so the plugin can check
 * that it came through Socio and was not replayed for long.
 *
 * Format: `<base64url JSON>.<base64url HMAC-SHA256>`; the MAC covers
 * `socio-plugin-person\0<base64url JSON>`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import type { Role } from '@socio/shared/types';

/** How long one signature is good for. A request is forwarded at once. */
const PERSON_TTL_MS = 5 * 60_000;

export interface PluginPerson {
    /**
     * The person's Socio user id, the same for every plugin and stable: for a
     * person renamed offline, the id they had first (`person_seeds`, CB-338).
     */
    id: string;
    name: string;
    role: Role;
    timeZone: string;
    /** The plugin it was signed for. */
    plugin: string;
    /** Issued and expires, epoch ms. */
    iat: number;
    exp: number;
}

const mac = (proof: string, payload: string) =>
    createHmac('sha256', proof).update(`socio-plugin-person\u0000${payload}`).digest('base64url');

export function signPluginPerson(proof: string, person: Omit<PluginPerson, 'iat' | 'exp'>, now = Date.now()) {
    const payload = Buffer.from(JSON.stringify({ ...person, iat: now, exp: now + PERSON_TTL_MS })).toString(
        'base64url',
    );
    return `${payload}.${mac(proof, payload)}`;
}

/**
 * The person in an `x-cb-person` header, or undefined when it is missing,
 * forged, for another plugin, or expired. For plugin services (they hold
 * the proof as `CB_PLUGIN_PROOF`).
 */
export function verifyPluginPerson(
    proof: string,
    plugin: string,
    header: string | undefined,
    now = Date.now(),
): PluginPerson | undefined {
    if (!proof || !header || header.length > 4000) {
        return undefined;
    }
    const [payload, signature, extra] = header.split('.');
    if (!payload || !signature || extra !== undefined) {
        return undefined;
    }
    const expected = Buffer.from(mac(proof, payload));
    const supplied = Buffer.from(signature);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
        return undefined;
    }
    let person: PluginPerson;
    try {
        person = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as PluginPerson;
    } catch {
        return undefined;
    }
    if (
        person.plugin !== plugin ||
        typeof person.exp !== 'number' ||
        person.exp <= now ||
        typeof person.id !== 'string'
    ) {
        return undefined;
    }
    return person;
}
