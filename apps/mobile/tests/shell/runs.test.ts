import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { RunTraceView } from '@socio/shared/runs/run-trace';
import type { AgentRunSummary } from '@socio/shared/types';

import { LEARNING_HREF, learningIntro, skillRows, skillsEmpty } from '../../src/shell/learning';
import {
    runDuration,
    runRows,
    runsEmpty,
    runsLimitLine,
    runTime,
    runTimeline,
    traceable,
    traceState,
} from '../../src/shell/runs';

// Learning and Runs' view models: the web's RunsView and RunTimeline,
// and its PublishedSkillList, under Node.

const T = Date.UTC(2026, 10, 9, 15, 30);

const run = (runId: string, fields: Partial<AgentRunSummary> = {}): AgentRunSummary => ({
    runId,
    threadId: `chat-${runId}`,
    status: 'finished',
    source: 'web',
    startedAt: T,
    finishedAt: T + 1_500,
    error: null,
    errorDetail: null,
    title: 'Kickoff',
    dotName: 'Sebas',
    ownerId: 'u-ada',
    ownerName: 'Ada',
    readable: true,
    trace: { reason: 'completed', rounds: 3, inputTokens: 12_400, outputTokens: 820 },
    ...fields,
});

describe('the runs list', () => {
    const runs = [
        run('old', { startedAt: T - 60_000 }),
        run('failed', { status: 'failed', error: 'The model is out of reach.', ownerName: 'Ben', ownerId: 'u-ben' }),
        run('running', { status: 'running', finishedAt: null, trace: null, startedAt: T + 1 }),
    ];

    it('lists newest first; a member sees no owner, an admin sees whose each is', () => {
        const member = runRows(runs, '', false, T, 'UTC');
        expect(member.map((row) => row.id)).toEqual(['running', 'failed', 'old']);
        expect(member[1]).toMatchObject({
            status: 'Failed',
            tone: 'bad',
            meta: 'Sebas · Web · Nov 9, 3:30 PM · 1.5 s',
            error: 'The model is out of reach.',
            trace: { text: 'Completed · 3 rounds · 12.4k in · 820 out', trouble: false },
        });
        expect(member[0]!.meta.endsWith(' · …')).toBe(true);
        // Only a failed run offers "File issue", as the web's FileIssueFromRun.
        expect(member.map((row) => row.fileIssue)).toEqual([false, true, false]);
        const admin = runRows(runs, '', true, T, 'UTC');
        expect(admin[1]!.meta).toBe('Sebas · Ben · Web · Nov 9, 3:30 PM · 1.5 s');
    });

    it('filters by status as the web does, with its words when none match', () => {
        expect(runRows(runs, 'failed', false, T).map((row) => row.id)).toEqual(['failed']);
        expect(runRows(runs, 'stopped', false, T)).toEqual([]);
        expect(runsEmpty('stopped', true)).toBe('No stopped turns.');
        expect(runsEmpty('', true)).toBe('No turns yet.');
        expect(runsEmpty('', false)).toBe('Loading…');
        expect(runsLimitLine(199)).toBeNull();
        expect(runsLimitLine(200)).toBe('Showing the latest 200.');
        // The filter looks only at the 200 held, and says so.
        expect(runsLimitLine(199, 'failed')).toBeNull();
        expect(runsLimitLine(200, 'failed')).toBe('Among the latest 200.');
    });

    it('opens a trace only for a turn that has one the person may see', () => {
        expect(traceable(run('a'))).toBe(true);
        expect(traceable(run('a', { trace: null }))).toBe(false);
        expect(traceable(run('a', { trace: null, status: 'running' }))).toBe(true);
        expect(traceable(run('a', { canTrace: false }))).toBe(false);
        expect(traceState(null, false, false).kind).toBe('none');
    });

    it('words times and durations as the web’s Runs', () => {
        expect(runDuration(820)).toBe('820 ms');
        expect(runDuration(1_500)).toBe('1.5 s');
        expect(runDuration(125_000)).toBe('2m 05s');
        expect(runTime(Date.UTC(2025, 9, 31, 13, 53), T, 'UTC')).toBe('Oct 31, 2025, 1:53 PM');
    });
});

