// PEM private keys (Apple's .p8, a Google service account's `private_key`) as PKCS #8 bytes for
// WebCrypto's importKey, and a short fingerprint so a rotated key never reuses a cached token.

import { encode } from './base64url';

/** The DER bytes of a PEM document. Secrets stores often keep newlines as a literal `\n`. */
export function pemBytes(pem: string): Uint8Array<ArrayBuffer> {
    const body = pem.replace(/\\n/g, '\n').replace(/-----[^-]+-----|\s/g, '');
    const binary = atob(body);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        out[i] = binary.charCodeAt(i);
    }
    return out;
}

/** The first 16 characters of the key material's SHA-256: enough to tell keys apart, never the key. */
export async function fingerprint(text: string): Promise<string> {
    return encode(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).slice(0, 16);
}

/** One base64url JSON segment of a JWT. */
export const jwtPart = (value: unknown) => encode(new TextEncoder().encode(JSON.stringify(value)));

/** A short reason from a provider's answer, safe to log: letters, digits and `_` only, else nothing. */
export const loggable = (reason: unknown) =>
    typeof reason === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(reason) ? reason : '-';

/** Each provider call's stages (send, read the answer) are bounded, so a stuck host can't hold a push. */
export const STAGE_TIMEOUT_MS = 10_000;
