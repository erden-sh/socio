import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
    type BuildInfo,
    buildChange,
    buildCopyText,
    buildNoticeText,
    createBuildNotice,
    installedBuildNumber,
    type LastBuildStore,
    noticeClockRuns,
    originLine,
    parseBuildNumber,
    readBuildInfo,
    versionLine,
} from '../../src/shell/build-info';

// Which build is installed and whether it changed since the app last ran (src/shell/build-info.ts).

const PREVIEW: BuildInfo = {
    version: '0.1.0',
    build: 2829,
    variant: 'preview',
    commit: 'be466eab8',
    date: '2026-11-09',
};

/** The registry's lastBuild and setLastBuild, in memory. */
function memoryStore(initial: number | null): LastBuildStore & { kept: () => number | null } {
    let last = initial;
    return {
        lastBuild: async () => last,
        setLastBuild: async (build) => {
            last = build;
        },
        kept: () => last,
    };
}

describe("Settings' footer", () => {
    it('says the version, the build and the variant, ChatGPT’s way', () => {
        expect(versionLine(PREVIEW)).toBe('Version 0.1.0 (2829) · Preview');
        expect(versionLine({ ...PREVIEW, variant: 'development', build: 1 })).toBe('Version 0.1.0 (1) · Development');
        expect(versionLine({ ...PREVIEW, variant: 'production' })).toBe('Version 0.1.0 (2829)');
        expect(versionLine({ ...PREVIEW, build: null })).toBe('Version 0.1.0 · Preview');
    });

    it('says the commit and the date when the build has them', () => {
        expect(originLine(PREVIEW)).toBe('Commit be466ea · Built Nov 9, 2026');
        expect(originLine({ ...PREVIEW, date: '2026-01-31T23:30:00-05:00' })).toBe(
            'Commit be466ea · Built Jan 31, 2026',
        );
        expect(originLine({ ...PREVIEW, commit: null })).toBe('Built Nov 9, 2026');
        expect(originLine({ ...PREVIEW, commit: null, date: null })).toBeNull();
    });

    it('copies both lines with the whole commit', () => {
        expect(buildCopyText(PREVIEW)).toBe('Version 0.1.0 (2829) · Preview · commit be466eab8 · built 2026-11-09');
        expect(buildCopyText({ ...PREVIEW, commit: null, date: null })).toBe('Version 0.1.0 (2829) · Preview');
    });
});

describe('the installed build', () => {
    const embedded = {
        version: '0.0.9',
        ios: { buildNumber: '7' },
        android: { versionCode: 8 },
        extra: { variant: 'preview', buildCommit: 'be466eab8', buildDate: '2026-11-09' },
    };

    it('comes from the binary first, the commit and date from the embedded config', () => {
        expect(readBuildInfo({ version: '0.1.0', build: '2829' }, embedded, 'preview', 'ios')).toEqual(PREVIEW);
    });

    it('falls back to the embedded config when the binary can’t say', () => {
        expect(readBuildInfo(null, embedded, 'preview', 'ios')).toMatchObject({ version: '0.0.9', build: 7 });
        expect(readBuildInfo({ version: '', build: '' }, embedded, 'preview', 'android')).toMatchObject({
            version: '0.0.9',
            build: 8,
        });
        expect(readBuildInfo(null, null, 'production', 'ios')).toEqual({
            version: '0.0.0',
            build: null,
            variant: 'production',
            commit: null,
            date: null,
        });
    });

    it('compares only the binary’s own number, never the embedded config’s', () => {
        expect(installedBuildNumber({ build: '2829' })).toBe(2829);
        // A development client without appBuild: its config is Metro's, so no number and no notice.
        expect(installedBuildNumber(null)).toBeNull();
        expect(installedBuildNumber({ build: '' })).toBeNull();
    });

    it('reads only a positive whole build number', () => {
        expect(parseBuildNumber('2829')).toBe(2829);
        expect(parseBuildNumber(2829)).toBe(2829);
        for (const value of ['', '0', '1.2', 'abc', '-1', null, undefined, '99999999999999999999']) {
            expect(parseBuildNumber(value), String(value)).toBeNull();
        }
    });
});

