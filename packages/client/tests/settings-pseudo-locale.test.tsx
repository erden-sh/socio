// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Dictionary } from '@socio/i18n/keys';
import { pseudoDictionary } from '@socio/i18n/pseudo';
import ROUTES from '@socio/i18n/route-namespaces.json';
import type { AccessPolicyView } from '@socio/shared/access-policy';
import { AGENT_SCOPE_LABELS, type AgentGrantView } from '@socio/shared/agent-grants';
import type { ApprovalsState } from '@socio/shared/approvals';
import type { RosterPerson } from '@socio/shared/auth';
import type { ChatSkillView } from '@socio/shared/chat/chat-skills';
import type { DataApiTokenList } from '@socio/shared/dataspace/api-tokens';
import type { DeviceSummary } from '@socio/shared/device-sign-in';
import type { FlagAdminView, FlagsAdminState } from '@socio/shared/flags';
import type { GitHubAppView } from '@socio/shared/github-types';
import type { UserInferenceState } from '@socio/shared/inference';
import { STATUS_LABEL } from '@socio/shared/issues/issue-board';
import type { LeaveWorkspaceCheck } from '@socio/shared/leave-workspace';
import type { McpConnectionsState } from '@socio/shared/mcp-connections';
import type { PersonDetail } from '@socio/shared/people';
import type { RoomsReadiness } from '@socio/shared/rooms/rooms';
import type { ServiceAccountView } from '@socio/shared/service-accounts';
import type { SocioGrantsState } from '@socio/shared/socio-access';
import type { DeletedSpace, State, WorkspaceState } from '@socio/shared/types';
import type { PageI18n } from '@socio/shared/web/web';
import type { WorkspaceSecretsState } from '@socio/shared/workspace-secrets';

import { I18nRoot } from '../src/i18n/I18nRoot';
import type { ChannelsAnswer } from '../src/modules/settings/NotificationsSection';
import { initials } from '../src/modules/settings/people/people-format';
import PersonPage, { PERSON_TABS } from '../src/modules/settings/people/PersonPage.route';
import { findSection, SETTINGS_SECTIONS, type SettingsAccess } from '../src/modules/settings/sections';
import { SettingsLayout } from '../src/modules/settings/SettingsLayout';
import { SettingsSection } from '../src/modules/settings/SettingsSection';
import type { Passkey } from '../src/shell/auth-client';
import { CurrentUser, SignInSetup } from '../src/shell/current-user';
import { ShellContext, type Shell } from '../src/shell/shell-context';

// Every settings page in en-XA, the pseudo-locale, with only the
// namespaces its route inlines (route-namespaces.json): text that stays
// plain English was never translated, and a raw key means the route
// doesn't inline its namespace. The pages render as an admin with real
// accounts, every flag on, and the API answering each section's reads
// (ANSWERS below) with a list of one or two, so the loaded page is checked,
// not only its loading state.

// Other modules' cards on these pages aren't translated yet: they stand in
// as empty placeholders, so only Settings' own words are checked.
vi.mock('../src/modules/voice/DictationSettings', () => ({
    DictationPreference: () => <div data-slot="other-module" />,
    DictationAllowedSetting: () => <div data-slot="other-module" />,
    TranscriptionSetting: () => <div data-slot="other-module" />,
}));
vi.mock('../src/modules/voice/VoiceCallSettings', () => ({
    VoiceCallsSetting: () => <div data-slot="other-module" />,
}));
// Shared components and the shell, not translated yet either.
vi.mock('../src/components/private-space', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/components/private-space')>()),
    PrivateSpaceIcon: () => <div data-slot="other-module" />,
}));
vi.mock('../src/components/data-grid/DataGrid', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/components/data-grid/DataGrid')>()),
    RowActionsMenu: () => <div data-slot="other-module" />,
}));
vi.mock('../src/shell/flags', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/shell/flags')>()),
    EarlyAccessBadge: () => <div data-slot="other-module" />,
}));

globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
} as unknown as typeof ResizeObserver;

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const locales = join(import.meta.dirname, '../../i18n/locales/en-US');
const routes = ROUTES as unknown as Record<string, string[]>;
const pseudo = (ns: string) =>
    pseudoDictionary(JSON.parse(readFileSync(join(locales, `${ns}.json`), 'utf8')) as Dictionary);

