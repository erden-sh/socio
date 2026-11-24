// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { DeactivationImpact, RosterPerson } from '@socio/shared/auth';
import type { Group } from '@socio/shared/groups';
import type { ServiceAccountView } from '@socio/shared/service-accounts';
import type { User } from '@socio/shared/types';

import {
    initials,
    lastActive,
    reachSummary,
    signInChips,
    signInLinkWords,
} from '../src/modules/settings/people/people-format';
import { PeopleSection } from '../src/modules/settings/people/PeopleSection';
import { CurrentUser } from '../src/shell/current-user';

// Radix menus and checkboxes measure themselves.
globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
} as unknown as typeof ResizeObserver;

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

// Ana is an admin and the workspace owner (CB-390).
const owner: User = { id: 'u-ana', name: 'Ana Ops', role: 'admin' };
const admin: User = { id: 'u-ben', name: 'Ben Admin', role: 'admin' };

const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const reach = (overrides: Partial<NonNullable<RosterPerson['reach']>> = {}) => ({
    spaces: 2,
    socioGrants: 0,
    connectedAgents: 0,
    appsOwned: 0,
    keysMade: 0,
    codeAccess: false,
    telegram: false,
    ...overrides,
});
const person = (overrides: Partial<RosterPerson> & Pick<RosterPerson, 'id' | 'name' | 'role'>): RosterPerson => ({
    userId: `u-${overrides.id}`,
    email: `${overrides.id}@example.com`,
    emailVerified: true,
    adminByRule: false,
    password: true,
    passkeys: 0,
    providers: [],
    signInLinkVia: null,
    deactivated: false,
    createdAt: '2026-10-08T00:00:00.000Z',
    status: 'active',
    lastActiveAt: iso(3 * 86_400_000),
    sessions: 1,
    invite: null,
    reach: reach(),
    ...overrides,
});
// In no particular order: the list sorts them.
const roster: RosterPerson[] = [
    person({
        id: 'eve',
        name: 'Eve Former',
        role: 'member',
        status: 'deactivated',
        deactivated: true,
        sessions: 0,
        reach: reach({ appsOwned: 1 }),
    }),
    person({
        id: 'finn',
        name: 'Finn Invited',
        role: 'member',
        status: 'invited',
        password: false,
        lastActiveAt: null,
        sessions: 0,
        invite: { expiresAt: iso(86_400_000), expired: true },
    }),
    person({ id: 'dev', name: 'Dev Member', role: 'member' }),
    person({
        id: 'ana',
        name: 'Ana Ops',
        role: 'admin',
        owner: true,
        password: false,
        passkeys: 2,
        signInLinkVia: 'telegram',
        lastActiveAt: iso(60_000),
        sessions: 2,
        reach: reach({ spaces: 5, socioGrants: 3, appsOwned: 2, codeAccess: true, telegram: true }),
    }),
    person({
        id: 'cleo',
        name: 'Cleo Member',
        role: 'member',
        password: false,
        passkeys: 1,
        providers: ['google'],
        reach: reach({ appsOwned: 1 }),
    }),
    person({
        id: 'ben',
        name: 'Ben Admin',
        role: 'admin',
        lastActiveAt: iso(30 * 3_600_000),
        reach: reach({ spaces: 4, socioGrants: 1, keysMade: 2 }),
    }),
];

const impacts: Record<string, DeactivationImpact> = {
    ben: {
        accountId: 'ben',
        name: 'Ben Admin',
        refusal: null,
        deactivated: false,
        sessions: 2,
        keys: [
            {
                keyId: 'k1',
                name: 'deploys',
                hint: 'abcdef',
                accountId: 'svc_ci',
                account: 'CI',
                lastUsedAt: NOW - 2 * 3_600_000,
                expiresAt: NOW + 86_400_000,
                lastLiveKey: true,
            },
            {
                keyId: 'k2',
                name: 'nightly',
                hint: 'ghijkl',
                accountId: 'svc_bs',
                account: 'Board sync',
                lastUsedAt: null,
                expiresAt: NOW + 86_400_000,
                lastLiveKey: false,
            },
        ],
        connectedAgents: 1,
        socioGrants: 1,
        appSessions: 0,
        pluginAccess: 0,
        scheduledTasks: 3,
        jobRuns: 0,
        subscriptionConnections: 1,
        mcpConnections: 0,
        rooms: { handedOver: 1, archived: 0 },
        appsOwned: 2,
        owned: { apps: 2, schedules: 3 },
    },
    ana: {
        accountId: 'ana',
        name: 'Ana Ops',
        refusal: 'The workspace owner stays an active admin. Make another admin the owner first.',
        deactivated: false,
        sessions: 0,
        keys: [],
        connectedAgents: 0,
        socioGrants: 0,
        appSessions: 0,
        pluginAccess: 0,
        scheduledTasks: 0,
        jobRuns: 0,
        subscriptionConnections: 0,
        mcpConnections: 0,
        rooms: { handedOver: 0, archived: 0 },
        appsOwned: 0,
        owned: {},
    },
};

