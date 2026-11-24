// base64url without padding (RFC 4648 §5), as Web Push, VAPID and the relay's ids use it.

export function encode(bytes: ArrayBuffer | Uint8Array): string {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let text = '';
    for (let i = 0; i < view.length; i += 0x8000) {
        text += String.fromCharCode(...view.subarray(i, i + 0x8000));
    }
    return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const ALPHABET = /^[A-Za-z0-9_-]*={0,2}$/;

/** The bytes, or undefined when the text isn't base64url. */
export function decode(text: string): Uint8Array | undefined {
    if (!ALPHABET.test(text) || text.replace(/=+$/, '').length % 4 === 1) {
        return undefined;
    }
    const bare = text.replace(/=+$/, '');
    const binary = atob(bare.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (bare.length % 4)) % 4));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        out[i] = binary.charCodeAt(i);
    }
    return out;
}
