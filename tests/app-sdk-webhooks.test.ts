import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
    generateSecret,
    MemorySeenStore,
    parseSecrets,
    receiver,
    sign,
    verify,
    WEBHOOK_TOLERANCE_SECONDS,
} from '../packages/app-sdk/src/webhooks.js';

// CB-479: Standard Webhooks for Socio Forms receivers and adapters
// (`@socio/app-sdk/webhooks`). The vector is section 9 of the Forms
// receiver contract, docs/specs/FORMS-WEBHOOKS.md.

const SECRET = 'whsec_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const ID = 'msg_01JD7Q4W9A7G3K5P8R2S6U4V0X';
const TS = 1795100645;
const SIGNATURE = 'v1,L6yTYohs7AW+2OKv1bdkxrlwsucxuPOFbobw709B2fc=';
const BODY =
    '{"type":"form.submitted","timestamp":"2026-11-19T15:04:05.120Z","data":{"submissionId":"sub_01JD7Q4W8M2T5V9X3B6N1C0RKE","form":{"id":"frm_01JD7NZK3H8F2Q6W4T9Y5B1M7A","slug":"event-inquiry","version":3,"title":"Event inquiry"},"submittedAt":"2026-11-19T15:04:05.120Z","test":false,"fields":{"full_name":"Ana Example","email":"ana@example.com","guests":40,"event_date":"2027-02-14","interest":["private_event","catering"],"consent":true,"notes":null},"labels":{"full_name":"Your name","email":"Email","guests":"How many guests?","event_date":"Event date","interest":"What are you planning?","consent":"You may contact me about this request","notes":"Anything else?"},"options":{"interest":{"private_event":"Private event","catering":"Catering","workshop":"Workshop"}}}}';
const HEADERS = {
    'webhook-id': ID,
    'webhook-timestamp': String(TS),
    'webhook-signature': SIGNATURE,
    'x-forms-event': 'form.submitted',
    'x-forms-attempt': '1',
    'content-type': 'application/json',
};
const at = (seconds: number) => () => seconds * 1000;
const NOW = at(TS);
const bytes = (text: string) => new TextEncoder().encode(text);

describe('the WEBHOOKS.md test vector', () => {
    it('is the 767-byte body the contract names', async () => {
        const raw = bytes(BODY);
        expect(raw.length).toBe(767);
        const digest = Buffer.from(await crypto.subtle.digest('SHA-256', raw)).toString('hex');
        expect(digest).toBe('8b8d0789a7e7304693befbb64cd0d987111dfd614289ed3ca16c87c21c1e0213');
    });

    it('verifies from a string, bytes, an ArrayBuffer and fetch Headers', async () => {
        const expected = { ok: true, id: ID, timestamp: TS };
        expect(await verify(BODY, HEADERS, [SECRET], { now: NOW })).toEqual(expected);
        expect(await verify(bytes(BODY), HEADERS, [SECRET], { now: NOW })).toEqual(expected);
        expect(await verify(bytes(BODY).buffer, HEADERS, [SECRET], { now: NOW })).toEqual(expected);
        expect(await verify(BODY, new Headers(HEADERS), [SECRET], { now: NOW })).toEqual(expected);
    });

    it('matches header names in any case', async () => {
        const upper = { 'Webhook-Id': ID, 'Webhook-Timestamp': String(TS), 'Webhook-Signature': SIGNATURE };
        expect((await verify(BODY, upper, [SECRET], { now: NOW })).ok).toBe(true);
    });

    it('signs to the same signature', async () => {
        expect(await sign({ id: ID, timestamp: TS, body: BODY }, [SECRET])).toEqual({
            'webhook-id': ID,
            'webhook-timestamp': String(TS),
            'webhook-signature': SIGNATURE,
        });
        const fromDate = await sign({ id: ID, timestamp: new Date(TS * 1000 + 999), body: bytes(BODY) }, [SECRET]);
        expect(fromDate['webhook-signature']).toBe(SIGNATURE);
    });
});

