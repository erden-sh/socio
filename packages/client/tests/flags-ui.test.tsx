// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { FlagAdminView, FlagsAdminState } from '@socio/shared/flags';
import type { Role, WorkspaceState } from '@socio/shared/types';

import { FeaturesSection, SEARCH_FROM } from '../src/modules/settings/FeaturesSection';
import { SETTINGS_GROUPS, listed, settingsAccess } from '../src/modules/settings/sections';
import { ReleaseCard } from '../src/modules/whats-new/ReleaseCard';
import { WhatsNewPanel } from '../src/modules/whats-new/WhatsNewMenu';
import { useFlag } from '../src/shell/flags';
import { ShellContext, type Shell } from '../src/shell/shell-context';

// Settings → Optional features, Early access and In development, and
// What's new's early-access badges and link (CB-169, CB-182, CB-503).

vi.mock('@socio/shared/flags', async (importOriginal) => {
    const original = await importOriginal<typeof import('@socio/shared/flags')>();
    return {
        ...original,
        // A release highlight for CB-999 is an early-access feature.
        earlyAccessForIssue: (issue: string) => (issue === 'CB-999' ? [{ key: 'beta-board' }] : []),
    };
});

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root;
let host: HTMLDivElement;
let calls: Array<{ path: string; method: string; body?: unknown }>;
let answers: Record<string, unknown>;
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    calls = [];
    answers = {};
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
            const path = String(url).replace(/^\/api/, '');
            const method = init?.method ?? 'GET';
            calls.push({
                path,
                method,
                ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
            });
            return Response.json(method === 'GET' ? answers[path] : { ok: true });
        }),
    );
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
});

const workspace = (flags?: WorkspaceState['flags']) =>
    ({
        user: { id: 'bob', name: 'Bob', role: 'member' },
        flags,
    }) as WorkspaceState;
const shellOf = (flags?: WorkspaceState['flags']) =>
    ({
        workspace: workspace(flags),
        refresh: vi.fn(async () => {}),
    }) as unknown as Shell;

const render = (node: ReactNode, shell: Shell = shellOf()) =>
    act(async () =>
        root.render(
            <MemoryRouter>
                <ShellContext.Provider value={shell}>{node}</ShellContext.Provider>
            </MemoryRouter>,
        ),
    );
const settle = () => act(async () => {});

it('shows what the server decided for this person, and nothing outside the shell', async () => {
    function Probe() {
        return <span>{useFlag('web-reads') ? 'on' : 'off'}</span>;
    }
    await render(<Probe />, shellOf({ on: ['web-reads'] }));
    expect(host.textContent).toBe('on');
    await render(<Probe />, shellOf({ on: [] }));
    expect(host.textContent).toBe('off');
    await act(async () => root.render(<Probe />));
    expect(host.textContent).toBe('off');
});

const flag = (over: Partial<FlagAdminView>): FlagAdminView => ({
    key: 'web-reads',
    title: 'Socios read web pages',
    description: 'Reads.',
    stage: 'ga',
    default: true,
    owner: 'server',
    removeBy: '2027-06-30',
    tools: ['http_get', 'http_json'],
    you: { enabled: true, source: 'default' },
    everyone: { enabled: true, source: 'default' },
    workspaceBlocked: null,
    ...over,
});
const early = flag({
    key: 'beta-board',
    title: 'New board',
    stage: 'early-access',
    default: false,
    tools: [],
    issue: 'CB-999',
    you: { enabled: false, source: 'default' },
    everyone: { enabled: false, source: 'default' },
});
const unfinished = flag({
    key: 'beta-only',
    title: 'Unfinished',
    stage: 'dev',
    default: false,
    tools: [],
    you: { enabled: false, source: 'default' },
    everyone: { enabled: false, source: 'default' },
});
const adminState = (flags: FlagAdminView[] = [flag({}), early, unfinished]): FlagsAdminState => ({
    tenantId: 'main',
    flags,
    tiers: [{ id: 'pro', name: 'Pro', description: '', flags: {}, updatedBy: 'x', updatedAt: 1 }],
    tierId: 'pro',
    people: [
        { id: 'carol', name: 'Carol', role: 'admin' },
        { id: 'bob', name: 'Bob', role: 'member' },
    ],
    audit: [
        {
            actor: 'carol',
            actorName: 'Carol',
            action: 'update',
            targetKind: 'feature_flag',
            targetId: 'web-reads',
            detail: '{"scope":"workspace"}',
            createdAt: 1,
        },
        {
            actor: 'alice',
            actorName: 'Alice',
            action: 'update',
            targetKind: 'feature_flag',
            targetId: 'web-reads',
            detail: '{"scope":"instance"}',
            createdAt: 2,
        },
    ],
});
const cardsOn = () => [...host.querySelectorAll('[data-slot=flag]')];

