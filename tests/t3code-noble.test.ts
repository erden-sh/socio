import { execFileSync } from 'node:child_process';

import { expect, it } from 'vitest';

// The vendored T3 Code packages call @noble/curves and @noble/hashes in four places: the DPoP
// proof check (shared/dpop), the telemetry id hash (shared/telemetryId), the desktop control
// socket name (shared/desktopAppControl) and the ACP Registry download checksum
// (provider-acp-registry). Every expected value here was computed with @noble/curves 1.9.1 and
// @noble/hashes 1.8.0, before the move to 2.x, so a major bump that changes an output fails here.
// tests/support/t3code-noble-probe.ts makes the calls, under tsx, as the session host runs them.

const JWK = {
    kty: 'EC',
    crv: 'P-256',
    x: '-MBRMLuM2ywxx0I9ssjTO6LQDoX_ad3KomzW8__tduI',
    y: 'rFtxW2n-HKUJq_VwrADc-O3-d-ZlNi-3VXzY-ULH_0s',
};
const ACCESS_TOKEN = 'access-token-1';
const HEADER =
    'eyJ0eXAiOiJkcG9wK2p3dCIsImFsZyI6IkVTMjU2IiwiandrIjp7Imt0eSI6IkVDIiwiY3J2IjoiUC0yNTYiLCJ4IjoiLU1CUk1MdU0yeXd4eDBJOXNzalRPNkxRRG9YX2FkM0tvbXpXOF9fdGR1SSIsInkiOiJyRnR4VzJuLUhLVUpxX1Z3ckFEYy1PMy1kLVpsTmktM1ZYelktVUxIXzBzIn19';
const PAYLOAD =
    'eyJodG0iOiJQT1NUIiwiaHR1IjoiaHR0cHM6Ly9yZWxheS5leGFtcGxlLnRlc3QvdjEvdG9rZW4iLCJqdGkiOiJqdGktMSIsImlhdCI6MTcwMDAwMDAwMCwiYXRoIjoieGJEeU01V2pzOG1UQWhueVBabEVUQUo5UkxTVGpBcG02bUxmUDFBU2dybyJ9';
// One RFC 6979 signature of `${HEADER}.${PAYLOAD}`, in its low-S and high-S forms (s and n - s).
// ES256 (RFC 7518) has no low-S rule, and WebCrypto signers return either half.
const SIG_LOW_S = 'tVKbyfwX4lFJ5fJeRZFOftsV7tdrnQLMbJmcYoLt8j02JbII934OCoO6OoDTcQbIrIVDlLyf87STmewn95POnw';
const SIG_HIGH_S = 'tVKbyfwX4lFJ5fJeRZFOftsV7tdrnQLMbJmcYoLt8j3J2k32CIHx9nxFxX8sjvk3EGG3GOp3qtBgH96bBM9Wsg';
const SIG_TAMPERED = (() => {
    const bytes = Buffer.from(SIG_LOW_S, 'base64url');
    bytes[40] ^= 1;
    return bytes.toString('base64url');
})();
const THUMBPRINT = 'OBf3WrvXSs-WrWtFhE3-a48KcZx9wLyfBJ4tYUVD5eM';
const URL_ = 'https://relay.example.test/v1/token';
const NOW = 1_700_000_010;
const proof = (signature: string) => `${HEADER}.${PAYLOAD}.${signature}`;

