// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { PersonAssets, PersonPurgePlan, RosterPerson, SignInMethods } from '@socio/shared/auth';
import type { PersonDetail, PersonTrail } from '@socio/shared/people';
import type { State, User, WorkspaceState } from '@socio/shared/types';

import PersonPage from '../src/modules/settings/people/PersonPage.route';
import { CurrentUser, SignInSetup } from '../src/shell/current-user';
import { ShellContext, type Shell } from '../src/shell/shell-context';

// Radix menus measure themselves.
globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
} as unknown as typeof ResizeObserver;

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

// Ana is an admin and the workspace owner (CB-390); Ben an admin.
const owner: User = { id: 'u-ana', name: 'Ana Ops', role: 'admin' };
const admin: User = { id: 'u-ben', name: 'Ben Admin', role: 'admin' };

const NOW = Date.now();
const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const cleo: RosterPerson = {
    id: 'cleo',
    userId: 'u-cleo',
    name: 'Cleo Member',
    email: 'cleo@example.com',
    emailVerified: true,
    role: 'member',
    adminByRule: false,
    password: true,
    passkeys: 1,
    providers: ['google'],
    signInLinkVia: 'telegram',
    deactivated: false,
    createdAt: '2026-09-14T12:00:00.000Z',
    status: 'active',
    lastActiveAt: iso(30 * 3_600_000),
    sessions: 2,
    invite: { expiresAt: iso(-2 * DAY), expired: false },
    reach: null,
};

const detailOf = (person: RosterPerson = cleo): PersonDetail => ({
    person,
    signIn: {
        sessions: [
            {
                id: 's1',
                createdAt: iso(10 * DAY),
                renewedAt: iso(3_600_000),
                expiresAt: iso(-20 * DAY),
                userAgent:
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
                signInMethod: 'passkey',
                ip: '192.0.2.10',
            },
            {
                id: 's2',
                createdAt: iso(5 * DAY),
                renewedAt: iso(2 * DAY),
                expiresAt: iso(-25 * DAY),
                userAgent:
                    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
                signInMethod: 'provider:google',
                ip: null,
            },
        ],
        passkeys: [{ id: 'p1', name: 'MacBook', createdAt: iso(20 * DAY) }],
        password: true,
        providers: ['google'],
    },
    access: {
        spaces: [
            { id: 'sp-every', name: 'Everyday', level: 'everyone', membersOnly: false },
            { id: 'sp-design', name: 'Design team', level: 'editor', membersOnly: true },
            { id: 'sp-clients', name: 'Clients', level: 'member', membersOnly: true },
        ],
        socioGrants: [
            {
                id: 'g1',
                socioId: 'd-sebas',
                socioName: 'Sebas',
                audiences: ['app:tracker'],
                scopes: ['read'],
                createdAt: NOW - 5 * DAY,
                expiresAt: NOW + 20 * DAY,
                lastUsedAt: NOW - DAY,
            },
        ],
        connectedAgents: [
            {
                grantId: 'a1',
                clientName: 'Claude Code',
                clientDomain: 'claude.ai',
                label: 'Claude Code on a laptop',
                scopes: ['issues', 'pages'],
                createdAt: NOW - 9 * DAY,
                lastUsedAt: NOW - DAY,
                expiresAt: null,
            },
        ],
        appsOwned: [{ id: 'app1', name: 'Tracker' }],
        keysMade: [
            {
                keyId: 'k1',
                name: 'deploys',
                hint: 'x4Fq',
                accountId: 'svc_ci',
                account: 'CI',
                createdAt: NOW - 30 * DAY,
                expiresAt: NOW + 60 * DAY,
                lastUsedAt: NOW - 2 * 3_600_000,
                revokedAt: null,
            },
            {
                keyId: 'k2',
                name: 'old laptop',
                hint: 'Ab12',
                accountId: 'svc_bs',
                account: 'Board sync',
                createdAt: NOW - 90 * DAY,
                expiresAt: NOW + 10 * DAY,
                lastUsedAt: null,
                revokedAt: NOW - 3 * DAY,
            },
        ],
        codeAccess: false,
        telegram: { username: 'cleo', linkedAt: NOW - 40 * DAY },
    },
    groups: [{ id: 'g-0123456789ab', name: 'Readers', permissions: [] }],
});

const trailLine = (n: number) => ({
    id: `workspace:${n}`,
    at: NOW - n * 3_600_000,
    source: 'workspace' as const,
    actorId: 'u-ana',
    actorName: 'Ana Ops',
    action: 'update',
    detail: `change ${n}`,
});
const pages: Record<string, PersonTrail> = {
    '': { lines: [trailLine(1), trailLine(2)], next: 'cursor-2' },
    'cursor-2': { lines: [trailLine(3)], next: null },
};

const assets: PersonAssets = {
    accountId: 'cleo',
    name: 'Cleo Member',
    kinds: [
        { kind: 'apps', count: 1, items: [{ id: 'app1', name: 'Tracker', type: 'app' }] },
        {
            kind: 'schedules',
            count: 2,
            items: [
                { id: 't1', name: 'Morning digest', type: 'task' },
                { id: 'j1', name: 'Weekly report', type: 'job', deleted: true },
            ],
        },
        { kind: 'socios', count: 1, items: [{ id: 'd-cleo', name: 'Cleo’s helper', type: 'socio' }] },
        { kind: 'spaces', count: 1, items: [{ id: 'sp-design', name: 'Design team', type: 'editor' }] },
        { kind: 'data', count: 3, items: [{ id: 'ds1', name: 'Leads', type: 'dataset' }] },
        { kind: 'conversations', count: 0, items: [] },
        { kind: 'memories', count: 0, items: [] },
    ],
};
const rosterPerson = (id: string, name: string, extra: Partial<RosterPerson> = {}): RosterPerson => ({
    ...cleo,
    id,
    userId: `u-${id}`,
    name,
    email: `${id}@example.com`,
    ...extra,
});
const roster = [
    cleo,
    rosterPerson('dana', 'Dana Lead'),
    rosterPerson('ben', 'Ben Admin', { role: 'admin' }),
    rosterPerson('eve', 'Eve Gone', { status: 'deactivated', deactivated: true }),
    rosterPerson('ivy', 'Ivy New', { status: 'invited' }),
];
const cleanPlan: PersonPurgePlan = {
    accountId: 'cleo',
    name: 'Cleo Member',
    refusals: [],
    targets: { users: 1, socios: 1 },
    tables: [
        { table: 'users', rows: 1 },
        { table: 'conversations', rows: 4 },
    ],
    kept: [{ table: 'workspace_audit', column: 'actorId', rows: 7 }],
    files: { count: 2, bytes: 2048 },
    objects: { count: 0, bytes: 0 },
};

