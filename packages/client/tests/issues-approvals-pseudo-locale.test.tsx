// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Dictionary } from '@socio/i18n/keys';
import { pseudoDictionary } from '@socio/i18n/pseudo';
import { createReactI18n, I18nextProvider } from '@socio/i18n/react';
import ROUTES from '@socio/i18n/route-namespaces.json';
import type { ApprovalView, ApprovalsState } from '@socio/shared/approvals';
import { ATTACHMENT_HINT } from '@socio/shared/issues/issue-attachment-files';
import {
    ISSUE_STATUSES,
    issueSummary,
    type Issue,
    type IssueDetail,
    type IssueList,
} from '@socio/shared/issues/issue-types';
import type { AgentRunSummary, State, WorkspaceState } from '@socio/shared/types';
import type { PageI18n } from '@socio/shared/web/web';

import { ApprovalBar } from '../src/modules/approvals/ApprovalBar';
import { ApprovalCard } from '../src/modules/approvals/ApprovalCard';
import { FileIssueFromRun } from '../src/modules/issues/FileIssueFromRun';
import { OpenIssuesWidget } from '../src/modules/issues/OpenIssuesWidget';
import { openReport } from '../src/modules/issues/report';

import { fetchServices, createTestRouter } from './helpers/app-router';

// Issues and Approvals in en-XA, the pseudo-locale, through the app's real
// routes: each loader asks for its route's namespaces (route-namespaces.json)
// and gets them in en-XA, and what loads on demand comes from this server's
// files (the fetch below). Text that stays plain English was never
// translated, and a raw key means a route doesn't inline what its page
// shows. Only these modules' own parts of each page are read.

vi.mock('@copilotkit/react-core/v2', () => ({
    CopilotKitProvider: ({ children }: { children: unknown }) => children,
}));

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

vi.setConfig({ testTimeout: 30_000 });

const locales = join(import.meta.dirname, '../../i18n/locales/en-US');
const routes = ROUTES as unknown as Record<string, string[]>;
const pseudo = (ns: string) =>
    pseudoDictionary(JSON.parse(readFileSync(join(locales, `${ns}.json`), 'utf8')) as Dictionary);
const inlined = new Set(
    Object.entries(routes)
        .filter(([id]) => !id.startsWith('$'))
        .flatMap(([, namespaces]) => namespaces),
);
const own = (ns: string) => /^(?:issues|approvals)(?:\.|$)/.test(ns);

// What only loads on demand: the header's and other pages' parts (issues.slots)
// and the report dialog (issues.report).
const ON_DEMAND = ['issues.report', 'issues.slots'];
// What the issues and approvals routes inline and other pages load on demand
// (a chat's issue cards and approval cards, a socio's home page).
const ELSEWHERE = ['approvals.card', 'issues.form', 'issues.terms'];
// What this server serves on demand, per test: only ON_DEMAND unless a test
// reads other pages, so a namespace a route should inline but doesn't stays
// missing, and its keys show.
let served: string[] = ON_DEMAND;
const manifest = {
    release: '1.0.0',
    locales: {
        'en-XA': {
            coverage: 1,
            ns: Object.fromEntries(
                readdirSync(locales)
                    .map((name) => name.slice(0, -'.json'.length))
                    .filter((ns) => !inlined.has(ns) || ELSEWHERE.includes(ns))
                    .map((ns) => [ns, { hash: 'test', sourceHash: 'test' }]),
            ),
        },
    },
};
const pseudoPage = (namespaces: readonly string[]): PageI18n => ({
    locale: 'en-XA',
    dir: 'ltr',
    manifest,
    resources: { 'en-XA': Object.fromEntries(namespaces.map((ns) => [ns, pseudo(ns)])) },
    offered: ['en-US'],
});

const user = { id: 'u-ada', name: 'Ada', role: 'admin' as const };
const state = {
    settings: { name: 'Alpha', paused: false, researchAllowed: false, memoryAllowed: true },
    tasks: [],
    memories: [],
    mode: 'live',
    configured: true,
} as unknown as State;
const workspace = {
    user,
    spaces: [],
    dots: [{ id: 'd1', name: 'Bob', instructions: '', spaceIds: [], createdAt: 1 }],
    conversations: [],
    setup: { model: true, voice: false, telegram: 'not_configured', missing: [] },
    calls: [],
    preferences: {},
} as unknown as WorkspaceState;