const CASES: ReadonlyArray<readonly [string, object, unknown]> = [
    ['the JWK thumbprint', { fn: 'thumbprint', jwk: JWK }, THUMBPRINT],
    [
        'the access token hash',
        { fn: 'accessTokenHash', token: ACCESS_TOKEN },
        'xbDyM5Wjs8mTAhnyPZlETAJ9RLSTjApm6mLfP1ASgro',
    ],
    [
        'a low-S proof',
        {
            fn: 'verify',
            input: {
                proof: proof(SIG_LOW_S),
                method: 'POST',
                url: `${URL_}?x=1`,
                nowEpochSeconds: NOW,
                expectedThumbprint: THUMBPRINT,
                expectedAccessToken: ACCESS_TOKEN,
            },
        },
        { ok: true, thumbprint: THUMBPRINT, jti: 'jti-1', iat: 1_700_000_000 },
    ],
    [
        'a high-S proof',
        { fn: 'verify', input: { proof: proof(SIG_HIGH_S), method: 'post', url: URL_, nowEpochSeconds: NOW } },
        { ok: true, thumbprint: THUMBPRINT, jti: 'jti-1', iat: 1_700_000_000 },
    ],
    [
        'a signature over other bytes',
        { fn: 'verify', input: { proof: proof(SIG_TAMPERED), method: 'POST', url: URL_, nowEpochSeconds: NOW } },
        { ok: false, code: 'invalid_signature', reason: 'Invalid DPoP signature.' },
    ],
    [
        'a proof for another access token',
        {
            fn: 'verify',
            input: {
                proof: proof(SIG_LOW_S),
                method: 'POST',
                url: URL_,
                nowEpochSeconds: NOW,
                expectedAccessToken: 'another-token',
            },
        },
        { ok: false, code: 'access_token_hash_mismatch', reason: 'DPoP access token hash mismatch.' },
    ],
    [
        'a stale proof',
        { fn: 'verify', input: { proof: proof(SIG_LOW_S), method: 'POST', url: URL_, nowEpochSeconds: NOW + 600 } },
        { ok: false, code: 'time_window', reason: 'DPoP proof is outside the allowed time window.' },
    ],
    // 24 signatures: the chance that none has a high S is 2^-24.
    [
        'proofs a WebCrypto client signs',
        { fn: 'verifyWebCrypto', count: 24, url: URL_, now: NOW },
        Array(24).fill(true),
    ],
    [
        'a telemetry id',
        { fn: 'telemetryId', value: 'socio-account-1' },
        'e87e6000634d7d079ac99e6fbf1e4428382fd818e231110a0a0b38d6133eebc2',
    ],
    [
        'an empty telemetry id',
        { fn: 'telemetryId', value: '' },
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    ],
    [
        'the desktop control socket',
        {
            fn: 'desktopAddress',
            separator: '/',
            input: { stateDir: '/home/someone/.t3/state', platform: 'linux', tempDir: '/tmp', userId: 1000 },
        },
        { address: '/tmp/t3code-1000/80ed78e0203decbf9d2b28bb.sock', directory: '/tmp/t3code-1000' },
    ],
    [
        'the desktop control pipe',
        {
            fn: 'desktopAddress',
            separator: '\\',
            input: { stateDir: 'C:\\Users\\someone\\.t3', platform: 'win32', tempDir: 'C:\\Temp' },
        },
        { address: '\\\\.\\pipe\\t3code-app-49f5dfc0d3d641c2c398a089', directory: null },
    ],
    [
        'a checksum streamed in chunks',
        { fn: 'sha256Stream', chunks: ['a', 'bc'], repeat: 1 },
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    ],
    [
        'a checksum streamed over a thousand chunks',
        { fn: 'sha256Stream', chunks: ['a'.repeat(1000)], repeat: 1000 },
        'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    ],
];

it('computes what @noble/curves 1.9.1 and @noble/hashes 1.8.0 computed at each vendored call site', () => {
    const output = execFileSync('node', ['--import', 'tsx', 'tests/support/t3code-noble-probe.ts'], {
        cwd: process.cwd(),
        input: JSON.stringify(CASES.map(([, call]) => call)),
        encoding: 'utf8',
    });
    const results = JSON.parse(output) as unknown[];
    expect(Object.fromEntries(CASES.map(([name], i) => [name, results[i]]))).toEqual(
        Object.fromEntries(CASES.map(([name, , expected]) => [name, expected])),
    );
});
