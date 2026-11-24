import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MAX_RELEASE_VERSION } from '@socio/shared/updates/release-seen';

import { openRegistry, workspaceId } from '../../src/data';
import {
    createServerVersions,
    gateVerdict,
    MINIMUM_SERVER_VERSION,
    NO_SERVER_VERSIONS,
    ROLLBACK_MS,
    type ServerVersionState,
    serverVersionState,
    UNKNOWN_SERVER_VERSION,
    type VersionChange,
} from '../../src/sync/versions';
import { createNodeSqliteDriver } from '../helpers/node-sqlite-driver';
import { sha256 } from '../helpers/store';
import { httpDate, MINUTE, ORIGIN, settle, T0 } from '../net/helpers';

import { stampOnDisk, syncSetup } from './helpers';

// The server's versions and the minimum-version gate, with an
// injected clock: a higher version is taken at once and makes every scope due
// one pull; a lower one counts only once it lasts over 6 minutes (a rollback,
// not a deploy's old build); the gate moves only when two answers in a row
// agree, and '0.0.0' passes only in the test builds.

const SECOND = 1000;
/** A workspace whose gate two answers already opened, so only the version rules move. */
const GATE_OPEN: ServerVersionState = { ...NO_SERVER_VERSIONS, versionGate: 'open' };
/**
 * How a load balancer shares the answers between a start-first deploy's two
 * builds: in runs of either, not in turns (the order the fake server's deploy
 * test uses too).
 */
const ROUTING = ['next', 'old', 'old', 'next', 'old', 'next', 'next', 'old', 'old', 'old', 'next'] as const;

function tracked(options: { variant?: string; initial?: ServerVersionState | null; failWrites?: boolean } = {}) {
    const clock = { now: T0 };
    const writes: ServerVersionState[] = [];
    const errors: unknown[] = [];
    let failing = options.failWrites ?? false;
    const versions = createServerVersions({
        variant: options.variant ?? 'production',
        initial: options.initial ?? null,
        now: () => clock.now,
        persist: async (state) => {
            if (failing) {
                throw new Error('disk full');
            }
            writes.push(state);
        },
        onError: (error) => errors.push(error),
    });
    const heard: VersionChange[] = [];
    versions.subscribe((change) => heard.push(change));
    return {
        versions,
        clock,
        writes,
        errors,
        heard,
        set failing(value: boolean) {
            failing = value;
        },
        /** One answer at `at` minutes after T0. */
        answer(version: string | null, at?: number) {
            if (at !== undefined) {
                clock.now = T0 + at * MINUTE;
            }
            return versions.observe(version);
        },
    };
}

describe('the minimum-version gate’s verdict', () => {
    it('passes 0.32.0 and later, by SemVer', () => {
        expect(MINIMUM_SERVER_VERSION).toBe('0.32.0');
        for (const version of ['0.32.0', '0.32.1', '0.33.0', '1.0.0', '0.32.0+build.5', '0.33.0-rc.1']) {
            expect(gateVerdict(version, 'production'), version).toBe('open');
        }
        for (const version of ['0.31.9', '0.32.0-rc.1', '0.1.0']) {
            expect(gateVerdict(version, 'production'), version).toBe('closed');
        }
    });

    it('doesn’t pass a missing or unreadable version, in any build', () => {
        for (const variant of ['development', 'preview', 'production']) {
            for (const version of [null, '', 'dev', 'v0.32.0', '0.32', '0.32.0.1', ' 0.32.0']) {
                expect(gateVerdict(version, variant), `${variant} ${String(version)}`).toBe('closed');
            }
        }
    });

    it('passes 0.0.0 only in development and preview builds', () => {
        expect(UNKNOWN_SERVER_VERSION).toBe('0.0.0');
        expect(gateVerdict('0.0.0', 'development')).toBe('open');
        expect(gateVerdict('0.0.0', 'preview')).toBe('open');
        expect(gateVerdict('0.0.0', 'production')).toBe('closed');
        // Any other value gets production's rule.
        for (const variant of ['', 'staging', 'Development', 'dev']) {
            expect(gateVerdict('0.0.0', variant), variant).toBe('closed');
        }
        // Only 0.0.0 itself: the test builds hold every other version to the minimum.
        expect(gateVerdict('0.0.1', 'development')).toBe('closed');
        expect(gateVerdict('0.31.0', 'preview')).toBe('closed');
    });

    it('opens on two 0.0.0 answers in development and preview, and closes on them in production', () => {
        for (const [variant, gate] of [
            ['development', 'open'],
            ['preview', 'open'],
            ['production', 'closed'],
        ] as const) {
            const t = tracked({ variant });
            t.answer('0.0.0', 0);
            expect(t.versions.gate()).toBeNull();
            t.answer('0.0.0', 0.25);
            expect(t.versions.gate(), variant).toBe(gate);
        }
    });
});

