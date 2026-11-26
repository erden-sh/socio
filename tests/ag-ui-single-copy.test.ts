// One copy of each AG-UI 1.0.5 package in the lockfile (scripts/pnpm-hooks.cjs).
// A resolution without the hook (a bare `pnpm add` or `pnpm install` that had
// something to resolve) brings back a second copy beside CopilotKit's zod 3,
// and CopilotKit then stops recognizing Socio's agents. Rerun `pnpm deps`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const lockfile = readFileSync(join(import.meta.dirname, '..', 'pnpm-lock.yaml'), 'utf8');
const version = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).dependencies[
    '@ag-ui/client'
] as string;

describe('the AG-UI install', () => {
    it.each(['client', 'core', 'encoder', 'proto'])('has one @ag-ui/%s at the root version', (name) => {
        const snapshots = [...lockfile.matchAll(new RegExp(`^  '@ag-ui/${name}@${version}([^']*)':$`, 'gm'))];
        // Once under packages: and once under snapshots:, with no peer suffix.
        expect(snapshots.map((match) => match[1])).toEqual(['', '']);
    });

    it('keeps no pnpmfileChecksum, which the --ignore-pnpmfile install in CI refuses', () => {
        expect(lockfile).not.toMatch(/^pnpmfileChecksum:/m);
    });
});