// What loads on demand (on-demand.tsx, and WorkspaceDialog): this server's
// files, which the manifest names and the fetch below serves. Only these,
// named here rather than worked out from route-namespaces.json, so a
// namespace a route should inline but doesn't stays missing, and its keys
// show.
const NAMESPACES = [
    'settings.dialogs',
    'settings.person-dialogs',
    'settings.workspace-apps',
    'settings.workspace-github',
    'settings.workspace-limits',
    'settings.workspace-rooms',
];
const manifest = {
    release: '1.0.0',
    locales: {
        'en-XA': {
            coverage: 1,
            ns: Object.fromEntries(NAMESPACES.map((ns) => [ns, { hash: 'test', sourceHash: 'test' }])),
        },
    },
};

const pageOf = (route: string): PageI18n => ({
    locale: 'en-XA',
    dir: 'ltr',
    manifest,
    resources: { 'en-XA': Object.fromEntries([...routes.root!, ...routes[route]!].map((ns) => [ns, pseudo(ns)])) },
    offered: ['en-US'],
});

const user = { id: 'u-ada', name: 'Ada', role: 'admin' as const };
const workspace = {
    user,
    spaces: [],
    dots: [{ id: 'd1', name: 'Bob' }],
    conversations: [],
    calls: [],
    setup: { missing: [], telegram: 'configured' },
    flags: { on: ['socio-actor-access', 'coding-sessions'], internal: true },
    preferences: {},
} as unknown as WorkspaceState;
const state = { settings: { paused: false }, tasks: [], spaces: [], dots: [] } as unknown as State;
const shell = {
    state,
    workspace,
    admin: true,
    refresh: vi.fn(async () => {}),
    mutate: vi.fn(async () => true),
    setError: vi.fn(),
    openDialog: vi.fn(),
} as unknown as Shell;
const access: SettingsAccess = {
    admin: true,
    operator: true,
    signIn: true,
    telegram: true,
    flags: workspace.flags!.on,
    internal: true,
};

// The API's answers to each section's reads, by path. Everything else never
// answers. The words in them are the server's data, not Settings' copy:
// FIXTURE_TEXT names each one, and the check takes exactly those out.
const NOW = Date.UTC(2026, 10, 20, 12);
const iso = (at: number) => new Date(at).toISOString();
const DAY = 86_400_000;

const person = (id: string, name: string, extra: Partial<RosterPerson> = {}): RosterPerson => ({
    id,
    userId: `u-${id}`,
    name,
    email: `${id}@example.com`,
    emailVerified: true,
    role: 'member',
    adminByRule: false,
    password: true,
    passkeys: 1,
    providers: [],
    signInLinkVia: null,
    deactivated: false,
    createdAt: iso(NOW - 30 * DAY),
    status: 'active',
    lastActiveAt: iso(NOW - DAY),
    sessions: 1,
    invite: null,
    reach: {
        spaces: 2,
        socioGrants: 1,
        connectedAgents: 0,
        appsOwned: 1,
        keysMade: 0,
        codeAccess: false,
        telegram: false,
    },
    ...extra,
});
const roster = [person('ada', 'Ada', { role: 'admin', owner: true }), person('p-ben', 'Bob')];

const flag = (key: string, title: string, stage: FlagAdminView['stage']): FlagAdminView => ({
    key,
    title,
    description: '',
    stage,
    default: false,
    owner: 'server',
    removeBy: '2027-06-30',
    tools: [],
    you: { enabled: true, source: 'default' },
    everyone: { enabled: false, source: 'default' },
    workspaceBlocked: null,
});

