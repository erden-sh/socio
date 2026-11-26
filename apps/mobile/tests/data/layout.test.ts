import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
    CACHE_DB,
    type Hasher,
    isWorkspaceId,
    registryFile,
    storeDirectory,
    USER_DB,
    workspaceId,
    workspaceLayout,
} from '../../src/data';
import { sha256 } from '../helpers/store';

// The store's layout:
// one directory per workspace and person, named by the hex SHA-256 of the full
// origin, a newline and the app user id, with the hasher injected.

const ORIGIN = 'https://brain.example.test';

describe('workspaceId', () => {
    it('is the hex SHA-256 of the origin, a newline and the app user id', async () => {
        const expected = createHash('sha256').update('https://brain.example.test\nu-1', 'utf8').digest('hex');
        expect(await workspaceId(sha256, ORIGIN, 'u-1')).toBe(expected);
        expect(isWorkspaceId(expected)).toBe(true);
    });

    it('is the same for the same workspace and person', async () => {
        expect(await workspaceId(sha256, ORIGIN, 'u-1')).toBe(await workspaceId(sha256, ORIGIN, 'u-1'));
    });

    it('differs by port: three local servers never share a directory', async () => {
        const ids = await Promise.all(
            ['http://localhost:4351', 'http://localhost:4352', 'http://localhost:4353'].map((origin) =>
                workspaceId(sha256, origin, 'u-1'),
            ),
        );
        expect(new Set(ids).size).toBe(3);
    });

    it('differs by person on the same workspace', async () => {
        expect(await workspaceId(sha256, ORIGIN, 'u-1')).not.toBe(await workspaceId(sha256, ORIGIN, 'u-2'));
    });

    it('differs by scheme and by host', async () => {
        const ids = await Promise.all(
            ['https://brain.example.test', 'http://brain.example.test', 'https://other.example.test'].map((origin) =>
                workspaceId(sha256, origin, 'u-1'),
            ),
        );
        expect(new Set(ids).size).toBe(3);
    });

    it('keeps the origin and the person out of the name', async () => {
        const id = await workspaceId(sha256, 'https://acme.example.test', 'ada');
        expect(id).toMatch(/^[0-9a-f]{64}$/);
        expect(id).not.toContain('acme');
        expect(id).not.toContain('ada');
    });

    it.each([
        ['a trailing slash', 'https://brain.example.test/'],
        ['a path', 'https://brain.example.test/app'],
        ['uppercase', 'https://Brain.example.test'],
        ['the default port written out', 'https://brain.example.test:443'],
        ['no scheme', 'brain.example.test'],
        ['another scheme', 'socio://brain.example.test'],
        ['userinfo', 'https://ada@brain.example.test'],
        ['nothing', ''],
    ])('refuses an origin with %s, rather than normalizing it', async (_, origin) => {
        await expect(workspaceId(sha256, origin, 'u-1')).rejects.toThrow(TypeError);
    });

    it('refuses an empty app user id', async () => {
        await expect(workspaceId(sha256, ORIGIN, '')).rejects.toThrow(TypeError);
    });

    it('refuses a hasher that doesn’t give 64 lowercase hex characters', async () => {
        const base64: Hasher = async (text) => createHash('sha256').update(text).digest('base64');
        const upper: Hasher = async (text) => (await sha256(text)).toUpperCase();
        await expect(workspaceId(base64, ORIGIN, 'u-1')).rejects.toThrow(/64 lowercase hex/);
        await expect(workspaceId(upper, ORIGIN, 'u-1')).rejects.toThrow(/64 lowercase hex/);
    });
});

describe('the paths', () => {
    const id = 'ab'.repeat(32);

    it('puts each workspace in socio/<id>/ under the root, with its files and folders', () => {
        expect(workspaceLayout('/data/files', id)).toEqual({
            id,
            directory: `/data/files/socio/${id}`,
            cache: { directory: `/data/files/socio/${id}`, name: CACHE_DB },
            user: { directory: `/data/files/socio/${id}`, name: USER_DB },
            images: `/data/files/socio/${id}/images`,
            attachments: `/data/files/socio/${id}/attachments`,
            files: `/data/files/socio/${id}/files`,
        });
    });

    it('puts the registry in socio/, beside the workspace directories', () => {
        expect(storeDirectory('/data/files')).toBe('/data/files/socio');
        expect(registryFile('/data/files')).toEqual({ directory: '/data/files/socio', name: 'registry.db' });
    });

    it('takes a file:// root with or without a trailing slash', () => {
        expect(workspaceLayout('file:///var/mobile/Documents/', id).directory).toBe(
            `file:///var/mobile/Documents/socio/${id}`,
        );
        expect(storeDirectory('file:///var/mobile/Documents')).toBe('file:///var/mobile/Documents/socio');
    });

    it('refuses an id that isn’t one', () => {
        expect(() => workspaceLayout('/data/files', '../registry.db')).toThrow(TypeError);
        expect(() => workspaceLayout('/data/files', id.toUpperCase())).toThrow(TypeError);
    });
});
