// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
    PROPOSAL_PAGE,
    droppedWhy,
    type LearningContainerDetail,
    type LearningContainerSummary,
    type LearningProposalView,
} from '@socio/shared/learning';
import type { LearningSeamView } from '@socio/shared/learning';
import type { WorkspaceState } from '@socio/shared/types';

import { LearningView, ScopeSettings, runLine, triageLine } from '../src/modules/learning/LearningView';
import { CurrentUser } from '../src/shell/current-user';
import { ShellContext, type Shell } from '../src/shell/shell-context';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The container's proposals as the server keeps them, newest first
// (createdAt, then id); the fake server below pages them as the API does.
let proposals: LearningProposalView[];
let requests: string[];
let root: Root;
let host: HTMLDivElement;

const proposal = (index: number, createdAt = 1_000 - index) => ({
    id: `p${String(index).padStart(3, '0')}`,
    name: `skill-${index}`,
    description: `Proposal ${index}.`,
    evidenceThreadIds: ['t1'],
    status: 'pending' as const,
    createdAt,
});
const ordered = () => [...proposals].sort((a, b) => b.createdAt - a.createdAt || (b.id < a.id ? -1 : 1));
const cursorOf = (p: LearningProposalView) => `${p.createdAt}:${p.id}`;
function page(limit: number, cursor?: string) {
    const all = ordered();
    const start = cursor ? all.findIndex((p) => cursorOf(p) === cursor) + 1 : 0;
    const items = all.slice(start, start + limit);
    return {
        items,
        ...(start + limit < all.length ? { nextCursor: cursorOf(items.at(-1)!) } : {}),
    };
}
function detail(): LearningContainerDetail {
    const first = page(PROPOSAL_PAGE);
    return {
        id: 'research',
        newEvidence: 0,
        running: false,
        configured: true,
        runs: [],
        proposals: first.items,
        ...(first.nextCursor ? { proposalsCursor: first.nextCursor } : {}),
        published: [],
        revision: 0,
        pinned: null,
        delivered: 0,
    };
}
const summary: LearningContainerSummary = {
    id: 'research',
    dots: [],
    newEvidence: 0,
    pendingProposals: 0,
    published: 0,
    running: false,
    lastRun: null,
};

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    proposals = Array.from({ length: 60 }, (_, index) => proposal(index));
    requests = [];
    vi.stubGlobal('fetch', async (input: string) => {
        const url = new URL(input, 'http://app.test');
        requests.push(`${url.pathname}${url.search}`);
        if (url.pathname === '/api/learning/containers') {
            return Response.json([summary]);
        }
        if (url.pathname === '/api/learning/containers/research') {
            return Response.json(detail());
        }
        if (url.pathname === '/api/learning/containers/research/proposals') {
            return Response.json(
                page(Number(url.searchParams.get('limit')), url.searchParams.get('cursor') ?? undefined),
            );
        }
        if (url.pathname === '/api/learning/proposals/p000') {
            return Response.json({
                proposal: { ...proposals[0], skillMd: '# Skill', rationale: '' },
                evidence: [],
                current: null,
            });
        }
        return Response.json({ error: 'Not found.' }, { status: 404 });
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

async function until(check: () => boolean, what: string) {
    for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${host.textContent}`);
}
const listed = () =>
    [...host.querySelectorAll('[data-slot="learning-proposal"] strong')].map((name) => name.textContent);
const loadMore = () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Load more');

it('creates a scope assignment from Learning and reports the saved result', async () => {
    const onSaved = vi.fn();
    const dot = {
        id: 'researcher',
        name: 'Researcher',
        learningContainerId: null,
        skillDeliveryEnabled: false,
    };
    const writes: unknown[] = [];
    vi.stubGlobal('fetch', async (_input: string, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
            const update = JSON.parse(String(init.body));
            writes.push(update);
            return Response.json({ ...dot, ...update });
        }
        return Response.json([dot]);
    });
    act(() => root.render(<ScopeSettings onSaved={onSaved} />));
    act(() => host.querySelector('button')!.click());
    await until(() => !!host.querySelector('#learning-scope-id'), 'scope editor');
    const input = host.querySelector<HTMLInputElement>('#learning-scope-id')!;
    const toggle = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(toggle.disabled).toBe(true);
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'new-scope');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(toggle.disabled).toBe(false);
    act(() => toggle.click());
    act(() => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await until(() => onSaved.mock.calls.length === 1, 'scope saved');
    expect(writes).toEqual([{ learningContainerId: 'new-scope', skillDeliveryEnabled: true }]);
    expect(host.textContent).toContain('Scope saved.');
    expect(host.textContent).toContain('existing evidence and published skills stay in their original scope');
});

// The shell with the flags the server decided for alice: `learning-analyze-now` on or off.
const shellWith = (analyzeNow: boolean) =>
    ({
        workspace: {
            user: { id: 'alice', name: 'Alice', role: 'admin' },
            flags: { on: analyzeNow ? ['learning-analyze-now'] : [] },
        } as unknown as WorkspaceState,
    }) as unknown as Shell;
const renderContainer = (analyzeNow: boolean, open: LearningContainerDetail) =>
    act(() =>
        root.render(
            <ShellContext.Provider value={shellWith(analyzeNow)}>
                <CurrentUser.Provider value={{ id: 'alice', name: 'Alice', role: 'admin' }}>
                    <LearningView initial={{ admin: true, containers: [summary], open }} />
                </CurrentUser.Provider>
            </ShellContext.Provider>,
        ),
    );
const analyzeButton = () => [...host.querySelectorAll('button')].find((item) => item.textContent === 'Analyze now');

it.each([false, true])('explains why manual analysis cannot start (configured=%s)', (configured) => {
    renderContainer(true, { ...detail(), configured, newEvidence: 0 });
    const button = analyzeButton()!;
    expect(button.disabled).toBe(true);
    const reason = host.querySelector(`#${button.getAttribute('aria-describedby')}`)!;
    expect(reason.textContent).toContain(configured ? 'No new finished conversations' : 'enabled default shared model');
});

it('shows Analyze now only while the learning-analyze-now flag is on', () => {
    // Off (the default): no button, nothing mentions it, and nothing is asked of the route.
    renderContainer(false, { ...detail(), configured: true, newEvidence: 3, proposals: [] });
    expect(analyzeButton()).toBeUndefined();
    expect(host.textContent).not.toContain('Analyze now');
    expect(host.textContent).toContain('Analysis runs daily after 02:00 server time and catches up after downtime.');
    expect(requests.filter((request) => request.endsWith('/analyze'))).toEqual([]);
    // A running analysis can still be canceled. (A new root for each state.)
    const fresh = () => {
        act(() => root.unmount());
        root = createRoot(host);
    };
    fresh();
    renderContainer(false, { ...detail(), running: true });
    expect([...host.querySelectorAll('button')].some((item) => item.textContent === 'Cancel analysis')).toBe(true);
    // On: the button is there and enabled once there is new evidence, as before.
    fresh();
    renderContainer(true, { ...detail(), configured: true, newEvidence: 3, proposals: [] });
    expect(analyzeButton()?.disabled).toBe(false);
    expect(host.textContent).toContain('starts now with Analyze now');
});

it('shows the first page, loads the next on "Load more" and keeps both fresh', async () => {
    act(() =>
        root.render(
            <CurrentUser.Provider value={{ id: 'alice', name: 'Alice', role: 'admin' }}>
                <LearningView initial={{ admin: true, containers: [summary], open: detail() }} />
            </CurrentUser.Provider>,
        ),
    );
    // The loader's first page, and nothing asked for yet.
    expect(listed()).toEqual(
        ordered()
            .slice(0, 25)
            .map((p) => p.name),
    );
    expect(requests).toEqual([]);

    act(() => loadMore()!.click());
    await until(() => listed().length === 50, 'the second page');
    expect(listed()).toEqual(
        ordered()
            .slice(0, 50)
            .map((p) => p.name),
    );
    expect(requests.at(-1)).toMatch(/^\/api\/learning\/containers\/research\/proposals\?bodies=false&limit=25&cursor=/);

    // A new proposal and a review elsewhere: the poll shows both and keeps
    // all 50 the user loaded, now 51, with none twice.
    proposals.push(proposal(100, 5_000));
    proposals[30] = { ...proposals[30]!, status: 'rejected' };
    requests = [];
    await act(async () => {
        vi.advanceTimersByTime(3_000);
    });
    await until(() => listed().length === 51, 'the poll');
    expect(listed()).toEqual(
        ordered()
            .slice(0, 51)
            .map((p) => p.name),
    );
    expect(host.textContent).toContain('rejected · 1 evidence');
    // One read past the first page, for as many as were shown after it.
    expect(requests).toEqual([
        '/api/learning/containers/research?bodies=false',
        expect.stringMatching(/\/proposals\?bodies=false&limit=26&cursor=/),
    ]);

    // The last page: 61 in all, and no more to load.
    act(() => loadMore()!.click());
    await until(() => listed().length === 61, 'the last page');
    expect(loadMore()).toBeUndefined();
});

it('marks the open container and review, and keeps fields at 16px on phones', async () => {
    act(() =>
        root.render(
            <CurrentUser.Provider value={{ id: 'alice', name: 'Alice', role: 'admin' }}>
                <LearningView initial={{ admin: true, containers: [summary], open: detail() }} />
            </CurrentUser.Provider>,
        ),
    );
    const nav = host.querySelector('nav[aria-label="Learning containers"]')!;
    expect(nav.querySelector('[aria-current="true"]')?.textContent).toContain('research');
    const name = [...host.querySelectorAll('button')].find((button) => button.textContent === 'skill-0')!;
    expect(name.getAttribute('aria-expanded')).toBe('false');
    act(() => name.click());
    await until(() => !!host.querySelector('#skill-body'), 'the review');
    expect(name.getAttribute('aria-expanded')).toBe('true');
    // iOS zooms in on a field under 16px (CB-96): 16px below md.
    for (const id of ['skill-name', 'skill-description', 'skill-body']) {
        expect(host.querySelector(`#${id}`)!.className).toMatch(/(^| )text-base( |$).*md:text-(sm|xs)/);
    }
});

it('says why a run dropped proposals', () => {
    expect(droppedWhy({ rejected: 2, malformed: 1 })).toBe(' (2 already rejected, 1 malformed)');
    expect(droppedWhy({ published: 1, 'private-data': 1 })).toBe(' (1 already published, 1 with private details)');
    // Runs from before reasons were kept.
    expect(droppedWhy({})).toBe('');
    expect(droppedWhy(undefined)).toBe('');
});

it('shows Learning’s triage on the seam, and lets an admin label a conversation (CB-200)', async () => {
    const triage: LearningSeamView = {
        enabled: true,
        available: true,
        version: 'workspace:qwen/p1',
        passed: false,
        threshold: 0.9,
        perDay: 200,
        callsToday: 3,
        tokensToday: 1_200,
        costToday: null,
        golden: 4,
        intentRecurrence: 5,
        threads: [
            {
                threadId: 't1',
                title: 'Weekly report',
                finishedAt: 10,
                pending: true,
                label: null,
                score: 0.82,
                applied: false,
                intent: 'write',
            },
            {
                threadId: 't2',
                title: '',
                finishedAt: 9,
                pending: false,
                label: { value: 'one-off', source: 'admin', at: 5 },
                score: null,
                applied: false,
                intent: null,
            },
        ],
    };
    const writes: Array<{ path: string; body: unknown }> = [];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://app.test');
        if (init?.method === 'PUT') {
            writes.push({ path: url.pathname, body: JSON.parse(String(init.body)) });
            return Response.json(null);
        }
        if (url.pathname === '/api/learning/containers/research') {
            return Response.json({ ...detail(), triage });
        }
        return Response.json([summary]);
    });
    act(() =>
        root.render(
            <CurrentUser.Provider value={{ id: 'alice', name: 'Alice', role: 'admin' }}>
                <LearningView
                    initial={{
                        admin: true,
                        containers: [summary],
                        open: { ...detail(), triage },
                    }}
                />
            </CurrentUser.Provider>,
        ),
    );
    const status = host.querySelector('[data-slot="learning-triage-status"]')!;
    expect(status.textContent).toContain('On, with workspace:qwen/p1.');
    expect(status.textContent).toContain('Suggestions only');
    expect(status.textContent).toContain('4 of at least 20');
    expect(status.textContent).toContain('3 of 200 calls');
    expect(status.textContent).toContain('cost not reported');
    expect(status.querySelector('a')!.getAttribute('href')).toBe('/operations/settings');
    const items = [...host.querySelectorAll('[data-slot="learning-triage-item"]')];
    expect(items.map((item) => item.textContent)).toEqual([
        expect.stringContaining('model: 82% repeatable · intent: Write'),
        expect.stringContaining('Untitled conversation'),
    ]);
    expect(items[1]!.textContent).toContain('One-off (admin)');
    const pressed = [...items[1]!.querySelectorAll('button')].map((b) => b.getAttribute('aria-pressed'));
    expect(pressed).toEqual(['false', 'true']);
    const oneOff = [...items[0]!.querySelectorAll('button')].find((button) => button.textContent === 'One-off')!;
    act(() => oneOff.click());
    await until(() => writes.length === 1, 'the label');
    expect(writes).toEqual([{ path: '/api/learning/threads/t1/triage', body: { label: 'one-off' } }]);
});

it('says what a run left out and what it used', () => {
    const run = {
        id: 'r',
        trigger: 'intent',
        status: 'succeeded',
        startedAt: 1,
        threads: 5,
        proposals: 1,
        dropped: 2,
        dropReasons: { 'model-duplicate': 1, 'model-private': 1 },
        skipped: 3,
        inputTokens: 1_000,
        outputTokens: 234,
        costUsd: 0.0123,
        error: null,
    } as const;
    expect(runLine(run)).toBe(
        ' Last run: succeeded (intent), 1 proposal, 2 dropped (1 judged a repeat by the model, 1 judged private by the model), 3 conversations left out by triage, 1,234 tokens, $0.0123.',
    );
    // Runs from before CB-200 have none of it.
    expect(
        runLine({
            ...run,
            dropped: 0,
            dropReasons: {},
            skipped: undefined as never,
            inputTokens: undefined as never,
            outputTokens: undefined as never,
            costUsd: undefined as never,
        }),
    ).toBe(' Last run: succeeded (intent), 1 proposal.');
    expect(
        triageLine({
            label: 'repeatable',
            source: 'model',
            score: 0.9,
            intent: null,
        }),
    ).toBe('Shows a repeatable procedure · model: 90% repeatable');
});