describe('the build notice', () => {
    it('runs its 15 s only while the app is in front', () => {
        expect(noticeClockRuns('active')).toBe(true);
        expect(noticeClockRuns('unknown')).toBe(true);
        expect(noticeClockRuns('inactive')).toBe(false);
        expect(noticeClockRuns('background')).toBe(false);
    });

    it('decides none, first run, higher or lower', () => {
        expect(buildChange(2829, 2829)).toEqual({ kind: 'none' });
        expect(buildChange(null, 2829)).toEqual({ kind: 'first-run', build: 2829 });
        expect(buildChange(2790, 2829)).toEqual({ kind: 'higher', build: 2829, was: 2790 });
        expect(buildChange(2829, 2790)).toEqual({ kind: 'lower', build: 2790, was: 2829 });
    });

    it('words a change, and nothing else', () => {
        expect(buildNoticeText(buildChange(2790, 2829))).toBe('Updated to build 2829 (was 2790)');
        expect(buildNoticeText(buildChange(2829, 2790))).toBe('Older build installed: 2790 (was 2829)');
        expect(buildNoticeText(buildChange(null, 2829))).toBeNull();
        expect(buildNoticeText(buildChange(2829, 2829))).toBeNull();
    });

    it('says nothing on the first run, and keeps the number', async () => {
        const store = memoryStore(null);
        const notice = createBuildNotice();
        await notice.check(store, 2828);
        expect(notice.get()).toBeNull();
        expect(store.kept()).toBe(2828);
    });

    it('shows a higher build once, kept before it shows, until dismissed', async () => {
        const store = memoryStore(2828);
        const notice = createBuildNotice();
        const listener = vi.fn();
        notice.subscribe(listener);
        await notice.check(store, 2829);
        expect(notice.get()).toEqual({ kind: 'higher', text: 'Updated to build 2829 (was 2828)' });
        expect(store.kept()).toBe(2829);
        expect(listener).toHaveBeenCalledTimes(1);
        // The same process checks once (a launch's Try again), and dismissing clears it.
        await notice.check(store, 2829);
        notice.dismiss();
        expect(notice.get()).toBeNull();

        // The next launch of the same build: nothing.
        const next = createBuildNotice();
        await next.check(store, 2829);
        expect(next.get()).toBeNull();
    });

    it('shows a lower build as an older one', async () => {
        const store = memoryStore(2829);
        const notice = createBuildNotice();
        await notice.check(store, 2790);
        expect(notice.get()).toEqual({ kind: 'lower', text: 'Older build installed: 2790 (was 2829)' });
        expect(store.kept()).toBe(2790);
    });

    it('never throws: a store that fails shows nothing and tells onError', async () => {
        const onError = vi.fn();
        const notice = createBuildNotice(onError);
        const failing: LastBuildStore = {
            lastBuild: async () => {
                throw new Error('read-only');
            },
            setLastBuild: async () => {},
        };
        await expect(notice.check(failing, 2829)).resolves.toBeUndefined();
        expect(notice.get()).toBeNull();
        expect(onError).toHaveBeenCalledTimes(1);
    });

    it('does nothing when the build number can’t be read', async () => {
        const store = memoryStore(2828);
        const notice = createBuildNotice();
        await notice.check(store, null);
        expect(notice.get()).toBeNull();
        expect(store.kept()).toBe(2828);
    });
});

describe('the launch check', () => {
    // src/platform/device-store.ts runs React Native, so its wiring is read as source: the check
    // starts once the registry and its settings are loaded, before the root gate, and is never awaited.
    const source = readFileSync(join(import.meta.dirname, '../../src/platform/device-store.ts'), 'utf8');
    const lines = source.split('\n');
    const at = (pattern: RegExp) => lines.findIndex((line) => pattern.test(line));

    it('is started unawaited, after the registry opens and before the first frame waits on anything else', () => {
        const check = at(/buildNotice\.check\(/);
        expect(check).toBeGreaterThan(-1);
        expect(lines[check]?.trim()).toBe('void buildNotice.check(launched.opened.store.registry, INSTALLED_BUILD);');
        expect(source.match(/buildNotice\.check\(/g)).toHaveLength(1);
        expect(source).not.toMatch(/await\s+buildNotice/);
        expect(at(/await deviceSettings\.load\(launched\.opened\.store\.registry\)/)).toBeLessThan(check);
        expect(at(/openDeviceStore\(deviceDeps\(\)\)/)).toBeLessThan(check);
        expect(at(/await followRootGate\(/)).toBeGreaterThan(check);
        expect(at(/settle\(\{ kind: 'open', launched \}\)/)).toBeGreaterThan(check);
    });
});