const services: ServiceAccountView[] = [
    {
        id: 'svc_ci',
        name: 'CI',
        role: 'member',
        description: 'deploys',
        createdAt: NOW,
        createdBy: 'u-ben',
        createdByName: 'Ben Admin',
        disabledAt: null,
        keys: [],
    },
    {
        id: 'svc_bs',
        name: 'Board sync',
        role: 'member',
        description: '',
        createdAt: NOW,
        createdBy: 'u-ben',
        createdByName: 'Ben Admin',
        disabledAt: null,
        keys: [],
    },
];

const groups: Group[] = [
    {
        id: 'g-0123456789ab',
        name: 'Coders',
        permissions: ['code:run'],
        members: [
            { accountId: 'cleo', userId: 'u-cleo', name: 'Cleo Member', email: 'cleo@example.com', deactivated: false },
        ],
        createdAt: iso(86_400_000),
    },
];

let host: HTMLDivElement;
let root: Root;
let requests: { path: string; method: string; body?: unknown }[];
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    requests = [];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const path = new URL(input, 'http://app.test').pathname;
        const method = init?.method ?? 'GET';
        requests.push({ path, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
        const impact = /^\/api\/accounts\/([^/]+)\/deactivation-impact$/.exec(path)?.[1];
        const body =
            path === '/api/accounts/roster'
                ? { people: roster }
                : path === '/api/accounts' && method === 'GET'
                  ? { accounts: roster, unlinked: [{ id: 'u-zoe', name: 'Zoe', role: 'member' }] }
                  : path === '/api/accounts' && method === 'POST'
                    ? {
                          account: roster[0],
                          link: { url: 'https://app.test/reset?token=t', expiresAt: iso(-86_400_000), emailed: false },
                      }
                    : path.endsWith('/password-link')
                      ? { url: 'https://app.test/reset?token=new', expiresAt: iso(-86_400_000), emailed: false }
                      : path.endsWith('/sign-in-link')
                        ? { via: 'telegram', expiresAt: iso(-900_000) }
                        : impact
                          ? impacts[impact]
                          : path === '/api/service-accounts'
                            ? services
                            : path === '/api/admin/people/u-ben/releases'
                              ? { userId: 'u-ben', lastSeen: '0.6.1', views: [{ version: '0.6.1', firstSeenAt: NOW }] }
                              : path === '/api/accounts/ben/assets'
                                ? {
                                      accountId: 'ben',
                                      name: 'Ben Admin',
                                      kinds: [{ kind: 'apps', count: 2, items: [] }],
                                  }
                                : path === '/api/accounts/ben/transfer'
                                  ? {
                                        from: { accountId: 'ben', name: 'Ben Admin' },
                                        to: { accountId: 'dev', name: 'Dev Member' },
                                        kinds: [{ kind: 'apps', moved: { apps: 2 }, notes: [] }],
                                    }
                                  : path === '/api/groups' && method === 'GET'
                                    ? { groups }
                                    : { ok: true };
        return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
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

async function open(user: User, entry = '/settings/people', signIn = true) {
    act(() =>
        root.render(
            <MemoryRouter initialEntries={[entry]}>
                <CurrentUser.Provider value={user}>
                    <PeopleSection signIn={signIn} />
                </CurrentUser.Provider>
            </MemoryRouter>,
        ),
    );
    if (signIn && !entry.includes('tab=')) {
        await until(() => !!document.querySelector('[data-person="ana@example.com"]'), 'the roster');
    }
}

const table = () => document.querySelector<HTMLTableElement>('table[data-slot="people-table"]')!;
const row = (name: string) =>
    [...table().querySelectorAll('tbody tr')].find((tr) => tr.textContent?.includes(name)) as HTMLElement;
const names = () => [...table().querySelectorAll('[data-slot="person-link"]')].map((link) => link.textContent);
const select = (label: string) => document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
const options = (label: string) => [...select(label).options].map((option) => option.value);
const button = (scope: ParentNode, label: string) =>
    [...scope.querySelectorAll('button')].find((b) => b.textContent === label)!;
const key = (target: Element, name: string) =>
    act(() => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
    });
const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
const item = (label: string) => items().find((entry) => entry.textContent === label);
async function menu(name: string) {
    key(row(name).querySelector(`[aria-label="Actions for ${name}"]`)!, 'Enter');
    await until(() => items().length > 0, `${name}'s menu`);
}
const pick = (label: string, value: string) =>
    act(() => {
        const element = select(label);
        element.value = value;
        element.dispatchEvent(new Event('change', { bubbles: true }));
    });
const type = (element: HTMLInputElement, value: string) =>
    act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
    });
