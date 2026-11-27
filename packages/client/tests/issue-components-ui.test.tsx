// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { AppsState } from '@socio/shared/apps/app-types';
import type { IssueComponentLabel, IssueComponentOption } from '@socio/shared/issues/issue-components';
import {
    issueSummary,
    type Issue,
    type IssueDetail,
    type IssueEvent,
    type IssueList,
} from '@socio/shared/issues/issue-types';
import type { State, User, WorkspaceState } from '@socio/shared/types';

import { AppsPage } from '../src/modules/apps/AppsPage';
import { IssueBoard } from '../src/modules/issues/IssueBoard';
import { IssueHistory } from '../src/modules/issues/IssueComments';
import {
    ComponentChips,
    ComponentPicker,
    componentFacetOptions,
    componentsOf,
    draftedComponents,
    filterByComponents,
    groupOptions,
} from '../src/modules/issues/IssueComponents';
import { IssueDetailDialog } from '../src/modules/issues/IssueDetail';
import { IssuesPage } from '../src/modules/issues/IssuesPage';
import { closeReport, openReport } from '../src/modules/issues/report';
import { ReportIssue } from '../src/modules/issues/ReportIssue';
import { ShellContext, type Shell } from '../src/shell/shell-context';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const alice: User = { id: 'alice', name: 'Alice', role: 'admin' };
const bob: User = { id: 'bob', name: 'Bob', role: 'member' };

function issue(fields: Partial<Issue> = {}): Issue {
    const number = fields.number ?? 1;
    return {
        id: `i${number}`,
        number,
        title: `Issue ${number}`,
        body: '',
        status: 'open',
        priority: 'medium',
        kind: 'bug',
        area: null,
        labels: [],
        reporterId: 'bob',
        assigneeId: null,
        resolution: null,
        source: 'web',
        createdAt: 1,
        updatedAt: 1,
        closedAt: null,
        ...fields,
    };
}
const row = (fields: Partial<Issue> = {}) => issueSummary(issue(fields));

/**
 * The labels the server sends. The names deliberately differ from the
 * refs, so a name made from a ref would show.
 */
const labels: Record<string, IssueComponentLabel> = {
    'plugins:*': { label: 'All plugins', kind: 'plugins', state: 'live' },
    'apps:*': { label: 'All apps', kind: 'apps', state: 'live' },
    'plugin:forms': { label: 'Feedback Forms', kind: 'plugin', state: 'live' },
    'plugin:old': { label: 'Old Planner', kind: 'plugin', state: 'uninstalled' },
    'app:crm': { label: 'Customer Desk', kind: 'app', state: 'live', ownerName: 'Carol' },
    'app:crm@5': { label: 'Former CRM', kind: 'app', state: 'deleted', ownerName: 'Carol' },
};
const options: IssueComponentOption[] = [
    { ref: 'plugins:*', label: 'All plugins', kind: 'plugins' },
    { ref: 'apps:*', label: 'All apps', kind: 'apps' },
    { ref: 'plugin:calendar', label: 'Calendar', kind: 'plugin', state: 'disabled' },
    { ref: 'plugin:forms', label: 'Feedback Forms', kind: 'plugin', state: 'live' },
    { ref: 'app:crm', label: 'Customer Desk', kind: 'app', ownerName: 'Carol' },
    { ref: 'app:garden', label: 'Garden Plan', kind: 'app', ownerName: 'José' },
];

let root: Root;
let host: HTMLElement;
let routes: Record<string, (init?: RequestInit) => [number, unknown]>;
let calls: { method: string; path: string; body?: unknown }[];

function shellFor(user: User): Shell {
    const workspace = {
        user,
        spaces: [],
        dots: [],
        conversations: [],
        setup: { missing: [] },
        calls: [],
    } as unknown as WorkspaceState;
    return {
        state: { settings: { name: 'Brain', paused: false } } as unknown as State,
        workspace,
        admin: user.role === 'admin',
        configured: true,
        homeDot: { id: 'd1', name: 'Socio' },
    } as unknown as Shell;
}

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    window.matchMedia = (query: string) =>
        ({
            matches: false,
            media: query,
            addEventListener: () => {},
            removeEventListener: () => {},
        }) as unknown as MediaQueryList;
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;
    routes = { 'GET /api/issues/components': () => [200, { options }] };
    calls = [];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://app.test');
        const method = init?.method ?? 'GET';
        calls.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const handler = routes[`${method} ${url.pathname}`];
        const [status, body] = handler ? handler(init) : [404, { error: 'Not found.' }];
        return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => closeReport());
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