let host: HTMLDivElement;
let root: Root;
let plan: PersonPurgePlan;
let transferFails: boolean;
let applyFails: boolean;
let transferThrows: boolean;
let stepUpHold: Promise<void> | undefined;
let challenges: number;
let requests: { path: string; method: string; query: string; body?: unknown }[];
let detail: PersonDetail;
let refuse: { status: number; error: string } | undefined;
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    requests = [];
    detail = detailOf();
    refuse = undefined;
    plan = cleanPlan;
    transferFails = false;
    applyFails = false;
    transferThrows = false;
    stepUpHold = undefined;
    challenges = 0;
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://app.test');
        const path = url.pathname;
        const method = init?.method ?? 'GET';
        requests.push({
            path,
            method,
            query: url.search,
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        const reply = (body: unknown, status = 200) =>
            new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
        if (path === `/api/accounts/${detail.person.id}` && method === 'GET') {
            return refuse ? reply({ error: refuse.error }, refuse.status) : reply(detail);
        }
        if (path.endsWith('/audit')) {
            return reply(pages[url.searchParams.get('before') ?? '']);
        }
        if (path.endsWith('/deactivation-impact')) {
            return reply({
                accountId: detail.person.id,
                name: detail.person.name,
                refusal: null,
                deactivated: false,
                sessions: 2,
                keys: [],
                connectedAgents: 1,
                socioGrants: 1,
                appSessions: 0,
                pluginAccess: 0,
                scheduledTasks: 0,
                jobRuns: 0,
                subscriptionConnections: 0,
                mcpConnections: 0,
                rooms: { handedOver: 0, archived: 0 },
                appsOwned: 1,
                owned: { apps: 1, schedules: 2, socios: 1 },
            });
        }
        if (path.endsWith('/assets')) {
            return reply(assets);
        }
        if (path === '/api/accounts/roster') {
            return reply({ people: roster });
        }
        if (path.endsWith('/transfer') && transferThrows) {
            throw new TypeError('Failed to fetch');
        }
        if (path.endsWith('/transfer')) {
            const to = roster.find((p) => p.id === (init?.body && JSON.parse(String(init.body)).to))!;
            return transferFails
                ? reply({ error: 'A file changed meanwhile: try again.' }, 409)
                : reply({
                      from: { accountId: 'cleo', name: 'Cleo Member' },
                      to: { accountId: to.id, name: to.name },
                      kinds: [
                          {
                              kind: 'apps',
                              moved: { apps: 1 },
                              notes: ['App “Tracker” restarted: it acts for its new owner now.'],
                          },
                          {
                              kind: 'schedules',
                              moved: { tasks: 1, jobs: 1 },
                              notes: ['Job “Weekly report” is “Weekly report 2” now.'],
                          },
                      ],
                  });
        }
        if (path === '/api/accounts' && method === 'GET') {
            return reply({
                accounts: [{ ...cleo, id: 'ana', userId: 'u-ana', name: 'Ana Ops', role: 'admin', owner: true }],
                unlinked: [],
            });
        }
        if (path.endsWith('/owner/step-up')) {
            challenges++;
            return reply({ id: `oc${challenges}`, methods: ['confirm'], expiresAt: iso(-60_000) });
        }
        if (path.endsWith('/owner') && method === 'POST') {
            return reply({ ...detail.person, owner: true });
        }
        if (path.endsWith('/purge/step-up')) {
            challenges++;
            if (challenges > 1 && stepUpHold) {
                await stepUpHold;
            }
            return reply({ id: `ch${challenges}`, methods: ['confirm'], expiresAt: iso(-60_000) });
        }
        if (path.endsWith('/purge')) {
            const body = JSON.parse(String(init!.body)) as { apply: boolean };
            if (body.apply && applyFails) {
                return reply({ error: 'The backup failed: the disk is full.' }, 409);
            }
            return body.apply
                ? reply({
                      accountId: 'cleo',
                      name: 'Cleo Member',
                      rows: 5,
                      tables: plan.tables,
                      backup: '/data/backups/purge-2026-11-08',
                      cleanup: { files: 2, bytes: 2048, objects: 0 },
                  })
                : reply(plan);
        }
        return reply({ ok: true });
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
});

