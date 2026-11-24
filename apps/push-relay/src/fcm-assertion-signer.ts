// The service account's signed assertion that buys an FCM access token (RFC 7523, RS256).
// Ported from T3 Code's infra/relay/src/agentActivity/FcmAssertionSigner.ts (MIT, T3 Tools Inc;
// see vendor/t3code/SYNC.md): the same claims and WebCrypto, without Effect.

import { encode } from './base64url';
import { jwtPart, pemBytes } from './pem';

/** Google's token endpoint: the assertion's audience. */
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

const signingKeys = new Map<string, Promise<CryptoKey>>();

function signingKey(pem: string): Promise<CryptoKey> {
    let key = signingKeys.get(pem);
    if (!key) {
        key = crypto.subtle.importKey('pkcs8', pemBytes(pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, [
            'sign',
        ]);
        key.catch(() => signingKeys.delete(pem));
        signingKeys.set(pem, key);
    }
    return key;
}

export async function signFcmAssertion(input: {
    privateKey: string;
    clientEmail: string;
    /** Unix seconds. */
    issuedAt: number;
}): Promise<string> {
    const signingInput = `${jwtPart({ alg: 'RS256', typ: 'JWT' })}.${jwtPart({
        iss: input.clientEmail,
        scope: FCM_SCOPE,
        aud: GOOGLE_TOKEN_URL,
        iat: input.issuedAt,
        exp: input.issuedAt + 3600,
    })}`;
    const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        await signingKey(input.privateKey),
        new TextEncoder().encode(signingInput),
    );
    return `${signingInput}.${encode(signature)}`;
}
