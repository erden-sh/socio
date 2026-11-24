import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
    formatPushRevocation,
    isPushRevocationKey,
    isRevocationKey,
    parsePushRevocation,
    pushRevocationName,
} from '../../src/data';
import { base64url } from '../../src/sync/presence';

// The push revocation record's name and form (src/data/push-revocation.ts).

describe('pushRevocationName', () => {
    it('is the registration id’s 16 bytes in hex, which no older build’s pattern matches', () => {
        for (let round = 0; round < 50; round += 1) {
            const bytes = new Uint8Array(randomBytes(16));
            const name = pushRevocationName(base64url(bytes));
            expect(name).toBe(`socio.revoke-push.${Buffer.from(bytes).toString('hex')}`);
            expect(isPushRevocationKey(name!)).toBe(true);
            expect(isRevocationKey(name!)).toBe(false);
        }
    });

    it('names no id PS doesn’t make', () => {
        for (const id of ['', 'short', 'a'.repeat(23), `${'a'.repeat(21)}=`, `${'a'.repeat(21)}/`]) {
            expect(pushRevocationName(id)).toBeNull();
        }
    });
});

describe('the record', () => {
    it('holds the id and secret alone, and reads back', () => {
        const text = formatPushRevocation({ id: 'reg', secret: 's3cret' });
        expect(JSON.parse(text)).toEqual({ v: 1, id: 'reg', secret: 's3cret' });
        expect(parsePushRevocation(text)).toEqual({ id: 'reg', secret: 's3cret' });
    });

    it('keeps the relay origin the registration was made at', () => {
        const text = formatPushRevocation({ id: 'reg', secret: 's3cret', origin: 'https://relay.example.test' });
        expect(JSON.parse(text)).toEqual({ v: 1, id: 'reg', secret: 's3cret', origin: 'https://relay.example.test' });
        expect(parsePushRevocation(text)).toEqual({
            id: 'reg',
            secret: 's3cret',
            origin: 'https://relay.example.test',
        });
    });

    it.each([
        null,
        '',
        'not json',
        '[]',
        '{"id":"reg"}',
        '{"id":"","secret":"x"}',
        '{"id":1,"secret":"x"}',
        '{"id":"reg","secret":"x","origin":"https://relay.example.test/v1"}',
        '{"id":"reg","secret":"x","origin":"ftp://relay.example.test"}',
        '{"id":"reg","secret":"x","origin":5}',
    ])('reads nothing from %j', (text) => {
        expect(parsePushRevocation(text)).toBeNull();
    });
});