describe('the server version rules', () => {
    it('takes the first version, then a higher one at once, and asks for fresh pulls once each', async () => {
        const t = tracked({ initial: GATE_OPEN });
        expect(t.versions.highest()).toBeNull();
        expect(t.answer('0.32.0', 0).fresh).toBe(true);
        expect(t.answer('0.32.0', 0.25).fresh).toBe(false);
        expect(t.versions.highest()).toBe('0.32.0');
        expect(t.answer('0.33.0', 1).fresh).toBe(true);
        expect(t.versions.highest()).toBe('0.33.0');
        for (let at = 1.25; at < 10; at += 0.25) {
            expect(t.answer('0.33.0', at).fresh).toBe(false);
        }
        // Listeners hear after the answer, never during it.
        expect(t.heard.filter((change) => change.fresh)).toHaveLength(0);
        await settle();
        expect(t.heard.filter((change) => change.fresh)).toHaveLength(2);
    });

    it('ignores a lower version for 6 minutes, then takes it as a rollback, once', () => {
        const t = tracked({ initial: GATE_OPEN });
        t.answer('0.33.0', 0);
        expect(t.answer('0.32.0', 1)).toEqual({ fresh: false, gateMoved: false });
        expect(t.versions.state()).toMatchObject({
            serverVersion: '0.33.0',
            lowerVersion: '0.32.0',
            lowerSince: T0 + MINUTE,
        });
        for (let at = 1.25; at <= 7; at += 0.25) {
            expect(t.answer('0.32.0', at).fresh, `at ${at} min`).toBe(false);
            expect(t.versions.highest()).toBe('0.33.0');
        }
        // Exactly 6 minutes isn't more than 6.
        expect(T0 + 7 * MINUTE - (T0 + MINUTE)).toBe(ROLLBACK_MS);
        t.clock.now = T0 + 7 * MINUTE + 1;
        expect(t.versions.observe('0.32.0').fresh).toBe(true);
        expect(t.versions.state()).toMatchObject({ serverVersion: '0.32.0', lowerVersion: null, lowerSince: null });
        expect(t.answer('0.32.0', 8).fresh).toBe(false);
        // The fixed build coming back is a higher version again.
        expect(t.answer('0.33.0', 30).fresh).toBe(true);
    });

    it('rides out a start-first deploy: one fresh pull for the new build, and the old one never taken', async () => {
        const t = tracked({ initial: GATE_OPEN });
        t.answer('0.32.0', 0);
        await settle();
        t.heard.length = 0;
        // Both builds answer for 5.5 minutes, every 15 s, the old one in runs of up to 5 minutes 15 s.
        const start = 10;
        const answers: [number, string][] = [];
        for (let at = start; at < start + 1; at += 0.25) {
            answers.push([at, at % 0.5 === 0 ? '0.33.0' : '0.32.0']);
        }
        answers.push([start + 1, '0.33.0']);
        for (let at = start + 1.25; at < start + 5.5; at += 0.25) {
            answers.push([at, '0.32.0']);
        }
        for (let at = start + 5.5; at < start + 12; at += 0.25) {
            answers.push([at, '0.33.0']);
        }
        const fresh = answers.filter(([at, version]) => t.answer(version, at).fresh).map(([at]) => at);
        expect(fresh).toEqual([start]);
        expect(t.versions.highest()).toBe('0.33.0');
        expect(t.versions.state()).toMatchObject({ lowerVersion: null, lowerSince: null });
        await settle();
        expect(t.heard).toEqual([{ fresh: true, gateMoved: false }]);
    });

    it('starts the 6 minutes again after an answer at the highest version', () => {
        const t = tracked();
        t.answer('0.33.0', 0);
        t.answer('0.32.0', 1);
        t.answer('0.33.0', 5);
        expect(t.versions.state()).toMatchObject({ lowerVersion: null, lowerSince: null });
        t.answer('0.32.0', 8);
        expect(t.answer('0.32.0', 13).fresh).toBe(false);
        expect(t.answer('0.32.0', 14).fresh).toBe(false);
        expect(t.answer('0.32.0', 14.25).fresh).toBe(true);
        expect(t.versions.highest()).toBe('0.32.0');
    });

    it('takes the latest of the lower versions when they have lasted', () => {
        const t = tracked();
        t.answer('0.34.0', 0);
        t.answer('0.33.0', 1);
        t.answer('0.32.0', 4);
        expect(t.versions.state()).toMatchObject({ lowerVersion: '0.32.0', lowerSince: T0 + MINUTE });
        expect(t.answer('0.32.0', 7.25).fresh).toBe(true);
        expect(t.versions.highest()).toBe('0.32.0');
    });

    it('leaves the rules alone for an answer with no readable version', () => {
        const t = tracked();
        t.answer('0.33.0', 0);
        t.answer('0.32.0', 1);
        for (const version of [null, 'dev', '']) {
            expect(t.answer(version, 2).fresh).toBe(false);
        }
        expect(t.versions.state()).toMatchObject({
            serverVersion: '0.33.0',
            lowerVersion: '0.32.0',
            lowerSince: T0 + MINUTE,
            lastVersion: null,
        });
        expect(t.answer('0.32.0', 7.25).fresh).toBe(true);
    });

    it('starts the window again when the device clock goes back', () => {
        const t = tracked();
        t.answer('0.33.0', 0);
        t.answer('0.32.0', 60);
        t.answer('0.32.0', 30);
        expect(t.versions.state()).toMatchObject({ lowerSince: T0 + 30 * MINUTE });
        expect(t.answer('0.32.0', 36).fresh).toBe(false);
        expect(t.answer('0.32.0', 36.25).fresh).toBe(true);
    });

    it('measures the rollback window on the server’s clock, so a jump of the device clock counts for nothing', async () => {
        const t = tracked({ initial: GATE_OPEN });
        const answer = (version: string, device: number, server: number) => {
            t.clock.now = device;
            return t.versions.observe(version, httpDate(server));
        };
        answer('0.33.0', T0, T0);
        await settle();
        t.heard.length = 0;
        // The old build answers 15 s later, then the device clock jumps 10 minutes ahead (a manual change, or
        // NTP after a dead battery). The server's answers are still 15 s apart.
        expect(answer('0.32.0', T0 + 15 * SECOND, T0 + 15 * SECOND).fresh).toBe(false);
        expect(answer('0.32.0', T0 + 10 * MINUTE + 30 * SECOND, T0 + 30 * SECOND).fresh).toBe(false);
        expect(t.versions.state()).toMatchObject({ serverVersion: '0.33.0', lowerSince: T0 + 15 * SECOND });
        expect(answer('0.33.0', T0 + 10 * MINUTE + 45 * SECOND, T0 + 45 * SECOND).fresh).toBe(false);
        await settle();
        expect(t.heard).toEqual([]);
    });

    it('takes a lower version that still answers after a long gap: the deploy’s old build is long gone', () => {
        const t = tracked({ initial: GATE_OPEN });
        t.versions.observe('0.33.0', httpDate(T0));
        t.versions.observe('0.32.0', httpDate(T0 + MINUTE));
        // The app slept, or was killed and opened again, for an hour (the device clock agrees or not).
        t.clock.now = T0 - 3 * MINUTE;
        expect(t.versions.observe('0.32.0', httpDate(T0 + 61 * MINUTE)).fresh).toBe(true);
        expect(t.versions.highest()).toBe('0.32.0');
    });

    it('times an answer without a Date by the device clock and the offset the last Date gave', () => {
        // The device clock is an hour behind the server's.
        const behind = 60 * MINUTE;
        const t = tracked({ initial: GATE_OPEN });
        t.clock.now = T0 - behind;
        t.versions.observe('0.33.0', httpDate(T0));
        t.clock.now = T0 + MINUTE - behind;
        t.versions.observe('0.32.0', httpDate(T0 + MINUTE));
        t.clock.now = T0 + 7 * MINUTE - behind;
        expect(t.versions.observe('0.32.0', null).fresh).toBe(false);
        t.clock.now = T0 + 7 * MINUTE + SECOND - behind;
        expect(t.versions.observe('0.32.0').fresh).toBe(true);
    });

    it('takes a version over a stored highest it can’t read', () => {
        const t = tracked({ initial: { ...NO_SERVER_VERSIONS, serverVersion: 'garbage' } });
        expect(t.answer('0.32.0', 0).fresh).toBe(true);
        expect(t.versions.highest()).toBe('0.32.0');
    });
});