/** The data words: names and text in the fixtures, and issue keys. */
const FIXTURE_TEXT = ['Alpha', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Theta', 'Iota', 'Kappa', 'Bob', 'Ada', 'CB'];
/**
 * Words that aren't these modules': shared components' (a dialog's close
 * button), packages/shared's copy (the attachment hint, the auto review's
 * reason line from `autoReasonLine`).
 */
const SHARED_TEXT = ['Close', ATTACHMENT_HINT, '(risk low)'];

const issue = (number: number, fields: Partial<Issue> = {}): Issue => ({
    id: `i${number}`,
    number,
    title: `Alpha ${number}`,
    body: 'Gamma',
    status: ISSUE_STATUSES[number % ISSUE_STATUSES.length]!,
    priority: 'high',
    kind: 'feature',
    area: 'server',
    labels: ['needs-decision', 'owner:lead'],
    reporterId: 'u-ada',
    assigneeId: 'u-ada',
    resolution: null,
    source: 'web',
    createdAt: 1,
    updatedAt: 2,
    closedAt: null,
    votes: 2,
    voted: false,
    demand: 2,
    openBlockers: [3],
    components: ['plugins:*', 'plugin:forms', 'app:crm'],
    ...fields,
});
const issues = ISSUE_STATUSES.map((_, index) => issue(index + 1));
const labels = {
    'plugins:*': { label: 'All plugins', kind: 'plugins', state: 'live' },
    'plugin:forms': { label: 'Delta', kind: 'plugin', state: 'disabled' },
    'app:crm': { label: 'Epsilon', kind: 'app', state: 'deleted', ownerName: 'Bob' },
} as const;
const list: IssueList = {
    issues: issues.map((item) => issueSummary(item)),
    users: { 'u-ada': 'Ada' },
    components: labels,
};
const detail: IssueDetail = {
    issue: issue(1, { status: 'blocked', resolution: 'Zeta' }),
    comments: [
        {
            id: 'k1',
            issueId: 'i1',
            authorKind: 'user',
            authorId: 'u-ada',
            body: 'Theta',
            createdAt: 3,
            editedAt: 4,
        },
    ],
    attachments: [],
    events: [
        ['created', null, null],
        ['status', 'open', 'blocked'],
        ['priority', 'low', 'high'],
        ['assignee', null, 'u-ada'],
        ['blocked_by', null, 'CB-3'],
        ['components', '[]', '["plugin:forms","app:crm"]'],
    ].map(([kind, fromValue, toValue], index) => ({
        id: `e${index}`,
        issueId: 'i1',
        actorId: 'u-ada',
        kind: kind as IssueDetail['events'][number]['kind'],
        fromValue,
        toValue,
        createdAt: 5,
    })),
    blockedBy: [{ number: 3, title: 'Alpha 3', status: 'ready' }],
    blocks: [],
    related: [{ number: 4, title: 'Alpha 4', status: 'done' }],
    triage: {
        state: 'proposed',
        kind: 'bug',
        area: 'client',
        priority: 'low',
        labels: ['ux'],
        components: ['plugin:forms'],
        reason: 'Iota',
        commentId: null,
        createdAt: 3,
        decidedAt: null,
        decidedBy: null,
    },
    requesters: [{ dotId: 'd1', userId: 'u-ada', createdAt: 3 }],
    filedBy: { dotId: 'd1', dotOwnerId: 'u-ada', userId: 'u-ada', trigger: 'chat', causeId: null, createdAt: 1 },
    users: { 'u-ada': 'Ada', 'dot:d1': 'Bob' },
    components: labels,
} as IssueDetail;

const approval = (id: string, fields: Partial<ApprovalView> = {}): ApprovalView => ({
    id,
    dotId: 'd1',
    dotName: 'Bob',
    capability: 'data.create_dataset',
    capabilityLabel: 'Kappa',
    summary: 'Theta',
    details: ['Iota'],
    status: 'pending',
    decidedVia: null,
    createdAt: 1,
    expiresAt: Date.now() + 86_400_000,
    decidedAt: null,
    outcome: null,
    ...fields,
});
const pending = approval('ap1');
const decided = approval('ap2', {
    status: 'approved',
    decidedVia: 'auto',
    decidedAt: 2,
    outcome: 'Zeta',
    auto: {
        verdict: 'approved',
        risk: 'low',
        reason: 'Gamma',
        cause: 'model',
        model: 'Delta',
        backend: 'shared',
        latencyMs: 1200,
        at: 2,
        undoneAt: null,
        undoOutcome: null,
        undoable: true,
    },
});
const approvals: ApprovalsState = {
    capabilities: [
        {
            id: 'data.create_dataset',
            label: 'Kappa',
            description: 'Iota',
            auto: { allowed: true, maxRisk: 'medium', rules: ['Theta'], undo: true },
        },
        {
            id: 'app.register',
            label: 'Epsilon',
            description: 'Iota',
            auto: { allowed: false, maxRisk: 'low', rules: [], undo: false },
        },
    ],
    pending: [pending],
    recent: [decided],
    policies: [{ dotId: 'd1', capability: 'data.create_dataset', policy: 'auto' }],
    audit: (['requested', 'auto_approved', 'policy_changed'] as const).map((event, index) => ({
        id: `a${index}`,
        dotId: 'd1',
        capability: 'data.create_dataset',
        requestId: 'ap2',
        event,
        actor: 'auto:Delta',
        detail: 'Zeta',
        createdAt: 2,
    })),
    guidance: 'Gamma',
} as ApprovalsState;

const respond = (path: string): [number, unknown] => {
    switch (path) {
        case '/api/workspace':
            return [200, workspace];
        case '/api/state':
            return [200, state];
        case '/api/issues':
            return [200, list];
        case '/api/issues/1':
            return [200, detail];
        case '/api/issues/assignees':
            return [200, { users: [{ id: 'u-ada', name: 'Ada' }], deactivated: [] }];
        case '/api/issues/components':
            return [200, { options: [{ ref: 'plugin:forms', label: 'Delta', kind: 'plugin', state: 'disabled' }] }];
        case '/api/issues/titles':
            return [200, issues.map(({ number, title, status }) => ({ number, title, status }))];
        case '/api/approvals':
            return [200, approvals];
        case '/api/approvals/ap1':
            return [200, pending];
        case '/api/dot-requests/notices':
            return [200, { notices: [] }];
        default:
            return [404, { error: 'Not found.' }];
    }
};

let host: HTMLElement;
let root: Root | undefined;
let fetched: string[] = [];
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    served = ON_DEMAND;
    fetched = [];
    Element.prototype.scrollIntoView ??= () => {};
    window.matchMedia = (query: string) =>
        ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as never;
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    vi.stubGlobal('fetch', async (input: string) => {
        const file = /^\/i18n\/en-XA\/(.+)\.test\.json$/.exec(String(input));
        if (file) {
            fetched.push(file[1]!);
            return served.includes(file[1]!) ? Response.json(pseudo(file[1]!)) : new Response('', { status: 404 });
        }
        const [status, body] = respond(new URL(input, 'http://app.test').pathname);
        return Response.json(body, { status });
    });
    host = document.createElement('div');
    document.body.append(host);
});
afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    host.remove();
    vi.unstubAllGlobals();
});

