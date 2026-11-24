import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    ATTACHMENTS_PROTECTION,
    type FileProtectionLevel,
    IMAGES_PROTECTION,
    prepareAttachmentsFolder,
    prepareImagesFolder,
    prepareWorkspaceFolders,
    workspaceLayout,
} from '../../src/data';
import { createNodeFileSystem } from '../helpers/node-fs';

// The protection classes of a workspace's plain-file folders
// (src/data/workspace-files.ts), on a real temporary
// directory with a recording setFileProtection in place of socio-device's.

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

function setup() {
    const root = mkdtempSync(join(tmpdir(), 'socio-files-'));
    roots.push(root);
    const layout = workspaceLayout(root, 'ab'.repeat(32));
    const calls: [string, FileProtectionLevel, boolean][] = [];
    const deps = {
        fs: createNodeFileSystem(),
        // Records whether the folder already existed when its class was set.
        setFileProtection: async (path: string, level: FileProtectionLevel) => {
            calls.push([path, level, existsSync(path) && statSync(path).isDirectory()]);
        },
    };
    return { layout, calls, deps };
}

describe('the workspace folders’ protection', () => {
    it('locks images with the phone and keeps attachments at the keys’ unlock level', () => {
        expect(IMAGES_PROTECTION).toBe('complete');
        expect(ATTACHMENTS_PROTECTION).toBe('completeUntilFirstUserAuthentication');
    });

    it('makes each folder, then gives it its class', async () => {
        const { layout, calls, deps } = setup();
        await prepareWorkspaceFolders(deps, layout);
        expect(calls).toEqual([
            [layout.images, 'complete', true],
            [layout.attachments, 'completeUntilFirstUserAuthentication', true],
        ]);
    });

    it('sets the class again on a folder that exists, and keeps what is in it', async () => {
        const { layout, calls, deps } = setup();
        await prepareAttachmentsFolder(deps, layout);
        const picked = join(layout.attachments, 'picked.jpg');
        writeFileSync(picked, 'bytes');
        await prepareAttachmentsFolder(deps, layout);
        expect(existsSync(picked)).toBe(true);
        expect(calls.map(([, level]) => level)).toEqual([ATTACHMENTS_PROTECTION, ATTACHMENTS_PROTECTION]);
    });

    it('makes images/ again after Clear cache deleted it', async () => {
        const { layout, calls, deps } = setup();
        await prepareImagesFolder(deps, layout);
        rmSync(layout.images, { recursive: true });
        await prepareImagesFolder(deps, layout);
        expect(existsSync(layout.images)).toBe(true);
        expect(calls).toEqual([
            [layout.images, 'complete', true],
            [layout.images, 'complete', true],
        ]);
    });

    it('fails when the class can’t be set', async () => {
        const { layout, deps } = setup();
        const failing = { ...deps, setFileProtection: async () => Promise.reject(new Error('No file or directory')) };
        await expect(prepareImagesFolder(failing, layout)).rejects.toThrow('No file or directory');
    });
});
