import { webcrypto } from 'node:crypto';
// Runs the vendored T3 Code functions that call @noble/curves and @noble/hashes, for
// tests/t3code-noble.test.ts. The vendored sources go through tsx, as the session host does:
// Vite can't transform them (their tsconfig extends a base that isn't vendored). Reads a JSON
// array of calls on stdin and prints their results, in order, as one JSON array.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { resolveDesktopAppControlAddress } from '@t3tools/shared/desktopAppControl';
import { computeDpopAccessTokenHash, computeDpopJwkThumbprint, verifyDpopProof } from '@t3tools/shared/dpop';
import { hashTelemetryId } from '@t3tools/shared/telemetryId';

type Call =
    | { readonly fn: 'thumbprint'; readonly jwk: Parameters<typeof computeDpopJwkThumbprint>[0] }
    | { readonly fn: 'accessTokenHash'; readonly token: string }
    | { readonly fn: 'verify'; readonly input: Parameters<typeof verifyDpopProof>[0] }
    | { readonly fn: 'verifyWebCrypto'; readonly count: number; readonly url: string; readonly now: number }
    | { readonly fn: 'telemetryId'; readonly value: string }
    | {
          readonly fn: 'desktopAddress';
          readonly separator: string;
          readonly input: Omit<Parameters<typeof resolveDesktopAppControlAddress>[0], 'joinPath'>;
      }
    | { readonly fn: 'sha256Stream'; readonly chunks: ReadonlyArray<string>; readonly repeat: number };

// provider-acp-registry hashes a download chunk by chunk with sha256.create(): load the copy it
// resolves, by the specifier it imports.
const registry = createRequire(new URL('../../vendor/t3code/provider-acp-registry/package.json', import.meta.url));
const { sha256 } = (await import(registry.resolve('@noble/hashes/sha2.js'))) as {
    sha256: { create(): { update(chunk: Uint8Array): unknown; digest(): Uint8Array } };
};

const base64Url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** Signs `count` DPoP proofs with a fresh WebCrypto key and verifies each, as a browser client's would be. */
async function verifyWebCrypto(count: number, url: string, now: number) {
    const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const { kty, crv, x, y } = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
    const jwk = { kty, crv, x, y };
    const results = [];
    for (let i = 0; i < count; i++) {
        const input = `${base64Url({ typ: 'dpop+jwt', alg: 'ES256', jwk })}.${base64Url({ htm: 'GET', htu: url, jti: `j${i}`, iat: now })}`;
        const signature = await webcrypto.subtle.sign(
            { name: 'ECDSA', hash: 'SHA-256' },
            keys.privateKey,
            Buffer.from(input),
        );
        const proof = `${input}.${Buffer.from(signature).toString('base64url')}`;
        results.push(verifyDpopProof({ proof, method: 'GET', url, nowEpochSeconds: now }).ok);
    }
    return results;
}

async function run(call: Call): Promise<unknown> {
    switch (call.fn) {
        case 'thumbprint':
            return computeDpopJwkThumbprint(call.jwk);
        case 'accessTokenHash':
            return computeDpopAccessTokenHash(call.token);
        case 'verify':
            return verifyDpopProof(call.input);
        case 'verifyWebCrypto':
            return verifyWebCrypto(call.count, call.url, call.now);
        case 'telemetryId':
            return hashTelemetryId(call.value);
        case 'desktopAddress':
            return resolveDesktopAppControlAddress({
                ...call.input,
                joinPath: (...segments) => segments.join(call.separator),
            });
        case 'sha256Stream': {
            const hash = sha256.create();
            for (let i = 0; i < call.repeat; i++) {
                for (const chunk of call.chunks) {
                    hash.update(Buffer.from(chunk));
                }
            }
            return Buffer.from(hash.digest()).toString('hex');
        }
    }
}

const calls = JSON.parse(readFileSync(0, 'utf8')) as ReadonlyArray<Call>;
const results = [];
for (const call of calls) {
    results.push(await run(call));
}
process.stdout.write(JSON.stringify(results));
