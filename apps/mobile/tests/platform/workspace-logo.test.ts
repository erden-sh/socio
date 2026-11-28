import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { workspaceLayout } from '../../src/data/layout';
import { workspaceLogoPath } from '../../src/shell/workspaces';

// The binding Home's workspace button reads (CB-574, platform/workspace-logo.ts),
// with the store, files, fetch and hash it binds replaced by Node's: a workspace
// that goes back to the default logo draws the mascot (null), never the file it
// had, which is deleted.

const ID = 'b'.repeat(64);
const ORIGIN = 'https://brain.example.test';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 7]);
const CUSTOM = `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`;
const NAME = `logo-${createHash('sha256').update(PNG).digest('hex').slice(0, 16)}.png`;

const platform = vi.hoisted(() => ({
    root: '',
    launched: null as unknown,
    row: { id: '', state: 'ready', logo: null as string | null },
}));

vi.mock('../../src/platform/device-store', () => ({ launchedStore: () => platform.launched }));
vi.mock('../../src/platform/crypto', () => ({
    sha256BytesHex: async (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
}));
vi.mock('../../src/platform/add-workspace', async () => {
    const { createPublicFetch } = await import('../../src/net');
    const { createNodeFileSystem: nodeFs } = await import('../helpers/node-fs');
    const { fakeFetch: fetch } = await import('../net/helpers');
    const fs = nodeFs();
    return {
        publicFetch: createPublicFetch({ fetch: fetch(), userAgent: 'Socio/0.0.0 (test)' }),
        logoFiles: () => ({
            mkdir: fs.mkdir,
            remove: fs.remove,
            write: (path: string, bytes: Uint8Array) => writeFile(path, bytes),
            move: (from: string, to: string) => rename(from, to),
        }),
    };
});

beforeEach(async () => {
    vi.resetModules();
    platform.root = await mkdtemp(join(tmpdir(), 'socio-workspace-logo-'));
    await mkdir(workspaceLayout(platform.root, ID).directory, { recursive: true });
    platform.row = { id: ID, state: 'ready', logo: null };
    platform.launched = {
        opened: {
            store: {
                root: platform.root,
                registry: {
                    get: async (id: string) => (id === ID ? { ...platform.row } : null),
                    setLogo: async (id: string, logo: string | null) => {
                        if (id === ID) {
                            platform.row.logo = logo;
                        }
                    },
                },
            },
        },
    };
});

afterEach(async () => {
    await rm(platform.root, { recursive: true, force: true });
});

/** A scope opening on the workspace, its snapshot the registry's row now. */
const open = (n: number) => ({
    id: `${ID}#${n}`,
    workspace: { id: ID, origin: ORIGIN, logo: platform.row.logo },
    signal: new AbortController().signal,
});

/** What useWorkspaceLogoPath gives Home: the binding's name, as a path in the workspace's folder. */
const homePath = async (scope: ReturnType<typeof open>) => {
    const { keptLogos } = await import('../../src/platform/workspace-logo');
    return workspaceLogoPath(platform.root, ID, keptLogos.current(scope));
};

describe('platform/workspace-logo.ts (CB-574)', () => {
    it('opened with a custom logo, then switched to the default: Home draws the mascot, not the old file', async () => {
        const { refreshWorkspaceLogo } = await import('../../src/platform/workspace-logo');
        await refreshWorkspaceLogo(open(0), CUSTOM);
        expect(platform.row.logo).toBe(NAME);

        // The scope opens with the custom logo, then the workspace goes back to the default.
        const scope = open(1);
        expect(scope.workspace.logo).toBe(NAME);
        const before = await homePath(scope);
        expect(before).toBe(join(workspaceLayout(platform.root, ID).directory, NAME));
        expect(existsSync(before!)).toBe(true);

        await refreshWorkspaceLogo(scope, '/favicon.svg');
        expect(platform.row.logo).toBeNull();
        expect(existsSync(before!)).toBe(false);
        expect(await homePath(scope)).toBeNull();
    });

    it('draws the scope’s snapshot before the store has opened', async () => {
        platform.launched = null;
        const scope = { ...open(2), workspace: { id: ID, origin: ORIGIN, logo: 'logo.png' } };
        const { keptLogos } = await import('../../src/platform/workspace-logo');
        expect(keptLogos.current(scope)).toBe('logo.png');
    });
});
