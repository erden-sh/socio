import { describe, expect, it, vi } from 'vitest';

import type { FileSystem } from '../../src/data/layout';
import { createAttachmentFiles, type ExpoFileClass } from '../../src/platform/attachment-files';

// The attachments' file operations on expo-file-system (src/platform/
// attachment-files.ts): a copy from the picker's file into the
// workspace's, and the copy itself (a Blob) as the upload's body.

vi.mock('expo-file-system', () => ({ Paths: {}, Directory: class {}, File: class {} }));
vi.mock('expo-file-system/legacy', () => ({ readDirectoryAsync: vi.fn() }));
vi.mock('expo-crypto', () => ({ CryptoDigestAlgorithm: { SHA256: 'SHA-256' }, digest: vi.fn(), randomUUID: vi.fn() }));

describe('createAttachmentFiles', () => {
    it('copies File to File by file:// URI and hands the copy over as the body', async () => {
        const log: string[] = [];
        class FakeFile extends Blob {
            readonly uri: string;
            constructor(uri: string) {
                super(['bytes']);
                this.uri = uri;
            }
            async copy(destination: unknown) {
                log.push(`copy ${this.uri} -> ${(destination as FakeFile).uri}`);
            }
        }
        const fs = { list: vi.fn(), remove: vi.fn(), mkdir: vi.fn(), exists: vi.fn() } as unknown as FileSystem;
        const files = createAttachmentFiles(fs, FakeFile as unknown as ExpoFileClass);

        await files.copy('file:///cache/picked.jpg', '/data/socio/ab/attachments/f1.jpg');
        expect(log).toEqual(['copy file:///cache/picked.jpg -> file:///data/socio/ab/attachments/f1.jpg']);
        const body = await files.body('/data/socio/ab/attachments/f1.jpg');
        expect(body).toBeInstanceOf(Blob);
        expect((body as unknown as FakeFile).uri).toBe('file:///data/socio/ab/attachments/f1.jpg');
        expect(files.remove).toBe(fs.remove);
    });

    it('reads an issue file as base64 and hashes its bytes', async () => {
        class FakeFile extends Blob {
            readonly uri: string;
            constructor(uri: string) {
                super(['bytes']);
                this.uri = uri;
            }
            async copy() {}
            async base64() {
                return `b64:${this.uri}`;
            }
            async bytes() {
                return new Uint8Array([1, 2, 3]);
            }
        }
        const fs = { list: vi.fn(), remove: vi.fn(), mkdir: vi.fn(), exists: vi.fn() } as unknown as FileSystem;
        const hashed: number[][] = [];
        const files = createAttachmentFiles(fs, FakeFile as unknown as ExpoFileClass, async (bytes) => {
            hashed.push([...bytes]);
            return 'ab'.repeat(32);
        });
        expect(await files.base64!('/data/socio/ab/attachments/f1.png')).toBe(
            'b64:file:///data/socio/ab/attachments/f1.png',
        );
        expect(await files.sha256!('/data/socio/ab/attachments/f1.png')).toBe('ab'.repeat(32));
        expect(hashed).toEqual([[1, 2, 3]]);
    });
});
