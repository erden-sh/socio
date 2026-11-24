import { describe, expect, it } from 'vitest';

import {
    countDeliveries,
    killPlan,
    lockRefusal,
    MAX_DELAY_MS,
    outboxLeft,
    parseKillSendArgs,
    parseOutboxTally,
    pendingOnScreen,
    seeded,
    uiNodes,
    VARIANTS,
} from '../../perf/kill-send.mjs';
import { NOT_SENT, UNCONFIRMED, UPLOADING_FILES } from '../../src/chat/composer';
import { OUTBOX_COPY } from '../../src/sync/outbox';
import { outboxTally, outboxTallyLine } from '../../src/sync/outbox-tally';

// perf/kill-send.mjs: its arguments, the kill plan
// spread over 0 to 2 s, the count per message from the stored runs, and the
// pending bubbles it reads off the screen. The device half runs by hand.

describe('kill-send', () => {
    it('locks only an emulator, since nothing can unlock a phone with a PIN', () => {
        expect(lockRefusal({ mode: 'kill', qemu: '' })).toBeNull();
        expect(lockRefusal({ mode: 'lock', qemu: '1\n' })).toBeNull();
        expect(lockRefusal({ mode: 'mixed', qemu: '1' })).toBeNull();
        expect(lockRefusal({ mode: 'lock', qemu: '' })).toContain('only on an emulator');
        expect(lockRefusal({ mode: 'mixed', qemu: '0' })).toContain('--mode kill');
    });

    it('reads its arguments, the device serial first', () => {
        const base = ['--device', '58240DLCQ001G1', '--credentials', '/tmp/c.json'];
        expect(parseKillSendArgs([...base, '--variant', 'preview'])).toMatchObject({
            device: '58240DLCQ001G1',
            platform: 'android',
            workspace: 'A',
            app: VARIANTS.preview,
            rounds: 30,
            mode: 'kill',
            metro: null,
        });
        expect(parseKillSendArgs([...base, '--metro', '8104', '--rounds', '100', '--mode', 'mixed'])).toMatchObject({
            metro: 8104,
            rounds: 100,
            mode: 'mixed',
        });
        expect(parseKillSendArgs([...base, '--platform', 'ios'])).toMatchObject({ platform: 'ios' });
        expect(parseKillSendArgs(['--help'])).toHaveProperty('help');
        expect(() => parseKillSendArgs(['--credentials', 'x'])).toThrow(/--device/);
        expect(() => parseKillSendArgs(['--device', 'x'])).toThrow(/--credentials/);
        expect(() => parseKillSendArgs(base)).toThrow(/--metro/);
        expect(() => parseKillSendArgs([...base, '--metro', '8104', '--mode', 'nap'])).toThrow(/--mode/);
        expect(() => parseKillSendArgs([...base, '--metro', '8104', '--rounds', '0'])).toThrow(/--rounds/);
    });

    it('spreads the kills evenly over 0 to 2 s, with a unique message each, and locks one in four when mixed', () => {
        const plan = killPlan({ rounds: 40, mode: 'mixed', tag: 't', random: seeded(7) });
        expect(new Set(plan.map((step) => step.marker)).size).toBe(40);
        expect(plan.every((step) => step.delayMs >= 0 && step.delayMs <= MAX_DELAY_MS)).toBe(true);
        // One delay in each 50 ms slice.
        const slices = plan
            .map((step) => Math.min(39, Math.floor(step.delayMs / (MAX_DELAY_MS / 40))))
            .sort((a, b) => a - b);
        expect(new Set(slices).size).toBeGreaterThanOrEqual(36);
        expect(plan.filter((step) => step.action === 'lock')).toHaveLength(10);
        expect(killPlan({ rounds: 40, mode: 'mixed', tag: 't', random: seeded(7) })).toEqual(plan);
        expect(
            killPlan({ rounds: 3, mode: 'lock', tag: 't', random: seeded(1) }).every((s) => s.action === 'lock'),
        ).toBe(true);
    });

    it('counts each message once per run from the stored runs, and names losses and duplicates', () => {
        const user = (id: string, content: unknown) => ({ id, role: 'user', content });
        const runs = [
            { runId: 'r1', messages: [user('m1', 'ks-t-001'), { id: 'a1', role: 'assistant', content: 'ks-t-002' }] },
            // A steering message delivered mid-run is stored in that run.
            { runId: 'r2', messages: [user('m2', [{ type: 'text', text: 'ks-t-002' }]), user('m3', 'ks-t-003')] },
            // The same message again: a duplicate turn.
            { runId: 'r3', messages: [user('m3', 'ks-t-003')] },
        ];
        const counts = countDeliveries(runs, ['ks-t-001', 'ks-t-002', 'ks-t-003', 'ks-t-004']);
        expect(counts.once).toBe(2);
        expect(counts.lost).toEqual(['ks-t-004']);
        expect(counts.duplicated).toEqual(['ks-t-003']);
        expect(counts.rows[2]).toEqual({ marker: 'ks-t-003', messages: 2, ids: ['m3'], runs: 2 });
    });

    it('finds testIDs and pending bubbles in a uiautomator dump', () => {
        const xml = `<?xml version="1.0"?><hierarchy rotation="0">
            <node index="0" text="ks-t-001" resource-id="chat-composer-input" content-desc="" bounds="[10,1800][900,1900]" />
            <node index="1" text="" resource-id="chat-composer-send" content-desc="Send" bounds="[920,1800][1060,1900]"/>
            <node index="5" text="Message" hint="Message" resource-id="first-run-composer-input" content-desc="" bounds="[0,0][2,2]"/>
            <node index="2" text="Waiting to send" resource-id="" content-desc="" bounds="[0,0][1,1]"/>
            <node index="3" text="" resource-id="" content-desc="Couldn&#8217;t confirm" bounds="[0,0][1,1]"/>
            <node index="4" text="" resource-id="" content-desc="${UNCONFIRMED}" bounds="[0,0][1,1]"/>
        </hierarchy>`;
        const nodes = uiNodes(xml);
        expect(nodes.find((node) => node.id === 'chat-composer-input')).toMatchObject({
            text: 'ks-t-001',
            center: { x: 455, y: 1850 },
        });
        expect(nodes.find((node) => node.id === 'chat-composer-send')?.center).toEqual({ x: 990, y: 1850 });
        expect(nodes.find((node) => node.id === 'first-run-composer-input')?.text).toBe('');
        expect(pendingOnScreen(nodes)).toEqual(['Waiting to send', UNCONFIRMED]);
    });

    it("knows the composer's pending words", async () => {
        const { PENDING_WORDS } = await import('../../perf/kill-send.mjs');
        for (const words of [NOT_SENT, UNCONFIRMED, UPLOADING_FILES, OUTBOX_COPY.waitingToSend]) {
            expect(PENDING_WORDS).toContain(words);
        }
    });

    it('judges the outbox from Diagnostics’ line, every row and not only the bubbles on screen', () => {
        const rows = [
            { state: 'sent' },
            { state: 'unknown' },
            { state: 'queued' },
            { state: 'held' },
            { state: 'later' },
        ];
        const line = outboxTallyLine(outboxTally(rows, 1));
        expect(line).toBe('Outbox: queued 1 · inflight 0 · unknown 2 · held 1 · sent 1 · unsent 1');
        const tally = parseOutboxTally(line);
        expect(tally).toEqual({ queued: 1, inflight: 0, unknown: 2, held: 1, sent: 1, unsent: 1 });
        // An `unknown` row whose bubble is scrolled off still fails the run; `sent` rows waiting for the store don't.
        expect(outboxLeft(tally)).toEqual(['queued 1', 'unknown 2', 'held 1', 'unsent 1']);
        expect(outboxLeft(parseOutboxTally(outboxTallyLine(outboxTally([{ state: 'sent' }], 0))))).toEqual([]);
        // No line read (not a development or preview build, or Diagnostics didn't open) fails too.
        expect(parseOutboxTally('Diagnostics')).toBeNull();
        expect(outboxLeft(null)).toEqual(['no Outbox line read']);
    });
});
