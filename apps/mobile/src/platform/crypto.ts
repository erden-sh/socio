import { CryptoDigestAlgorithm, CryptoEncoding, digest, digestStringAsync, randomUUID } from 'expo-crypto';

import type { RandomBytes } from '../data/keys';
import type { Hasher } from '../data/layout';

// SHA-256 and random bytes for the store (src/data/layout.ts and keys.ts), and
// the ids a chat's runs and messages get on the device (src/net/run-client.ts).

/** SHA-256 of `text` as UTF-8, as 64 lowercase hex characters (expo-crypto's default encoding is hex). */
export const sha256Hex: Hasher = async (text) =>
    (await digestStringAsync(CryptoDigestAlgorithm.SHA256, text)).toLowerCase();

/** SHA-256 of `text` as UTF-8, in standard base64: the sign-in sheet's PKCE challenge (src/net/sheet-sign-in.ts). */
export const sha256Base64 = (text: string): Promise<string> =>
    digestStringAsync(CryptoDigestAlgorithm.SHA256, text, { encoding: CryptoEncoding.BASE64 });

/** SHA-256 of `bytes` as 64 lowercase hex characters: an issue file's, as the server records it. */
export async function sha256BytesHex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const hash = new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, bytes));
    let hex = '';
    for (const byte of hash) {
        hex += byte.toString(16).padStart(2, '0');
    }
    return hex;
}

/**
 * `length` bytes from `crypto.getRandomValues`, which Hermes doesn't have:
 * react-native-get-random-values adds it, imported first in index.ts, so it is
 * there before any module runs. Throws rather than fall back when it isn't.
 */
export const randomBytes: RandomBytes = (length) => {
    const source: unknown = Reflect.get(globalThis, 'crypto');
    const getRandomValues: unknown =
        typeof source === 'object' && source !== null ? Reflect.get(source, 'getRandomValues') : undefined;
    if (typeof getRandomValues !== 'function') {
        throw new Error(
            'crypto.getRandomValues is missing: index.ts must import react-native-get-random-values first.',
        );
    }
    const bytes = new Uint8Array(length);
    getRandomValues.call(source, bytes);
    return bytes;
};

/** A fresh id for a run or a message: expo-crypto's v4 UUID (Hermes has no `crypto.randomUUID`). */
export const randomId = (): string => randomUUID();
