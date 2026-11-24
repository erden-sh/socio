import { describe, expect, it } from 'vitest';

import { compareBoardOrder } from '@socio/shared/issues/issue-board';
import type { IssueSummary } from '@socio/shared/issues/issue-types';

import {
    appBoard,
    appHolding,
    boardDifferences,
    type ParityCapture,
    paritySettings,
    paritySummary,
    runParity,
    serverIssues,
    webBoard,
} from '../e2e/board-parity-cases';
import { liveAccount, parityReport, parseParityArgs, takeCapture, USER_AGENT } from '../e2e/board-parity.mjs';

// The board parity harness (e2e/board-parity.mjs) on a made-up board: the matrix passes
// when both sides agree, and each kind of drift fails its case; the capture's
// requests carry the generic User-Agent, sign out after a failure and never
// echo the password.

const at = (n: number) => 1_700_000_000_000 + n * 1000;

function summary(number: number, fields: Partial<IssueSummary>): IssueSummary {
    return {
        number,
        title: `Made-up issue ${number}`,
        status: 'open',
        priority: 'medium',
        kind: 'bug',
        area: null,
        labels: [],
        assigneeId: null,
        updatedAt: at(number),
        demand: 0,
        votes: 0,
        voted: false,
        openBlockers: [],
        excerpt: '',
        ...fields,
    } as unknown as IssueSummary;
}

const ISSUES: IssueSummary[] = [
    summary(1, { status: 'triage', priority: 'critical', kind: 'bug', area: 'server', votes: 2 }),
    summary(2, {
        status: 'open',
        priority: 'high',
        kind: 'feature',
        area: 'client',
        labels: ['dot-request'],
        demand: 2,
    }),
    summary(3, { status: 'ready', priority: 'high', kind: 'improvement', area: 'chat', votes: 5 }),
    summary(4, { status: 'in_progress', priority: 'medium', kind: 'docs', area: 'docs', assigneeId: 'u-ada' }),
    summary(5, { status: 'in_review', priority: 'medium', kind: 'chore', votes: 5, title: 'Board search is slow' }),
    summary(6, { status: 'blocked', priority: 'low', kind: 'request', labels: ['dot-request', 'needs-decision'] }),
    summary(7, { status: 'done', priority: 'low', kind: 'bug', area: 'server', title: 'Café menu sync' }),
    summary(8, { status: 'wont_fix', priority: 'medium', kind: 'feature', excerpt: 'mobile board' }),
    summary(9, { status: 'open', priority: 'medium', kind: 'bug', area: 'server', votes: 1, updatedAt: at(9) }),
    summary(10, { status: 'open', priority: 'medium', kind: 'bug', area: 'server', votes: 1, updatedAt: at(9) }),
    summary(11, {
        status: 'triage',
        priority: 'high',
        kind: 'bug',
        labels: ['dot-request'],
        title: 'Mobile error page',
    }),
];

const serverOrder = (issues: IssueSummary[]) => [...issues].sort(compareBoardOrder);

function capture(
    issues = serverOrder(ISSUES),
    searches: Record<string, number[]> = { board: [5, 8], mobile: [8, 11], xqzvw: [] },
): ParityCapture {
    return {
        issues: JSON.stringify({ issues, users: { 'u-ada': 'Ada Lovelace' } }),
        searches: Object.fromEntries(Object.entries(searches).map(([q, numbers]) => [q, JSON.stringify({ numbers })])),
    };
}

describe('board parity', () => {
    it('passes every case of the matrix when both sides agree', async () => {
        const results = await runParity(capture());
        const failed = results.filter((result) => !result.pass);
        expect(failed).toEqual([]);
        const { groups, pass, cases } = paritySummary(results);
        expect(pass).toBe(true);
        expect(Object.keys(groups)).toEqual(['order', 'baseline', 'single', 'pair', 'lane', 'query']);
        // Every facet value twice (alone, by votes): 8 statuses, 4 priorities, 6 kinds, 15 areas and the labels.
        expect(groups.single!.cases % 2).toBe(0);
        expect(groups.baseline!.cases).toBe(4);
        expect(groups.query!.cases).toBe(3 * 4);
        expect(cases).toBe(results.length);
    });

    it('builds pairs only where the board has a row', () => {
        const pairs = paritySettings(ISSUES, []).filter((one) => one.group === 'pair');
        expect(pairs.map((one) => one.name)).toContain('status=open & area=server');
        expect(pairs.map((one) => one.name)).not.toContain('status=done & area=client');
        expect(pairs.length).toBeGreaterThan(20);
    });

    it('fails the order case when the server’s order isn’t compareBoardOrder’s', async () => {
        const shuffled = serverOrder(ISSUES).reverse();
        const results = await runParity(capture(shuffled));
        expect(results.find((result) => result.group === 'order')?.pass).toBe(false);
        // The web keeps the server's order; the app sorts: the baseline differs too.
        expect(results.find((result) => result.name === 'all')?.pass).toBe(false);
    });

    it('goes through the app’s sync path: the collection holds every issue and the assignee’s name', async () => {
        const holding = await appHolding(capture());
        expect(holding.issues.map((issue) => issue.number).sort((a, b) => a - b)).toEqual(ISSUES.map((i) => i.number));
        expect(holding.users).toEqual({ 'u-ada': 'Ada Lovelace' });
        expect([...(holding.matches.get('board') ?? [])]).toEqual([5, 8]);
    });

    it('names each kind of drift by issue number', async () => {
        const one = capture();
        const all = serverIssues(one);
        const holding = await appHolding(one);
        const [setting] = paritySettings(all, []);
        const web = webBoard(one, all, setting!);
        const app = appBoard(holding, setting!);
        expect(boardDifferences(web, app)).toEqual([]);
        const swapped = { ...app, columns: { ...app.columns, open: [...(app.columns.open ?? [])].reverse() } };
        expect(boardDifferences(web, swapped)).toEqual([
            expect.stringMatching(/^open order: web \[2,10,9\], app \[9,10,2\]$/),
        ]);
        const missing = { ...app, columns: { ...app.columns, open: [2] }, header: '0 open · 0 in progress · 0 done' };
        expect(boardDifferences(web, missing)).toEqual([
            'open count: web 3, app 1',
            'open rows: only on the web [10,9], only in the app []',
            expect.stringMatching(/^header: /),
        ]);
    });

    it('keeps titles out of the cases and puts only the named issues’ titles in the report', async () => {
        const one = capture(serverOrder(ISSUES).reverse());
        const results = await runParity(one);
        expect(JSON.stringify(results)).not.toMatch(/Made-up issue/);
        const report = parityReport(paritySummary(results), results, serverIssues(one));
        expect(Object.keys(report.titles).length).toBeGreaterThan(0);
        expect(report.cases.every((one) => !('differences' in one))).toBe(true);
    });
});

