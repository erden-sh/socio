// The APNs provider token (an ES256 JWT, `{alg, kid}` and `{iss, iat}`), signed with WebCrypto.
// Ported from T3 Code's infra/relay/src/agentActivity/apnsJwt.ts (MIT, T3 Tools Inc; see
// vendor/t3code/SYNC.md): no Effect, no node:crypto and no @noble. Upstream signs
// deterministically (RFC 6979 via @noble) so every isolate presents the same token; WebCrypto's
// ECDSA is randomized, so isolates share one signed token through D1 instead (apns-provider-tokens.ts).

import { encode } from './base64url';
import { fingerprint, jwtPart, pemBytes } from './pem';

/** The relay's APNs key: APNS_TEAM_ID, APNS_KEY_ID and the .p8 in APNS_KEY_P8. */
export interface ApnsCredentials {
    teamId: string;
    keyId: string;
    /** The .p8 file: a PKCS #8 P-256 private key in PEM. */
    privateKey: string;
}

/** Imported keys, so a push never re-parses the PEM. The key set is static per deployment. */
const signingKeys = new Map<string, Promise<CryptoKey>>();

function signingKey(pem: string): Promise<CryptoKey> {
    let key = signingKeys.get(pem);
    if (!key) {
        key = crypto.subtle.importKey('pkcs8', pemBytes(pem), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
        // A bad key fails every time; don't keep the rejection, so a fixed secret is picked up.
        key.catch(() => signingKeys.delete(pem));
        signingKeys.set(pem, key);
    }
    return key;
}

/** Signs a provider token issued at `issuedAtS` (Unix seconds). WebCrypto's ECDSA signature is the raw r‖s JWS wants. */
export async function makeApnsJwt(credentials: ApnsCredentials, issuedAtS: number): Promise<string> {
    const signingInput = `${jwtPart({ alg: 'ES256', kid: credentials.keyId })}.${jwtPart({
        iss: credentials.teamId,
        iat: issuedAtS,
    })}`;
    const signature = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        await signingKey(credentials.privateKey),
        new TextEncoder().encode(signingInput),
    );
    return `${signingInput}.${encode(signature)}`;
}

/** Tokens are cached per team, key id and key material, so a rotated key never reuses an old token. */
export async function apnsProviderTokenCacheKey(credentials: ApnsCredentials): Promise<string> {
    return `${credentials.teamId}:${credentials.keyId}:${await fingerprint(credentials.privateKey)}`;
}