const ANSWERS: Record<string, unknown> = {
    '/api/github': {
        repository: 'example/app',
        repositorySource: 'env',
        app: null,
        installation: null,
        unreadable: false,
        canConnect: true,
    } satisfies GitHubAppView,
    '/api/rooms/readiness': {
        enabled: false,
        conversations: { private: 3, room: 0 },
        allPrivate: true,
    } satisfies RoomsReadiness,
    '/api/accounts/roster': { people: roster },
    '/api/accounts': { accounts: roster },
    '/api/service-accounts': [
        {
            id: 'svc_ci',
            name: 'Alpha',
            role: 'member',
            description: '',
            createdAt: NOW,
            createdBy: 'u-ada',
            createdByName: 'Ada',
            disabledAt: null,
            keys: [],
        },
    ] satisfies ServiceAccountView[],
    '/api/access-policy': {
        version: 3,
        updatedAt: NOW,
        updatedBy: 'alice',
        unreadable: false,
        saved: {},
        signIn: {
            ceiling: {
                password: true,
                passkey: true,
                signInLink: false,
                emailLinks: false,
                google: false,
                apple: false,
                openSignUp: false,
                providers: [{ id: 'oidc', name: 'Alpha' }],
                allowedEmails: [],
                allowedDomains: ['example.com'],
                adminEmails: [],
            },
            inForce: {
                password: true,
                passkey: true,
                signInLink: false,
                emailLinks: false,
                google: false,
                apple: false,
                openSignUp: false,
                providers: ['oidc'],
                allowedEmails: [],
                allowedDomains: ['example.com'],
                adminEmails: [],
            },
        },
        audit: [],
    } satisfies AccessPolicyView,
    '/api/workspace-secrets': {
        overlapDefaultMinutes: 60,
        flags: [],
        secrets: [
            {
                id: 's1',
                name: 'API_KEY',
                scope: 'workspace',
                appId: null,
                appName: null,
                description: '',
                createdAt: NOW,
                createdByName: 'Ada',
                updatedAt: NOW,
                versions: [
                    {
                        version: 1,
                        state: 'current',
                        setAt: NOW,
                        setBy: 'ada',
                        setByName: 'Ada',
                        retireAt: null,
                        lastReadAt: null,
                    },
                ],
                grants: [],
                lastReadAt: null,
                lastReadByName: null,
            },
        ],
        apps: [],
    } satisfies WorkspaceSecretsState,
    '/api/data/api-tokens': {
        tokens: [
            {
                id: 't1',
                name: 'Alpha',
                hint: 'abcdef',
                scopes: ['data:read'],
                statementsPerMinute: 600,
                createdAt: NOW,
                createdBy: 'ada',
                createdByName: 'Ada',
                expiresAt: NOW + DAY,
                lastUsedAt: null,
                uses: 0,
                revokedAt: null,
                revokedBy: null,
            },
        ],
        scopes: ['data:read', 'data:write', 'data:admin'],
        daysDefault: 7,
        daysMax: 30,
        statementsPerMinuteDefault: 600,
        statementsPerMinuteMax: 100_000,
    } satisfies DataApiTokenList,
    '/api/chat-skills': {
        skills: [{ name: 'alpha', description: '', kind: 'prompt', builtIn: false, instructions: '', updatedAt: NOW }],
    } satisfies { skills: ChatSkillView[] },
    '/api/admin/spaces/deleted': {
        spaces: [
            {
                id: 'sp1',
                name: 'Alpha',
                description: '',
                createdAt: NOW - DAY,
                deletedAt: NOW,
                deletedBy: 'alice',
                deletedByName: 'Alice',
                private: true,
                pages: 3,
            },
        ],
    } satisfies { spaces: DeletedSpace[] },
    '/api/flags': {
        tenantId: 'main',
        flags: [flag('alpha', 'Alpha', 'ga'), flag('beta', 'Beta', 'early-access'), flag('gamma', 'Gamma', 'dev')],
        tiers: [],
        tierId: null,
        people: [
            { id: 'u-ada', name: 'Ada', role: 'admin' },
            { id: 'u-bob', name: 'Bob', role: 'member' },
        ],
        audit: [],
    } satisfies FlagsAdminState,
    '/api/auth/passkey/list-user-passkeys': [
        { id: 'pk1', name: 'Alpha', createdAt: iso(NOW - DAY) },
    ] satisfies Passkey[],
    '/api/auth/devices': {
        devices: [
            {
                id: 'dev-1',
                label: 'Alpha',
                platform: 'ios',
                variant: 'production',
                state: 'active',
                signInMethod: 'passkey',
                createdAt: iso(NOW - DAY),
                lastSeenAt: iso(NOW),
                current: false,
            },
        ],
    } satisfies { devices: DeviceSummary[] },
    '/api/account/leave': { allowed: true, refusal: null } satisfies LeaveWorkspaceCheck,
    '/api/mcp-connections': {
        socios: [{ id: 'd1', name: 'Bob' }],
        connections: [
            {
                id: 'c1',
                name: 'Alpha',
                url: 'https://mcp.example.com/mcp',
                authentication: 'none',
                state: 'connected',
                generation: 1,
                catalogRevision: 'c'.repeat(64),
                createdAt: NOW,
                updatedAt: NOW,
                grants: [],
                tools: [
                    {
                        name: 'alpha',
                        description: '',
                        inputSchema: { type: 'object' },
                        fingerprint: 'f'.repeat(64),
                        supported: true,
                    },
                ],
            },
        ],
    } satisfies McpConnectionsState,
    '/api/notifications/channels': {
        channels: [
            { id: 'push', label: 'Alpha', enabled: true, content: 'message', targets: [] },
            { id: 'telegram', label: 'Beta', enabled: false, content: 'private', targets: [] },
        ],
        pushKey: 'BAECAwQ',
    } satisfies ChannelsAnswer,
    '/api/me/inference': {
        kinds: [{ id: 'byo-alpha', label: 'Alpha', description: '', state: 'disconnected' }],
        active: null,
    } satisfies UserInferenceState,
    '/api/agent-grants': {
        grants: [
            {
                grantId: 'g1',
                userId: 'u-ada',
                clientId: 'https://client.example.com/m.json',
                clientName: 'Alpha',
                clientDomain: 'example.com',
                localApp: false,
                label: 'Beta',
                scopes: ['issues:read'],
                createdAt: NOW - DAY,
                lastUsedAt: null,
                expiresAt: null,
                revokedAt: null,
                revokedBy: null,
            },
        ],
    } satisfies { grants: AgentGrantView[] },
    '/api/actors/grants': {
        grants: [
            {
                id: 'g1',
                socioId: 'd1',
                socioName: 'Bob',
                audience: 'app:alpha',
                app: { label: 'Alpha', origin: 'https://alpha.example.com' },
                access: 'read',
                scopes: ['app:read'],
                task: 'Beta',
                conversation: { kind: 'private', title: 'Gamma' },
                createdAt: NOW - DAY,
                expiresAt: NOW + DAY,
                lastUsedAt: NOW,
                idleMinutes: 30,
                state: 'live',
                ended: null,
            },
        ],
    } satisfies SocioGrantsState,
    '/api/approvals': {
        capabilities: [
            {
                id: 'app_access_read',
                label: 'Alpha',
                description: '',
                auto: { allowed: true, maxRisk: 'low', rules: [], undo: false },
            },
        ],
        pending: [],
        recent: [],
        policies: [{ dotId: 'd1', capability: 'app_access_read', policy: 'bypass' }],
        audit: [],
    } satisfies ApprovalsState,
    '/api/accounts/p-ben': {
        person: roster[1]!,
        signIn: {
            sessions: [
                {
                    id: 's1',
                    createdAt: iso(NOW - 2 * DAY),
                    renewedAt: iso(NOW - DAY),
                    expiresAt: iso(NOW + 20 * DAY),
                    userAgent: null,
                    signInMethod: 'passkey',
                    ip: null,
                },
            ],
            passkeys: [{ id: 'pk1', name: 'Alpha', createdAt: iso(NOW - DAY) }],
            password: true,
            providers: [],
        },
        access: {
            spaces: [{ id: 'sp1', name: 'Alpha', level: 'editor', membersOnly: true }],
            socioGrants: [],
            connectedAgents: [],
            appsOwned: [],
            keysMade: [],
            codeAccess: false,
            telegram: null,
        },
        groups: [],
    } satisfies PersonDetail,
};

