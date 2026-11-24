import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { sha256BytesHex } from '../../src/platform/crypto';

// An issue file's SHA-256 as the server records it: lowercase hex of
// the bytes (`createHash('sha256').update(data).digest('hex')`), from
// expo-crypto's digest, here node's.

vi.mock('expo-crypto', () => ({
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    digest: async (_algorithm: string, data: Uint8Array) => {
        const hash = createHash('sha256').update(data).digest();
        return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength);
    },
    digestStringAsync: vi.fn(),
    randomUUID: vi.fn(),
}));

describe('sha256BytesHex', () => {
    it('gives the server’s hex for the same bytes', async () => {
        const bytes = new Uint8Array([0, 1, 2, 250, 255]);
        expect(await sha256BytesHex(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
    });
});