async function until(check: () => boolean, what: string) {
    for (const deadline = Date.now() + 5_000; Date.now() < deadline;) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${document.body.textContent}`);
}

function shellFor(user: User): Shell {
    const workspace = {
        user,
        spaces: [
            { id: 'sp-every', name: 'Everyday', description: '', createdAt: 1 },
            { id: 'sp-design', name: 'Design team', description: '', createdAt: 1, private: true },
            { id: 'sp-clients', name: 'Clients', description: '', createdAt: 1, private: true },
            { id: 'sp-finance', name: 'Finance', description: '', createdAt: 1, private: true },
        ],
        dots: [],
        conversations: [],
        setup: { missing: [], telegram: 'not_configured' },
        calls: [],
    } as unknown as WorkspaceState;
    return {
        state: { settings: { name: 'Socio' } } as unknown as State,
        workspace,
        admin: true,
        configured: true,
        homeDot: { id: 'd1', name: 'Socio' },
    } as unknown as Shell;
}

const METHODS = { passkey: true, password: true, signUp: false, emailReset: false, signInLink: true } as SignInMethods;

async function open(user: User = admin, entry = '/settings/people/cleo', wait = true) {
    const router = createMemoryRouter(
        [
            { path: '/settings/people/:id', Component: PersonPage },
            { path: '/settings/people', Component: () => null },
        ],
        {
            initialEntries: [entry],
        },
    );
    act(() =>
        root.render(
            <ShellContext.Provider value={shellFor(user)}>
                <CurrentUser.Provider value={user}>
                    <SignInSetup.Provider value={METHODS}>
                        <RouterProvider router={router} />
                    </SignInSetup.Provider>
                </CurrentUser.Provider>
            </ShellContext.Provider>,
        ),
    );
    if (wait) {
        await until(() => !!host.querySelector('[data-slot="person-header"]'), 'the person');
    }
    return router;
}

const slot = (name: string, scope: ParentNode = document) => scope.querySelector<HTMLElement>(`[data-slot="${name}"]`);
const all = (name: string, scope: ParentNode = document) => [
    ...scope.querySelectorAll<HTMLElement>(`[data-slot="${name}"]`),
];
const button = (scope: ParentNode, label: string) =>
    [...scope.querySelectorAll('button')].find((b) => b.textContent === label || b.ariaLabel === label)!;
const click = (element: HTMLElement) => act(() => element.click());
const pick = (element: HTMLSelectElement, value: string) =>
    act(() => {
        element.value = value;
        element.dispatchEvent(new Event('change', { bubbles: true }));
    });
const tab = async (label: string) => {
    const trigger = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === label)!;
    act(() => {
        trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    });
    await until(() => trigger.getAttribute('aria-selected') === 'true', `the ${label} tab`);
};
const settled = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

it('shows who they are, four tiles and the Access tab, with a footer to deactivate', async () => {
    await open();
    const header = slot('person-header')!;
    expect(header.textContent).toContain('Cleo Member');
    expect(header.textContent).toContain('Active');
    expect(header.textContent).toContain('cleo@example.com · joined Sep 14');
    expect(all('person-tile').map((tile) => tile.textContent)).toEqual([
        expect.stringContaining('Last activeYesterday'),
        'Signed in on2 devicesChrome · macOS, Safari · iPhone',
        'Can reach3 Spaces1 as editor',
        'Acts for them1 socio · 1 agentdelegated access',
    ]);
    const spaces = all('person-space').map((row) => row.textContent);
    expect(spaces).toEqual([
        'Everyday everyoneEveryone',
        expect.stringContaining('Design team private'),
        expect.stringContaining('Clients private'),
    ]);
    expect(slot('person-socio-grant')!.textContent).toContain('Sebas may use an app for Cleo');
    expect(slot('person-agent')!.textContent).toContain('Claude Code on a laptop');
    expect(slot('person-code-access')!.textContent).toContain('No');
    // Code access comes from groups (CB-376): every admin manages them.
    expect(slot('person-code-access')!.querySelector('a')?.getAttribute('href')).toBe('/settings/people?tab=groups');
    expect(all('person-group').map((row) => row.textContent)).toEqual([
        expect.stringContaining('Readers No permissions'),
    ]);
    expect(slot('person-telegram')!.textContent).toContain('@cleo');
    expect(slot('person-footer')!.textContent).toContain('Deactivate Cleo');
    // Where the later lifecycle actions go.
    expect(slot('person-lifecycle-actions')).not.toBeNull();
});

it('changes, adds and removes their Spaces through the Space’s people routes', async () => {
    await open();
    pick(document.querySelector<HTMLSelectElement>('select[aria-label="Role in Clients"]')!, 'editor');
    await settled();
    expect(requests).toContainEqual(
        expect.objectContaining({
            method: 'PUT',
            path: '/api/spaces/sp-clients/people/u-cleo',
            body: { role: 'editor' },
        }),
    );
    // Add: only Spaces they have no row in (the open Everyday is one).
    const addable = [
        ...document.querySelectorAll<HTMLOptionElement>('select[aria-label="Space to add them to"] option'),
    ]
        .map((option) => option.value)
        .filter(Boolean);
    expect(addable).toEqual(['sp-every', 'sp-finance']);
    pick(document.querySelector<HTMLSelectElement>('select[aria-label="Space to add them to"]')!, 'sp-finance');
    act(() => document.querySelector<HTMLFormElement>('form[aria-label="Add to a Space"]')!.requestSubmit());
    await settled();
    expect(requests).toContainEqual(
        expect.objectContaining({
            method: 'PUT',
            path: '/api/spaces/sp-finance/people/u-cleo',
            body: { role: 'member' },
        }),
    );
    // Remove asks first.
    click(button(document, 'Remove from Design team'));
    await until(() => !!slot('confirm-remove-space'), 'the confirmation');
    expect(requests.some((r) => r.method === 'DELETE')).toBe(false);
    await act(async () => button(slot('confirm-remove-space')!, 'Remove').click());
    expect(requests).toContainEqual(
        expect.objectContaining({ method: 'DELETE', path: '/api/spaces/sp-design/people/u-cleo' }),
    );
});

it('revokes a socio’s access and disconnects an agent with the admin routes', async () => {
    await open(owner);
    expect(slot('person-code-access')!.querySelector('a')?.getAttribute('href')).toBe('/settings/people?tab=groups');
    // Taking them out of a group goes through the Groups route.
    click(button(slot('person-group')!, 'Remove'));
    await settled();
    expect(requests).toContainEqual(
        expect.objectContaining({ method: 'DELETE', path: '/api/groups/g-0123456789ab/members/cleo' }),
    );
    click(button(slot('person-socio-grant')!, 'Revoke'));
    await until(() => !!slot('confirm-revoke-grant'), 'the confirmation');
    await act(async () => button(slot('confirm-revoke-grant')!, 'Revoke').click());
    expect(requests).toContainEqual(expect.objectContaining({ method: 'DELETE', path: '/api/actors/admin/grants/g1' }));
    await until(() => !slot('confirm-revoke-grant'), 'the dialog to close');
    click(button(slot('person-agent')!, 'Disconnect'));
    await until(() => !!slot('confirm-revoke-grant'), 'the confirmation');
    await act(async () => button(slot('confirm-revoke-grant')!, 'Disconnect').click());
    expect(requests).toContainEqual(expect.objectContaining({ method: 'DELETE', path: '/api/admin/agent-grants/a1' }));
});

it('shows an admin’s Spaces read-only: admins edit every Space', async () => {
    detail = detailOf({ ...cleo, id: 'ben', userId: 'u-ben', name: 'Ben Admin', role: 'admin' });
    await open(owner, '/settings/people/ben');
    expect(document.querySelector('select[aria-label^="Role in "]')).toBeNull();
    expect(document.querySelector('form[aria-label="Add to a Space"]')).toBeNull();
    expect(slot('person-spaces')!.textContent).toContain('As an admin, Ben edits every Space.');
});

it('lists devices with a sign-out each, and how they sign in', async () => {
    await open(admin, '/settings/people/cleo?tab=sign-in');
    await until(() => all('person-session').length === 2, 'the devices');
    const [mac, phone] = all('person-session');
    expect(mac!.textContent).toContain('Chrome · macOS');
    expect(mac!.textContent).toContain('by Passkey');
    expect(mac!.textContent).toContain('192.0.2.10');
    expect(phone!.textContent).toContain('by Google');
    click(button(mac!, 'Sign out Chrome · macOS'));
    await settled();
    expect(requests).toContainEqual(
        expect.objectContaining({ method: 'DELETE', path: '/api/accounts/cleo/sessions/s1' }),
    );
    expect(slot('person-passkeys')!.textContent).toContain('MacBook');
    expect(slot('person-password')!.textContent).toContain('Set');
    expect(slot('person-providers')!.textContent).toContain('Google');
    expect(slot('person-password-link')!.textContent).toContain('expires');
});

it('lists every kind they own with its items, and keys with their state linking to the Service accounts tab', async () => {
    await open(admin, '/settings/people/cleo?tab=owns');
    await until(() => all('person-owned-kind').length === 5, 'the owned kinds');
    expect(slot('person-owns-summary')!.textContent).toContain(
        'Cleo owns 1 app, 2 schedules, 1 socio, 1 Space membership, 3 items.',
    );
    expect(all('person-owned-kind').map((card) => card.getAttribute('aria-label'))).toEqual([
        'Apps',
        'Schedules',
        'Personal socios',
        'Spaces',
        'Data space',
    ]);
    const items = all('person-owned-item').map((row) => row.textContent);
    expect(items).toContain('Trackerapp');
    expect(items).toContain('Weekly reportjob · deleted, kept');
    // Data lists 1 of 3.
    expect(document.querySelector('[aria-label="Data space"]')!.textContent).toContain('and 2 more');
    const [live, revoked] = all('person-key');
    expect(live!.textContent).toContain('deploys');
    expect(live!.textContent).toContain('used 2 h ago');
    expect(revoked!.textContent).toContain('revoked');
    expect(revoked!.querySelector('.line-through')?.textContent).toBe('old laptop');
    expect(live!.querySelector('a')?.getAttribute('href')).toBe('/settings/people?tab=service-accounts&account=svc_ci');
});

const checkbox = (title: string) =>
    document.querySelector<HTMLElement>(`[data-slot="transfer-dialog"] [role="checkbox"][aria-label="${title}"]`)!;
const recipients = () =>
    [...document.querySelectorAll<HTMLOptionElement>('select[aria-label="New owner"] option')]
        .map((option) => option.value)
        .filter(Boolean);

it('transfers everything by default: every kind ticked, active people only, then what moved', async () => {
    await open(admin, '/settings/people/cleo?tab=owns');
    await until(() => all('person-owned-kind').length === 5, 'the owned kinds');
    click(button(slot('person-owns-summary')!, 'Transfer everything…'));
    await until(() => all('transfer-kind').length === 5, 'the kinds');
    for (const title of ['Apps', 'Schedules', 'Personal socios', 'Spaces', 'Data space']) {
        expect(checkbox(title).getAttribute('aria-checked')).toBe('true');
    }
    // Empty kinds aren't offered.
    expect(checkbox('Memories')).toBeNull();
    expect(slot('transfer-partial-warning')).toBeNull();
    // Active people with an app user, never Cleo, never the deactivated or invited.
    await until(() => recipients().length > 0, 'the people');
    expect(recipients()).toEqual(['ben', 'dana']);
    const confirm = () => button(slot('transfer-dialog')!, 'Transfer everything to Dana');
    pick(document.querySelector<HTMLSelectElement>('select[aria-label="New owner"]')!, 'dana');
    await act(async () => confirm().click());
    await until(() => !!slot('transfer-result'), 'the result');
    // Everything: no list, so what they own by now moves too.
    expect(requests).toContainEqual(
        expect.objectContaining({ method: 'POST', path: '/api/accounts/cleo/transfer', body: { to: 'dana' } }),
    );
    expect(all('transfer-result-kind').map((row) => row.textContent)).toEqual([
        'Apps1 appsApp “Tracker” restarted: it acts for its new owner now.',
        'Schedules1 tasks, 1 jobsJob “Weekly report” is “Weekly report 2” now.',
    ]);
    // Running apps restart for the new owner by themselves: no manual steps to read.
    expect(slot('running-apps-note')).toBeNull();
    // The Owns tab loads again.
    await until(() => requests.filter((r) => r.path.endsWith('/assets')).length >= 3, 'the reload');
});

it('warns before a partial transfer, keeps data with apps, and sends the chosen kinds', async () => {
    await open(admin, '/settings/people/cleo?tab=owns');
    await until(() => all('person-owned-kind').length === 5, 'the owned kinds');
    click(button(slot('person-owns-summary')!, 'Transfer everything…'));
    await until(() => all('transfer-kind').length === 5, 'the kinds');
    // Data moves with apps: ticked and fixed.
    expect(checkbox('Data space').hasAttribute('disabled')).toBe(true);
    click(checkbox('Schedules'));
    expect(checkbox('Schedules').getAttribute('aria-checked')).toBe('false');
    expect(slot('transfer-partial-warning')!.textContent).toContain('Only some kinds move.');
    click(checkbox('Schedules'));
    expect(slot('transfer-partial-warning')).toBeNull();
    click(checkbox('Personal socios'));
    await until(() => recipients().length > 0, 'the people');
    pick(document.querySelector<HTMLSelectElement>('select[aria-label="New owner"]')!, 'ben');
    await act(async () => button(slot('transfer-dialog')!, 'Transfer these to Ben').click());
    await until(() => !!slot('transfer-result'), 'the result');
    expect(requests).toContainEqual(
        expect.objectContaining({
            path: '/api/accounts/cleo/transfer',
            body: { to: 'ben', kinds: ['apps', 'schedules', 'spaces', 'data'] },
        }),
    );
});

it('opens a kind’s own Transfer with that kind alone, and the partial warning', async () => {
    await open(admin, '/settings/people/cleo?tab=owns');
    await until(() => all('person-owned-kind').length === 5, 'the owned kinds');
    click(button(document, 'Transfer Schedules'));
    await until(() => all('transfer-kind').length === 5, 'the kinds');
    expect(checkbox('Schedules').getAttribute('aria-checked')).toBe('true');
    expect(checkbox('Apps').getAttribute('aria-checked')).toBe('false');
    expect(slot('transfer-partial-warning')).not.toBeNull();
});

it('transfers first, then deactivates, from the deactivate dialog', async () => {
    await open();
    click(button(slot('person-footer')!, 'Deactivate…'));
    await until(() => !!slot('impact-owned'), 'what stays theirs');
    expect(slot('impact-owned')!.textContent).toContain('1 app they own');
    expect(slot('impact-owned')!.textContent).toContain('2 schedules they own');
    const combined = () => document.querySelector<HTMLButtonElement>('[data-slot="transfer-and-deactivate"]')!;
    expect(combined().disabled).toBe(true);
    await until(
        () => document.querySelectorAll('select[aria-label="Hand everything to"] option').length > 1,
        'the people',
    );
    pick(document.querySelector<HTMLSelectElement>('select[aria-label="Hand everything to"]')!, 'dana');
    expect(slot('deactivate-transfer-order')!.textContent).toBe(
        'Everything Cleo owns moves to Dana Lead.Then Cleo is deactivated.If the transfer fails, nothing moves and Cleo is not deactivated.',
    );
    expect(combined().textContent).toBe('Transfer everything to Dana and deactivate');
    // Plain deactivation stays on offer.
    expect(button(slot('confirm-deactivate')!, 'Deactivate Cleo only')).toBeDefined();
    await act(async () => combined().click());
    await until(() => requests.some((r) => r.path.endsWith('/deactivate')), 'the deactivation');
    const order = requests.filter((r) => r.method === 'POST').map((r) => r.path);
    expect(order).toEqual(['/api/accounts/cleo/transfer', '/api/accounts/cleo/deactivate']);
    expect(requests.find((r) => r.path.endsWith('/transfer'))!.body).toEqual({ to: 'dana' });
});

it('deactivates nothing when the transfer fails', async () => {
    transferFails = true;
    await open();
    click(button(slot('person-footer')!, 'Deactivate…'));
    await until(
        () => document.querySelectorAll('select[aria-label="Hand everything to"] option').length > 1,
        'the people',
    );
    pick(document.querySelector<HTMLSelectElement>('select[aria-label="Hand everything to"]')!, 'dana');
    await act(async () => document.querySelector<HTMLButtonElement>('[data-slot="transfer-and-deactivate"]')!.click());
    await until(() => !!slot('deactivate-action-error'), 'the error');
    expect(slot('deactivate-action-error')!.textContent).toBe(
        'The transfer failed, so Cleo was not deactivated and nothing moved: A file changed meanwhile: try again.',
    );
    expect(requests.some((r) => r.path.endsWith('/deactivate'))).toBe(false);
    // The preview stays, so another new owner can be picked and tried.
    expect(slot('impact-owned')).not.toBeNull();
    transferFails = false;
    pick(document.querySelector<HTMLSelectElement>('select[aria-label="Hand everything to"]')!, 'ben');
    await act(async () => document.querySelector<HTMLButtonElement>('[data-slot="transfer-and-deactivate"]')!.click());
    await until(() => requests.some((r) => r.path.endsWith('/deactivate')), 'the deactivation');
    expect(requests.filter((r) => r.path.endsWith('/transfer')).map((r) => r.body)).toEqual([
        { to: 'dana' },
        { to: 'ben' },
    ]);
});

it('opens the transfer dialog from “Stays theirs”, and back to the preview', async () => {
    await open();
    click(button(slot('person-footer')!, 'Deactivate…'));
    await until(() => !!slot('impact-owned'), 'what stays theirs');
    click(button(slot('impact-owned')!, 'Transfer…'));
    await until(() => all('transfer-kind').length === 5, 'the transfer dialog');
    expect(slot('confirm-deactivate')).toBeNull();
    click(button(slot('transfer-dialog')!, 'Cancel'));
    await until(() => !!slot('impact-owned'), 'the preview again');
});

const menuItem = (text: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === text);
const openMore = async () => {
    act(() => {
        document
            .querySelector<HTMLElement>('[aria-label="More for Cleo Member"]')!
            .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await until(() => !!menuItem('Releases seen'), 'the menu');
};

it('offers Remove permanently to admins, never on yourself or the workspace owner', async () => {
    detail = detailOf({ ...cleo, id: 'ben', userId: 'u-ben', name: 'Ben Admin', role: 'admin' });
    await open(admin, '/settings/people/ben');
    expect(button(slot('person-lifecycle-actions')!, 'Remove permanently…')).toBeUndefined();
    act(() => root.unmount());
    root = createRoot(host);
    detail = detailOf();
    await open(admin);
    expect(button(slot('person-lifecycle-actions')!, 'Remove permanently…')).toBeDefined();
    await openMore();
    act(() => menuItem('Remove permanently…')!.click());
    await until(() => !!slot('remove-dry-run'), 'the dry run');
    expect(requests).toContainEqual(
        expect.objectContaining({ method: 'POST', path: '/api/accounts/cleo/purge', body: { apply: false } }),
    );
});

it('explains each blocker, with Transfer first for what they own, and won’t go on', async () => {
    plan = {
        ...cleanPlan,
        refusals: [
            'Deactivate them first.',
            'They still own apps 1, schedules 2: transfer it to someone first.',
            'apps app1 is under a listed users (apps.ownerUserId): list it, or cascade to apps.',
            '3 row(s) of issues.assigneeId name a listed users: the purge doesn’t remove those; end them in the app first.',
        ],
    };
    await open(owner);
    click(button(slot('person-lifecycle-actions')!, 'Remove permanently…'));
    await until(() => all('remove-blocker').length === 3, 'the blockers');
    const [deactivate, owned, rows] = all('remove-blocker');
    expect(deactivate!.textContent).toContain('Only a deactivated person can be removed');
    expect(owned!.textContent).toContain('hand it to someone first');
    // The planner's record lines fold under "They still own".
    expect(slot('remove-owned-records', owned!)!.textContent).toContain('1 record the planner lists for this');
    expect(slot('remove-owned-records', owned!)!.textContent).toContain('apps app1 is under a listed users');
    expect(rows!.textContent).toContain('end these in the app first');
    expect(slot('remove-goes')!.textContent).toContain('Rows, across 2 tables5');
    expect(slot('remove-kept')!.textContent).toContain('workspace_audit.actorId7 rows');
    expect(button(slot('remove-dialog')!, 'Continue').disabled).toBe(true);
    click(button(owned!, 'Transfer first…'));
    await until(() => all('transfer-kind').length === 5, 'the transfer dialog');
    expect(slot('remove-dialog')).toBeNull();
});

it('keeps Remove disabled until the name is typed exactly, then shows the backup and goes back to People', async () => {
    detail = detailOf({ ...cleo, status: 'deactivated', deactivated: true });
    const router = await open(owner);
    click(button(slot('person-lifecycle-actions')!, 'Remove permanently…'));
    await until(() => !!slot('remove-dry-run'), 'the dry run');
    expect(slot('remove-blockers')).toBeNull();
    click(button(slot('remove-dialog')!, 'Continue'));
    const remove = () => button(slot('remove-dialog')!, 'Remove Cleo permanently (development sign-in)');
    await until(() => !!remove(), 'the step-up');
    const name = document.querySelector<HTMLInputElement>('input[aria-label="Their name"]')!;
    const type = (value: string) =>
        act(() => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, value);
            name.dispatchEvent(new Event('input', { bubbles: true }));
        });
    expect(remove().disabled).toBe(true);
    type('cleo member');
    expect(remove().disabled).toBe(true);
    expect(slot('remove-name-mismatch')).not.toBeNull();
    type('Cleo Member ');
    expect(remove().disabled).toBe(true);
    type('Cleo Member');
    expect(remove().disabled).toBe(false);
    await act(async () => remove().click());
    await until(() => !!slot('remove-result'), 'the result');
    expect(requests).toContainEqual(
        expect.objectContaining({
            path: '/api/accounts/cleo/purge',
            body: { apply: true, confirmName: 'Cleo Member', stepUp: { id: 'ch1', confirm: true } },
        }),
    );
    expect(slot('remove-backup')!.textContent).toContain('/data/backups/purge-2026-11-08');
    click(button(slot('remove-dialog')!, 'Back to People'));
    await until(() => router.state.location.pathname === '/settings/people', 'the People list');
});

it('pages the activity trail with Load more', async () => {
    await open();
    await tab('Activity');
    await until(() => all('person-trail-line').length === 2, 'the first page');
    expect(all('person-trail-line')[0]!.textContent).toContain('Ana Ops change 1');
    click(button(slot('person-activity')!, 'Load more'));
    await until(() => all('person-trail-line').length === 3, 'the next page');
    expect(requests.filter((r) => r.path.endsWith('/audit')).map((r) => r.query)).toEqual([
        '?limit=50',
        '?limit=50&before=cursor-2',
    ]);
    expect(button(slot('person-activity')!, 'Load more')).toBeUndefined();
});

it('asks before a demotion, and opens the deactivate preview from the footer', async () => {
    detail = detailOf({ ...cleo, role: 'admin' });
    await open(owner);
    pick(document.querySelector<HTMLSelectElement>('select[aria-label="Role of Cleo Member"]')!, 'member');
    await until(() => !!slot('confirm-role'), 'the confirmation');
    expect(requests.some((r) => r.method === 'PATCH')).toBe(false);
    await act(async () => button(slot('confirm-role')!, 'Make member').click());
    expect(requests).toContainEqual(
        expect.objectContaining({ method: 'PATCH', path: '/api/accounts/cleo', body: { role: 'member' } }),
    );
    click(button(slot('person-footer')!, 'Deactivate…'));
    await until(() => document.body.textContent!.includes('Also ends'), 'the preview');
});

it('offers Reactivate for a deactivated person', async () => {
    detail = detailOf({ ...cleo, status: 'deactivated', deactivated: true });
    await open();
    expect(slot('person-footer')!.textContent).toContain('Reactivate Cleo');
    expect(button(slot('person-header')!, 'Password link')).toBeUndefined();
});

it('says why the server refuses an account, and when nobody has the account', async () => {
    refuse = { status: 403, error: 'Only an admin can change this.' };
    await open(admin, '/settings/people/cleo', false);
    await until(() => !!slot('person-forbidden'), 'the refusal');
    expect(slot('person-forbidden')!.textContent).toBe('Only an admin can change this.');
    act(() => root.unmount());
    root = createRoot(host);
    refuse = { status: 404, error: 'Account not found.' };
    await open(admin, '/settings/people/cleo', false);
    await until(() => !!slot('person-not-found'), 'the 404');
    refuse = { status: 500, error: 'Boom.' };
    act(() => root.unmount());
    root = createRoot(host);
    await open(admin, '/settings/people/cleo', false);
    await until(() => !!slot('person-error'), 'the error');
    expect(slot('person-error')!.textContent).toContain('Try again');
});

it('keeps the person on screen when an action for the last one answers after a navigation', async () => {
    const people: Record<string, PersonDetail> = {
        cleo: detailOf(),
        ben: detailOf({ ...cleo, id: 'ben', userId: 'u-ben', name: 'Ben Admin', email: 'ben@example.com' }),
    };
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const path = new URL(input, 'http://app.test').pathname;
        const method = init?.method ?? 'GET';
        if (method === 'DELETE') {
            await held;
        }
        const id = /^\/api\/accounts\/([^/]+)$/.exec(path)?.[1];
        const body =
            id && method === 'GET' ? people[id] : path.endsWith('/audit') ? { lines: [], next: null } : { ok: true };
        return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    });
    const router = await open(admin, '/settings/people/cleo?tab=sign-in');
    await until(() => all('person-session').length === 2, 'the devices');
    click(button(all('person-session')[0]!, 'Sign out Chrome · macOS'));
    await act(() => router.navigate('/settings/people/ben'));
    await until(() => slot('person-header')?.textContent?.includes('Ben Admin') ?? false, 'Ben');
    await act(async () => release());
    await settled();
    await settled();
    expect(slot('person-header')!.textContent).toContain('Ben Admin');
    expect(document.querySelector('[data-person]')?.getAttribute('data-person')).toBe('ben@example.com');
});

it('gets a fresh step-up and reloads the plan after a failed removal, so a retry works', async () => {
    detail = detailOf({ ...cleo, status: 'deactivated', deactivated: true });
    applyFails = true;
    await open(owner);
    click(button(slot('person-lifecycle-actions')!, 'Remove permanently…'));
    await until(() => !!slot('remove-dry-run'), 'the dry run');
    click(button(slot('remove-dialog')!, 'Continue'));
    const remove = () => button(slot('remove-dialog')!, 'Remove Cleo permanently (development sign-in)');
    await until(() => !!remove(), 'the step-up');
    const name = document.querySelector<HTMLInputElement>('input[aria-label="Their name"]')!;
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Cleo Member');
        name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => remove().click());
    await until(() => !!slot('remove-error'), 'the error');
    expect(slot('remove-error')!.textContent).toBe('The backup failed: the disk is full.');
    await until(() => challenges === 2, 'a fresh challenge');
    // The plan was read again (still clear), so the typed name step stays.
    expect(requests.filter((r) => r.path.endsWith('/purge') && !(r.body as { apply: boolean }).apply)).toHaveLength(2);
    applyFails = false;
    await act(async () => remove().click());
    await until(() => !!slot('remove-result'), 'the result');
    const applies = requests.filter((r) => r.path.endsWith('/purge') && (r.body as { apply: boolean }).apply);
    expect(applies.map((r) => (r.body as { stepUp: { id: string } }).stepUp.id)).toEqual(['ch1', 'ch2']);
});

it('goes back to the dry run when a failed removal turns up a blocker', async () => {
    detail = detailOf({ ...cleo, status: 'deactivated', deactivated: true });
    applyFails = true;
    await open(owner);
    click(button(slot('person-lifecycle-actions')!, 'Remove permanently…'));
    await until(() => !!slot('remove-dry-run'), 'the dry run');
    click(button(slot('remove-dialog')!, 'Continue'));
    const remove = () => button(slot('remove-dialog')!, 'Remove Cleo permanently (development sign-in)');
    await until(() => !!remove(), 'the step-up');
    const name = document.querySelector<HTMLInputElement>('input[aria-label="Their name"]')!;
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Cleo Member');
        name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    plan = { ...cleanPlan, refusals: ['They still own apps 1: transfer it to someone first.'] };
    await act(async () => remove().click());
    await until(() => all('remove-blocker').length === 1, 'the new blocker');
    expect(slot('remove-error')!.textContent).toBe('The backup failed: the disk is full.');
    expect(button(slot('remove-dialog')!, 'Continue').disabled).toBe(true);
});

it('keeps Remove disabled until a fresh step-up arrives after a failure', async () => {
    detail = detailOf({ ...cleo, status: 'deactivated', deactivated: true });
    applyFails = true;
    let release!: () => void;
    stepUpHold = new Promise<void>((resolve) => (release = resolve));
    await open(owner);
    click(button(slot('person-lifecycle-actions')!, 'Remove permanently…'));
    await until(() => !!slot('remove-dry-run'), 'the dry run');
    click(button(slot('remove-dialog')!, 'Continue'));
    const remove = () => button(slot('remove-dialog')!, 'Remove Cleo permanently (development sign-in)');
    await until(() => !!remove(), 'the step-up');
    const name = document.querySelector<HTMLInputElement>('input[aria-label="Their name"]')!;
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Cleo Member');
        name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await until(() => !remove().disabled, 'the button');
    await act(async () => remove().click());
    await until(() => !!slot('remove-error'), 'the error');
    // The spent challenge is gone: no retry until the new one comes.
    expect(slot('remove-step-up-waiting')).not.toBeNull();
    expect(remove().disabled).toBe(true);
    applyFails = false;
    await act(async () => release());
    await until(() => !remove().disabled, 'the fresh challenge');
    await act(async () => remove().click());
    await until(() => !!slot('remove-result'), 'the result');
    const applies = requests.filter((r) => r.path.endsWith('/purge') && (r.body as { apply: boolean }).apply);
    expect(applies.map((r) => (r.body as { stepUp: { id: string } }).stepUp.id)).toEqual(['ch1', 'ch2']);
});

it('says a transfer whose answer was lost may have finished, and loads what they own again', async () => {
    transferThrows = true;
    await open();
    click(button(slot('person-footer')!, 'Deactivate…'));
    await until(
        () => document.querySelectorAll('select[aria-label="Hand everything to"] option').length > 1,
        'the people',
    );
    const impacts = () => requests.filter((r) => r.path.endsWith('/deactivation-impact')).length;
    const before = impacts();
    pick(document.querySelector<HTMLSelectElement>('select[aria-label="Hand everything to"]')!, 'dana');
    await act(async () => document.querySelector<HTMLButtonElement>('[data-slot="transfer-and-deactivate"]')!.click());
    await until(() => !!slot('deactivate-action-error'), 'the error');
    expect(slot('deactivate-action-error')!.textContent).toContain('Couldn’t confirm the transfer finished');
    expect(slot('deactivate-action-error')!.textContent).not.toContain('nothing moved');
    await until(() => impacts() > before, 'the preview again');
    expect(requests.some((r) => r.path.endsWith('/deactivate'))).toBe(false);
});

it('reloads the Owns tab after a transfer made from the deactivate dialog', async () => {
    await open(admin, '/settings/people/cleo?tab=owns');
    await until(() => all('person-owned-kind').length === 5, 'the owned kinds');
    const loads = () => requests.filter((r) => r.path.endsWith('/assets')).length;
    click(button(slot('person-footer')!, 'Deactivate…'));
    await until(() => !!slot('impact-owned'), 'what stays theirs');
    click(button(slot('impact-owned')!, 'Transfer…'));
    await until(() => all('transfer-kind').length === 5, 'the transfer dialog');
    await until(() => recipients().length > 0, 'the people');
    const before = loads();
    pick(document.querySelector<HTMLSelectElement>('select[aria-label="New owner"]')!, 'dana');
    await act(async () => button(slot('transfer-dialog')!, 'Transfer everything to Dana').click());
    await until(() => !!slot('transfer-result'), 'the result');
    await until(() => loads() > before, 'the Owns tab again');
    click(button(slot('transfer-dialog')!, 'Done'));
    await until(() => !!slot('impact-owned'), 'the preview');
    click(button(slot('confirm-deactivate')!, 'Cancel'));
    expect(requests.some((r) => r.path.endsWith('/deactivate'))).toBe(false);
});

it('says a standalone transfer whose answer was lost may have finished, and reloads before a retry', async () => {
    transferThrows = true;
    await open(admin, '/settings/people/cleo?tab=owns');
    await until(() => all('person-owned-kind').length === 5, 'the owned kinds');
    click(button(slot('person-owns-summary')!, 'Transfer everything…'));
    await until(() => all('transfer-kind').length === 5, 'the kinds');
    await until(() => recipients().length > 0, 'the people');
    const loads = () => requests.filter((r) => r.path.endsWith('/assets')).length;
    const before = loads();
    pick(document.querySelector<HTMLSelectElement>('select[aria-label="New owner"]')!, 'dana');
    await act(async () => button(slot('transfer-dialog')!, 'Transfer everything to Dana').click());
    await until(() => !!slot('transfer-error'), 'the error');
    expect(slot('transfer-error')!.textContent).toContain('Couldn’t confirm the transfer finished');
    // The dialog's list and the Owns tab both load again.
    await until(() => loads() >= before + 2, 'the reloads');
    await until(() => all('transfer-kind').length === 5, 'the kinds again');
    // The new owner is chosen again before a retry.
    expect(document.querySelector<HTMLSelectElement>('select[aria-label="New owner"]')!.value).toBe('');
    expect(button(slot('transfer-dialog')!, 'Transfer').disabled).toBe(true);
    expect(slot('transfer-result')).toBeNull();
});

// CB-390: the workspace owner.
const anaPerson = (): RosterPerson => ({
    ...cleo,
    id: 'ana',
    userId: 'u-ana',
    name: 'Ana Ops',
    email: 'ana@example.com',
    role: 'admin',
    owner: true,
});

it('shows the workspace owner to another admin with an Owner badge and the owner-only actions off', async () => {
    detail = detailOf(anaPerson());
    await open(admin, '/settings/people/ana');
    expect(slot('owner-badge', slot('person-header')!)!.textContent).toBe('Owner');
    const role = document.querySelector<HTMLSelectElement>('select[aria-label="Role of Ana Ops"]')!;
    expect(role.disabled).toBe(true);
    expect(role.title).toContain('only the owner can change it');
    expect(button(slot('person-header')!, 'Password link').disabled).toBe(true);
    expect(button(slot('person-header')!, 'Sign out everywhere').disabled).toBe(true);
    expect(button(slot('person-footer')!, 'Deactivate…').disabled).toBe(true);
    expect(button(slot('person-lifecycle-actions')!, 'Remove permanently…')).toBeUndefined();
    await tab('Owns');
    await until(() => all('person-owned-kind').length === 5, 'the owned kinds');
    expect(button(slot('person-owns-summary')!, 'Transfer everything…')).toBeUndefined();
});

it('keeps the owner an active admin on their own page: no demotion or deactivation', async () => {
    detail = detailOf(anaPerson());
    await open(owner, '/settings/people/ana');
    const role = document.querySelector<HTMLSelectElement>('select[aria-label="Role of Ana Ops"]')!;
    expect(role.disabled).toBe(true);
    expect(role.title).toContain('make another admin the owner first');
    expect(button(slot('person-header')!, 'Password link').disabled).toBe(false);
    expect(button(slot('person-footer')!, 'Deactivate…').disabled).toBe(true);
});

it('lets only the owner make another active admin the owner, with the name typed and a step-up', async () => {
    const ben = {
        ...cleo,
        id: 'ben',
        userId: 'u-ben',
        name: 'Ben Admin',
        email: 'ben@example.com',
        role: 'admin' as const,
    };
    detail = detailOf(ben);
    const more = async () => {
        await until(() => requests.some((r) => r.path === '/api/accounts'), 'who owns the workspace');
        await settled();
        act(() => {
            document
                .querySelector<HTMLElement>('[aria-label="More for Ben Admin"]')!
                .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });
        await until(() => !!menuItem('Releases seen'), 'the menu');
    };
    // Another admin: no Make owner.
    const dana: User = { id: 'u-dana', name: 'Dana Lead', role: 'admin' };
    await open(dana, '/settings/people/ben');
    await more();
    expect(menuItem('Make owner…')).toBeUndefined();
    act(() => root.unmount());
    root = createRoot(host);
    // A member's page: no Make owner either, even for the owner.
    detail = detailOf();
    await open(owner);
    await until(() => requests.some((r) => r.path === '/api/accounts'), 'who owns the workspace');
    await settled();
    await openMore();
    expect(menuItem('Make owner…')).toBeUndefined();
    act(() => root.unmount());
    root = createRoot(host);
    // The owner on an admin's page.
    detail = detailOf(ben);
    await open(owner, '/settings/people/ben');
    await more();
    await until(() => !!menuItem('Make owner…'), 'Make owner');
    act(() => menuItem('Make owner…')!.click());
    const confirm = () => button(slot('make-owner-dialog')!, 'Make Ben the owner (development sign-in)');
    await until(() => !!slot('make-owner-dialog') && !!confirm(), 'the step-up');
    expect(requests).toContainEqual(
        expect.objectContaining({ method: 'POST', path: '/api/accounts/ben/owner/step-up' }),
    );
    expect(confirm().disabled).toBe(true);
    const name = document.querySelector<HTMLInputElement>('input[aria-label="Their name"]')!;
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'ben admin');
        name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(confirm().disabled).toBe(true);
    expect(slot('make-owner-name-mismatch')).not.toBeNull();
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Ben Admin');
        name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(confirm().disabled).toBe(false);
    await act(async () => confirm().click());
    await until(() => !slot('make-owner-dialog'), 'the dialog to close');
    const sent = requests.find((r) => r.path === '/api/accounts/ben/owner' && r.method === 'POST');
    expect(sent?.body).toEqual({
        confirmName: 'Ben Admin',
        stepUp: { id: expect.stringMatching(/^oc\d+$/), confirm: true },
    });
});