/**
 * The data words in ANSWERS (and the workspace above): names and their
 * initials, keys, URLs, a token's hint and a tool's schema as JSON.
 */
const FIXTURE_TEXT = [
    'mcp.example.com/mcp',
    'p-ben@example.com',
    'ada@example.com',
    'example.com',
    'example/app',
    'cbdt_api_abcdef',
    'issues:read',
    '"inputSchema"',
    '"type"',
    '"object"',
    'API_KEY',
    'BAECAwQ',
    'server',
    'Alpha',
    'alpha',
    'Alice',
    'Gamma',
    'gamma',
    'Beta',
    'beta',
    'Bob',
    'Ada',
    initials('Ada'),
    initials('Bob'),
];
/**
 * Words that aren't Settings': packages/shared's (an agent scope's plain
 * words, an issue status), the data grid's screen-reader header for its
 * row menus (components/data-grid, not translated yet), and the issue keys
 * a placeholder gives as a sample.
 */
const SHARED_TEXT = [AGENT_SCOPE_LABELS['issues:read']!, ...Object.values(STATUS_LABEL), 'Actions', 'CB-12, CB-34'];

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    // The API answers the reads in ANSWERS; anything else never answers.
    // Dictionaries come from /i18n/<locale>/<ns>.<hash>.json.
    vi.stubGlobal(
        'fetch',
        vi.fn((url: string, init?: RequestInit) => {
            const file = /^\/i18n\/en-XA\/(.+)\.test\.json$/.exec(String(url));
            if (file && NAMESPACES.includes(file[1]!)) {
                return Promise.resolve(Response.json(pseudo(file[1]!)));
            }
            const path = new URL(String(url), 'http://app.test').pathname;
            return (init?.method ?? 'GET') === 'GET' && path in ANSWERS
                ? Promise.resolve(Response.json(ANSWERS[path]))
                : new Promise<Response>(() => {});
        }),
    );
});
afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    host.remove();
    vi.unstubAllGlobals();
});

