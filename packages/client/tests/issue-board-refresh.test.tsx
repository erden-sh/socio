// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { expect, it, vi } from 'vitest';

import { issueSummary, type Issue, type IssueDetail } from '@socio/shared/issues/issue-types';

import { closeChangeChannel } from '../src/lib/change-channel';
import { ModulesProvider } from '../src/modules/context';
import { IssuesPage } from '../src/modules/issues/IssuesPage';
import { notifyIssuesChanged } from '../src/modules/issues/report';
import { ShellContext, type Shell } from '../src/shell/shell-context';

const renders = vi.hoisted(() => ({ board: 0, cards: 0 }));
vi.mock('@socio/shared/issues/issue-board', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@socio/shared/issues/issue-board')>();
    return {
        ...actual,
        groupByStatus(...args: Parameters<typeof actual.groupByStatus>) {
            renders.board++;
            return actual.groupByStatus(...args);
        },
    };
});
vi.mock('../src/modules/issues/IssueVotes', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/modules/issues/IssueVotes')>();
    return {
        ...actual,
        VoteButton(props: Parameters<typeof actual.VoteButton>[0]) {
            renders.cards++;
            return <actual.VoteButton {...props} />;
        },
    };
});

it('skips dense board work for unrelated shell refreshes while updates, optimistic moves, votes and selection stay live', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    window.matchMedia = (query) =>
        ({
            matches: false,
            media: query,
            addEventListener() {},
            removeEventListener() {},
        }) as unknown as MediaQueryList;
    globalThis.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;
    // The list polls every ISSUES_POLL_MS on a real interval: a poll landing
    // mid-test (a slow, loaded host) would add a GET and a render the counts
    // below don't expect. Faked, it never fires; nothing here advances it.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    // Every column holds several cards and Done the most, as a busy board
    // does. The render counters, not the size, prove the board's memo: each
    // card's render is counted, so a few per column show it as well as
    // hundreds did. Hundreds took seconds of React and jsdom work, which a
    // loaded host stretched past the timeout (CB-471).
    const statuses = ['triage', 'open', 'ready', 'in_progress', 'in_review', 'done'] as const;
    const perColumn = 3;
    let issues: Issue[] = statuses.flatMap((status, column) =>
        Array.from({ length: status === 'done' ? 3 * perColumn : perColumn }, (_, index) => {
            const number = column * perColumn + index + 1;
            return {
                id: 'fixture-' + number,
                number,
                title: 'Dense fixture ' + number,
                body: 'Synthetic description.',
                status,
                priority: 'medium',
                kind: 'bug',
                area: null,
                labels: [],
                reporterId: 'fixture',
                assigneeId: number === 4 ? 'bob' : null,
                source: 'web',
                resolution: null,
                createdAt: 1,
                updatedAt: 1,
                closedAt: null,
            };
        }),
    );
    let users: Record<string, string> = { bob: 'Bob' };
    const detail = (issue: Issue) =>
        ({
            issue,
            comments: [],
            events: [],
            attachments: [],
            users: {},
            blockedBy: [],
            blocks: [],
        }) as unknown as IssueDetail;
    let finishMove: ((response: Response) => void) | undefined;
    let moved: Issue | undefined;
    const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
            headers: { 'Content-Type': 'application/json' },
        });
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push(method + ' ' + input);
        if (input === '/api/issues') {
            return json({
                issues: issues.map((issue) => issueSummary(issue)),
                users,
            });
        }
        if (input === '/api/issues/1' && method === 'PATCH') {
            const change = JSON.parse(String(init?.body));
            moved = { ...issues[0]!, ...change };
            return new Promise<Response>((resolve) => {
                finishMove = resolve;
            });
        }
        if (input === '/api/issues/2/vote' && method === 'POST') {
            issues = issues.map((issue) => (issue.number === 2 ? { ...issue, votes: 1, voted: true } : issue));
            return json(detail(issues.find((issue) => issue.number === 2)!));
        }
        return new Response('{}', {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
        });
    });
    const shell = {
        state: {
            settings: { name: 'Fixture', paused: false },
            tasks: [],
            memories: [],
            mode: 'live',
            configured: true,
        },
        workspace: {
            user: { id: 'fixture', name: 'Fixture', role: 'admin' },
            spaces: [],
            dots: [],
            conversations: [],
            setup: { missing: [] },
            calls: [],
        },
        admin: true,
        configured: true,
        homeDot: { id: 'd1', name: 'Fixture' },
    } as unknown as Shell;
    const router = createMemoryRouter([{ path: '/issues', element: <IssuesPage /> }], { initialEntries: ['/issues'] });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const modules: [] = [];
    const show = (refresh: number) =>
        root.render(
            <ShellContext.Provider
                value={{
                    ...shell,
                    state: {
                        ...shell.state,
                        settings: {
                            ...shell.state.settings,
                            name: 'Unrelated shell refresh ' + refresh,
                        },
                    },
                }}
            >
                <ModulesProvider modules={modules}>
                    <RouterProvider router={router} />
                </ModulesProvider>
            </ShellContext.Provider>,
        );
    const card = (number: number) => host.querySelector<HTMLElement>(`[data-issue="CB-${number}"]`)!;
    const refreshes = async () => {
        renders.board = 0;
        renders.cards = 0;
        for (let i = 0; i < 10; i++) {
            await act(async () => show(i));
        }
        expect(renders.board).toBe(0);
        expect(renders.cards).toBe(0);
    };
    try {
        await act(async () => show(0));
        expect(host.querySelectorAll('[data-slot="issue-card"]')).toHaveLength(5 * perColumn + 3 * perColumn);
        expect(renders.board).toBeGreaterThan(0);
        expect(renders.cards).toBeGreaterThan(0);
        const original = card(1);
        await refreshes();
        expect(card(1)).toBe(original);
        expect(calls.filter((call) => call === 'GET /api/issues')).toHaveLength(1);

        // Actual fresh200 payloads contain new JSON arrays/objects, even when nothing changed.
        const reload = async () => {
            await act(async () => notifyIssuesChanged());
        };
        renders.board = 0;
        renders.cards = 0;
        await reload();
        expect(calls.filter((call) => call === 'GET /api/issues')).toHaveLength(2);
        expect(renders.board).toBe(0);
        expect(renders.cards).toBe(0);
        expect(card(1)).toBe(original);

        // Every changed field remains live: status, text, arrays and authoritative assignee names.
        issues = issues.map((row) =>
            row.number === 3
                ? {
                      ...row,
                      status: 'done',
                      title: 'Updated remotely',
                      labels: ['ux'],
                      openBlockers: [2],
                  }
                : row,
        );
        renders.board = 0;
        renders.cards = 0;
        await reload();
        expect(renders.board).toBe(1);
        expect(renders.cards).toBe(1);
        expect(card(3).closest('[data-status]')?.getAttribute('data-status')).toBe('done');
        expect(card(3).textContent).toContain('Updated remotely');
        expect(card(3).textContent).toContain('ux');
        expect(card(4).textContent).toContain('Bob');
        users = { bob: 'Robert' };
        await reload();
        expect(card(4).textContent).toContain('Robert');
        users = {};
        await reload();
        expect(card(4).textContent).not.toContain('Robert');
        expect(card(4).textContent).toContain('bob');
        issues = issues.filter((row) => row.number !== 5);
        renders.board = 0;
        renders.cards = 0;
        await reload();
        expect(card(5)).toBeNull();
        expect(renders.cards).toBe(0);
        expect(host.querySelectorAll('[data-slot="issue-card"]')).toHaveLength(5 * perColumn + 3 * perColumn - 1);

        // A move still uses the current stable update callback and appears before its HTTP reply.
        const transfer = {
            types: ['application/x-socio-issue'],
            getData: () => '1',
            setData() {},
            dropEffect: 'none',
            effectAllowed: 'all',
        };
        const drop = new Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(drop, 'dataTransfer', { value: transfer });
        await act(async () => host.querySelector('[data-status="open"]')!.dispatchEvent(drop));
        expect(card(1).closest('[data-status]')?.getAttribute('data-status')).toBe('open');
        expect(finishMove).toBeTypeOf('function');
        expect(calls).toContain('PATCH /api/issues/1');
        issues = issues.map((issue) => (issue.number === 1 ? moved! : issue));
        await act(async () => finishMove!(json(detail(moved!))));
        await refreshes();
        expect(card(1).closest('[data-status]')?.getAttribute('data-status')).toBe('open');

        // Card-local optimistic voting and the ensuing list update still reach the memoized board.
        renders.board = 0;
        renders.cards = 0;
        await act(async () => card(2).querySelector<HTMLButtonElement>('[data-slot="issue-vote"]')!.click());
        expect(calls).toContain('POST /api/issues/2/vote');
        expect(card(2).querySelector('[data-slot="issue-vote"]')?.getAttribute('aria-pressed')).toBe('true');
        expect(card(2).querySelector('[data-slot="issue-vote"]')?.textContent).toContain('1');
        expect(renders.board).toBe(1);
        expect(renders.cards).toBe(1);
        await refreshes();

        // Selection changes invalidate board props; unrelated refreshes then preserve the selection.
        await act(async () =>
            [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Select')!.click(),
        );
        await act(async () => card(2).click());
        expect(card(2).querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('true');
        expect(card(1).draggable).toBe(false);
        await refreshes();
        expect(card(2).querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('true');
    } finally {
        await act(async () => root.unmount());
        host.remove();
        router.dispose();
        closeChangeChannel();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        vi.useRealTimers();
    }
});