async function until(check: () => boolean, what: string) {
    for (let i = 0; i < 200; i++) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${document.body.textContent}`);
}
function render(node: ReactNode, user: User = alice, path = '/') {
    act(() =>
        root.render(
            <ShellContext.Provider value={shellFor(user)}>
                <MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>
            </ShellContext.Provider>,
        ),
    );
}
const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T>(selector);
const $$ = <T extends Element = HTMLElement>(selector: string) => [...document.body.querySelectorAll<T>(selector)];
const byLabel = (label: string) => $(`[aria-label="${label}"]`);
const chips = (scope: ParentNode = document.body) =>
    [...scope.querySelectorAll<HTMLElement>('[data-slot="issue-component"]')].map((chip) => chip.dataset.ref);
const setValue = (element: HTMLInputElement, value: string) => {
    const proto = Object.getPrototypeOf(element) as object;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
};
const openPicker = () => act(() => $('[data-slot="issue-components-add"]')!.click());
const groups = () =>
    $$('[data-slot="issue-components-group"]').map((group) => [
        group.getAttribute('aria-label'),
        [...group.querySelectorAll<HTMLElement>('[data-slot="issue-components-option"]')].map(
            (option) => option.dataset.ref,
        ),
    ]);

// --- Pure helpers ------------------------------------------------------------

it('drafts a plugin’s ref on its pages, and keeps only refs among the reader’s options', () => {
    expect(componentsOf('/plugins/forms')).toEqual(['plugin:forms']);
    expect(componentsOf('/plugins/forms/open')).toEqual(['plugin:forms']);
    expect(componentsOf('/plugins/forms/manage')).toEqual(['plugin:forms']);
    // A deep link and the plugin's settings page are about it too (CB-446).
    expect(componentsOf('/plugins/forms/responses/42')).toEqual(['plugin:forms']);
    expect(componentsOf('/settings/plugins/forms')).toEqual(['plugin:forms']);
    expect(componentsOf('/settings/plugins/forms/')).toEqual(['plugin:forms']);
    expect(componentsOf('/settings/plugins')).toBeUndefined();
    expect(componentsOf('/settings/people/forms')).toBeUndefined();
    expect(componentsOf('/plugins')).toBeUndefined();
    expect(componentsOf('/apps')).toBeUndefined();
    expect(componentsOf('/chats/c1')).toBeUndefined();
    // Nothing until the options are known; then only what they hold.
    expect(draftedComponents(['plugin:forms'], undefined)).toEqual([]);
    expect(draftedComponents(['plugin:forms', 'plugin:secret'], options)).toEqual(['plugin:forms']);
    expect(draftedComponents(undefined, options)).toEqual([]);
});

it('offers the facet only the label map’s refs on the list, and matches them exactly', () => {
    const issues = [
        row({ number: 1, components: ['plugin:forms'] }),
        row({ number: 2, components: ['plugins:*'] }),
        row({ number: 3, components: ['app:crm', 'plugin:forms'] }),
        row({ number: 4 }),
    ];
    // `plugin:old` is in the map but on no listed issue: no empty value.
    expect(componentFacetOptions(issues, labels)).toEqual(['plugins:*', 'plugin:forms', 'app:crm']);
    // A ref with no label (one the reader can't see) is never offered.
    expect(componentFacetOptions([row({ components: ['plugin:hidden'] })], labels)).toEqual([]);
    // A chosen value stays, to be unchecked.
    expect(componentFacetOptions(issues, labels, ['plugin:old'])).toContain('plugin:old');
    const numbers = (chosen: string[]) => filterByComponents(issues, chosen).map((item) => item.number);
    expect(numbers([])).toEqual([1, 2, 3, 4]);
    // "All plugins" is its own value: it doesn't match one plugin, nor the reverse.
    expect(numbers(['plugins:*'])).toEqual([2]);
    expect(numbers(['plugin:forms'])).toEqual([1, 3]);
    expect(numbers(['app:crm', 'plugins:*'])).toEqual([2, 3]);
});

it('groups the options All, Plugins and Apps, and searches names and owners', () => {
    const ids = (query: string) => groupOptions(options, query).map((group) => group.id);
    expect(ids('')).toEqual(['all', 'plugins', 'apps']);
    expect(groupOptions(options, 'garden').map((group) => [group.id, group.options.map((o) => o.ref)])).toEqual([
        ['apps', ['app:garden']],
    ]);
    // By owner, accents folded.
    expect(groupOptions(options, 'jose').flatMap((group) => group.options.map((o) => o.ref))).toEqual(['app:garden']);
    expect(groupOptions(options, 'nothing like it')).toEqual([]);
});

// --- The picker --------------------------------------------------------------

it('picks components in groups with a search, owners and disabled plugins marked, at most ten', async () => {
    let value: string[] = ['plugin:old'];
    const onChange = vi.fn((next: string[]) => {
        value = next;
        draw();
    });
    const draw = () => render(<ComponentPicker value={value} onChange={onChange} options={options} labels={labels} />);
    draw();
    // A ref that is no longer an option stays, by its label, and removable.
    expect(chips()).toEqual(['plugin:old']);
    expect($('[data-slot="issue-component"]')!.textContent).toBe('Old Planner(uninstalled)');
    expect($('[data-slot="issue-component"]')!.dataset.state).toBe('uninstalled');
    openPicker();
    await until(() => !!$('[data-slot="issue-components-picker"]'), 'the picker');
    expect(groups()).toEqual([
        ['All', ['plugins:*', 'apps:*']],
        ['Plugins', ['plugin:calendar', 'plugin:forms']],
        ['Apps', ['app:crm', 'app:garden']],
    ]);
    const option = (ref: string) => $(`[data-slot="issue-components-option"][data-ref="${ref}"]`)!;
    expect(option('plugin:calendar').textContent).toBe('Calendaroff');
    expect(option('app:crm').textContent).toBe('Customer DeskCarol');
    // Search narrows the list.
    act(() => setValue(byLabel('Search components') as HTMLInputElement, 'desk'));
    expect(groups()).toEqual([['Apps', ['app:crm']]]);
    act(() => option('app:crm').querySelector('input')!.click());
    expect(value).toEqual(['plugin:old', 'app:crm']);
    // Removing the uninstalled one.
    act(() => (byLabel('Remove Old Planner') as HTMLButtonElement).click());
    expect(value).toEqual(['app:crm']);

    // Ten chosen: the rest can't be checked; a chosen one can still be unchecked.
    value = Array.from({ length: 10 }, (_, i) => `plugin:p${i}`);
    value[0] = 'plugin:forms';
    draw();
    act(() => setValue(byLabel('Search components') as HTMLInputElement, ''));
    await until(() => !!$('[data-slot="issue-components-full"]'), 'the cap note');
    expect(option('app:garden').querySelector('input')!.disabled).toBe(true);
    expect(option('plugin:forms').querySelector('input')!.disabled).toBe(false);
    act(() => option('plugin:forms').querySelector('input')!.click());
    expect(value).toHaveLength(9);
    expect(value).not.toContain('plugin:forms');
});

it('shows read-only chips with no picker when disabled', () => {
    render(<ComponentPicker value={['app:crm']} onChange={() => {}} options={options} labels={labels} disabled />);
    expect(chips()).toEqual(['app:crm']);
    expect($('[data-slot="issue-components-add"]')).toBeNull();
    expect(byLabel('Remove Customer Desk')).toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    render(<ComponentPicker value={[]} onChange={() => {}} options={options} disabled />);
    expect($('[data-slot="issue-components-field"]')!.textContent).toBe('None');
});

// --- Chips -------------------------------------------------------------------

it('shows two chips at most on a card, then +n, the gone ones muted', () => {
    render(<ComponentChips refs={['plugin:forms', 'app:crm@5', 'apps:*', 'plugin:old']} labels={labels} />);
    expect(chips()).toEqual(['plugin:forms', 'app:crm@5']);
    const [live, deleted] = $$('[data-slot="issue-component"]');
    expect(live!.textContent).toBe('Feedback Forms');
    expect(live!.querySelector('svg')).not.toBeNull();
    expect(deleted!.textContent).toBe('Former CRM(deleted)');
    expect(deleted!.dataset.state).toBe('deleted');
    expect(deleted!.className).toContain('text-muted-foreground/70');
    expect(deleted!.title).toBe('Component: Former CRM, owned by Carol, deleted');
    const more = $('[data-slot="issue-components-more"]')!;
    expect(more.textContent).toBe('+2');
    expect(more.title).toBe('All apps, Old Planner');
    act(() => root.unmount());
    root = createRoot(host);
    render(<ComponentChips refs={[]} labels={labels} />);
    expect(host.innerHTML).toBe('');
});

it('puts the chips on board cards, named by the list’s label map', () => {
    render(
        <IssueBoard
            issues={[row({ number: 3, components: ['plugin:forms', 'app:crm', 'apps:*'] })]}
            users={{}}
            components={labels}
            statuses={['open']}
            canMove={false}
            onMove={() => {}}
            selection={{ active: false, selected: new Set(), toggle: () => {} }}
        />,
    );
    const card = $('[data-issue="CB-3"]')!;
    expect(chips(card)).toEqual(['plugin:forms', 'app:crm']);
    expect(card.textContent).toContain('Feedback Forms');
    expect(card.textContent).toContain('Customer Desk');
    expect(card.querySelector('[data-slot="issue-components-more"]')?.textContent).toBe('+1');
});

// --- The board's facet -------------------------------------------------------

it('filters the board by a Component facet built from the list’s label map', async () => {
    const list: IssueList = {
        issues: [
            row({ number: 1, components: ['plugin:forms'] }),
            row({ number: 2, components: ['plugins:*'] }),
            row({ number: 3 }),
        ],
        users: {},
        components: {
            'plugin:forms': labels['plugin:forms']!,
            'plugins:*': labels['plugins:*']!,
            // On no listed issue: not offered.
            'app:crm': labels['app:crm']!,
        },
    };
    routes['GET /api/issues'] = () => [200, list];
    const router = createMemoryRouter([{ path: '/issues', element: <IssuesPage /> }], { initialEntries: ['/issues'] });
    act(() =>
        root.render(
            <ShellContext.Provider value={shellFor(bob)}>
                <RouterProvider router={router} />
            </ShellContext.Provider>,
        ),
    );
    await until(() => !!$('[data-issue="CB-1"]'), 'the board');
    const shown = () => $$('[data-slot="issue-card"]').map((card) => card.dataset.issue);
    expect(shown()).toEqual(['CB-1', 'CB-2', 'CB-3']);
    act(() => {
        byLabel('Filter by component')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    const items = () => $$('[role="menuitemcheckbox"]');
    await until(() => items().length > 0, 'the facet menu');
    expect(items().map((item) => item.textContent)).toEqual(['All plugins', 'Feedback Forms']);
    act(() => items()[0]!.click());
    await until(() => shown().length === 1, 'the filter');
    // Exact: "All plugins" doesn't match the issue tagged with one plugin.
    expect(shown()).toEqual(['CB-2']);
    expect($('[data-slot="issue-toolbar-count"]')?.textContent).toBe('1 of 3');
});

it('leaves the facet out when no listed issue has a component', async () => {
    routes['GET /api/issues'] = () => [200, { issues: [row({ number: 1 })], users: {}, components: {} }];
    const router = createMemoryRouter([{ path: '/issues', element: <IssuesPage /> }], { initialEntries: ['/issues'] });
    act(() =>
        root.render(
            <ShellContext.Provider value={shellFor(bob)}>
                <RouterProvider router={router} />
            </ShellContext.Provider>,
        ),
    );
    await until(() => !!$('[data-issue="CB-1"]'), 'the board');
    expect(byLabel('Filter by component')).toBeNull();
});

// --- The detail --------------------------------------------------------------

const event = (fields: Partial<IssueEvent>): IssueEvent => ({
    id: 'e',
    issueId: 'i9',
    actorId: 'alice',
    kind: 'components',
    fromValue: null,
    toValue: null,
    createdAt: 1,
    ...fields,
});

it('tells components changes in words, by the label map’s names', () => {
    render(
        <IssueHistory
            users={{ alice: 'Alice' }}
            components={labels}
            events={[
                event({ id: 'e1', fromValue: null, toValue: '["plugin:forms"]' }),
                event({ id: 'e2', fromValue: '["plugin:forms"]', toValue: '["app:crm","apps:*","plugin:forms"]' }),
                event({ id: 'e3', fromValue: '["app:crm","plugin:old"]', toValue: '["plugins:*"]' }),
                event({ id: 'e4', fromValue: '["app:crm@5"]', toValue: null }),
            ]}
        />,
    );
    expect(
        $$('[data-slot="issue-event"]').map((item) => item.querySelectorAll('span')[1]!.textContent?.trim()),
    ).toEqual([
        'added the component Feedback Forms',
        'added the components Customer Desk and All apps',
        'added the component All plugins; removed the components Customer Desk and Old Planner',
        'removed the component Former CRM',
    ]);
});

function detailOf(fields: Partial<Issue>, extra: Partial<IssueDetail> = {}): IssueDetail {
    return {
        issue: issue({ number: 9, ...fields }),
        comments: [],
        attachments: [],
        events: [],
        blockedBy: [],
        blocks: [],
        users: { alice: 'Alice', bob: 'Bob' },
        components: labels,
        ...extra,
    };
}
async function openDetail(detail: IssueDetail, user: User, update = async () => detail) {
    routes['GET /api/issues/9'] = () => [200, detail];
    routes['GET /api/issues/assignees'] = () => [200, { users: [{ id: 'alice', name: 'Alice' }] }];
    render(
        <IssueDetailDialog
            number={9}
            user={user}
            update={update}
            onChanged={() => {}}
            onDeleted={() => {}}
            onClose={() => {}}
        />,
        user,
    );
    await until(() => !!$('[data-slot="issue-comment-form"]'), 'the detail');
}

it('lets admins edit components in the detail; members see chips', async () => {
    const detail = detailOf({ components: ['app:crm@5', 'plugin:forms'] });
    const update = vi.fn(async (_number: number, change: { components?: string[] }) => ({
        ...detail,
        issue: { ...detail.issue, ...change },
    }));
    await openDetail(detail, alice, update as never);
    const field = () => $('[data-slot="issue-components-field"]')!;
    expect(chips(field())).toEqual(['app:crm@5', 'plugin:forms']);
    await until(() => !($('[data-slot="issue-components-add"]') as HTMLButtonElement).disabled, 'the options');
    // The deleted app is no longer an option but is removable.
    act(() => (byLabel('Remove Former CRM') as HTMLButtonElement).click());
    await until(() => update.mock.calls.length === 1, 'the change');
    expect(update.mock.calls[0]).toEqual([9, { components: ['plugin:forms'] }]);
    openPicker();
    await until(() => !!$('[data-slot="issue-components-picker"]'), 'the picker');
    act(() => $('[data-ref="apps:*"] input')!.click());
    await until(() => update.mock.calls.length === 2, 'the second change');
    expect(update.mock.calls[1]).toEqual([9, { components: ['plugin:forms', 'apps:*'] }]);

    // A member: read-only chips, no picker and no options asked for.
    act(() => root.unmount());
    root = createRoot(host);
    calls = [];
    await openDetail(detail, bob);
    const fields = $('[data-slot="issue-fields"]')!;
    expect(chips(fields)).toEqual(['app:crm@5', 'plugin:forms']);
    expect(fields.textContent).toContain('Former CRM');
    expect($('[data-slot="issue-components-add"]')).toBeNull();
    expect(calls.some((call) => call.path === '/api/issues/components')).toBe(false);
});

it('lists the suggested components in the triage proposal', async () => {
    await openDetail(
        detailOf(
            { status: 'triage' },
            {
                triage: {
                    state: 'proposed',
                    kind: 'bug',
                    area: null,
                    priority: 'high',
                    labels: [],
                    components: ['plugin:forms', 'app:crm'],
                    reason: 'Forms lose answers.',
                    commentId: 'c1',
                    createdAt: 1,
                    decidedAt: null,
                    decidedBy: null,
                },
            },
        ),
        bob,
    );
    const card = $('[data-slot="issue-triage"]')!;
    expect(chips(card)).toEqual(['plugin:forms', 'app:crm']);
    expect(card.textContent).toContain('Feedback Forms');
    expect(card.textContent).toContain('Customer Desk');
    expect(card.querySelector<HTMLElement>('[data-ref="app:crm"]')!.title).toBe('Proposed component: Customer Desk');
});

// --- Reporting ---------------------------------------------------------------

const reportForm = () => $('[data-slot="report-issue-form"]');

it('drafts the plugin of the page when it is among the options, and files it', async () => {
    routes['POST /api/issues'] = () => [201, detailOf({ number: 9 })];
    render(<ReportIssue />, bob, '/plugins/forms');
    act(() => (byLabel('Report issue') as HTMLButtonElement).click());
    await until(() => chips(reportForm() ?? document.body).length > 0, 'the drafted component');
    expect(chips(reportForm()!)).toEqual(['plugin:forms']);
    expect(reportForm()!.textContent).toContain('Feedback Forms');
    act(() => setValue(reportForm()!.querySelector('input')!, 'Answers vanish'));
    act(() => (reportForm() as HTMLFormElement).requestSubmit());
    await until(() => calls.some((call) => call.method === 'POST'), 'the filing');
    expect(calls.find((call) => call.method === 'POST')?.body).toMatchObject({
        title: 'Answers vanish',
        components: ['plugin:forms'],
    });
});

it('drafts nothing for a plugin the reader can’t pick, and sends no components', async () => {
    routes['POST /api/issues'] = () => [201, detailOf({ number: 9 })];
    render(<ReportIssue />, bob, '/plugins/secret');
    act(() => (byLabel('Report issue') as HTMLButtonElement).click());
    await until(() => !!reportForm(), 'the form');
    await until(() => !($('[data-slot="issue-components-add"]') as HTMLButtonElement).disabled, 'the options');
    expect(chips(reportForm()!)).toEqual([]);
    expect(reportForm()!.textContent).not.toContain('secret');
    act(() => setValue(reportForm()!.querySelector('input')!, 'Something broke'));
    act(() => (reportForm() as HTMLFormElement).requestSubmit());
    await until(() => calls.some((call) => call.method === 'POST'), 'the filing');
    expect(calls.find((call) => call.method === 'POST')?.body).not.toHaveProperty('components');
});

it('reports an issue about an app from the Apps page, and lists admins the apps they can’t open', async () => {
    const apps: AppsState = {
        enabled: true,
        apps: [
            {
                id: 'crm',
                name: 'Customer Desk',
                description: '',
                dotId: 'd1',
                dotName: 'Socio',
                owner: true,
                port: 3000,
                datasets: [],
                datasetNames: [],
                sharedSpaceId: null,
                sharedSpaceName: null,
                startCommand: null,
                status: 'ephemeral',
                url: 'http://crm.apps.test',
                createdAt: 1,
                updatedAt: 1,
                computer: 'running',
                answering: true,
            },
        ],
        others: [{ id: 'payroll', name: 'Payroll', ownerName: 'Dana' }],
    };
    routes['GET /api/apps'] = () => [200, apps];
    render(
        <>
            <ReportIssue moduleId="apps" />
            <AppsPage />
        </>,
        alice,
        '/apps',
    );
    await until(() => !!$('[data-slot="app-card"]'), 'the apps');
    const others = $('[data-slot="apps-others"]')!;
    expect(others.textContent).toContain('Other apps in the workspace');
    expect(others.textContent).toContain('Only the owner and the people of the Space it’s shared with can open one.');
    expect($$('[data-slot="apps-other"]').map((item) => item.textContent)).toEqual(['Payrollby Dana']);
    // Name and owner only: nothing to open, launch, set or report.
    expect(others.querySelectorAll('button, a')).toHaveLength(0);

    act(() => (byLabel('Report an issue about Customer Desk') as HTMLButtonElement).click());
    await until(() => chips(reportForm() ?? document.body).length > 0, 'the drafted app');
    expect(chips(reportForm()!)).toEqual(['app:crm']);

    // A member's list has no `others`: no such section.
    act(() => closeReport());
    act(() => root.unmount());
    root = createRoot(host);
    routes['GET /api/apps'] = () => [200, { ...apps, others: undefined }];
    render(<AppsPage />, bob, '/apps');
    await until(() => !!$('[data-slot="app-card"]'), 'the member’s apps');
    expect($('[data-slot="apps-others"]')).toBeNull();
});

it('keeps only the drafted refs of an opened report that are among the options', async () => {
    render(<ReportIssue moduleId="issues" />, bob, '/issues');
    act(() => openReport({ components: ['app:garden', 'app:unknown'] }));
    await until(() => chips(reportForm() ?? document.body).length > 0, 'the drafted app');
    expect(chips(reportForm()!)).toEqual(['app:garden']);
    expect(reportForm()!.textContent).toContain('Garden Plan');
});