/** What a person reads: the text and the attributes read aloud or shown. */
function readable(node: HTMLElement) {
    const attributes = [...node.querySelectorAll('[aria-label], [title], [placeholder], [alt]')].flatMap((element) =>
        ['aria-label', 'title', 'placeholder', 'alt']
            .map((name) => element.getAttribute(name))
            .filter((value): value is string => !!value),
    );
    return [node.textContent ?? '', ...attributes];
}

/** The English left once every pseudo-locale string (in brackets) is taken out. */
function untranslated(texts: readonly string[]) {
    return texts.flatMap((text) => {
        let rest = text;
        for (let before = ''; before !== rest;) {
            before = rest;
            rest = rest.replace(/\[[^[\]]*\]/g, ' ');
        }
        // Not copy: example URLs and file paths in placeholders, and the
        // fixtures' data.
        rest = rest.replace(/\S+:\/\/\S+/g, ' ').replace(/\S+\/\S+\.\w+/g, ' ');
        for (const fixture of [...SHARED_TEXT, ...FIXTURE_TEXT]) {
            rest = rest.replaceAll(fixture, ' ');
        }
        return [...rest.matchAll(/\p{L}{2,}/gu)].map((match) => match[0]);
    });
}

async function open(section: (typeof SETTINGS_SECTIONS)[number] | 'person', tab = 'access') {
    const route = section === 'person' ? 'settings:person' : `settings:section:${section}`;
    const page = pageOf(route);
    const content =
        section === 'person' ? (
            <PersonPage />
        ) : (
            <SettingsLayout group={findSection(section)!.group}>
                <SettingsSection id={section} access={access} />
            </SettingsLayout>
        );
    const router = createMemoryRouter(
        [
            {
                id: 'root',
                path: section === 'person' ? '/settings/people/:id' : '/',
                loader: () => ({ i18n: page }),
                Component: () => (
                    <I18nRoot>
                        <ShellContext.Provider value={shell}>
                            <CurrentUser.Provider value={user}>
                                <SignInSetup.Provider value={{ password: true, passkey: true, providers: [] } as never}>
                                    {content}
                                </SignInSetup.Provider>
                            </CurrentUser.Provider>
                        </ShellContext.Provider>
                    </I18nRoot>
                ),
            },
        ],
        {
            initialEntries: [section === 'person' ? `/settings/people/p-ben?tab=${tab}` : '/'],
            hydrationData: { loaderData: { root: { i18n: page } } },
        },
    );
    root = createRoot(host);
    await act(async () => root!.render(<RouterProvider router={router} />));
    // The on-demand namespaces' loads, and what renders once they're in.
    for (let tick = 0; tick < 5; tick++) {
        await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    }
}

it('declares every settings page’s namespaces, and loads only the listed ones on demand', () => {
    const inlined = new Set(
        Object.entries(routes)
            .filter(([id]) => !id.startsWith('$'))
            .flatMap(([, namespaces]) => namespaces),
    );
    const settings = readdirSync(locales)
        .map((name) => name.slice(0, -'.json'.length))
        .filter((ns) => ns.startsWith('settings'));
    expect(settings.filter((ns) => !inlined.has(ns)).sort()).toEqual(NAMESPACES);
    for (const section of SETTINGS_SECTIONS) {
        expect(routes[`settings:section:${section}`], section).toBeDefined();
    }
    expect(routes['settings:person']).toBeDefined();
});

// Pages that render another module's cards, not yet translated.
const OTHER_MODULES: Partial<Record<(typeof SETTINGS_SECTIONS)[number], string>> = {
    coding: 'modules/coding',
    telegram: 'modules/telegram',
};

it.each(SETTINGS_SECTIONS.filter((section) => !OTHER_MODULES[section]))(
    'renders %s in en-XA with only its route’s namespaces',
    async (section) => {
        await open(section);
        expect(host.querySelector('[data-slot="settings-page"]'), section).not.toBeNull();
        expect(untranslated(readable(host)), section).toEqual([]);
    },
);

it.each(PERSON_TABS)('renders a person’s %s tab in en-XA with only its route’s namespaces', async (tab) => {
    await open('person', tab);
    expect(host.querySelector('[data-slot="settings-page"]'), tab).not.toBeNull();
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent, tab).toMatch(/^\[/);
    expect(untranslated(readable(host)), tab).toEqual([]);
});
