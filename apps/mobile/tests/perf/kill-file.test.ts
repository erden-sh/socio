import { describe, expect, it } from 'vitest';

import {
    countFilings,
    filePlan,
    parseKillFileArgs,
    passed,
    pendingOnScreen,
    PENDING_WORDS,
} from '../../perf/kill-file.mjs';
import { MAX_DELAY_MS, seeded, uiNodes, VARIANTS } from '../../perf/kill-send.mjs';
import { PENDING_ISSUE_LABEL } from '../../src/shell/issue-filing';
import { OUTBOX_COPY } from '../../src/sync/outbox';

// perf/kill-file.mjs: its arguments, the plan (kills spread over
// 0 to 2 s, every other round offline), the count per title from the
// server's issues and their files, and the verdict. The device half runs by
// hand (README, Chaos).

describe('kill-file', () => {
    const base = ['--device', 'emulator-5554', '--credentials', '/tmp/c.json'];

    it('reads its arguments', () => {
        expect(parseKillFileArgs([...base, '--metro', '8136'])).toMatchObject({
            device: 'emulator-5554',
            workspace: 'A',
            app: VARIANTS.development,
            metro: 8136,
            rounds: 50,
            offline: true,
            proxyControl: 4459,
            settleSeconds: 180,
        });
        expect(parseKillFileArgs([...base, '--variant', 'preview', '--online-only', '--rounds', '20'])).toMatchObject({
            metro: null,
            offline: false,
            rounds: 20,
        });
        expect(parseKillFileArgs(['--help'])).toHaveProperty('help');
        expect(() => parseKillFileArgs(['--credentials', 'x'])).toThrow(/--device/);
        expect(() => parseKillFileArgs(['--device', 'x'])).toThrow(/--credentials/);
        expect(() => parseKillFileArgs(base)).toThrow(/--metro/);
        expect(() => parseKillFileArgs([...base, '--metro', '8136', '--rounds', '0'])).toThrow(/--rounds/);
        expect(() => parseKillFileArgs([...base, '--metro', '80'])).toThrow(/--metro/);
    });

    it('spreads the kills over 0 to 2 s, a unique title each, every other round offline', () => {
        const plan = filePlan({ rounds: 50, offline: true, tag: 't', random: seeded(3) });
        expect(new Set(plan.map((step) => step.title)).size).toBe(50);
        expect(plan[0]).toMatchObject({ round: 1, title: 'kf-t-001', offline: true });
        expect(plan.filter((step) => step.offline)).toHaveLength(25);
        expect(plan.every((step) => step.delayMs >= 0 && step.delayMs <= MAX_DELAY_MS)).toBe(true);
        const slices = plan.map((step) => Math.min(49, Math.floor(step.delayMs / (MAX_DELAY_MS / 50))));
        expect(new Set(slices).size).toBeGreaterThanOrEqual(45);
        // Offline and online rounds each reach both ends of the window.
        for (const offline of [true, false]) {
            const delays = plan.filter((step) => step.offline === offline).map((step) => step.delayMs);
            expect(Math.min(...delays)).toBeLessThan(400);
            expect(Math.max(...delays)).toBeGreaterThan(1600);
        }
        expect(filePlan({ rounds: 50, offline: true, tag: 't', random: seeded(3) })).toEqual(plan);
        expect(filePlan({ rounds: 4, offline: false, tag: 't', random: seeded(1) }).some((s) => s.offline)).toBe(false);
    });

    it('counts each title once with one file, and names losses, duplicates and wrong file counts', () => {
        const issues = [
            { number: 20, title: 'kf-t-001', attachments: 1 },
            { number: 21, title: 'kf-t-002', attachments: 1 },
            { number: 23, title: 'kf-t-002', attachments: 0 },
            { number: 22, title: 'kf-t-003', attachments: 2 },
            { number: 24, title: 'kf-t-0010', attachments: 1 },
        ];
        const counts = countFilings(issues, ['kf-t-001', 'kf-t-002', 'kf-t-003', 'kf-t-004']);
        expect(counts.once).toBe(1);
        expect(counts.lost).toEqual(['kf-t-004']);
        expect(counts.duplicated).toEqual(['kf-t-002']);
        expect(counts.wrongFiles).toEqual(['kf-t-003 (2 files)']);
        expect(counts.rows[1]).toEqual({ title: 'kf-t-002', numbers: [21, 23], attachments: [1, 0] });
        expect(passed(counts, 4, [], [], 0)).toBe(false);
        const clean = countFilings(issues.slice(0, 2), ['kf-t-001', 'kf-t-002']);
        expect(passed(clean, 2, [], [], 0)).toBe(true);
        expect(passed(clean, 2, ['Waiting to send'], [], 0)).toBe(false);
        expect(passed(clean, 2, [], ['unknown 1'], 0)).toBe(false);
    });

    it('fails when a kept draft came back without its photo, even if the counts look right', () => {
        const clean = countFilings(
            [
                { number: 20, title: 'kf-t-001', attachments: 1 },
                { number: 21, title: 'kf-t-002', attachments: 1 },
            ],
            ['kf-t-001', 'kf-t-002'],
        );
        expect(passed(clean, 2, [], [], 1)).toBe(false);
    });

    it("knows the Board's pending words", () => {
        expect(PENDING_WORDS).toEqual(
            expect.arrayContaining([OUTBOX_COPY.waitingToSend, PENDING_ISSUE_LABEL, 'Couldn’t confirm']),
        );
        expect(OUTBOX_COPY.unconfirmed.startsWith('Couldn’t confirm')).toBe(true);
        const nodes = uiNodes(`<hierarchy>
            <node text="CB-?" resource-id="" content-desc="" bounds="[0,0][1,1]"/>
            <node text="" resource-id="" content-desc="Waiting to send" bounds="[0,0][1,1]"/>
            <node text="CB-12" resource-id="" content-desc="" bounds="[0,0][1,1]"/>
        </hierarchy>`);
        expect(pendingOnScreen(nodes)).toEqual(['CB-?', 'Waiting to send']);
    });
});