describe('the minimum-version gate', () => {
    it('stays undecided until two verdicts in a row agree, each the highest version’s', () => {
        const t = tracked();
        expect(t.versions.gate()).toBeNull();
        expect(t.answer('0.31.0', 0).gateMoved).toBe(false);
        expect(t.versions.state()).toMatchObject({ versionGate: null, versionGateVote: 'closed' });
        expect(t.answer('0.32.0', 0.25).gateMoved).toBe(false);
        expect(t.versions.state()).toMatchObject({ versionGate: null, versionGateVote: 'open' });
        // 0.31.0 again, but 0.32.0 is the highest: its verdict is the second 'open' in a row.
        expect(t.answer('0.31.0', 0.5).gateMoved).toBe(true);
        expect(t.versions.state()).toMatchObject({ versionGate: 'open', versionGateVote: null });
    });

    it('doesn’t flap while a too-old build and a new one answer in turn', async () => {
        const t = tracked();
        t.answer('0.32.0', 0);
        t.answer('0.32.0', 0.25);
        expect(t.versions.gate()).toBe('open');
        await settle();
        t.heard.length = 0;
        // A rollback to a build below the minimum, start-first: both answer in turn, for 5.5 minutes.
        let at = 1;
        for (let index = 0; index < 22; index += 1, at += 0.25) {
            expect(t.answer(index % 2 === 0 ? '0.31.0' : '0.32.0', at).gateMoved).toBe(false);
            expect(t.versions.gate()).toBe('open');
        }
        // Then only the old build. 0.32.0 last answered at 6.25: 0.31.0 lasts from 6.5, so it is taken at 12.75
        // and the next answer closes the gate.
        for (; at < 12.75; at += 0.25) {
            expect(t.answer('0.31.0', at).gateMoved, `at ${at}`).toBe(false);
        }
        expect(t.answer('0.31.0', at)).toEqual({ fresh: true, gateMoved: false });
        expect(t.answer('0.31.0', at + 0.25).gateMoved).toBe(true);
        expect(t.versions.gate()).toBe('closed');
        // An update, start-first as well: the second answer after its first opens the gate, whichever build gives
        // it, and the old build's later answers leave it open.
        at += 5;
        const gates = Array.from({ length: 22 }, (_, index) => {
            t.answer(index % 2 === 0 ? '0.32.1' : '0.31.0', at + index / 4);
            return t.versions.gate();
        });
        expect(gates).toEqual(['closed', ...Array<string>(21).fill('open')]);
        await settle();
        expect(t.heard.filter((change) => change.gateMoved)).toHaveLength(2);
    });

    it('moves once in a start-first deploy across the minimum, however the two builds take turns', async () => {
        // A workspace on 0.31.0, below the minimum, updates to 0.32.0.
        const t = tracked({ initial: { ...NO_SERVER_VERSIONS, serverVersion: '0.31.0', versionGate: 'closed' } });
        const builds = { old: '0.31.0', next: '0.32.0' };
        const gates = ROUTING.map((build, index) => {
            t.answer(builds[build], (index + 1) / 4);
            return t.versions.gate();
        });
        // The new build's answer and the next, whichever build gives it.
        expect(gates).toEqual(['closed', ...Array<string>(ROUTING.length - 1).fill('open')]);
        // The old build drains for the rest of the 5.5 minutes.
        for (let at = 3.25; at < 5.5; at += 0.25) {
            t.answer(at % 0.5 === 0 ? '0.31.0' : '0.32.0', at);
            expect(t.versions.gate()).toBe('open');
        }
        await settle();
        expect(t.heard.filter((change) => change.gateMoved)).toHaveLength(1);
        expect(t.heard.filter((change) => change.fresh)).toHaveLength(1);
    });

    it('closes once on a rollback below the minimum, after the lower version has lasted', async () => {
        const t = tracked({ initial: { ...NO_SERVER_VERSIONS, serverVersion: '0.32.0', versionGate: 'open' } });
        // The rollback is start-first too: 0.31.0 starts and 0.32.0 drains, answering in runs for 5.5 minutes.
        const builds = { next: '0.31.0', old: '0.32.0' };
        const answers = [...ROUTING, ...ROUTING].map((build) => builds[build]);
        // Then only 0.31.0 answers.
        while (answers.length < 60) {
            answers.push('0.31.0');
        }
        const closedAt: number[] = [];
        for (const [index, version] of answers.entries()) {
            const at = (index + 1) / 4;
            t.answer(version, at);
            if (t.versions.gate() === 'closed') {
                closedAt.push(at);
            }
        }
        // 0.32.0 last answered at 5.25 minutes, so 0.31.0 has lasted from 5.5: taken at 11.75, closed at 12.
        expect(closedAt[0]).toBe(12);
        expect(closedAt).toHaveLength(answers.length - 12 * 4 + 1);
        expect(t.versions.highest()).toBe('0.31.0');
        await settle();
        expect(t.heard).toEqual([
            { fresh: true, gateMoved: false },
            { fresh: false, gateMoved: true },
        ]);
    });

    it('still closes on two answers in a row with no readable version', () => {
        const t = tracked({ initial: { ...NO_SERVER_VERSIONS, serverVersion: '0.32.0', versionGate: 'open' } });
        expect(t.answer(null, 0).gateMoved).toBe(false);
        expect(t.answer('0.32.0', 0.25).gateMoved).toBe(false);
        expect(t.answer('dev', 0.5).gateMoved).toBe(false);
        expect(t.answer(null, 0.75).gateMoved).toBe(true);
        expect(t.versions.gate()).toBe('closed');
        expect(t.versions.highest()).toBe('0.32.0');
    });

    it('lets a listener go', async () => {
        const t = tracked();
        const calls: VersionChange[] = [];
        const stop = t.versions.subscribe((change) => calls.push(change));
        t.answer('0.32.0', 0);
        await settle();
        stop();
        t.answer('0.33.0', 1);
        await settle();
        expect(calls).toEqual([{ fresh: true, gateMoved: false }]);
        expect(t.heard).toHaveLength(2);
    });
});

