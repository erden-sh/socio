import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseServerBuild, SERVER_RELEASES_PATH, serverVersionLine } from '../../src/shell/server-version';

// The server's version at the foot of Settings (CB-501, src/shell/server-version.ts).

const SRC = join(import.meta.dirname, '../../src');
const read = (path: string) => readFileSync(join(SRC, path), 'utf8');

describe('the server line', () => {
    it('says the version, as the web says it, with the commit read for that version', () => {
        expect(serverVersionLine('0.51.0', { version: '0.51.0', commit: 'f1b3465abcdef' }, false)).toBe(
            'Server: Socio v0.51.0 (f1b3465)',
        );
        expect(serverVersionLine('0.51.0', null, false)).toBe('Server: Socio v0.51.0');
        expect(serverVersionLine('0.51.0', { version: '0.51.0', commit: null }, false)).toBe('Server: Socio v0.51.0');
    });

    it("never pairs a version with another build's commit", () => {
        expect(serverVersionLine('0.52.0', { version: '0.51.0', commit: 'f1b3465' }, false)).toBe(
            'Server: Socio v0.52.0',
        );
    });

    it('shows nothing until a version is known, nor for a server that reads none', () => {
        expect(serverVersionLine(null, null, false)).toBeNull();
        expect(serverVersionLine(null, { version: '0.51.0', commit: 'f1b3465' }, true)).toBeNull();
        expect(serverVersionLine('0.0.0', null, false)).toBeNull();
        expect(serverVersionLine('not a version', null, false)).toBeNull();
    });

    it('marks the last version known while the server is away', () => {
        expect(serverVersionLine('0.51.0', { version: '0.51.0', commit: 'f1b3465' }, true)).toBe(
            'Server: Socio v0.51.0 (f1b3465) · last known',
        );
    });
});

describe("the releases answer's reading", () => {
    it('takes the running version and commit', () => {
        expect(parseServerBuild({ current: '0.51.0', commit: 'f1b3465', releases: [] })).toEqual({
            version: '0.51.0',
            commit: 'f1b3465',
        });
        expect(parseServerBuild({ current: '0.51.0', commit: null, releases: [] })).toEqual({
            version: '0.51.0',
            commit: null,
        });
        expect(parseServerBuild({ current: '0.51.0', commit: '  ' })).toEqual({ version: '0.51.0', commit: null });
    });

    it('refuses what it cannot read', () => {
        expect(parseServerBuild(null)).toBeNull();
        expect(parseServerBuild('0.51.0')).toBeNull();
        expect(parseServerBuild({ current: 51 })).toBeNull();
        expect(parseServerBuild({ error: 'Unauthorized' })).toBeNull();
    });

    it("asks the web footer's path, the version alone", () => {
        expect(SERVER_RELEASES_PATH).toBe('/api/releases?limit=0');
    });
});

describe("Settings' footer", () => {
    const settings = read('screens/settings.tsx');

    it("shows the server's line under the app's, only while a workspace is open", () => {
        expect(settings).toMatch(/\{open \? <WorkspaceBuildFooter \/> : <BuildFooter server=\{null\} \/>\}/);
        expect(settings).toMatch(/testID="settings-build-origin"[\s\S]*testID="settings-build-server"/);
    });

    it('reads the version from the scope, the commit from the releases answer, and marks it while away', () => {
        expect(settings).toMatch(/useSyncExternalStore\(scope\.versions\.subscribe, scope\.versions\.highest\)/);
        expect(settings).toMatch(/\.fetch\(SERVER_RELEASES_PATH\)/);
        expect(settings).toMatch(/serverVersionLine\(version, build, reconnecting\)/);
        // Read again when the version moves and when the server is back.
        expect(settings).toMatch(/\[scope, version, reconnecting\]/);
    });
});