const dialog = (slot: string) => document.querySelector<HTMLElement>(`[data-slot="${slot}"]`);

it('lists active people by name, then invited, then deactivated, with what each row says', async () => {
    await open(admin);
    expect(names()).toEqual(['Ana Ops', 'Ben Admin', 'Cleo Member', 'Dev Member', 'Finn Invited', 'Eve Former']);
    const badge = (name: string) => row(name).querySelector('[data-slot="badge"][data-state]')!.textContent;
    expect(['Ana Ops', 'Finn Invited', 'Eve Former'].map(badge)).toEqual(['Active', 'Invite expired', 'Deactivated']);
    expect(row('Eve Former').className).toContain('opacity-60');
    // Initials, the person's page, and how they sign in.
    expect(row('Ana Ops').querySelector('[data-slot="avatar-fallback"]')?.textContent).toBe('AO');
    expect(row('Ana Ops').querySelector('a')?.getAttribute('href')).toBe('/settings/people/ana');
    expect(row('Ana Ops').textContent).toContain('Now2 devices');
    expect(row('Ana Ops').textContent).toContain('Passkey ×2');
    expect(row('Ana Ops').textContent).toContain('5 Spaces · 3 socios · 2 apps · code');
    expect(row('Dev Member').querySelector('[data-warn]')?.textContent).toBe('Password only');
    expect(row('Finn Invited').textContent).toContain('Nothing set up yet');
    expect(row('Eve Former').textContent).toContain('Can’t sign in');
    expect(row('Eve Former').textContent).toContain('Owns 1 app');
    // The tabs' counts.
    await until(() => document.body.textContent!.includes('Service accounts · 2'), 'the service account count');
    expect(document.body.textContent).toContain('People · 6');
    // A phone gets a card per person, in the same order.
    expect(
        [...document.querySelectorAll('[data-slot="people-cards"] > li')].map((li) => li.getAttribute('data-person')),
    ).toEqual([
        'ana@example.com',
        'ben@example.com',
        'cleo@example.com',
        'dev@example.com',
        'finn@example.com',
        'eve@example.com',
    ]);
    // Each card opens the person's page, as the table's rows do.
    expect(
        document
            .querySelector('[data-slot="people-cards"] [data-person="ben@example.com"] [data-slot="person-link"]')
            ?.getAttribute('href'),
    ).toBe('/settings/people/ben');
});

it('changes roles from a phone’s cards too, with the same guards and confirmation', async () => {
    await open(admin);
    const card = (email: string) =>
        document.querySelector<HTMLElement>(`[data-slot="people-cards"] [data-person="${email}"]`)!;
    const picker = (email: string) => card(email).querySelector<HTMLSelectElement>('select[aria-label^="Role of"]')!;
    expect(picker('ana@example.com').disabled).toBe(true);
    expect([...picker('ben@example.com').options].map((o) => o.value)).toEqual(['admin', 'member']);
    act(() => {
        picker('ben@example.com').value = 'member';
        picker('ben@example.com').dispatchEvent(new Event('change', { bubbles: true }));
    });
    await until(() => !!dialog('confirm-role'), 'the confirmation');
    expect(requests.some((r) => r.method === 'PATCH')).toBe(false);
});