describe('the live capture', () => {
    const account = {
        origin: 'https://brain.example.com',
        login: 'smoke@example.com',
        password: 'not-a-real-password',
    };

    function fakeFetch(status: (path: string) => number) {
        const calls: { method: string; path: string; headers: Record<string, string>; body?: string }[] = [];
        const impl = (async (url: string, init: RequestInit) => {
            const path = url.slice(account.origin.length);
            calls.push({
                method: init.method ?? 'GET',
                path,
                headers: init.headers as Record<string, string>,
                body: init.body as string | undefined,
            });
            const headers = new Headers(
                path.startsWith('/api/auth/sign-in') ? { 'set-cookie': 'session=abc; Path=/; HttpOnly' } : {},
            );
            const body = path.startsWith('/api/issues/search') ? '{"numbers":[1]}' : `{"echo":"${account.login}"}`;
            return new Response(body, { status: status(path), headers });
        }) as unknown as typeof fetch;
        return { calls, impl };
    }

    it('signs in once, reads the list and each query, signs out, all with the generic User-Agent', async () => {
        const { calls, impl } = fakeFetch(() => 200);
        const taken = await takeCapture(account, ['board', 'chat message'], impl);
        expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
            'POST /api/auth/sign-in/email',
            'GET /api/issues',
            'GET /api/issues/search?q=board',
            'GET /api/issues/search?q=chat+message',
            'POST /api/auth/logout',
        ]);
        expect(calls.every((call) => call.headers['User-Agent'] === USER_AGENT)).toBe(true);
        expect(USER_AGENT).toBe('research-script/0.1');
        expect(calls.slice(1).every((call) => call.headers.Cookie === 'session=abc')).toBe(true);
        // The password goes into the sign-in's body and nowhere else.
        expect(calls.filter((call) => JSON.stringify(call).includes(account.password)).length).toBe(1);
        expect(Object.keys(taken.searches)).toEqual(['board', 'chat message']);
    });

    it('signs out after a failed read, and says the status without a body or the password', async () => {
        const { calls, impl } = fakeFetch((path) => (path === '/api/issues' ? 500 : 200));
        const failed = await takeCapture(account, ['board'], impl).catch((error: Error) => error);
        expect(failed).toBeInstanceOf(Error);
        expect((failed as Error).message).toBe('GET /api/issues answered 500.');
        expect(calls.at(-1)?.path).toBe('/api/auth/logout');
    });

    it('never echoes the sign-in’s answer or the login on a refused sign-in', async () => {
        const { impl } = fakeFetch((path) => (path.startsWith('/api/auth/sign-in') ? 401 : 200));
        const failed = (await takeCapture(account, [], impl).catch((error: Error) => error)) as Error;
        expect(failed.message).toBe('POST /api/auth/sign-in/email answered 401.');
        expect(failed.message).not.toContain(account.login);
    });

    it('reads the account from the environment and names only what is missing', () => {
        expect(() => liveAccount({ SMOKE_LOGIN: 'x', SMOKE_PASSWORD: 'secret' })).toThrow(
            'Set SMOKE_BASE_URL (or pass --capture).',
        );
        expect(() =>
            liveAccount({ SMOKE_BASE_URL: 'http://brain.example.com', SMOKE_LOGIN: 'x', SMOKE_PASSWORD: 'y' }),
        ).toThrow('must be https');
        expect(
            liveAccount({ SMOKE_BASE_URL: 'https://brain.example.com/x', SMOKE_LOGIN: 'x', SMOKE_PASSWORD: 'y' })
                .origin,
        ).toBe('https://brain.example.com');
        expect(parseParityArgs(['--out', '/tmp/x'])).toEqual({ help: false, out: '/tmp/x', capture: null });
        expect(() => parseParityArgs([])).toThrow('--out is required');
    });
});