describe('rotation', () => {
    const other = generateSecret();

    it('signs with every secret, one v1 entry each', async () => {
        const headers = await sign({ id: ID, timestamp: TS, body: BODY }, [SECRET, other]);
        const entries = headers['webhook-signature'].split(' ');
        expect(entries).toHaveLength(2);
        expect(entries[0]).toBe(SIGNATURE);
        expect(entries[1]).toMatch(/^v1,[A-Za-z0-9+/]{43}=$/);
    });

    it('accepts when any secret matches any entry', async () => {
        const both = await sign({ id: ID, timestamp: TS, body: BODY }, [other, SECRET]);
        expect((await verify(BODY, both, [SECRET], { now: NOW })).ok).toBe(true);
        expect((await verify(BODY, both, [other], { now: NOW })).ok).toBe(true);
        expect((await verify(BODY, HEADERS, [other, SECRET], { now: NOW })).ok).toBe(true);
        expect(await verify(BODY, HEADERS, [other], { now: NOW })).toEqual({ ok: false, reason: 'bad_signature' });
    });

    it('ignores other versions and broken entries beside a good one', async () => {
        const signature = `v2,abc v1,!!! v1,${'A'.repeat(43)}= ${SIGNATURE}`;
        const headers = { ...HEADERS, 'webhook-signature': signature };
        expect((await verify(BODY, headers, [SECRET], { now: NOW })).ok).toBe(true);
    });
});

describe('the replay window', () => {
    const t = WEBHOOK_TOLERANCE_SECONDS;

    it('accepts exactly five minutes either way', async () => {
        expect((await verify(BODY, HEADERS, [SECRET], { now: at(TS + t) })).ok).toBe(true);
        expect((await verify(BODY, HEADERS, [SECRET], { now: at(TS - t) })).ok).toBe(true);
        expect((await verify(BODY, HEADERS, [SECRET], { now: () => (TS + t) * 1000 + 999 })).ok).toBe(true);
    });

    it('refuses one second beyond, in the past and the future', async () => {
        expect(await verify(BODY, HEADERS, [SECRET], { now: at(TS + t + 1) })).toEqual({
            ok: false,
            reason: 'timestamp_too_old',
        });
        expect(await verify(BODY, HEADERS, [SECRET], { now: at(TS - t - 1) })).toEqual({
            ok: false,
            reason: 'timestamp_too_new',
        });
    });

    it('takes a custom tolerance', async () => {
        expect((await verify(BODY, HEADERS, [SECRET], { now: at(TS + 10), toleranceSeconds: 5 })).ok).toBe(false);
    });

    it('defaults to the real clock', async () => {
        expect(await verify(BODY, HEADERS, [SECRET])).toEqual({ ok: false, reason: 'timestamp_too_old' });
        const fresh = await sign({ id: ID, timestamp: new Date(), body: BODY }, [SECRET]);
        expect((await verify(BODY, fresh, [SECRET])).ok).toBe(true);
    });
});

describe('tampering', () => {
    const refused = { ok: false, reason: 'bad_signature' };

    it('refuses a changed body, even by one byte', async () => {
        expect(await verify(BODY.replace('"guests":40', '"guests":41'), HEADERS, [SECRET], { now: NOW })).toEqual(
            refused,
        );
        expect(await verify(`${BODY}\n`, HEADERS, [SECRET], { now: NOW })).toEqual(refused);
        const flipped = bytes(BODY);
        flipped[100]! ^= 1;
        expect(await verify(flipped, HEADERS, [SECRET], { now: NOW })).toEqual(refused);
    });

    it('refuses a changed id or timestamp', async () => {
        expect(await verify(BODY, { ...HEADERS, 'webhook-id': `${ID}Y` }, [SECRET], { now: NOW })).toEqual(refused);
        expect(await verify(BODY, { ...HEADERS, 'webhook-timestamp': String(TS + 1) }, [SECRET], { now: NOW })).toEqual(
            refused,
        );
    });

    it('refuses a changed signature', async () => {
        const changed = SIGNATURE.replace('L6y', 'L6z');
        expect(await verify(BODY, { ...HEADERS, 'webhook-signature': changed }, [SECRET], { now: NOW })).toEqual(
            refused,
        );
    });
});