it('searches by name or email and filters by role and status', async () => {
    await open(admin);
    type(document.querySelector<HTMLInputElement>('input[aria-label="Search name or email"]')!, 'CLEO@');
    expect(names()).toEqual(['Cleo Member']);
    type(document.querySelector<HTMLInputElement>('input[aria-label="Search name or email"]')!, '');
    pick('Role filter', 'member');
    expect(names()).toEqual(['Cleo Member', 'Dev Member', 'Finn Invited', 'Eve Former']);
    pick('Status filter', 'invite-expired');
    expect(names()).toEqual(['Finn Invited']);
    pick('Role filter', 'admin');
    expect(document.querySelector('[data-slot="people-empty"]')?.textContent).toBe('Nobody matches.');
});

it('calls out expired invites, with a new password link as the resend', async () => {
    await open(admin);
    const callout = document.querySelector<HTMLElement>('[data-slot="expired-invites"]')!;
    expect(callout.textContent).toContain('1 invite expired without being used');
    expect(callout.textContent).toContain('Finn Invited');
    await act(async () => button(callout, 'Password link').click());
    expect(requests).toContainEqual({ path: '/api/accounts/finn/password-link', method: 'POST', body: {} });
    await until(() => !!document.querySelector('input[aria-label="Password link"]'), 'the link');
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Password link"]')!.value).toBe(
        'https://app.test/reset?token=new',
    );
});

it('keeps the workspace owner’s account to the owner, with an Owner badge', async () => {
    await open(admin);
    const owners = () => [...table().querySelectorAll('[data-slot="owner-badge"]')].map((b) => b.closest('tr'));
    expect(owners()).toEqual([row('Ana Ops')]);
    expect(row('Ana Ops').querySelector('[data-slot="owner-badge"]')!.textContent).toBe('Owner');
    expect(select('Role of Ana Ops').disabled).toBe(true);
    expect(select('Role of Ana Ops').title).toContain('only the owner can change it');
    expect(select('Role of Ben Admin').disabled).toBe(false);
    expect(options('Role of Ben Admin')).toEqual(['admin', 'member']);
    expect(select('Role of Eve Former').disabled).toBe(true);
    await menu('Ana Ops');
    expect(items().map((entry) => [entry.textContent, entry.hasAttribute('data-disabled')])).toEqual([
        ['Open', false],
        ['Password link', true],
        ['Send sign-in link via Telegram', false],
        ['Releases seen', false],
        ['Sign out everywhere', true],
        ['Deactivate…', true],
    ]);
    key(document.activeElement ?? document.body, 'Escape');
    await until(() => !items().length, 'the menu to close');
    // No operator role to give anyone.
    act(() => button(document, 'Invite people').click());
    await until(() => !!dialog('invite-people'), 'the invite dialog');
    expect(options("New person's role")).toEqual(['admin', 'member']);
    act(() => root.unmount());
    root = createRoot(host);

    // The owner manages their own account, but stays an active admin.
    await open(owner);
    expect(select('Role of Ana Ops').disabled).toBe(true);
    expect(select('Role of Ana Ops').title).toContain('make another admin the owner first');
    expect(options('Role of Ben Admin')).toEqual(['admin', 'member']);
    await menu('Ana Ops');
    expect(items().map((entry) => [entry.textContent, entry.hasAttribute('data-disabled')])).toEqual([
        ['Open', false],
        ['Password link', false],
        ['Send sign-in link via Telegram', false],
        ['Releases seen', false],
        ['Sign out everywhere', false],
        ['Deactivate…', true],
    ]);
});

it('asks before a role change that takes something away, and not before one that adds', async () => {
    await open(owner);
    const patches = () => requests.filter((r) => r.method === 'PATCH');
    pick('Role of Dev Member', 'admin');
    await until(() => patches().length === 1, 'the promotion');
    expect(patches()[0]).toEqual({ path: '/api/accounts/dev', method: 'PATCH', body: { role: 'admin' } });
    pick('Role of Ben Admin', 'member');
    await until(() => !!dialog('confirm-role'), 'the confirmation');
    expect(dialog('confirm-role')!.textContent).toContain('Make Ben Admin a member?');
    expect(dialog('confirm-role')!.textContent).toContain('plugin sessions');
    expect(patches()).toHaveLength(1);
    await act(async () => button(dialog('confirm-role')!, 'Make member').click());
    await until(() => patches().length === 2, 'the demotion');
    expect(patches()[1]).toEqual({ path: '/api/accounts/ben', method: 'PATCH', body: { role: 'member' } });
});

