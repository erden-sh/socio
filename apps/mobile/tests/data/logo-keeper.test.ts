import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { workspaceLayout } from '../../src/data/layout';
import type { LogoFiles } from '../../src/data/logo';
import { createLogoKeeper, type LogoScope } from '../../src/data/logo-keeper';
import { createPublicFetch } from '../../src/net';
import { createNodeFileSystem } from '../helpers/node-fs';
import { fakeFetch } from '../net/helpers';

// The open workspace's logo kept current across scopes (CB-574): a refresh in
// one scope, a switch away and back, then another refresh, and Home always
// draws the newest logo, from a file that exists.

const ORIGIN = 'https://brain.example.test';
const ID = 'a'.repeat(64);
const png = (tail: number) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, tail]);
const dataUrl = (bytes: Uint8Array) => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
const named = (bytes: Uint8Array) => `logo-${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.png`;

let root: string;
let directory: string;
let row: { state: string; logo: string | null };
let scopes = 0;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'socio-logo-keeper-'));
    directory = workspaceLayout(root, ID).directory;
    await mkdir(directory, { recursive: true });
    row = { state: 'ready', logo: null };
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

function keeper() {
    const fs = createNodeFileSystem();
    const files: LogoFiles = {
        mkdir: fs.mkdir,
        remove: fs.remove,
        write: (path, bytes) => writeFile(path, bytes),
        move: (from, to) => rename(from, to),
    };
    return createLogoKeeper({
        root,
        // The registry's row for the one workspace: what a new scope snapshots.
        registry: {
            get: async (id) => (id === ID ? ({ ...row, id } as never) : null),
            setLogo: async (id, logo) => {
                if (id === ID) {
                    row.logo = logo;
                }
            },
        },
        files,
        publicFetch: createPublicFetch({ fetch: fakeFetch(), userAgent: 'Socio/0.0.0 (test)' }),
        hash: async (bytes) => createHash('sha256').update(bytes).digest('hex'),
    });
}

/** A scope opening on the workspace: a fresh id and the registry's row as it is now. */
function open(): LogoScope & { close: () => void } {
    const controller = new AbortController();
    scopes += 1;
    return {
        id: `${ID}#${scopes}`,
        workspace: { id: ID, origin: ORIGIN, logo: row.logo },
        signal: controller.signal,
        close: () => controller.abort(),
    };
}

/** What Home draws for `scope`: the file name and whether that file is on disk. */
const drawn = (kept: ReturnType<typeof keeper>, scope: LogoScope) => {
    const name = kept.current(scope);
    return { name, exists: name === null || existsSync(join(directory, name)) };
};

describe('the kept logo across scopes (CB-574)', () => {
    it('refresh A→B, switch away and back, refresh B→C: Home draws C, and C is on disk', async () => {
        const kept = keeper();
        const [A, B, C] = [png(1), png(2), png(3)];

        const first = open();
        await kept.refresh(first, dataUrl(A));
        expect(drawn(kept, first)).toEqual({ name: named(A), exists: true });
        await kept.refresh(first, dataUrl(B));
        expect(drawn(kept, first)).toEqual({ name: named(B), exists: true });

        // Switch away and back: the old scope closes, a new one snapshots B from the registry.
        first.close();
        const second = open();
        expect(second.workspace.logo).toBe(named(B));
        expect(drawn(kept, second)).toEqual({ name: named(B), exists: true });

        await kept.refresh(second, dataUrl(C));
        expect(drawn(kept, second)).toEqual({ name: named(C), exists: true });
        expect(await readdir(directory)).toEqual([named(C)]);
        expect(row.logo).toBe(named(C));
    });

    it('never points Home at a deleted file, even while a refresh replaces it', async () => {
        const kept = keeper();
        const scope = open();
        const seen: { name: string | null; exists: boolean }[] = [];
        kept.subscribe(() => seen.push(drawn(kept, scope)));
        for (const tail of [1, 2, 3]) {
            await kept.refresh(scope, dataUrl(png(tail)));
            seen.push(drawn(kept, scope));
        }
        await kept.refresh(scope, '/favicon.svg');
        seen.push(drawn(kept, scope));
        expect(seen.length).toBeGreaterThan(4);
        expect(seen.every((entry) => entry.exists)).toBe(true);
        expect(seen.at(-1)).toEqual({ name: null, exists: true });
        expect(await readdir(directory)).toEqual([]);
    });

    it('forgets a closed scope’s logo, so a new scope reads the registry instead', async () => {
        const kept = keeper();
        const first = open();
        await kept.refresh(first, dataUrl(png(1)));
        first.close();
        // Something else changed the registry's row (another refresh, a sign-in again).
        row.logo = null;
        const second = open();
        expect(kept.current(second)).toBeNull();
        // A refresh that comes after its scope closed writes nothing.
        await kept.refresh(first, dataUrl(png(2)));
        expect(row.logo).toBeNull();
    });
});