describe('the server versions’ state', () => {
    it('is written when it changes, never for a repeat', async () => {
        const t = tracked();
        t.answer('0.32.0', 0);
        // 304s every 15 s report the same version: nothing more to write.
        for (let at = 0.25; at < 30; at += 0.25) {
            t.answer('0.32.0', at);
        }
        await t.versions.flush();
        expect(t.writes).toEqual([
            { ...NO_SERVER_VERSIONS, serverVersion: '0.32.0', lastVersion: '0.32.0', versionGateVote: 'open' },
            { ...NO_SERVER_VERSIONS, serverVersion: '0.32.0', lastVersion: '0.32.0', versionGate: 'open' },
        ]);
    });

    it('keeps as the last version only a release version: an unreadable or oversized one is kept as null', async () => {
        const t = tracked({ initial: GATE_OPEN });
        t.answer('0.32.0', 0);
        await t.versions.flush();
        expect(t.writes.at(-1)?.lastVersion).toBe('0.32.0');
        const huge = 'x'.repeat(1 << 20);
        for (const [at, version] of [
            [0.25, huge],
            [0.5, `0.32.0-${'a'.repeat(MAX_RELEASE_VERSION)}`],
            [0.75, 'dev'],
            [1, '<b>Update now</b>'],
        ] as const) {
            t.answer(version, at);
            expect(t.versions.state().lastVersion, version.slice(0, 20)).toBeNull();
        }
        await t.versions.flush();
        expect(t.writes.at(-1)?.lastVersion).toBeNull();
        for (const write of t.writes) {
            expect((write.lastVersion ?? '').length).toBeLessThanOrEqual(MAX_RELEASE_VERSION);
        }
        // A readable one is kept again.
        t.answer('0.0.0', 1.25);
        expect(t.versions.state().lastVersion).toBe('0.0.0');
    });

    it('writes again after a failed write, with the next change or on flush', async () => {
        const t = tracked({ failWrites: true });
        t.answer('0.32.0', 0);
        await settle();
        expect(t.errors).toHaveLength(1);
        expect(t.writes).toEqual([]);
        await expect(t.versions.flush()).rejects.toThrow('disk full');
        t.failing = false;
        await t.versions.flush();
        expect(t.writes).toEqual([t.versions.state()]);
        await t.versions.flush();
        expect(t.writes).toHaveLength(1);
    });

    it('survives a reopen of the registry, and the rules carry on from it', async () => {
        const root = mkdtempSync(join(tmpdir(), 'socio-versions-'));
        mkdirSync(join(root, 'socio'));
        const key = '5d'.repeat(32);
        const keys = new Map<string, string>();
        try {
            const registry = await openRegistry(createNodeSqliteDriver({ keys }), root, key, () => T0);
            const id = await workspaceId(sha256, ORIGIN, 'u-ada');
            await registry.add({ id, origin: ORIGIN, appUserId: 'u-ada', name: 'Acme' });
            const clock = { now: T0 };
            const before = createServerVersions({
                variant: 'production',
                initial: await registry.serverVersions(id),
                now: () => clock.now,
                persist: (state) => registry.setServerVersions(id, state),
            });
            const answers: [number, string][] = [
                [0, '0.33.0'],
                [0.25, '0.33.0'],
                // A rollback below the minimum starts: its first answer, then the app is killed.
                [1, '0.31.0'],
            ];
            for (const [at, version] of answers) {
                clock.now = T0 + at * MINUTE;
                before.observe(version);
            }
            await before.flush();
            const kept = before.state();
            expect(kept).toEqual({
                serverVersion: '0.33.0',
                lowerVersion: '0.31.0',
                lowerSince: T0 + MINUTE,
                lastVersion: '0.31.0',
                versionGate: 'open',
                versionGateVote: null,
            });
            await registry.close();

            /** A relaunch at `at` minutes: the registry reopened and a tracker started from it. */
            const relaunch = async (at: number) => {
                const reopened = await openRegistry(createNodeSqliteDriver({ keys }), root, key, () => T0);
                clock.now = T0 + at * MINUTE;
                const versions = createServerVersions({
                    variant: 'production',
                    initial: await reopened.serverVersions(id),
                    now: () => clock.now,
                    persist: (state) => reopened.setServerVersions(id, state),
                });
                return { reopened, versions };
            };

            // 10 minutes later: the window kept, so the first answer finds the lower version has lasted.
            const first = await relaunch(11);
            expect(await first.reopened.serverVersions(id)).toEqual(kept);
            expect(first.versions.gate()).toBe('open');
            expect(first.versions.observe('0.31.0')).toEqual({ fresh: true, gateMoved: false });
            expect(first.versions.state()).toMatchObject({ serverVersion: '0.31.0', versionGateVote: 'closed' });
            await first.versions.flush();
            const voted = first.versions.state();
            await first.reopened.close();

            // Killed again: the pending vote kept, so the next launch's first answer is the second in a row.
            const second = await relaunch(30);
            expect(await second.reopened.serverVersions(id)).toEqual(voted);
            expect(second.versions.observe('0.31.0')).toEqual({ fresh: false, gateMoved: true });
            expect(second.versions.gate()).toBe('closed');
            await second.versions.flush();
            expect(await second.reopened.serverVersions(id)).toEqual(second.versions.state());
            await second.reopened.close();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('reads values a newer build wrote as undecided', () => {
        expect(
            serverVersionState({
                ...NO_SERVER_VERSIONS,
                serverVersion: '0.40.0',
                versionGate: 'blocked',
                versionGateVote: 'maybe',
            }),
        ).toEqual({ ...NO_SERVER_VERSIONS, serverVersion: '0.40.0' });
        expect(serverVersionState(null)).toEqual(NO_SERVER_VERSIONS);
    });
});

describe('server versions through the shell’s sources', () => {
    type Setup = Awaited<ReturnType<typeof syncSetup>>;
    const open: Setup[] = [];
    afterEach(async () => {
        for (const s of open.splice(0)) {
            await s.close().catch(() => {});
        }
    });

    async function setup(variant = 'production', version?: string, hold = false, initial?: ServerVersionState) {
        const t = tracked({ variant, initial });
        const s = await syncSetup({ versions: t.versions, version, hold });
        open.push(s);
        return { s, t };
    }

    it('reads the version from /api/state, and a higher one makes every scope pull once, with its ETag', async () => {
        const { s, t } = await setup('production', undefined, false, GATE_OPEN);
        await s.state.pull('', s.state.cursor());
        await s.workspace.pull('', s.workspace.cursor());
        expect(t.versions.highest()).toBe('0.32.0');
        expect([s.state.stale(), s.workspace.stale()]).toEqual([false, false]);
        await settle();
        t.heard.length = 0;

        // A deploy. /api/workspace carries no version: its pull shows nothing.
        s.server.deploy('0.33.0');
        await s.workspace.pull('', s.workspace.cursor());
        expect(t.versions.highest()).toBe('0.32.0');
        // The state's body holds the version, so it changes and comes back whole.
        const shown = await s.state.pull('', s.state.cursor());
        expect(shown.outcome).toBe('changed');
        expect(t.versions.highest()).toBe('0.33.0');
        expect([s.state.stale(), s.workspace.stale()]).toEqual([false, true]);
        await settle();
        expect(t.heard).toEqual([{ fresh: true, gateMoved: false }]);

        // The fresh pull sends the ETag: the new build checks the body's hash, which hasn't changed.
        const cursor = s.workspace.cursor();
        expect(cursor).not.toBeNull();
        const fresh = await s.workspace.pull('', cursor);
        expect(s.server.requests.at(-1)).toMatchObject({ path: '/api/workspace', ifNoneMatch: cursor, status: 304 });
        expect(fresh.outcome).toBe('not-modified');
        expect(s.workspace.stale()).toBe(false);

        // Once: the next answers ask for nothing more.
        await s.state.pull('', s.state.cursor());
        expect(s.server.requests.at(-1)?.status).toBe(304);
        await settle();
        expect(t.heard).toHaveLength(1);

        // The stamps reach cache.db with their meta rows.
        await s.cache.flush();
        expect(await stampOnDisk(s.db, 'state')).toBe('0.33.0');
        expect(await stampOnDisk(s.db, 'workspace')).toBe('0.33.0');
    });

    it('counts a 304 as an answer with the version of the state the device holds', async () => {
        const { s, t } = await setup('production', '0.31.0');
        await s.state.pull('', s.state.cursor());
        expect(t.versions.state()).toMatchObject({ versionGate: null, versionGateVote: 'closed' });
        await s.state.pull('', s.state.cursor());
        expect(s.server.requests.at(-1)?.status).toBe(304);
        expect(t.versions.gate()).toBe('closed');
        expect(t.versions.state().lastVersion).toBe('0.31.0');
    });

    it('opens the gate on a development server’s 0.0.0 only in the test builds', async () => {
        for (const [variant, gate] of [
            ['development', 'open'],
            ['preview', 'open'],
            ['production', 'closed'],
        ] as const) {
            const { s, t } = await setup(variant, '0.0.0');
            await s.state.pull('', s.state.cursor());
            await s.state.pull('', s.state.cursor());
            expect(t.versions.gate(), variant).toBe(gate);
        }
    });

    it('keeps the old build’s answers during a deploy from moving anything, 304s included', async () => {
        const { s, t } = await setup('production', undefined, false, GATE_OPEN);
        await s.state.pull('', null);
        await s.workspace.pull('', null);
        await settle();
        t.heard.length = 0;
        const old = s.server.build;
        const next = s.server.deploy('0.33.0');
        const answers: string[] = [];
        // The two builds answer in turn for 5 minutes; the old one twice in a row now and then.
        const order = [next, old, old, next, old, next, next, old, old, old, next];
        for (const [index, build] of order.entries()) {
            s.clock.server += 15 * 1000;
            t.clock.now = T0 + (index + 1) * 15 * SECOND;
            s.server.answerAs(build);
            await s.state.pull('', s.state.cursor());
            answers.push(`${s.server.requests.at(-1)?.status} ${build.version}`);
        }
        expect(answers).toContain('304 0.32.0');
        expect(t.versions.highest()).toBe('0.33.0');
        expect(t.versions.gate()).toBe('open');
        await settle();
        expect(t.heard).toEqual([{ fresh: true, gateMoved: false }]);
        expect(s.workspace.stale()).toBe(true);
    });

    it('opens the gate once on a deploy across the minimum, however the two builds take turns, 304s included', async () => {
        const { s, t } = await setup('production', '0.31.0');
        await s.state.pull('', null);
        await s.state.pull('', s.state.cursor());
        expect(t.versions.gate()).toBe('closed');
        await settle();
        t.heard.length = 0;
        const builds = { old: s.server.build, next: s.server.deploy('0.32.0') };
        const answers: string[] = [];
        for (const [index, build] of ROUTING.entries()) {
            s.clock.server += 15 * SECOND;
            t.clock.now = T0 + (index + 1) * 15 * SECOND;
            s.server.answerAs(builds[build]);
            await s.state.pull('', s.state.cursor());
            answers.push(`${s.server.requests.at(-1)?.status} ${builds[build].version} ${t.versions.gate()}`);
        }
        expect(answers).toContain('304 0.31.0 open');
        expect(t.versions.gate()).toBe('open');
        await settle();
        expect(t.heard.filter((change) => change.gateMoved)).toHaveLength(1);
    });

    it('times the rollback window by the answers’ Date, not the device clock', async () => {
        const { s, t } = await setup('production', undefined, false, GATE_OPEN);
        await s.state.pull('', null);
        const old = s.server.build;
        const next = s.server.deploy('0.33.0');
        s.clock.server += 15 * SECOND;
        await s.state.pull('', s.state.cursor());
        expect(t.versions.highest()).toBe('0.33.0');
        s.server.answerAs(old);
        s.clock.server += 15 * SECOND;
        t.clock.now = s.clock.server;
        await s.state.pull('', s.state.cursor());
        // The device clock jumps 10 minutes ahead between two of the old build's answers, 15 s apart.
        s.clock.skew += 10 * MINUTE;
        s.clock.server += 15 * SECOND;
        t.clock.now = s.clock.device();
        await s.state.pull('', s.state.cursor());
        expect(s.server.requests.at(-1)?.status).toBe(304);
        expect(t.versions.highest()).toBe('0.33.0');
        s.server.answerAs(next);
        s.clock.server += 15 * SECOND;
        t.clock.now = s.clock.device();
        await s.state.pull('', s.state.cursor());
        await settle();
        expect(t.heard.filter((change) => change.fresh)).toHaveLength(2);
        expect(t.versions.highest()).toBe('0.33.0');
    });

    it('leaves a scope stale when its pull began before the higher version was taken', async () => {
        const { s, t } = await setup('production', undefined, true);
        const first = s.state.pull('', null);
        await settle();
        s.release();
        await first;
        const second = s.workspace.pull('', null);
        await settle();
        s.release();
        await second;
        expect(s.workspace.stale()).toBe(false);

        // The workspace pull goes out first; the state's answer, with the new version, lands before it.
        s.server.deploy('0.33.0');
        const workspace = s.workspace.pull('', s.workspace.cursor());
        await settle();
        const state = s.state.pull('', s.state.cursor());
        await settle();
        expect(s.heldAnswers).toBe(2);
        s.release(1);
        await state;
        expect(t.versions.highest()).toBe('0.33.0');
        s.release(0);
        await workspace;
        // Asked before the new version was known: still due its one pull.
        expect(s.workspace.stale()).toBe(true);
        const again = s.workspace.pull('', s.workspace.cursor());
        await settle();
        s.release();
        await again;
        expect(s.workspace.stale()).toBe(false);
    });

    it('a relaunch finds a scope stale when the highest version moved past its stamp', async () => {
        const { s, t } = await setup();
        await s.state.pull('', null);
        await s.workspace.pull('', null);
        s.server.deploy('0.33.0');
        await s.state.pull('', s.state.cursor());
        await s.cache.flush();
        await t.versions.flush();
        const directory = s.directory;
        await s.close({ remove: false });
        open.splice(0);

        // The app was killed before the workspace's fresh pull: the registry kept the highest version.
        const relaunched = tracked({ initial: t.versions.state() });
        const again = await syncSetup({ versions: relaunched.versions, directory, driver: s.driver });
        open.push(again);
        expect(again.state.stale()).toBe(false);
        expect(again.workspace.stale()).toBe(true);
    });
});