describe('malformed input never throws', () => {
    const cases: [string, Record<string, unknown>, string][] = [
        ['no headers', {}, 'missing_headers'],
        ['an empty id', { ...HEADERS, 'webhook-id': '' }, 'missing_headers'],
        ['no signature header', { ...HEADERS, 'webhook-signature': undefined }, 'missing_headers'],
        ['a repeated id', { ...HEADERS, 'webhook-id': [ID, ID] }, 'malformed_headers'],
        ['a header twice in different case', { ...HEADERS, 'WEBHOOK-ID': ID }, 'malformed_headers'],
        ['a non-numeric timestamp', { ...HEADERS, 'webhook-timestamp': '1795100645.5' }, 'malformed_headers'],
        ['a negative timestamp', { ...HEADERS, 'webhook-timestamp': '-1' }, 'malformed_headers'],
        ['a huge timestamp', { ...HEADERS, 'webhook-timestamp': '9'.repeat(400) }, 'malformed_headers'],
        ['a huge id', { ...HEADERS, 'webhook-id': 'x'.repeat(10_000) }, 'malformed_headers'],
        [
            'a huge signature header',
            { ...HEADERS, 'webhook-signature': `${SIGNATURE} `.repeat(500) },
            'malformed_headers',
        ],
        ['no v1 entry', { ...HEADERS, 'webhook-signature': 'v2,abc' }, 'no_signature'],
        ['a v1 entry that is not base64', { ...HEADERS, 'webhook-signature': 'v1,***' }, 'no_signature'],
        ['a short v1 entry', { ...HEADERS, 'webhook-signature': 'v1,AAAA' }, 'no_signature'],
        ['a bare v1,', { ...HEADERS, 'webhook-signature': 'v1,' }, 'no_signature'],
    ];

    it.each(cases)('%s', async (_name, headers, reason) => {
        await expect(verify(BODY, headers as never, [SECRET], { now: NOW })).resolves.toEqual({ ok: false, reason });
    });

    it('refuses a repeated signature header joined by fetch Headers or Node', async () => {
        const headers = new Headers(HEADERS);
        headers.append('webhook-signature', SIGNATURE);
        expect(headers.get('webhook-signature')).toContain(', ');
        await expect(verify(BODY, headers, [SECRET], { now: NOW })).resolves.toEqual({
            ok: false,
            reason: 'malformed_headers',
        });
        const joined = { ...HEADERS, 'webhook-signature': `${SIGNATURE}, ${SIGNATURE}` };
        await expect(verify(BODY, joined, [SECRET], { now: NOW })).resolves.toEqual({
            ok: false,
            reason: 'malformed_headers',
        });
        const twice = new Headers(HEADERS);
        twice.append('webhook-timestamp', String(TS));
        await expect(verify(BODY, twice, [SECRET], { now: NOW })).resolves.toEqual({
            ok: false,
            reason: 'malformed_headers',
        });
    });

    it('treats a non-object header bag as missing', async () => {
        await expect(verify(BODY, null as never, [SECRET], { now: NOW })).resolves.toEqual({
            ok: false,
            reason: 'missing_headers',
        });
    });

    it('treats a body of the wrong type as a mismatch', async () => {
        await expect(verify(42 as never, HEADERS, [SECRET], { now: NOW })).resolves.toEqual({
            ok: false,
            reason: 'bad_signature',
        });
    });
});

describe('secrets', () => {
    it('generates whsec_ secrets of 32 random bytes', () => {
        const a = generateSecret();
        expect(a).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
        expect(Buffer.from(a.slice(6), 'base64')).toHaveLength(32);
        expect(generateSecret()).not.toBe(a);
    });

    it('parses one or two, separated by whitespace or commas', () => {
        const b = generateSecret();
        expect(parseSecrets(SECRET)).toEqual([SECRET]);
        expect(parseSecrets(`  ${SECRET}\n`)).toEqual([SECRET]);
        expect(parseSecrets(`${SECRET} ${b}`)).toEqual([SECRET, b]);
        expect(parseSecrets(`${SECRET},${b}`)).toEqual([SECRET, b]);
        expect(parseSecrets(`${SECRET} ,\n\t${b},`)).toEqual([SECRET, b]);
    });

    it('refuses none, three or a malformed one without echoing it', () => {
        expect(() => parseSecrets('')).toThrow(/one or two/);
        expect(() => parseSecrets(' , ')).toThrow(/one or two/);
        expect(() => parseSecrets('whsec_')).toThrow(/secret 1/);
        const three = [generateSecret(), generateSecret(), generateSecret()].join(' ');
        expect(() => parseSecrets(three)).toThrow(/found 3/);
        for (const bad of ['sk_live_abc', 'whsec_!!!!', `whsec_${'A'.repeat(20)}`, `whsec_${btoa('x'.repeat(65))}`]) {
            let message = '';
            try {
                parseSecrets(bad);
            } catch (error) {
                message = (error as Error).message;
            }
            expect(message).toMatch(/secret 1/);
            expect(message).not.toContain(bad);
        }
    });

    it('accepts keys of 24 to 64 bytes', async () => {
        for (const size of [24, 64]) {
            const secret = `whsec_${Buffer.alloc(size, 7).toString('base64')}`;
            expect(parseSecrets(secret)).toEqual([secret]);
            const headers = await sign({ id: ID, timestamp: TS, body: BODY }, [secret]);
            expect((await verify(BODY, headers, [secret], { now: NOW })).ok).toBe(true);
        }
    });

    it('throws for no secret or a bad one: that is configuration, not input', async () => {
        await expect(verify(BODY, HEADERS, [], { now: NOW })).rejects.toThrow(TypeError);
        await expect(verify(BODY, HEADERS, ['nope'], { now: NOW })).rejects.toThrow(TypeError);
        await expect(sign({ id: ID, timestamp: TS, body: BODY }, [])).rejects.toThrow(TypeError);
        expect(() => receiver({ secrets: ['nope'], seen: new MemorySeenStore() })).toThrow(TypeError);
    });

    it('refuses to sign a bad id or timestamp', async () => {
        await expect(sign({ id: '', timestamp: TS, body: BODY }, [SECRET])).rejects.toThrow(TypeError);
        await expect(sign({ id: ID, timestamp: 1.5, body: BODY }, [SECRET])).rejects.toThrow(TypeError);
        await expect(sign({ id: ID, timestamp: new Date(Number.NaN), body: BODY }, [SECRET])).rejects.toThrow(
            TypeError,
        );
    });
});