it('sends a sign-in link by Telegram from the menu, to people with Telegram linked', async () => {
    await open(admin);
    await menu('Ben Admin');
    expect(item('Send sign-in link via Telegram')).toBeUndefined();
    key(document.activeElement ?? document.body, 'Escape');
    await until(() => !items().length, 'the menu to close');
    await menu('Ana Ops');
    await act(async () => item('Send sign-in link via Telegram')!.click());
    expect(requests).toContainEqual({ path: '/api/accounts/ana/sign-in-link', method: 'POST', body: {} });
    // Nothing to copy: the link went to Ana, not to the admin.
    expect(document.querySelector('input[aria-label="Password link"]')).toBeNull();
});

it('previews a deactivation, keys first, and names the person on the button', async () => {
    await open(admin);
    await menu('Ben Admin');
    await act(async () => item('Deactivate…')!.click());
    await until(() => !!dialog('deactivation-impact'), 'the preview');
    const preview = dialog('confirm-deactivate')!;
    expect(requests).toContainEqual({ path: '/api/accounts/ben/deactivation-impact', method: 'GET' });
    expect(preview.querySelector('h2')?.textContent).toBe('Deactivate Ben Admin?');
    const keys = preview.querySelector<HTMLElement>('[data-slot="impact-keys"]')!;
    expect(keys.textContent).toContain('2 service keys stop working.');
    expect(keys.querySelector('[data-key="deploys"] [data-slot="last-live-key"]')?.textContent).toBe(
        'CI’s only key: CI stops',
    );
    expect(keys.querySelector('[data-key="nightly"]')?.textContent).toContain('Board sync keeps another key');
    expect(keys.querySelector('[data-key="nightly"] [data-slot="last-live-key"]')).toBeNull();
    const link = [...keys.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]);
    expect(link).toEqual([['Open CI', '/settings/people?tab=service-accounts&account=svc_ci']]);
    // Also ends: non-zero lines only, in order; then what stays theirs.
    const ends = [...preview.querySelectorAll('[aria-label="Also ends"] li')].map((li) => li.textContent);
    expect(ends).toEqual([
        'Sessions on 2 devicessigned out now',
        '1 connected agentdisconnected',
        '1 socio access grantrevoked',
        '3 scheduled taskspaused, kept',
        '1 model subscription connectiondisconnected',
        '1 room where Ben is the last adminhanded to its earliest member',
    ]);
    expect(preview.querySelector('[aria-label="Stays Ben’s"]')?.textContent).toContain('2 apps they own');
    // Nothing happens until it is confirmed.
    const deactivations = () => requests.filter((r) => r.path.endsWith('/deactivate'));
    expect(deactivations()).toEqual([]);
    await act(async () => button(preview, 'Deactivate Ben').click());
    expect(deactivations()).toEqual([{ path: '/api/accounts/ben/deactivate', method: 'POST', body: {} }]);
});

it('loads the list again after a transfer started from the deactivate dialog', async () => {
    await open(admin);
    await menu('Ben Admin');
    await act(async () => item('Deactivate…')!.click());
    await until(() => !!dialog('impact-owned'), 'what Ben owns');
    await act(async () => button(dialog('impact-owned')!, 'Transfer…').click());
    await until(() => !!document.querySelector('select[aria-label="New owner"] option[value="dev"]'), 'the people');
    const rosterLoads = () => requests.filter((r) => r.path === '/api/accounts/roster' && r.method === 'GET').length;
    const before = rosterLoads();
    pick('New owner', 'dev');
    await act(async () => button(dialog('transfer-dialog')!, 'Transfer everything to Dev').click());
    await until(() => !!dialog('transfer-result'), 'the result');
    expect(requests).toContainEqual({ path: '/api/accounts/ben/transfer', method: 'POST', body: { to: 'dev' } });
    // Ben owns less now: the roster behind the dialog is read again, without a deactivation.
    await until(() => rosterLoads() > before, 'the roster again');
    expect(requests.filter((r) => r.path.endsWith('/deactivate'))).toEqual([]);
});