describe('a run’s trace', () => {
    const view: RunTraceView = {
        runId: 'r1',
        status: 'failed',
        startedAt: 1_000,
        finishedAt: 5_000,
        trace: {
            turn: { label: 'Shared model', model: 'qwen', source: 'web', cap: 25 },
            rounds: [
                { kind: 'round', round: 1, startedAt: 1_000, endedAt: 2_000, stop: 'tool_calls', inputTokens: 1_200 },
                { kind: 'round', round: 2, startedAt: 3_600, endedAt: 4_000, stop: 'error', error: 'http_500' },
            ],
            tools: [
                {
                    kind: 'tool',
                    round: 1,
                    name: 'search_space_pages',
                    callId: 'call-1',
                    startedAt: 2_000,
                    endedAt: 3_500,
                    outcome: 'error',
                    error: 'http_400',
                },
            ],
            waits: [{ kind: 'wait', for: 'approval', name: 'send_email', round: 2, at: 3_550 }],
            end: { reason: 'error', rounds: 2, cap: 25 },
            totals: { rounds: 2, inputTokens: 1_200 },
            dropped: 4,
        },
    };

    it('shows the steps in the chat trace’s words, the end in red when it went wrong', () => {
        const timeline = runTimeline(view, false)!;
        expect(timeline).toMatchObject({
            end: 'Error',
            trouble: true,
            meta: '2 rounds of 25 at most · 1.2k in · 4.0 s · Shared model · qwen',
            dropped: '4 more steps were left out.',
            advanced: null,
        });
        expect(timeline.steps.map((step) => [step.verb, step.outcome, step.tone])).toEqual([
            ['Searched pages', 'error', 'bad'],
            ['Waiting for approval', undefined, 'muted'],
        ]);
        expect(timeline.steps[0]!.tool).toBeUndefined();
    });

    it('with Advanced on, adds the rounds, raw codes, call ids and the run’s detail', () => {
        const timeline = runTimeline(view, true)!;
        expect(timeline.steps.map((step) => step.verb)).toEqual([
            'Round 1',
            'Searched pages',
            'Waiting for approval',
            'Round 2',
        ]);
        expect(timeline.steps[1]).toMatchObject({
            outcome: 'error · http_400',
            tool: 'search_space_pages',
            callId: 'call-1',
        });
        expect(timeline.steps[3]!.outcome).toBe('error · http_500');
        expect(timeline.advanced?.rows[0]).toEqual({ name: 'Run', value: 'r1', copy: true });
    });

    it('is worked out once per answer and setting', () => {
        expect(runTimeline(view, false)).toBe(runTimeline(view, false));
        expect(runTimeline(view, true)).toBe(runTimeline(view, true));
        expect(runTimeline({ ...view }, false)).not.toBe(runTimeline(view, false));
    });

    it('says when a turn ran before traces', () => {
        const item = {
            value: { ...view, trace: null },
            gone: false,
            settled: true,
            failed: false,
            fetchedAt: 1,
            refreshing: false,
        };
        expect(traceState(item, true, false).kind).toBe('old');
        expect(traceState({ ...item, value: null, settled: false }, true, false).kind).toBe('loading');
        // No copy and the read failed: Try again, busy while it reads.
        const failed = { ...item, value: null, failed: true };
        expect(traceState(failed, true, false)).toEqual({ kind: 'offline', retrying: false });
        expect(traceState({ ...failed, refreshing: true }, true, false)).toEqual({ kind: 'offline', retrying: true });
    });
});

describe('Learning', () => {
    it('lists every container’s published skills by container, then name', () => {
        expect(
            skillRows([
                {
                    containerId: 'sales',
                    skills: [{ name: 'quote', description: 'Quotes', revision: 1, revisionId: 'a' }],
                },
                {
                    containerId: 'eng',
                    skills: [
                        { name: 'triage', description: 'Triage bugs', revision: 1, revisionId: 'b' },
                        { name: 'review', description: 'Reviews', revision: 2, revisionId: 'c' },
                    ],
                },
            ]).map((row) => row.key),
        ).toEqual(['eng/review', 'eng/triage', 'sales/quote']);
        expect(skillsEmpty(false)).toBe('Loading…');
        expect(skillsEmpty(true)).toBe('No skills yet.');
    });

    it('says each role’s line; admins review on the web', () => {
        expect(learningIntro(false)).toBe('Procedures your socios have learned, reviewed by an admin.');
        expect(learningIntro(true)).toMatch(/Nothing reaches a socio until you publish it/);
        expect(LEARNING_HREF).toBe('/learning');
    });
});

describe('a run’s page', () => {
    const screen = readFileSync(new URL('../../src/screens/runs.tsx', import.meta.url), 'utf8');

    it('files an issue linked to a failed run, filled from it, and offers Try again when its trace didn’t load', () => {
        expect(screen).toMatch(
            /\{row\.fileIssue \? \(\s*<Button[^>]*?onPress=\{\(\) => \{[^}]*?openIssueFor\(scope\.drafts, runId, run\);\s*navigation\.navigate\('FileIssue', \{ runId \}\);/s,
        );
        expect(screen).toMatch(/testID="run-trace-retry"/);
        expect(screen).toContain('runsLimitLine(runs.length, filter)');
    });
});