it('splits the flags by stage: Optional features, Early access and In development', async () => {
    answers['/flags'] = adminState();
    await render(<FeaturesSection page="features" />);
    await settle();
    expect(cardsOn().map((card) => card.getAttribute('data-key'))).toEqual(['web-reads']);
    expect(host.querySelector('[data-slot=early-access-badge]')).toBeNull();
    await render(<FeaturesSection key="early" page="early-access" />);
    await settle();
    expect(cardsOn().map((card) => card.getAttribute('data-key'))).toEqual(['beta-board']);
    expect(cardsOn()[0]!.querySelector('[data-slot=early-access-badge]')).not.toBeNull();
    expect(cardsOn()[0]!.querySelector('[data-slot=flag-experimental]')?.textContent).toBe('Experimental');
    expect(host.textContent).toContain('people can’t turn them on for themselves');
    await render(<FeaturesSection key="dev" page="features-dev" />);
    await settle();
    expect(cardsOn().map((card) => card.getAttribute('data-key'))).toEqual(['beta-only']);
});

it('lists In development only in an internal deployment, and every flag page for admins only', () => {
    const entries = SETTINGS_GROUPS.flatMap((group) => group.entries);
    const ids = (internal: boolean, role: 'member' | 'admin' | 'operator') =>
        entries
            .filter((item) =>
                listed(
                    item,
                    settingsAccess(
                        {
                            user: { id: 'u', name: 'U', role },
                            setup: { telegram: 'not_configured' },
                            flags: internal ? { on: [], internal: true } : { on: [] },
                        } as unknown as WorkspaceState,
                        true,
                    ),
                ),
            )
            .map((item) => item.id)
            .filter((id) => ['features', 'early-access', 'features-dev'].includes(id));
    expect(ids(false, 'admin')).toEqual(['features', 'early-access']);
    expect(ids(true, 'admin')).toEqual(['features', 'early-access', 'features-dev']);
    expect(ids(true, 'member')).toEqual([]);
    // Early access is the workspace's, not the person's account.
    const account = SETTINGS_GROUPS.find((group) => group.id === 'account')!;
    expect(account.entries.map((item) => item.id)).not.toContain('early-access');
});

