/**
 * The deployment's key (protocol §2.3): an Ed25519 keypair it makes itself.
 * The issuer gets the public half at registration; the private half stays
 * sealed in the workspace's database. With `node:crypto` only.
 */
import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';

/** An Ed25519 public key as the issuer takes it (RFC 8037), with the profile's `alg` and `use`. */
export interface PublicJwk {
    kty: 'OKP';
    crv: 'Ed25519';
    x: string;
    kid: string;
    alg: 'EdDSA';
    use: 'sig';
}

export interface DeploymentKey {
    kid: string;
    /** The private key (`d`) with its public half; only ever stored sealed. */
    privateJwk: { kty: 'OKP'; crv: 'Ed25519'; x: string; d: string };
}

export function newDeploymentKey(): DeploymentKey {
    const { privateKey } = generateKeyPairSync('ed25519');
    const jwk = privateKey.export({ format: 'jwk' });
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.x || !jwk.d) {
        throw new Error('Could not make an Ed25519 key.');
    }
    return { kid: randomUUID(), privateJwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x, d: jwk.d } };
}

export function publicJwk(key: DeploymentKey): PublicJwk {
    return { kty: 'OKP', crv: 'Ed25519', x: key.privateJwk.x, kid: key.kid, alg: 'EdDSA', use: 'sig' };
}

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** How long an assertion is good for: the issuer takes up to 300 s; a request needs far less. */
export const ASSERTION_SECONDS = 120;

/**
 * A client assertion (RFC 7523 §3): the deployment signing, with its own
 * key, that it is asking `audience` now. Good once (`jti`) and for two minutes.
 */
export function clientAssertion(key: DeploymentKey, clientId: string, audience: string, nowMs: number): string {
    const iat = Math.floor(nowMs / 1000);
    const input = `${encode({ alg: 'EdDSA', kid: key.kid, typ: 'JWT' })}.${encode({
        iss: clientId,
        sub: clientId,
        aud: audience,
        iat,
        exp: iat + ASSERTION_SECONDS,
        jti: randomUUID(),
    })}`;
    const signature = sign(null, Buffer.from(input), createPrivateKey({ key: key.privateJwk, format: 'jwk' }));
    return `${input}.${signature.toString('base64url')}`;
}