/** What a person reads in `node`, without the parts `skip` names (other modules'). */
function readable(node: Element, skip: readonly string[] = []) {
    const copy = node.cloneNode(true) as Element;
    // Times are the reader's locale's (Intl), not dictionary words.
    for (const selector of ['time', ...skip]) {
        for (const element of copy.querySelectorAll(selector)) {
            element.remove();
        }
    }
    const attributes = [...copy.querySelectorAll('[aria-label], [title], [placeholder], [alt]')].flatMap((element) =>
        ['aria-label', 'title', 'placeholder', 'alt']
            .map((name) => element.getAttribute(name))
            .filter((value): value is string => !!value),
    );
    return [copy.textContent ?? '', ...attributes];
}

/** The English left once every pseudo-locale string (in brackets) and the fixtures' words are taken out. */
function untranslated(texts: readonly string[]) {
    return texts.flatMap((text) => {
        let rest = text;
        for (let before = ''; before !== rest;) {
            before = rest;
            rest = rest.replace(/\[[^[\]]*\]/g, ' ');
        }
        for (const fixture of [...SHARED_TEXT, ...FIXTURE_TEXT]) {
            rest = rest.replaceAll(fixture, ' ');
        }
        return [...rest.matchAll(/\p{L}{2,}/gu)].map((match) => match[0]);
    });
}

async function settle(ticks = 8) {
    for (let tick = 0; tick < ticks; tick++) {
        await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    }
}

async function open(path: string) {
    const router = createTestRouter(path, {
        services: () => ({ ...fetchServices(), i18n: async (namespaces) => pseudoPage(namespaces) }),
    });
    root = createRoot(host);
    await act(async () => root!.render(<RouterProvider router={router} />));
    await settle();
    return router;
}

const $ = (selector: string) => {
    const found = document.querySelector(selector);
    expect(found, selector).not.toBeNull();
    return found!;
};

// Other modules' slots on the board and in an issue.
const BOARD_SKIP = ['[data-slot="issues-footer"]', '[data-slot="issue-batch-actions"]', '[data-slot="issue-actions"]'];

it('inlines every issues and approvals namespace on a route, or loads it on demand', () => {
    const ours = readdirSync(locales)
        .map((name) => name.slice(0, -'.json'.length))
        .filter(own);
    expect(ours.filter((ns) => !inlined.has(ns)).sort()).toEqual(ON_DEMAND);
    expect(ours.filter((ns) => inlined.has(ns) && !own(ns)).length).toBe(0);
    for (const id of ['issues', 'approvals', 'approvals:request']) {
        expect(routes[id], id).toBeDefined();
    }
});

