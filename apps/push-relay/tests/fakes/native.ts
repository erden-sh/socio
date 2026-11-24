// Fake APNs, FCM and Google token endpoints on 127.0.0.1, as node:http servers. They record every
// request and answer from a script. They speak HTTP/1.1 only, while APNs takes HTTP/2 only: the
// real transport takes a forward to Apple, with the owner's credentials.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { ApnsEnv } from '../../src/providers';

export interface Recorded {
    method: string;
    path: string;
    headers: IncomingMessage['headers'];
    body: string;
}

export interface Answer {
    status: number;
    body?: unknown;
}

/** One fake host: answers in order from `script`, then `fallback`. */
export class FakeHost {
    readonly requests: Recorded[] = [];
    script: (Answer | ((request: Recorded) => Answer))[] = [];
    private server?: Server;
    origin = '';

    constructor(private readonly fallback: Answer | ((request: Recorded) => Answer)) {}

    async start() {
        this.server = createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', (chunk: Buffer) => chunks.push(chunk));
            req.on('end', () => {
                const recorded: Recorded = {
                    method: req.method ?? '',
                    path: req.url ?? '',
                    headers: req.headers,
                    body: Buffer.concat(chunks).toString('utf8'),
                };
                this.requests.push(recorded);
                const next = this.script.shift() ?? this.fallback;
                const answer = typeof next === 'function' ? next(recorded) : next;
                const text =
                    answer.body === undefined
                        ? ''
                        : typeof answer.body === 'string'
                          ? answer.body
                          : JSON.stringify(answer.body);
                res.writeHead(answer.status, text ? { 'content-type': 'application/json' } : {});
                res.end(text);
            });
        });
        await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
        this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
        return this;
    }

    async stop() {
        await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    }
}

/** APNs' two hosts, as paths of one fake. */
export const apnsHostsOf = (fake: FakeHost): Record<ApnsEnv, string> => ({
    sandbox: `${fake.origin}/sandbox`,
    production: `${fake.origin}/production`,
});

/** A JWT's two JSON parts. */
export function jwtParts(jwt: string) {
    const [head, claims, signature] = jwt.split('.');
    return {
        head: JSON.parse(Buffer.from(head, 'base64url').toString('utf8')) as Record<string, unknown>,
        claims: JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as Record<string, unknown>,
        signingInput: `${head}.${claims}`,
        signature: Buffer.from(signature, 'base64url'),
    };
}

// Workers' types widen these: generateKey to a key or a pair, exportKey to bytes or a JWK.
const pairOf = (pair: CryptoKey | CryptoKeyPair) => pair as CryptoKeyPair;
const pkcs8Of = async (key: CryptoKey) => (await crypto.subtle.exportKey('pkcs8', key)) as ArrayBuffer;

const pem = (der: ArrayBuffer) =>
    `-----BEGIN PRIVATE KEY-----\n${(
        Buffer.from(der)
            .toString('base64')
            .match(/.{1,64}/g) ?? []
    ).join('\n')}\n-----END PRIVATE KEY-----\n`;

/** A made-up APNs key (.p8) and its public half, for verifying the provider token. */
export async function apnsTestKey() {
    const pair = pairOf(
        await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']),
    );
    return { pem: pem(await pkcs8Of(pair.privateKey)), publicKey: pair.publicKey };
}

/** A made-up service account's key and its public half, for verifying the assertion. */
export async function fcmTestKey() {
    const pair = pairOf(
        await crypto.subtle.generateKey(
            {
                name: 'RSASSA-PKCS1-v1_5',
                modulusLength: 2048,
                publicExponent: new Uint8Array([1, 0, 1]),
                hash: 'SHA-256',
            },
            true,
            ['sign', 'verify'],
        ),
    );
    return { pem: pem(await pkcs8Of(pair.privateKey)), publicKey: pair.publicKey };
}
