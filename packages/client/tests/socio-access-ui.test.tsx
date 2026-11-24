// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';

import type { ApprovalView, ApprovalsState } from '@socio/shared/approvals';
import type { CodingSessionCard } from '@socio/shared/coding/coding-sessions';
import type { AppAccessCard, AppActionCard, SocioGrantView } from '@socio/shared/socio-access';

import { ApprovalBar } from '../src/modules/approvals/ApprovalBar';
import { ApprovalCard } from '../src/modules/approvals/ApprovalCard';
import { OPS_GROUPS, findOpsSection } from '../src/modules/operations/sections';
import { SETTINGS_GROUPS, allowed, listed } from '../src/modules/settings/sections';
import { SocioAccessSection } from '../src/modules/settings/SocioAccessSection';
import { ShellContext } from '../src/shell/shell-context';

// CB-232 in the browser: the consent cards (facts first, their
// words inert, "Allow for this task", Allow off until long parameters are
// opened), the composer's bar, Account → Socio access and the flag gates.

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const RLO = String.fromCodePoint(0x202e);
let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

async function until(check: () => boolean, what: string) {
    for (const deadline = Date.now() + 5_000; Date.now() < deadline;) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${host?.textContent}`);
}
const mount = (element: ReactNode) => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<MemoryRouter>{element}</MemoryRouter>));
};
const button = (text: string) =>
    [...host!.querySelectorAll('button')].find((entry) => entry.textContent?.includes(text));

const facts = {
    label: 'CRM Dashboard',
    origin: 'https://crm.apps.example',
    owner: 'Alice',
    development: false,
};
const accessCard = (extra: Partial<AppAccessCard> = {}): AppAccessCard => ({
    kind: 'app_access',
    socioName: 'Rulo',
    access: 'write',
    minutes: 60,
    app: facts,
    allows: ['see and change the app’s own data'],
    never: 'It can’t change the app’s settings or sharing.',
    visibleTo: null,
    task: `Fix **stages** [link](https://evil.example) [U+202E]x`,
    widens: false,
    alwaysAsk: false,
    ...extra,
});
const view = (extra: Partial<ApprovalView>): ApprovalView => ({
    id: 'ap1',
    dotId: 'd1',
    dotName: 'Rulo',
    capability: 'app_access_write',
    capabilityLabel: 'Let a socio change an app’s data for you',
    summary: 'Read and change CRM Dashboard for 1 hour',
    details: [],
    status: 'pending',
    createdAt: 1,
    expiresAt: Date.now() + 900_000,
    card: accessCard(),
    ...extra,
});