it('opens the service account from the preview, to make it a new key', async () => {
    await open(admin);
    await menu('Ben Admin');
    await act(async () => item('Deactivate…')!.click());
    await until(() => !!dialog('impact-keys'), 'the keys');
    await act(async () => [...dialog('impact-keys')!.querySelectorAll('a')][0]!.click());
    await until(() => !!document.querySelector('[data-account-id="svc_ci"]'), 'the Service accounts tab');
    expect(document.querySelector('[data-account-id="svc_ci"]')!.className).toContain('ring-2');
    expect(dialog('confirm-deactivate')).toBeNull();
});

it('refuses a deactivation the server refuses (the last admin), and says why', async () => {
    impacts.dev = { ...impacts.ana!, accountId: 'dev', name: 'Dev Member', refusal: 'Keep at least one admin.' };
    try {
        await open(admin);
        await menu('Dev Member');
        await act(async () => item('Deactivate…')!.click());
        await until(() => !!dialog('impact-refusal'), 'the refusal');
        expect(dialog('impact-refusal')!.textContent).toBe('Keep at least one admin.');
        expect(button(dialog('confirm-deactivate')!, 'Deactivate Dev').disabled).toBe(true);
    } finally {
        delete impacts.dev;
    }
});

it('reactivates after saying what doesn’t come back', async () => {
    await open(admin);
    await menu('Eve Former');
    expect(items().map((entry) => entry.textContent)).toEqual(['Open', 'Reactivate…']);
    await act(async () => item('Reactivate…')!.click());
    await until(() => !!dialog('confirm-reactivate'), 'the confirmation');
    expect(dialog('confirm-reactivate')!.textContent).toContain('service keys they made');
    expect(dialog('confirm-reactivate')!.textContent).toContain('stay paused until they resume them');
    await act(async () => button(dialog('confirm-reactivate')!, 'Reactivate Eve').click());
    expect(requests).toContainEqual({ path: '/api/accounts/eve/reactivate', method: 'POST', body: {} });
});

it('shows the releases a person has seen (CB-166)', async () => {
    await open(admin);
    await menu('Ben Admin');
    await act(async () => item('Releases seen')!.click());
    await until(() => !!document.querySelector('[data-slot="person-releases"] li'), 'the releases');
    expect(requests).toContainEqual({ path: '/api/admin/people/u-ben/releases', method: 'GET' });
    expect(document.querySelector('[data-slot="person-releases"]')!.getAttribute('aria-label')).toBe(
        'Releases Ben Admin has seen',
    );
});

it('invites a person from the dialog, linking an existing user, and shows their password link', async () => {
    await open(admin);
    act(() => button(document, 'Invite people').click());
    await until(() => options('Existing user to link').includes('u-zoe'), 'the unlinked users');
    const form = document.querySelector<HTMLFormElement>('form[aria-label="Add a person"]')!;
    type(form.querySelector<HTMLInputElement>('[aria-label="New person\'s name"]')!, 'Zoe New');
    type(form.querySelector<HTMLInputElement>('[aria-label="New person\'s email"]')!, 'zoe@example.com');
    pick("New person's role", 'admin');
    pick('Existing user to link', 'u-zoe');
    await act(async () => form.requestSubmit());
    await until(() => !!dialog('password-link'), 'the link');
    expect(requests.find((r) => r.path === '/api/accounts' && r.method === 'POST')?.body).toEqual({
        name: 'Zoe New',
        email: 'zoe@example.com',
        role: 'admin',
        userId: 'u-zoe',
    });
    expect(dialog('password-link')!.textContent).toContain('Password link for zoe@example.com');
});

it('opens Service accounts from its address, and keeps them with the local sign-in picker', async () => {
    await open(admin, '/settings/people?tab=service-accounts', false);
    await until(() => !!document.querySelector('[data-account="CI"]'), 'the service accounts');
    expect(document.querySelector('[data-slot="needs-sign-in"]')).toBeNull();
    expect(requests.some((r) => r.path === '/api/accounts/roster')).toBe(false);
});

