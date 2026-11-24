import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/** The CBOR subset WebAuthn needs: ints, byte and text strings, maps. */
type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;
function head(major: number, length: number) {
    if (length < 24) {
        return Buffer.from([(major << 5) | length]);
    }
    if (length < 256) {
        return Buffer.from([(major << 5) | 24, length]);
    }
    const out = Buffer.alloc(3);
    out[0] = (major << 5) | 25;
    out.writeUInt16BE(length, 1);
    return out;
}
export function cbor(value: Cbor): Buffer {
    if (typeof value === 'number') {
        return value >= 0 ? head(0, value) : head(1, -1 - value);
    }
    if (typeof value === 'string') {
        return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
    }
    if (value instanceof Uint8Array) {
        return Buffer.concat([head(2, value.length), Buffer.from(value)]);
    }
    return Buffer.concat([head(5, value.size), ...[...value].flatMap(([key, item]) => [cbor(key), cbor(item)])]);
}

const b64url = (data: Uint8Array) => Buffer.from(data).toString('base64url');
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest();

/**
 * A software passkey (ES256, "none" attestation), standing in for a
 * platform authenticator: it answers the options a WebAuthn server sends
 * with the JSON `navigator.credentials` would give the browser client.
 */
export class SoftAuthenticator {
    readonly credentialId = randomBytes(16);
    private privateKey: KeyObject;
    private publicKey: KeyObject;
    private counter = 0;
    constructor(
        private origin: string,
        private rpId = new URL(origin).hostname,
    ) {
        ({ privateKey: this.privateKey, publicKey: this.publicKey } = generateKeyPairSync('ec', {
            namedCurve: 'P-256',
        }));
    }

    private authData(flags: number, attested?: Buffer) {
        const count = Buffer.alloc(4);
        count.writeUInt32BE(this.counter++);
        return Buffer.concat([sha256(this.rpId), Buffer.from([flags]), count, ...(attested ? [attested] : [])]);
    }

    /** Answers `navigator.credentials.create()` options. */
    register(options: { challenge: string }, origin = this.origin) {
        const jwk = this.publicKey.export({ format: 'jwk' });
        const coseKey = cbor(
            new Map<Cbor, Cbor>([
                [1, 2], // kty: EC2
                [3, -7], // alg: ES256
                [-1, 1], // crv: P-256
                [-2, Buffer.from(jwk.x!, 'base64url')],
                [-3, Buffer.from(jwk.y!, 'base64url')],
            ]),
        );
        const length = Buffer.alloc(2);
        length.writeUInt16BE(this.credentialId.length);
        const attested = Buffer.concat([
            Buffer.alloc(16), // AAGUID
            length,
            this.credentialId,
            coseKey,
        ]);
        const clientData = JSON.stringify({
            type: 'webauthn.create',
            challenge: options.challenge,
            origin,
            crossOrigin: false,
        });
        // Flags: user present, user verified, attested credential data.
        const attestationObject = cbor(
            new Map<Cbor, Cbor>([
                ['fmt', 'none'],
                ['attStmt', new Map()],
                ['authData', this.authData(0x45, attested)],
            ]),
        );
        return {
            id: b64url(this.credentialId),
            rawId: b64url(this.credentialId),
            type: 'public-key',
            response: {
                clientDataJSON: b64url(Buffer.from(clientData)),
                attestationObject: b64url(attestationObject),
                transports: ['internal'],
            },
            clientExtensionResults: {},
            authenticatorAttachment: 'platform',
        };
    }

    /** Answers `navigator.credentials.get()` options. */
    authenticate(options: { challenge: string }, origin = this.origin) {
        const clientData = Buffer.from(
            JSON.stringify({
                type: 'webauthn.get',
                challenge: options.challenge,
                origin,
                crossOrigin: false,
            }),
        );
        const authenticatorData = this.authData(0x05);
        const signature = sign('sha256', Buffer.concat([authenticatorData, sha256(clientData)]), this.privateKey);
        return {
            id: b64url(this.credentialId),
            rawId: b64url(this.credentialId),
            type: 'public-key',
            response: {
                clientDataJSON: b64url(clientData),
                authenticatorData: b64url(authenticatorData),
                signature: b64url(signature),
            },
            clientExtensionResults: {},
            authenticatorAttachment: 'platform',
        };
    }
}