it('renders the board, the list and their menus in en-XA with only their namespaces', async () => {
    localStorage.setItem('issues-view', 'board');
    await open('/issues');
    $('[data-slot="issue-board"]');
    expect(untranslated(readable($('main[data-slot="issues-page"]'), BOARD_SKIP))).toEqual([]);
    // Select mode's bar, then the list.
    const select = [...document.querySelectorAll<HTMLButtonElement>('main button[aria-pressed]')].find((button) =>
        button.querySelector('.lucide-square-check'),
    );
    await act(async () => select!.click());
    await settle();
    $('[data-slot="issue-batch-bar"]');
    expect(untranslated(readable($('main[data-slot="issues-page"]'), BOARD_SKIP))).toEqual([]);
    const listView = document.querySelectorAll<HTMLButtonElement>('[data-tour="issue-views"] button')[1]!;
    await act(async () => listView.click());
    await settle();
    $('[data-slot="issue-list"]');
    expect(untranslated(readable($('main[data-slot="issues-page"]'), BOARD_SKIP))).toEqual([]);
    localStorage.removeItem('issues-view');
});

it('renders an open issue in en-XA: fields, triage, links, requesters, comments and history', async () => {
    await open('/issues/CB-1');
    await settle(12);
    const dialog = $('[data-slot="issue-detail"]');
    $('[data-slot="issue-triage"]');
    $('[data-slot="issue-links"]');
    $('[data-slot="issue-requesters"]');
    $('[data-slot="issue-comment"]');
    expect(untranslated(readable(dialog, BOARD_SKIP))).toEqual([]);
    // The history tab.
    const history = dialog.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]!;
    await act(async () => {
        history.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        history.focus();
    });
    await settle();
    $('[data-slot="issue-history"]');
    expect(untranslated(readable(dialog, BOARD_SKIP))).toEqual([]);
});

it('opens the report dialog with its words loaded on demand', async () => {
    await open('/issues');
    await act(async () => openReport({ runId: 'r1' }));
    await settle();
    const form = $('[data-slot="report-issue-form"]');
    expect(untranslated(readable(form))).toEqual([]);
    expect(fetched).toContain('issues.report');
});

it.each(['/approvals', '/approvals/ap1'])('renders %s in en-XA with only its namespaces', async (path) => {
    await open(path);
    await settle(12);
    $('[data-slot="approval-card"]');
    expect(untranslated(readable($('[data-slot="app-body"]')))).toEqual([]);
});

it('renders a socio’s home page panels in en-XA once their words load', async () => {
    served = [...ON_DEMAND, ...ELSEWHERE];
    await open('/dots/d1');
    await settle(12);
    for (const panel of ['approvals', 'filings']) {
        expect(untranslated(readable($(`[data-panel="${panel}"]`))), panel).toEqual([]);
    }
});

it('opens an issue from the board with no request for its words', async () => {
    const asked: string[] = [];
    const router = createTestRouter('/issues', {
        services: () => ({
            ...fetchServices(),
            i18n: async (namespaces) => {
                asked.push(...namespaces);
                return pseudoPage(namespaces);
            },
        }),
    });
    root = createRoot(host);
    await act(async () => root!.render(<RouterProvider router={router} />));
    await settle();
    expect(asked).toEqual(expect.arrayContaining(routes.issues!));
    asked.length = 0;
    fetched = [];
    await act(async () => router.navigate('/issues/CB-1'));
    await settle(12);
    $('[data-slot="issue-detail"]');
    expect(asked).toEqual([]);
    expect(fetched).toEqual([]);
});

/** A server render with the root's namespaces only (its instance has no backend). */
function serverRender(node: ReactNode) {
    const server = createReactI18n({
        locale: 'en-XA',
        resources: { 'en-XA': Object.fromEntries(routes.root!.map((ns) => [ns, pseudo(ns)])) },
        namespaces: routes.root!,
    });
    return renderToString(<I18nextProvider i18n={server}>{node}</I18nextProvider>);
}

it('renders nothing on the server for what loads on demand, never its keys', () => {
    const run = { runId: 'r1', status: 'failed', title: 'Alpha' } as AgentRunSummary;
    expect(serverRender(<FileIssueFromRun run={run} />)).toBe('');
    expect(serverRender(<OpenIssuesWidget />)).toBe('');
    expect(serverRender(<ApprovalCard id="ap1" initial={pending} />)).toBe('');
    expect(serverRender(<ApprovalBar pending={[]} onShow={() => {}} />)).toBe('');
});