/** Answers `/api/approvals/ap1` with `current()`, and records calls. */
function serve(current: () => ApprovalView, extra: (path: string, method: string) => unknown = () => undefined) {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://app.test');
        const method = init?.method ?? 'GET';
        calls.push({
            method,
            path: url.pathname,
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        const answer = extra(url.pathname, method) ?? current();
        return new Response(JSON.stringify(answer), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    });
    return calls;
}

it('shows an access card: platform facts first, the socio’s words as inert text', async () => {
    const card = accessCard({ visibleTo: 'Sales room' });
    serve(() => view({ card }));
    mount(<ApprovalCard id="ap1" initial={view({ card })} />);
    const text = host!.textContent!;
    expect(text).toContain('Rulo wants to read and change CRM Dashboard');
    expect(text).toContain('https://crm.apps.example');
    expect(text).toContain('visible to everyone in Sales room');
    // Markdown and links stay text; no link to the socio's URL.
    expect(text).toContain('Fix **stages** [link](https://evil.example)');
    expect(host!.querySelector('a[href="https://evil.example"]')).toBeNull();
    expect(text).not.toContain(RLO);
    // Write: "Allow for this task", and nothing else is labeled Approve.
    expect(button('Allow for this task')).toBeDefined();
    expect(button('Approve')).toBeUndefined();
    // The facts come before the quote.
    const quote = host!.querySelector('[data-slot="socio-access-quote"]')!;
    const app = host!.querySelector('[data-slot="socio-access-app"]')!;
    expect(app.compareDocumentPosition(quote) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('keeps Allow off until the full parameters are opened, then allows', async () => {
    const action: AppActionCard = {
        kind: 'app_action',
        socioName: 'Rulo',
        app: facts,
        action: 'sms.send',
        tier: 'consequential',
        params: {
            preview: '{"body":"yyyy',
            bytes: 4096,
            complete: false,
            counts: [{ path: 'recipients', count: 142 }],
        },
        display: [{ label: 'Summary', value: 'Send a reminder to Dana' }],
    };
    let opened = false;
    const current = () =>
        view({
            capability: 'app_action',
            card: action,
            review: { mustOpen: true, opened },
        });
    const calls = serve(current, (path, method) => {
        if (path === '/api/approvals/ap1/open' && method === 'POST') {
            opened = true;
            return { full: `{"body":"yyyy${RLO}","recipients":["+1"]}` };
        }
        return undefined;
    });
    mount(<ApprovalCard id="ap1" initial={current()} />);
    const allow = button('Allow')!;
    expect(allow.disabled).toBe(true);
    expect(allow.getAttribute('aria-describedby')).toBeTruthy();
    expect(host!.textContent).toContain('142 items in recipients');
    expect(host!.textContent).toContain('As described by the app');
    await act(async () => button('Show all parameters')!.click());
    await until(() => !button('Allow')!.disabled, 'Allow to turn on');
    const params = host!.querySelector('[data-slot="action-params"]')!;
    expect(params.textContent).toContain('[U+202E]');
    expect(params.textContent).not.toContain(RLO);
    // Focus moves to what was opened.
    expect(document.activeElement).toBe(params);
    expect(calls.some((call) => call.path === '/api/approvals/ap1/open')).toBe(true);
});

it('the composer bar waits for the card too, and says so', () => {
    const pending = view({
        capability: 'app_action',
        card: null,
        review: { mustOpen: true, opened: false },
    });
    mount(<ApprovalBar pending={[{ view: pending, busy: false, decide: async () => {} }]} onShow={() => {}} />);
    expect(button('Approve')!.disabled).toBe(true);
    expect(host!.textContent).toContain('open all its parameters');
});

it('the composer bar never allows an action or access beyond read: that is the card’s', async () => {
    const small: AppActionCard = {
        kind: 'app_action',
        socioName: 'Rulo',
        app: facts,
        action: 'sms.send',
        tier: 'consequential',
        params: {
            preview: '{"to":["+1"]}',
            bytes: 13,
            complete: true,
            counts: [{ path: 'to', count: 1 }],
        },
        display: [],
    };
    const codingCard: CodingSessionCard = {
        kind: 'coding_session',
        socioName: 'Rulo',
        repository: 'acme/app',
        base: 'main',
        branchPattern: 'socio/rulo/…',
        push: false,
        minutes: 60,
        model: { label: 'Homelab', outsideProvider: false, host: null },
        budgetTokens: 2_000_000,
        allows: ['read the repository'],
        never: 'It can’t push.',
        visibleTo: null,
        task: 'Fix the chart',
    };
    const decided: string[] = [];
    const shown: string[] = [];
    const bar = (pending: ApprovalView) =>
        mount(
            <ApprovalBar
                pending={[
                    {
                        view: pending,
                        busy: false,
                        decide: async (decision) => void decided.push(decision),
                    },
                ]}
                onShow={(id) => shown.push(id)}
            />,
        );
    // A small action (nothing to open) and write and act access: no Allow,
    // whatever it is labeled; Deny and Show request stay, as buttons.
    for (const pending of [
        view({ capability: 'app_action', card: small, review: null }),
        view({ card: accessCard({ access: 'write' }) }),
        view({ capability: 'app_access_act', card: accessCard({ access: 'act' }) }),
        // A coding session (CB-239): repository, model, budget and push are
        // on its card only.
        view({ capability: 'coding_session_read', card: codingCard }),
    ]) {
        bar(pending);
        expect(button('Allow')).toBeUndefined();
        expect(button('Approve')).toBeUndefined();
        expect(host!.querySelector('[data-slot="approval-on-card"]')?.textContent).toContain('decide on its card');
        await act(async () => button('Show request')!.click());
        await act(async () => button('Deny')!.click());
        act(() => root!.unmount());
        host!.remove();
    }
    expect(shown).toEqual(['ap1', 'ap1', 'ap1', 'ap1']);
    expect(decided).toEqual(['deny', 'deny', 'deny', 'deny']);
    // Read access may still be allowed from the bar, as before.
    bar(
        view({
            capability: 'app_access_read',
            card: accessCard({ access: 'read' }),
        }),
    );
    expect(host!.querySelector('[data-slot="approval-on-card"]')).toBeNull();
    const allow = button('Allow')!;
    expect(allow.textContent).toBe('Allow');
    expect(allow.disabled).toBe(false);
    await act(async () => allow.click());
    expect(decided.at(-1)).toBe('approve');
});

it('shows the app owner’s name inert', () => {
    const card = accessCard({ app: { ...facts, owner: `Ali${RLO}ecila` } });
    serve(() => view({ card }));
    mount(<ApprovalCard id="ap1" initial={view({ card })} />);
    const app = host!.querySelector('[data-slot="socio-access-app"]')!;
    expect(app.textContent).toContain('Ali[U+202E]ecila');
    expect(app.textContent).not.toContain(RLO);
});

const grant = (extra: Partial<SocioGrantView>): SocioGrantView => ({
    id: 'g1',
    socioId: 'd1',
    socioName: 'Rulo',
    audience: 'app:crm',
    app: { label: 'CRM Dashboard', origin: 'https://crm.apps.example' },
    access: 'read',
    scopes: ['app:read'],
    task: 'Check the chart',
    conversation: { kind: 'private', title: 'Pipeline' },
    createdAt: 1,
    expiresAt: Date.now() + 3_600_000,
    lastUsedAt: Date.now(),
    idleMinutes: 30,
    state: 'live',
    ended: null,
    ...extra,
});

it('Account → Socio access: the person’s read opt-in per socio, their grants and End access', async () => {
    let grants = [
        grant({}),
        grant({
            id: 'g0',
            state: 'ended',
            ended: { at: 2, reason: 'You ended it', by: 'you' },
        }),
    ];
    const approvals: Partial<ApprovalsState> = {
        capabilities: [
            {
                id: 'app_access_read',
                label: 'Read',
                description: '',
                auto: { allowed: true, maxRisk: 'low', rules: [], undo: false },
            },
        ],
        policies: [{ dotId: 'd2', capability: 'app_access_read', policy: 'bypass' }],
    };
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://app.test');
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, path: url.pathname, body });
        let answer: unknown = {};
        if (url.pathname === '/api/actors/grants') {
            answer = { grants };
        }
        if (url.pathname === '/api/approvals') {
            answer = approvals;
        }
        if (method === 'DELETE') {
            grants = grants.map((item) =>
                item.id === 'g1'
                    ? {
                          ...item,
                          state: 'ended',
                          ended: { at: 3, reason: 'You ended it', by: 'you' },
                      }
                    : item,
            );
            answer = { grant: grants[0] };
        }
        return new Response(JSON.stringify(answer), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    });
    const shell = {
        workspace: {
            user: { id: 'alice', name: 'Alice', role: 'member' },
            dots: [
                { id: 'd1', name: 'Rulo' },
                { id: 'd2', name: 'Mingo' },
            ],
        },
    };
    mount(
        <ShellContext.Provider value={shell as never}>
            <SocioAccessSection />
        </ShellContext.Provider>,
    );
    await until(() => !!host!.querySelector('[data-grant="g1"]'), 'the grants to load');
    const selects = [...host!.querySelectorAll('select')];
    expect(selects.map((select) => select.value)).toEqual(['manual', 'bypass']);
    expect(selects[0]!.getAttribute('aria-label')).toMatch(/Rulo may read apps for you without asking/);
    // Only read has a choice here: there is no select for write or act.
    expect(host!.textContent).toContain('Changing data and taking actions always wait for you');
    await act(async () => {
        selects[0]!.value = 'bypass';
        selects[0]!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(calls).toContainEqual({
        method: 'PUT',
        path: '/api/approvals/policies',
        body: { dotId: 'd1', capability: 'app_access_read', policy: 'bypass' },
    });
    // The ended grant is under "Ended"; the live one can be ended.
    expect(host!.querySelector('[data-slot="ended-grants"] [data-grant="g0"]')).not.toBeNull();
    const end = button('End access')!;
    expect(end.getAttribute('aria-label')).toBe('End Rulo’s access to CRM Dashboard');
    await act(async () => end.click());
    await until(() => !!document.querySelector('[data-slot="confirm-end-socio-access"]'), 'the confirmation');
    const confirm = [
        ...document.querySelectorAll<HTMLButtonElement>('[data-slot="confirm-end-socio-access"] button'),
    ].find((entry) => entry.textContent === 'End access')!;
    await act(async () => confirm.click());
    await until(() => calls.some((call) => call.method === 'DELETE'), 'the revoke');
    expect(calls.find((call) => call.method === 'DELETE')?.path).toBe('/api/actors/grants/g1');
});

it('lists Socio access in Settings and Operations only while the flag is on', () => {
    const entry = SETTINGS_GROUPS.flatMap((group) => group.entries).find((item) => item.id === 'socio-access')!;
    const access = {
        admin: false,
        operator: false,
        signIn: true,
        telegram: false,
    };
    expect(allowed(entry, access)).toBe(false);
    expect(listed(entry, { ...access, flags: [] })).toBe(false);
    expect(listed(entry, { ...access, flags: ['socio-actor-access'] })).toBe(true);
    const ops = OPS_GROUPS.flatMap((group) => group.sections).find((item) => item.id === 'socio-access');
    expect(ops?.flag).toBe('socio-actor-access');
    expect(findOpsSection('socio-access')?.label).toBe('Socio access');
});