it('shows each flag’s value and its source, the server’s part read-only, and saves the workspace rule only', async () => {
    answers['/flags'] = adminState([
        flag({
            env: false,
            instance: { enabled: false, roles: ['admin'], people: ['bob'], updatedBy: 'alice', updatedAt: 1 },
            tier: true,
            everyone: { enabled: false, source: 'instance' },
            you: { enabled: true, source: 'workspace' },
        }),
    ]);
    await render(<FeaturesSection page="features" />);
    await settle();
    const card = cardsOn()[0]!;
    expect(card.querySelector('[data-slot=flag-values]')?.textContent).toBe(
        'Off for everyone, by this server’s configuration. On for you, by this workspace’s rule.',
    );
    expect(card.querySelector('[data-slot=flag-server]')?.textContent).toBe(
        'Set by this server’s configuration: off by default; on for Admins, Bob only; included in the Pro plan.',
    );
    // Maintenance detail is folded away.
    const details = card.querySelector('details[data-slot=flag-details]')!;
    expect(details.hasAttribute('open')).toBe(false);
    expect(details.textContent).toContain('http_get, http_json');
    expect(details.textContent).toContain('2027-06-30');
    expect(card.querySelector('[data-slot=flag-values]')?.textContent).not.toContain('server;');
    // One editor, the workspace's: no server rule, no lock, no plans, no role above admin.
    expect(card.querySelectorAll('[data-slot=flag-rule]')).toHaveLength(1);
    expect(host.querySelector('[data-slot=flag-plans]')).toBeNull();
    expect(host.textContent).not.toMatch(/operator|Lock it|for themselves/i);
    // The audit names admins for workspace rules only.
    const audit = host.querySelector('[data-slot=flag-audit]')!.textContent!;
    expect(audit).toContain('Carol changed the workspace rule for web-reads');
    expect(audit).toContain('This server’s configuration changed web-reads');
    expect(audit).not.toContain('Alice');
    const mode = card.querySelector('select')!;
    await act(async () => {
        mode.value = 'some';
        mode.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const box = (text: string) =>
        [...card.querySelectorAll('label')].find((label) => label.textContent === text)!.querySelector('input')!;
    await act(async () => box('Admins').click());
    await act(async () => box('Bob').click());
    await act(async () =>
        [...card.querySelectorAll('button')].find((button) => button.textContent === 'Save')!.click(),
    );
    await settle();
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([
        {
            path: '/flags/web-reads/workspace',
            method: 'PUT',
            body: { enabled: false, roles: ['admin'], people: ['bob'] },
        },
    ]);
});

it('shows what the server decides instead of an editor where admins can’t change it', async () => {
    answers['/flags'] = adminState([
        flag({
            instance: { enabled: true, roles: [], people: [], locked: true, updatedBy: 'alice', updatedAt: 1 },
            everyone: { enabled: true, source: 'instance' },
            you: { enabled: true, source: 'instance' },
            workspaceBlocked: 'Set by this server’s configuration: admins can’t change it.',
        }),
    ]);
    await render(<FeaturesSection page="features" />);
    await settle();
    const card = cardsOn()[0]!;
    expect(card.querySelector('[data-slot=flag-rule]')).toBeNull();
    expect(card.querySelector('[data-slot=flag-blocked]')?.textContent).toBe(
        'Set by this server’s configuration: admins can’t change it.',
    );
    expect(card.querySelector('[data-slot=flag-server]')?.textContent).toBe(
        'Set by this server’s configuration: on for everyone, and admins can’t change it.',
    );
});

it('names no role above admin, in the editor or the server’s part, and keeps a stored one on save', async () => {
    answers['/flags'] = adminState([
        flag({
            instance: { enabled: false, roles: ['operator' as Role], people: [], updatedBy: 'x', updatedAt: 1 },
            workspace: {
                enabled: false,
                roles: ['operator' as Role, 'admin'],
                people: [],
                updatedBy: 'x',
                updatedAt: 2,
            },
        }),
    ]);
    await render(<FeaturesSection page="features" />);
    await settle();
    const card = cardsOn()[0]!;
    expect(card.querySelector('[data-slot=flag-server]')?.textContent).toBe(
        'Set by this server’s configuration: on for some people only.',
    );
    // The editor opens on "some" for the stored rule: Admins and Members only.
    expect(card.querySelector('select')!.value).toBe('some');
    const roleBoxes = [...card.querySelectorAll('label')]
        .map((label) => label.textContent)
        .filter((text) => ['Admins', 'Members', 'Operators'].includes(text ?? ''));
    expect(roleBoxes).toEqual(['Admins', 'Members']);
    expect(host.textContent).not.toMatch(/operator/i);
    // The hidden audience is said, unnamed, while the visible one is edited.
    const others = () => card.querySelector('[data-slot=flag-rule-others]')?.textContent;
    expect(others()).toContain('also includes some others');
    const admins = [...card.querySelectorAll('label')].find((label) => label.textContent === 'Admins')!;
    await act(async () => admins.querySelector('input')!.click());
    expect(others()).toContain('also includes some others');
    await act(async () => admins.querySelector('input')!.click());
    await act(async () =>
        [...card.querySelectorAll('button')].find((button) => button.textContent === 'Save')!.click(),
    );
    await settle();
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([
        {
            path: '/flags/web-reads/workspace',
            method: 'PUT',
            body: { enabled: false, roles: ['operator', 'admin'], people: [] },
        },
    ]);
});

it('searches a long list', async () => {
    const many = Array.from({ length: SEARCH_FROM + 1 }, (_, index) =>
        flag({
            key: `switch-${index}`,
            title: `Switch ${index}`,
            description: index === 3 ? 'Calendar sync.' : 'Other.',
        }),
    );
    answers['/flags'] = adminState(many);
    await render(<FeaturesSection page="features" />);
    await settle();
    const search = host.querySelector<HTMLInputElement>('[data-slot=features-search]')!;
    expect(cardsOn()).toHaveLength(SEARCH_FROM + 1);
    const type = (value: string) =>
        act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
            setter.call(search, value);
            search.dispatchEvent(new Event('input', { bubbles: true }));
        });
    await type('calendar');
    expect(cardsOn().map((card) => card.getAttribute('data-key'))).toEqual(['switch-3']);
    await type('nothing like it');
    expect(host.querySelector('[data-slot=features-no-match]')).not.toBeNull();
    // A short list has no search.
    answers['/flags'] = adminState([flag({})]);
    await render(<FeaturesSection key="short" page="features" />);
    await settle();
    expect(host.querySelector('[data-slot=features-search]')).toBeNull();
});

it('links admins, and only admins, to Early access from What’s new', async () => {
    const panel = (role: 'member' | 'admin') =>
        render(<WhatsNewPanel titleId="t" onClose={() => {}} />, {
            workspace: { user: { id: 'u', name: 'U', role }, flags: { on: [] } },
            refresh: vi.fn(async () => {}),
        } as unknown as Shell);
    await panel('member');
    await settle();
    expect(host.querySelector('[data-slot=whats-new-early-access]')).toBeNull();
    await panel('admin');
    await settle();
    expect(host.querySelector('[data-slot=whats-new-early-access]')?.getAttribute('href')).toBe(
        '/settings/early-access',
    );
});

it('marks release highlights that are early-access features', async () => {
    await render(
        <ReleaseCard
            release={{
                version: '0.22.0',
                tag: 'v0.22.0',
                date: '2026-10-27',
                summary: 'Flags.',
                highlights: [
                    { title: 'Try the new board', issue: 'CB-999' },
                    { title: 'Fixed things', issue: 'CB-1' },
                ],
                url: '/releases/v0.22.0',
            }}
        />,
    );
    const items = host.querySelectorAll('[data-slot=release-highlights] li');
    expect(items[0]!.querySelector('[data-slot=early-access-badge]')?.textContent).toBe('Early access');
    expect(items[1]!.querySelector('[data-slot=early-access-badge]')).toBeNull();
});