describe('receiver', () => {
    const request = (headers: Record<string, string>, body: string | Uint8Array = BODY) =>
        new Request('https://lab.example/webhooks/forms', { method: 'POST', headers, body: body as BodyInit });

    it('passes a verified event on once, then answers 200 to the repeat', async () => {
        const seen = new MemorySeenStore({ now: NOW });
        const receive = receiver({ secrets: [SECRET], seen, now: NOW });
        const events: unknown[] = [];
        const handle = (event: { id: string; payload: unknown }) => {
            events.push(event);
        };

        const first = await receive(request(HEADERS), handle);
        expect(first.status).toBe(204);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            id: ID,
            timestamp: TS,
            body: BODY,
            payload: { type: 'form.submitted', data: { submissionId: 'sub_01JD7Q4W8M2T5V9X3B6N1C0RKE' } },
        });

        const repeat = await receive(request(HEADERS), handle);
        expect(repeat.status).toBe(200);
        expect(await repeat.json()).toEqual({ duplicate: true });
        expect(events).toHaveLength(1);
    });

    it.each([500, 503, 429, 302])(
        'remembers nothing when the handler answers %i, so the retry runs',
        async (status) => {
            const seen = new MemorySeenStore();
            const receive = receiver({ secrets: [SECRET], seen, now: NOW });
            let runs = 0;
            const failing = () => {
                runs++;
                return new Response(null, { status });
            };
            expect((await receive(request(HEADERS), failing)).status).toBe(status);
            expect(seen.has(ID)).toBe(false);
            expect((await receive(request(HEADERS), failing)).status).toBe(status);
            expect(runs).toBe(2);
            expect((await receive(request(HEADERS), () => new Response('ok', { status: 200 }))).status).toBe(200);
            expect((await receive(request(HEADERS), failing)).status).toBe(200);
            expect(runs).toBe(2);
        },
    );

    it("returns the handler's own response", async () => {
        const receive = receiver({ secrets: [SECRET], seen: new MemorySeenStore(), now: NOW });
        const response = await receive(request(HEADERS), () => new Response('ok', { status: 202 }));
        expect(response.status).toBe(202);
    });

    it('answers 401 with the reason for a bad signature, and never calls the handler', async () => {
        const receive = receiver({ secrets: [SECRET], seen: new MemorySeenStore(), now: NOW });
        let called = false;
        const handle = () => {
            called = true;
        };
        const tampered = await receive(request(HEADERS, BODY.replace('40', '41')), handle);
        expect(tampered.status).toBe(401);
        expect(await tampered.json()).toEqual({ error: 'bad_signature' });
        const unsigned = await receive(request({ 'content-type': 'application/json' }), handle);
        expect(unsigned.status).toBe(401);
        const stale = receiver({ secrets: [SECRET], seen: new MemorySeenStore(), now: at(TS + 3600) });
        expect(await (await stale(request(HEADERS), handle)).json()).toEqual({ error: 'timestamp_too_old' });
        expect(called).toBe(false);
    });

    it('checks the signature before the seen store, so a forged repeat gets 401', async () => {
        const seen = new MemorySeenStore();
        seen.add(ID, 60);
        const receive = receiver({ secrets: [SECRET], seen, now: NOW });
        const forged = await receive(request({ ...HEADERS, 'webhook-signature': `v1,${'A'.repeat(43)}=` }), () => {});
        expect(forged.status).toBe(401);
    });

    it('leaves the id unstored when the handler throws, so a retry runs it', async () => {
        const seen = new MemorySeenStore();
        const receive = receiver({ secrets: [SECRET], seen, now: NOW });
        const failed = await receive(request(HEADERS), () => {
            throw new Error('database down');
        });
        expect(failed.status).toBe(500);
        expect(seen.has(ID)).toBe(false);
        let runs = 0;
        expect((await receive(request(HEADERS), () => void runs++)).status).toBe(204);
        expect(runs).toBe(1);
    });

    it('takes any store, async included, with the 7-day TTL', async () => {
        const stored = new Map<string, number>();
        const seen = {
            has: async (id: string) => stored.has(id),
            add: async (id: string, ttl: number) => void stored.set(id, ttl),
        };
        const receive = receiver({ secrets: [SECRET], seen, now: NOW });
        expect((await receive(request(HEADERS), () => {})).status).toBe(204);
        expect(stored.get(ID)).toBe(7 * 24 * 60 * 60);
        expect((await receive(request(HEADERS), () => {})).status).toBe(200);
    });

    it('answers 413 for a streamed oversized body even with an unread clone kept', async () => {
        const receive = receiver({ secrets: [SECRET], seen: new MemorySeenStore(), now: NOW, maxBodyBytes: 800 });
        const chunk = bytes('x'.repeat(500));
        let sent = 0;
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (sent++ < 4) {
                    controller.enqueue(chunk);
                } else {
                    controller.close();
                }
            },
        });
        const original = new Request('https://lab.example/webhooks/forms', {
            method: 'POST',
            headers: HEADERS,
            body: stream,
            duplex: 'half',
        } as RequestInit);
        const kept = original.clone(); // e.g. middleware logging it later
        const response = await receive(original, () => {});
        expect(response.status).toBe(413);
        expect(kept.bodyUsed).toBe(false);
    });

    it('refuses other methods, large bodies and signed bodies that are not JSON', async () => {
        const receive = receiver({ secrets: [SECRET], seen: new MemorySeenStore(), now: NOW, maxBodyBytes: 800 });
        const get = new Request('https://lab.example/webhooks/forms', { headers: HEADERS });
        expect((await receive(get, () => {})).status).toBe(405);
        expect((await receive(request(HEADERS, `${BODY}${' '.repeat(100)}`), () => {})).status).toBe(413);
        const text = 'not json';
        const signed = await sign({ id: 'msg_text', timestamp: TS, body: text }, [SECRET]);
        expect((await receive(request({ ...signed }, text), () => {})).status).toBe(400);
    });
});

describe('MemorySeenStore', () => {
    it('forgets an id after its TTL and keeps at most maxEntries', () => {
        let now = 0;
        const store = new MemorySeenStore({ now: () => now, maxEntries: 2 });
        store.add('a', 10);
        expect(store.has('a')).toBe(true);
        now = 10_000;
        expect(store.has('a')).toBe(false);
        store.add('b', 10);
        store.add('c', 10);
        store.add('d', 10);
        expect([store.has('b'), store.has('c'), store.has('d')]).toEqual([false, true, true]);
    });
});

describe('the entry point stays portable', () => {
    it('imports nothing and uses no Node-only API', () => {
        const source = readFileSync(new URL('../packages/app-sdk/src/webhooks.ts', import.meta.url), 'utf8');
        const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
        expect(code).not.toMatch(/\bimport\b|\brequire\s*\(/);
        expect(code).not.toMatch(/\bBuffer\b|\bprocess\b|node:/);
    });

    it('is exported as @socio/app-sdk/webhooks', () => {
        const pkg = JSON.parse(readFileSync(new URL('../packages/app-sdk/package.json', import.meta.url), 'utf8'));
        expect(pkg.exports['./webhooks']).toBe('./src/webhooks.ts');
    });
});
