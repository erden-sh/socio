/**
 * `http_ece` (web-push's dependency) ships no types; the notification tests
 * use its decrypt to read a push the way a browser does (RFC 8291).
 */
declare module 'http_ece' {
    import type { ECDH } from 'node:crypto';
    const ece: {
        decrypt(buffer: Buffer, params: { version: 'aes128gcm'; privateKey: ECDH; authSecret: string }): Buffer;
    };
    export default ece;
}