it('manages groups under the Groups tab: create with "Run code", add and remove people, delete after asking', async () => {
    await open(admin, '/settings/people?tab=groups');
    await until(() => !!document.querySelector('[data-slot="group"]'), 'the groups');
    await until(() => options('Person to add to Coders').includes('dev'), 'the roster');
    const card = document.querySelector<HTMLElement>('section[aria-label="Group Coders"]')!;
    expect(card.textContent).toContain('Run code');
    expect([...card.querySelectorAll('[data-slot="group-member"]')].map((entry) => entry.textContent)).toEqual([
        expect.stringContaining('Cleo Member'),
    ]);
    // Add: everyone active not in it yet, admins too (marked).
    const addable = options('Person to add to Coders').filter(Boolean);
    expect(addable).not.toContain('cleo');
    expect(addable).not.toContain('eve');
    expect(addable).toContain('dev');
    pick('Person to add to Coders', 'dev');
    await act(async () =>
        card.querySelector<HTMLFormElement>('form[aria-label="Add someone to Coders"]')!.requestSubmit(),
    );
    expect(requests).toContainEqual(
        expect.objectContaining({ method: 'PUT', path: '/api/groups/g-0123456789ab/members/dev' }),
    );
    await act(async () => button(card, 'Remove').click());
    expect(requests).toContainEqual(
        expect.objectContaining({ method: 'DELETE', path: '/api/groups/g-0123456789ab/members/cleo' }),
    );
    // Create: a name, "Run code" ticked by default.
    act(() => button(document, 'New group').click());
    await until(() => !!dialog('group-dialog'), 'the new group dialog');
    type(dialog('group-dialog')!.querySelector<HTMLInputElement>('[aria-label="Group name"]')!, 'Builders');
    await act(async () => dialog('group-dialog')!.querySelector<HTMLFormElement>('form')!.requestSubmit());
    expect(requests.find((r) => r.path === '/api/groups' && r.method === 'POST')?.body).toEqual({
        name: 'Builders',
        permissions: ['code:run'],
    });
    // Delete asks first.
    act(() => button(card, 'Delete').click());
    await until(() => !!dialog('delete-group'), 'the confirmation');
    expect(requests.some((r) => r.method === 'DELETE' && r.path === '/api/groups/g-0123456789ab')).toBe(false);
    await act(async () => button(dialog('delete-group')!, 'Delete').click());
    expect(requests).toContainEqual(expect.objectContaining({ method: 'DELETE', path: '/api/groups/g-0123456789ab' }));
});

it('says groups need real accounts with the local sign-in picker', async () => {
    await open(admin, '/settings/people?tab=groups', false);
    await until(() => !!document.querySelector('[data-slot="needs-sign-in"]'), 'the note');
    expect(document.querySelector('[data-slot="needs-sign-in"]')!.textContent).toContain('admins may run code');
    expect(requests.some((r) => r.path === '/api/groups')).toBe(false);
});

it('words last active, sign-in methods and reach', () => {
    const now = Date.UTC(2026, 10, 8, 12);
    expect(
        [5 * 60_000, 25 * 60_000, 3 * 3_600_000, 30 * 3_600_000, 3 * 86_400_000, 16 * 86_400_000].map((ago) =>
            lastActive(now - ago, now),
        ),
    ).toEqual(['Now', '25 min ago', '3 h ago', 'Yesterday', '3 days ago', '2 weeks ago']);
    expect(lastActive(Date.UTC(2026, 9, 2, 12), now)).toBe('Oct 2');
    expect(signInChips(roster.find((p) => p.id === 'cleo')!)).toEqual([{ label: 'Passkey' }, { label: 'Google' }]);
    expect(reachSummary({ ...roster[0]!, reach: null })).toBe('—');
    expect(['Ana Ops', 'CI', 'cleo', 'Ben van Admin'].map(initials)).toEqual(['AO', 'CI', 'CL', 'BA']);
});

it('words the admin’s sign-in link by the channel it goes by (CB-352)', () => {
    expect(signInLinkWords('email')).toEqual({ action: 'Send sign-in link by email', sent: 'by email' });
    expect(signInLinkWords('telegram')).toEqual({ action: 'Send sign-in link via Telegram', sent: 'on Telegram' });
    expect(signInLinkWords(null)).toBeNull();
});
