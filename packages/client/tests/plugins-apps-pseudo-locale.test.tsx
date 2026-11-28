// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, type ComponentType, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Dictionary } from '@socio/i18n/keys';
import { pseudoDictionary } from '@socio/i18n/pseudo';
import { createReactI18n, I18nextProvider } from '@socio/i18n/react';
import ROUTES from '@socio/i18n/route-namespaces.json';
import type { AppAttemptsState, AppsState, AppView, DotAppsState, PromotionPlan } from '@socio/shared/apps/app-types';
import type { PluginDataBudget } from '@socio/shared/data-types';
import type { PluginBindingPlan } from '@socio/shared/plugins/bindings';
import type { PluginUpdateReview } from '@socio/shared/plugins/plugin-update';
import type { PluginLauncherEntry } from '@socio/shared/plugins/plugins';
import type { State, WorkspaceState } from '@socio/shared/types';
import type { PageI18n } from '@socio/shared/web/web';

import type { InstalledRow, PluginBackups, PluginList } from '../src/modules/plugins/plugin-rows';

import { fetchServices, createTestRouter } from './helpers/app-router';

// The Plugins and Apps pages in en-XA, the pseudo-locale, through the
// app's real routes: each route asks for its namespaces
// (route-namespaces.json) and gets them in en-XA, nothing more, and what
// loads on demand (the dialogs', the promotion wizard's, a socio's Apps
// panel's) comes from this server's files (the fetch below). Text that
// stays plain English was never translated, and a raw key means a route
// doesn't inline what its page shows. Only these modules' parts are read:
// an embedded plugin's frame (PluginFrame.tsx) and the plugin's own page
// aren't migrated yet, nor the header's other modules' buttons.

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

vi.setConfig({ testTimeout: 30_000 });

// Radix selects measure themselves.
globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
} as unknown as typeof ResizeObserver;

const locales = join(import.meta.dirname, '../../i18n/locales/en-US');
const routes = ROUTES as unknown as Record<string, string[]>;
const pseudo = (ns: string) =>
    pseudoDictionary(JSON.parse(readFileSync(join(locales, `${ns}.json`), 'utf8')) as Dictionary);
const inlined = new Set(
    Object.entries(routes)
        .filter(([id]) => !id.startsWith('$'))
        .flatMap(([, namespaces]) => namespaces),
);

// What loads on demand: this server's files, which the manifest names and
// the fetch below serves. Only these, named here rather than worked out
// from route-namespaces.json, so a namespace a route should inline but
// doesn't stays missing, and its keys show.
const ON_DEMAND = ['apps.dialogs', 'apps.dot', 'apps.promote', 'plugins.dialogs'];
// Also served: the install dialog's words, inlined on a plugin's page and
// loaded on demand on the catalog, and what other modules load on demand on
// these pages (the header's connection badge, the Report issue dialog), so
// they never show keys whenever they come.
const SERVED = [...ON_DEMAND, 'plugins.bindings', 'shell.status', 'issues.report', 'issues.form', 'issues.terms'];
const manifest = {
    release: '1.0.0',
    locales: {
        'en-XA': {
            coverage: 1,
            ns: Object.fromEntries(
                readdirSync(locales)
                    .map((name) => name.slice(0, -'.json'.length))
                    .filter((ns) => !inlined.has(ns) || SERVED.includes(ns))
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

// The page's clock and time zone, fixed: what the fixtures' times read as
// doesn't depend on when or where the test runs (set in beforeEach).
const now = Date.UTC(2026, 10, 20, 12);
const TIME_ZONE = 'UTC';
const DAY = 86_400_000;

const user = { id: 'u-ada', name: 'Ada', role: 'admin' as const };
const tabPlugin: PluginLauncherEntry = {
    id: 'kappa',
    name: 'Kappa',
    description: 'Lambda',
    display: 'tab',
    mode: 'service',
    origin: 'https://kappa.apps.example.com',
    entryPath: '/',
    openAllow: [],
    openAnyHttps: false,
} as unknown as PluginLauncherEntry;
const state = {
    settings: { name: 'Alpha', paused: false, researchAllowed: false, memoryAllowed: true },
    tasks: [],
    memories: [],
    mode: 'live',
    configured: true,
} as unknown as State;
const workspace = {
    user,
    spaces: [{ id: 's1', name: 'Delta', description: '', createdAt: 1, access: 'editor' }],
    dots: [{ id: 'd1', name: 'Bob', instructions: '', spaceId: 's1', spaceIds: ['s1'], createdAt: 1 }],
    conversations: [],
    setup: { model: true, voice: false, telegram: 'not_configured', missing: [] },
    calls: [],
    preferences: {},
    permissions: { createSpaces: true },
    plugins: [tabPlugin],
} as unknown as WorkspaceState;

const installed = (patch: Partial<InstalledRow> = {}): InstalledRow => ({
    id: 'omega',
    name: 'Omega',
    description: 'Sigma',
    author: 'Tau',
    version: '1.2.0',
    permissions: ['calendar:read', 'person:read', 'zeta:read'],
    openAnyHttps: true,
    icon: '',
    enabled: true,
    display: 'embed',
    replicas: 2,
    running: 1,
    state: 'running',
    origin: 'https://omega.apps.example.com',
    mode: 'service',
    audience: 'members',
    config: { EDGE_URL: 'https://edge.example.com', MODE: 'gone' },
    configFields: {
        EDGE_URL: { description: 'Chi', type: 'url', required: true },
        SYNC: { description: 'Psi', type: 'boolean', default: 'false' },
        MODE: { description: 'Phi', type: 'enum', options: ['pit', 'oauth'] },
        LEVEL: { description: 'Rho', type: 'enum', options: ['low'], required: true },
    },
    egress: {
        hosts: ['edge.example.com'],
        settings: [
            { field: 'EDGE_URL', host: 'edge.example.com' },
            { field: 'MIRROR_URL', problem: 'Upsilon' },
        ],
    },
    update: {
        version: '1.3.0',
        from: 'a',
        to: 'b',
        additions: [],
        removedSettings: [],
        openAnyHttps: true,
        addsOpenAnyHttps: false,
    },
    backup: {
        state: 'failing',
        declared: true,
        volumes: ['data', 'logs'],
        lastSuccessAt: now - DAY,
        sizeBytes: 3_100_000,
        lastErrorAt: now - 3_600_000,
        lastError: 'Upsilon',
    },
    ...patch,
});
const LIST: PluginList = {
    catalog: [
        {
            id: 'social-strategy',
            name: 'Epsilon',
            version: '2.0.0',
            author: 'Tau',
            description: 'Sigma',
            display: 'embed',
            mode: 'service',
            permissions: ['social:read', 'social:write', 'calendar:write'],
            openAnyHttps: true,
            icon: '',
            installed: false,
            storageWarnings: [
                { kind: 'not_backed_up', message: 'Upsilon' },
                { kind: 'private_storage', message: 'Upsilon' },
            ] as never,
        },
        {
            id: 'omega',
            name: 'Omega',
            version: '1.2.0',
            author: 'Tau',
            description: 'Sigma',
            display: 'embed',
            mode: 'bundled',
            permissions: [],
            icon: '',
            installed: true,
        },
    ],
    installed: [
        installed(),
        installed({ id: 'eta', name: 'Eta', enabled: false, update: undefined, backup: undefined }),
        installed({
            id: 'theta',
            name: 'Theta',
            mode: 'bundled',
            update: undefined,
            backup: { state: 'not_backed_up', declared: false, volumes: ['data'] },
        }),
    ],
};
const BINDINGS: PluginBindingPlan = {
    pluginId: 'social-strategy',
    installed: false,
    needs: [
        {
            need: 'posts',
            access: 'write',
            implicit: false,
            description: 'Mu',
            tables: [{ table: 'posts', columns: [{ name: 'body', type: 'text' }] }],
            previous: { datasetId: 'ds1', datasetName: 'Nu' },
            candidates: [
                { id: 'ds1', name: 'Nu', description: '' },
                { id: 'ds2', name: 'Xi', description: '', writer: { id: 'p2', name: 'Eta' }, problem: 'Upsilon' },
            ],
            preselected: { datasetId: 'ds1' },
        },
        {
            need: 'people',
            access: 'read',
            implicit: false,
            description: 'Mu',
            tables: [],
            bound: { datasetId: 'ds3', datasetName: 'Pi', boundBy: 'u-ada', boundAt: 1 },
            candidates: [],
            preselected: null,
        },
    ],
};
const BACKUPS: PluginBackups = {
    backup: { state: 'ok', declared: true, volumes: ['data'], lastSuccessAt: now - DAY, sizeBytes: 2_000_000 },
    history: [
        {
            snapshotId: 'snap1',
            takenAt: now - DAY,
            reason: 'request',
            note: 'Omicron',
            version: '1.2.0',
            bytes: 2_000_000,
        },
        { snapshotId: 'snap2', takenAt: now - 2 * DAY, reason: 'pre-update', version: '1.1.0', bytes: 900 },
    ] as never,
};
const BUDGET: PluginDataBudget = {
    pluginId: 'omega',
    statementsPerMinute: 120,
    override: 120,
    workspaceDefault: 600,
    max: 6000,
};

const attempt = (patch: Partial<AppAttemptsState['attempts'][number]> = {}) => ({
    attempt: 1,
    version: 3,
    kind: 'build' as const,
    state: 'failed' as const,
    reason: null,
    exitCode: 1,
    signal: null,
    message: 'Upsilon',
    startedAt: now - 3_600_000,
    upAt: null,
    endedAt: now - 3_500_000,
    ...patch,
});
const app = (patch: Partial<AppView> = {}): AppView => ({
    id: 'a1',
    name: 'Iota',
    description: 'Sigma',
    dotId: 'd1',
    dotName: 'Bob',
    owner: true,
    port: 3001,
    datasets: ['ds1'],
    datasetNames: ['Nu', 'Xi'],
    sharedSpaceId: null,
    startCommand: null,
    status: 'promoted',
    url: 'https://iota.apps.example.com',
    createdAt: 1,
    updatedAt: now - DAY,
    runtime: 'failed',
    liveVersion: 3,
    previousVersion: 2,
    canReadLogs: true,
    lastAttempt: attempt(),
    needsSetup: ['API_KEY', 'API_SECRET'],
    health: {
        state: 'degraded',
        reason: 'Upsilon',
        attempts: 2,
        maxAttempts: 5,
        nextAttemptAt: now + 600_000,
        lastRecoveryAt: now - DAY,
        lastRecoveryReason: null,
        lastError: 'Upsilon',
        escalatedAt: null,
        updatedAt: now,
    },
    versions: [
        {
            version: 3,
            files: 12,
            sizeBytes: 1,
            sha256: '',
            createdAt: now - DAY,
            createdByDotName: 'Bob',
            changes: ['Omicron'],
        },
        {
            version: 2,
            files: 1,
            sizeBytes: 1,
            sha256: '',
            createdAt: now - 2 * DAY,
            createdByDotName: 'Bob',
            changes: [],
        },
        {
            version: 1,
            files: 4,
            sizeBytes: 1,
            sha256: '',
            createdAt: now - 3 * DAY,
            createdByDotName: 'Bob',
            changes: [],
        },
    ] as never,
    ...patch,
});
const APPS: AppsState = {
    enabled: true,
    apps: [
        app(),
        app({
            id: 'a2',
            name: 'Kappa',
            status: 'ephemeral',
            computer: 'running',
            answering: false,
            liveVersion: null,
            previousVersion: null,
            lastAttempt: attempt({ kind: 'start' }),
            needsSetup: ['API_KEY'],
            versions: [],
            health: {
                state: 'failed',
                reason: null,
                attempts: 5,
                maxAttempts: 5,
                nextAttemptAt: null,
                lastRecoveryAt: null,
                lastRecoveryReason: null,
                lastError: 'Upsilon',
                escalatedAt: now,
                updatedAt: now,
            },
        }),
        app({ id: 'a3', name: 'Lambda', status: 'packaged', computer: 'stopped', versions: [], health: undefined }),
        app({
            id: 'a4',
            name: 'Mu',
            status: 'unpublished',
            owner: false,
            ownerName: 'Eta',
            needsSetup: [],
            health: { ...app().health!, state: 'recovering', nextAttemptAt: null },
        }),
        app({
            id: 'a5',
            name: 'Nu',
            status: 'promoted',
            runtime: 'starting',
            versions: [],
            lastAttempt: null,
            needsSetup: [],
            health: { ...app().health!, state: 'healthy', lastRecoveryReason: 'Omicron' },
        }),
    ],
    others: [{ id: 'a9', name: 'Pi', ownerName: 'Eta' }],
};
const ATTEMPTS: AppAttemptsState = {
    attempts: [
        attempt(),
        attempt({ attempt: 2, kind: 'start', state: 'running', upAt: now - 60_000, endedAt: null, exitCode: null }),
        attempt({ attempt: 3, kind: 'start', reason: 'oom', exitCode: null }),
        attempt({ attempt: 4, reason: 'health_check' }),
        attempt({ attempt: 5, reason: 'lost' }),
        attempt({ attempt: 6, state: 'stopped', exitCode: null }),
        attempt({ attempt: 7, exitCode: null, signal: 'SIGKILL' }),
        attempt({ attempt: 8, state: 'succeeded', exitCode: 0 }),
        attempt({ attempt: 9, state: 'running', endedAt: null, exitCode: null }),
    ],
    attempt: { ...attempt({ upAt: now - 3_550_000 }), lines: ['Omicron'], dropped: 3 },
};
const PLAN: PromotionPlan = {
    appId: 'a3',
    name: 'Lambda',
    dotName: 'Bob',
    version: {
        version: 2,
        manifest: {
            name: 'Lambda',
            description: 'Sigma',
            entry: 'server.ts',
            runtime: 'bun',
            routes: ['/rho'],
            datasets: [{ id: 'nu', access: 'write' }],
            egress: [],
            env: { THEME: 'Omicron' },
        },
        files: 3,
        sizeBytes: 12_000,
        sha256: '',
        createdAt: now,
        createdByDotName: 'Bob',
        changes: ['Omicron'],
    },
    files: [{ path: 'server.ts', size: 900 }],
    datasets: [
        {
            ref: 'nu',
            access: 'write',
            datasetId: 'ds1',
            name: 'Nu',
            kind: 'scratch',
            sizeBytes: 4_000,
            tableNames: ['rows', 'cells'],
            sharedSpaceId: null,
            choices: ['move', 'share', 'keep'],
        },
        {
            ref: 'xi',
            access: 'read',
            tables: ['rows'],
            datasetId: 'ds2',
            name: 'Xi',
            kind: 'scratch',
            sizeBytes: 4_000,
            tableNames: [],
            sharedSpaceId: null,
            sharedArea: true,
            choices: ['move', 'share', 'keep'],
        },
        {
            ref: 'pi',
            access: 'read',
            datasetId: null,
            name: 'Pi',
            kind: 'missing',
            sizeBytes: 0,
            tableNames: [],
            sharedSpaceId: null,
            choices: [],
        },
        {
            ref: 'rho',
            access: 'read',
            datasetId: 'ds4',
            name: 'Rho',
            kind: 'workspace',
            sizeBytes: 0,
            tableNames: [],
            sharedSpaceId: null,
            choices: ['keep'],
        },
        {
            ref: 'tau',
            access: 'read',
            datasetId: 'ds5',
            name: 'Tau',
            kind: 'dataset',
            sizeBytes: 0,
            tableNames: [],
            sharedSpaceId: null,
            choices: ['keep'],
        },
    ],
    runtime: false,
    promoted: false,
};

/** The data words: names in the fixtures, and the technical names the pages show as they are. */
const FIXTURE_TEXT = [
    'Alpha',
    'Delta',
    'Bob',
    'Ada',
    'Epsilon',
    'Omega',
    'Eta',
    'Theta',
    'Kappa',
    'Lambda',
    'Iota',
    'Sigma',
    'Tau',
    'Chi',
    'Psi',
    'Phi',
    'Rho',
    'Upsilon',
    'Omicron',
    'Mu',
    'Nu',
    'Xi',
    'Pi',
    'edge.example.com',
    'social:read',
    'social:write',
    'calendar:read',
    'calendar:write',
    'person:read',
    'rho',
    'nu',
    'example.com',
    'bridge.openAnyHttps',
    'EDGE_URL',
    'MIRROR_URL',
    'SYNC',
    'MODE',
    'LEVEL',
    'API_KEY',
    'API_SECRET',
    'THEME',
    'SIGKILL',
    'server.ts',
    'zeta:read',
    'posts',
    'people',
    'body',
    'rows',
    'cells',
    'gone',
    'pit',
    'oauth',
    'low',
    'data',
    'logs',
    'bun',
    'write',
    'read',
    'https://',
];
/**
 * Shared components' and other modules' words, not these modules': the
 * sidebar's toggle, the breadcrumb's landmark, a dialog's close button
 * (components/), and the Ctrl key.
 */
const SHARED_TEXT = ['Toggle Sidebar', 'Collapse sidebar', 'breadcrumb', 'Close', 'Ctrl'];

/**
 * The words Intl itself writes for en-XA: month and weekday names, day
 * periods (AM, PM) and byte units (kB, MB). They are the locale's data,
 * as `{{when, datetime}}` and `{{size, bytes}}` format them, not copy to
 * translate. Taken from Intl, not listed, so they follow the engine's CLDR.
 */
const INTL_WORDS = (() => {
    const words = new Set<string>();
    const add = (options: Intl.DateTimeFormatOptions, at: number) => {
        for (const part of new Intl.DateTimeFormat('en-XA', { timeZone: TIME_ZONE, ...options }).formatToParts(at)) {
            if (part.type === 'month' || part.type === 'weekday' || part.type === 'dayPeriod') {
                words.add(part.value);
            }
        }
    };
    for (let day = 0; day < 366; day += 1) {
        const at = Date.UTC(2026, 0, 1 + day);
        add({ month: 'long', weekday: 'long' }, at);
        add({ month: 'short', weekday: 'short' }, at);
    }
    for (let hour = 0; hour < 24; hour += 1) {
        add({ hour: 'numeric', hour12: true }, Date.UTC(2026, 0, 1, hour));
        add({ hour: 'numeric', hour12: true, dayPeriod: 'short' }, Date.UTC(2026, 0, 1, hour));
    }
    for (const unit of ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const) {
        const format = new Intl.NumberFormat('en-XA', { style: 'unit', unit, unitDisplay: 'short' });
        for (const amount of [0, 1, 1.5, 2, 42]) {
            for (const match of format.format(amount).matchAll(/\p{L}{2,}/gu)) {
                words.add(match[0]);
            }
        }
    }
    return words;
})();

const respond = (path: string, method: string): [number, unknown] => {
    if (path === '/api/workspace') {
        return [200, workspace];
    }
    if (path === '/api/state') {
        return [200, state];
    }
    if (path === '/api/plugins') {
        return [200, LIST];
    }
    if (/^\/api\/plugins\/[^/]+\/bindings$/.test(path)) {
        return [200, BINDINGS];
    }
    if (path === '/api/plugins/omega/backups') {
        return [200, BACKUPS];
    }
    if (path === '/api/data/plugins/omega/budget') {
        return [200, BUDGET];
    }
    if (path === '/api/plugins/kappa/launch' && method === 'POST') {
        return [500, { error: 'Upsilon' }];
    }
    if (path === '/api/apps') {
        return [200, APPS];
    }
    if (/^\/api\/apps\/[^/]+\/attempts$/.test(path)) {
        return [200, ATTEMPTS];
    }
    if (path === '/api/apps/a3/promotion') {
        return [200, PLAN];
    }
    if (path === '/api/apps/gone/launch') {
        return [404, { error: 'Upsilon' }];
    }
    // Whatever else a page asks: nothing to show, in no words.
    return [404, { error: '—' }];
};

let host: HTMLElement;
let root: Root | undefined;
let fetched: string[] = [];
const zone = process.env.TZ;
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    process.env.TZ = TIME_ZONE;
    fetched = [];
    // Only Date: the router and the settle loop keep their real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    Element.prototype.scrollIntoView ??= () => {};
    Element.prototype.hasPointerCapture ??= () => false;
    window.matchMedia = (query: string) =>
        ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as never;
    vi.stubGlobal('EventSource', undefined);
    vi.stubGlobal('open', () => null);
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const file = /^\/i18n\/en-XA\/(.+)\.test\.json$/.exec(String(input));
        if (file) {
            fetched.push(file[1]!);
            return SERVED.includes(file[1]!) ? Response.json(pseudo(file[1]!)) : new Response('', { status: 404 });
        }
        const [status, body] = respond(new URL(input, 'http://app.test').pathname, init?.method ?? 'GET');
        return Response.json(body, { status });
    });
    host = document.createElement('div');
    document.body.append(host);
});
afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    host.remove();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.useRealTimers();
    if (zone === undefined) {
        delete process.env.TZ;
    } else {
        process.env.TZ = zone;
    }
});

/** What a person reads in `node`, without the parts `skip` names (other modules'). */
function readable(node: Element, skip: readonly string[] = []) {
    const copy = node.cloneNode(true) as Element;
    for (const selector of skip) {
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
        for (const fixture of [...SHARED_TEXT, ...FIXTURE_TEXT].sort((a, b) => b.length - a.length)) {
            rest = rest.replaceAll(fixture, ' ');
        }
        return [...rest.matchAll(/\p{L}{2,}/gu)].map((match) => match[0]).filter((word) => !INTL_WORDS.has(word));
    });
}

async function settle(ticks = 12) {
    for (let tick = 0; tick < ticks; tick++) {
        await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    }
}

async function until(check: () => boolean, what: string) {
    for (let tick = 0; tick < 300; tick++) {
        if (check()) {
            return;
        }
        await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${document.body.textContent}`);
}

async function open(path: string, asked: string[][] = []) {
    const router = createTestRouter(path, {
        services: () => ({
            ...fetchServices(),
            i18n: async (namespaces) => {
                asked.push([...namespaces]);
                return pseudoPage(namespaces);
            },
        }),
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

const click = async (element: Element) => {
    await act(async () => (element as HTMLElement).click());
    await settle(4);
};

// The header's slots hold other modules' buttons (Ask a socio, Report issue).
const HEADER_SKIP = ['[data-slot="header-actions"]'];
// A setting's error is shared's check (@socio/shared/plugins/plugin-config), not this module's words.
const PAGE_SKIP = ['[data-slot="plugin-setting-error"]'];

/** Every dialog open now reads in en-XA. */
function dialogsRead() {
    const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')];
    expect(dialogs.length).toBeGreaterThan(0);
    for (const dialog of dialogs) {
        expect(untranslated(readable(dialog))).toEqual([]);
    }
}

it('inlines each Plugins and Apps route’s words, and loads the rest on demand', () => {
    const own = readdirSync(locales)
        .map((name) => name.slice(0, -'.json'.length))
        .filter((ns) => /^(plugins|apps)(\.|$)/.test(ns));
    expect(own.filter((ns) => !inlined.has(ns)).sort()).toEqual(ON_DEMAND);
    expect(routes['plugins']).toEqual(['plugins', 'plugins.catalog']);
    expect(routes['plugins:manage']).toEqual(['plugins', 'plugins.manage', 'plugins.settings', 'plugins.bindings']);
    expect(routes['plugins:frame']).toEqual(['plugins.frame']);
    expect(routes['apps']).toEqual(['apps']);
    expect(routes['apps:open']).toEqual(['apps.open']);
    expect(routes.root).not.toEqual(expect.arrayContaining(['plugins']));
});

it('renders the Plugins catalog, a plugin’s details and the Installed tab in en-XA', async () => {
    const asked: string[][] = [];
    const router = await open('/plugins', asked);
    expect(asked).toContainEqual(routes['plugins']);
    await until(() => !!document.querySelector('[data-slot="plugin-catalog"]'), 'the catalog');
    expect(untranslated(readable($('[data-slot="app-header"]'), HEADER_SKIP))).toEqual([]);
    expect(untranslated(readable($('[data-slot="plugins-page"]')))).toEqual([]);
    await act(async () => router.navigate('/plugins?app=social-strategy'));
    await settle();
    await until(() => !!document.querySelector('[data-slot="plugin-storage-warnings"]'), 'the details');
    expect(untranslated(readable($('[data-slot="plugins-page"]')))).toEqual([]);
    await act(async () => router.navigate('/plugins?app=omega'));
    await settle();
    expect(untranslated(readable($('[data-slot="plugins-page"]')))).toEqual([]);
    await act(async () => router.navigate('/plugins?tab=installed'));
    await settle();
    await until(() => !!document.querySelector('[data-slot="plugin-installed"]'), 'the installed plugins');
    expect(untranslated(readable($('[data-slot="plugins-page"]')))).toEqual([]);
});

it('opens the install dialog in en-XA, its words loaded on demand', async () => {
    await open('/plugins?app=social-strategy');
    await until(() => !!document.querySelector('[data-slot="plugin-storage-warnings"]'), 'the details');
    // The detail's first button is Back; Install is its last.
    const buttons = [...$('[data-slot="plugins-page"]').querySelectorAll('article button')];
    await click(buttons.at(-1)!);
    await until(() => !!document.querySelector('[data-slot="plugin-install-bindings"]'), 'the install dialog');
    expect(fetched).toContain('plugins.bindings');
    dialogsRead();
});

it('renders a plugin’s admin page in en-XA: overview, access, settings, network, datasets, backups', async () => {
    const asked: string[][] = [];
    await open('/settings/plugins/omega', asked);
    expect(asked).toContainEqual(routes['plugins:manage']);
    await until(() => !!document.querySelector('[data-slot="plugin-backup-history"]'), 'the backups');
    await until(() => !!document.querySelector('[data-slot="plugin-data-budget"]'), 'the data budget');
    await until(() => !!document.querySelector('[data-slot="plugin-datasets"]'), 'the datasets');
    expect(untranslated(readable($('[data-slot="app-header"]'), HEADER_SKIP))).toEqual([]);
    expect(untranslated(readable($('[data-slot="plugin-page"]'), PAGE_SKIP))).toEqual([]);
});

it.each(['eta', 'theta', 'missing'])('renders the admin page of plugin %s in en-XA', async (id) => {
    await open(`/settings/plugins/${id}`);
    await until(() => !document.querySelector('[aria-busy="true"]'), 'the page');
    expect(untranslated(readable($('[data-slot="plugin-page"]'), PAGE_SKIP))).toEqual([]);
});

it('opens the update review and Uninstall in en-XA, their words loaded on demand', async () => {
    await open('/settings/plugins/omega');
    await until(() => !!document.querySelector('[data-slot="plugin-update"]'), 'the page');
    await click($('[data-slot="plugin-update"]'));
    await until(() => !!document.querySelector('[data-slot="plugin-update-review"]'), 'the update review');
    expect(fetched).toContain('plugins.dialogs');
    dialogsRead();
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await settle(4);
    const danger = $('[data-slot="plugin-danger-zone"]');
    await click(danger.querySelector('button')!);
    await until(() => !!document.querySelector('[data-slot="plugin-uninstall"]'), 'Uninstall');
    dialogsRead();
});

it('shows a tab plugin’s launch page and its crumb in en-XA', async () => {
    const asked: string[][] = [];
    await open('/plugins/kappa', asked);
    expect(asked).toContainEqual(routes['plugins:frame']);
    await until(() => !!document.querySelector('[data-slot="plugin-open"]'), 'the launch page');
    await until(() => $('[data-slot="plugin-open"]').textContent!.includes('Upsilon'), 'the refusal');
    expect(untranslated(readable($('[data-slot="plugin-open"]')))).toEqual([]);
    expect(untranslated(readable($('[data-slot="app-header"]'), HEADER_SKIP))).toEqual([]);
});

/** An instance with the root's namespaces and `namespaces`, in en-XA, as a page that loaded them has. */
function pseudoInstance(namespaces: readonly string[]) {
    const all = [...routes.root!, ...namespaces];
    return createReactI18n({
        locale: 'en-XA',
        resources: { 'en-XA': Object.fromEntries(all.map((ns) => [ns, pseudo(ns)])) },
        namespaces: all,
    });
}

async function renderWith(namespaces: readonly string[], node: ReactNode) {
    root = createRoot(host);
    await act(async () => root!.render(<I18nextProvider i18n={pseudoInstance(namespaces)}>{node}</I18nextProvider>));
    await settle(4);
}

it('lists every update addition in en-XA', async () => {
    const { UpdateReviewDialog } = await import('../src/modules/plugins/UpdateReviewDialog');
    const review: PluginUpdateReview = {
        version: '1.3.0',
        from: 'a',
        to: 'b',
        additions: [
            { key: '1', kind: 'egress', host: 'edge.example.com' },
            { key: '2', kind: 'egress-setting', field: 'EDGE_URL', host: 'edge.example.com' },
            { key: '3', kind: 'egress-setting', field: 'EDGE_URL' },
            { key: '4', kind: 'permission', permission: 'zeta:read' },
            { key: '5', kind: 'bridge-open', url: 'https://example.com' },
            { key: '6', kind: 'bridge-open-any-https' },
            { key: '7', kind: 'embed' },
            { key: '8', kind: 'action', action: 'posts', tier: 'read' },
            { key: '9', kind: 'action', action: 'posts', tier: 'write', from: 'read' },
            { key: '10', kind: 'always-ask-dropped' },
            { key: '11', kind: 'bridge-routes' },
            { key: '12', kind: 'secret', name: 'API_KEY', required: true },
            { key: '13', kind: 'secret', name: 'API_KEY', required: false },
            { key: '14', kind: 'service-secret', name: 'API_SECRET' },
            { key: '15', kind: 'dataset', name: 'posts', access: 'read' },
            { key: '16', kind: 'dataset', name: 'posts', access: 'write' },
            { key: '17', kind: 'dataset-write', name: 'posts' },
            { key: '18', kind: 'webhook', method: 'POST', path: '/rho' },
            { key: '19', kind: 'webhook-limit', method: 'GET', path: '/rho' },
            { key: '20', kind: 'public-path', path: '/rho' },
            { key: '21', kind: 'cpus', from: 1, to: 2 },
            { key: '22', kind: 'memory', from: 256, to: 512 },
            { key: '23', kind: 'volume', name: 'data' },
        ],
        removedSettings: ['MODE'],
        openAnyHttps: true,
        addsOpenAnyHttps: true,
    };
    await renderWith(
        ['plugins', 'plugins.dialogs'],
        <UpdateReviewDialog name="Omega" review={review} onClose={() => {}} onConfirm={async () => {}} />,
    );
    // HTTP methods and paths are technical.
    const text = readable($('[data-slot="plugin-update-review"]')).map((value) =>
        value.replaceAll(/\b(GET|POST)\b/g, ' '),
    );
    expect(untranslated(text)).toEqual([]);
});

it('asks to open a plugin’s link in en-XA', async () => {
    const { OpenLinkDialog } = await import('../src/modules/plugins/OpenLinkDialog');
    await renderWith(
        ['plugins.frame'],
        <OpenLinkDialog url="https://example.com/rho" pluginName="Omega" onOpen={() => {}} onCancel={() => {}} />,
    );
    // The URL's path is the link itself.
    const text = readable($('[data-slot="plugin-open-link"]')).map((value) => value.replaceAll('/rho', ' '));
    expect(untranslated(text)).toEqual([]);
});

it('renders the Apps page in en-XA', async () => {
    const asked: string[][] = [];
    await open('/apps', asked);
    expect(asked).toContainEqual(routes['apps']);
    await until(() => !!document.querySelector('[data-slot="apps-list"]'), 'the apps');
    expect(untranslated(readable($('[data-slot="app-header"]'), HEADER_SKIP))).toEqual([]);
    // Open every version list.
    for (const details of document.querySelectorAll('details')) {
        details.open = true;
    }
    // The apps' addresses are data.
    const text = readable($('[data-slot="apps-page"]')).map((value) =>
        value.replaceAll(/https:\/\/[a-z]+\.apps\.example\.com/g, ' '),
    );
    expect(untranslated(text)).toEqual([]);
});

it.each<[string, AppsState]>([
    ['not set up', { enabled: false, apps: [] }],
    ['empty', { enabled: true, apps: [] }],
])('renders an Apps page that is %s in en-XA', async (_, answer) => {
    const fetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) =>
        String(input) === '/api/apps' ? Response.json(answer) : fetch(input, init),
    );
    await open('/apps');
    await until(() => !document.querySelector('[data-slot="apps-page"] [data-slot="skeleton"]'), 'the page');
    expect(untranslated(readable($('[data-slot="apps-page"]')))).toEqual([]);
});

it('opens an app’s logs, Delete and Unregister in en-XA, their words loaded on demand', async () => {
    await open('/apps');
    await until(() => !!document.querySelector('[data-slot="apps-list"]'), 'the apps');
    const [first, second] = document.querySelectorAll('[data-slot="app-card"]');
    // Logs, then Delete… of the promoted app; Unregister of the ephemeral one.
    const buttons = (card: Element) => [...card.querySelectorAll('button')];
    await click(buttons(first!).find((item) => item.querySelector('.lucide-scroll-text'))!);
    await until(() => !!document.querySelector('[data-slot="app-attempt-summary"]'), 'the logs');
    expect(fetched).toContain('apps.dialogs');
    dialogsRead();
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await settle(4);
    await click(buttons(first!).find((item) => item.querySelector('.lucide-trash2, .lucide-trash-2'))!);
    await until(() => !!document.querySelector('[data-slot="delete-app-dialog"]'), 'Delete');
    dialogsRead();
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await settle(4);
    await click(buttons(second!).find((item) => item.querySelector('.lucide-trash2, .lucide-trash-2'))!);
    await until(() => !!document.querySelector('[data-slot="unregister-app-dialog"]'), 'Unregister');
    const dialog = $('[data-slot="unregister-app-dialog"]');
    // Its Cancel is the shared confirmation's (components/confirm-delete).
    const cancel = [...dialog.querySelectorAll('button')].find((item) => item.textContent === 'Cancel');
    cancel?.remove();
    expect(untranslated(readable(dialog))).toEqual([]);
});

it('walks the promotion wizard in en-XA, its words loaded on demand', async () => {
    await open('/apps?promote=a3');
    await until(() => !!document.querySelector('[data-slot="promote-review"]'), 'the wizard');
    expect(fetched).toContain('apps.promote');
    for (const details of document.querySelectorAll('details')) {
        details.open = true;
    }
    dialogsRead();
});

it('shows each step of the promotion wizard in en-XA', async () => {
    const { PromoteDialog } = await import('../src/modules/apps/PromoteDialog');
    const { ShellContext } = await import('../src/shell/shell-context');
    const fetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) =>
        String(input) === '/api/apps/a3/promotion' // Without the missing dataset, which has no choice and holds the wizard on its data step.
            ? Response.json({ ...PLAN, runtime: true, datasets: PLAN.datasets.filter((item) => item.choices.length) })
            : fetch(input, init),
    );
    await renderWith(
        ['apps.promote'],
        <ShellContext.Provider value={{ workspace } as never}>
            <PromoteDialog appId="a3" onClose={() => {}} onDone={() => {}} />
        </ShellContext.Provider>,
    );
    await until(() => !!document.querySelector('[data-slot="promote-review"]'), 'the review');
    const dialog = () => $('[data-slot="promote-dialog"]');
    const next = () => [...dialog().querySelectorAll('[data-slot="dialog-footer"] button')].at(-1)!;
    await click(next());
    await until(() => !!document.querySelector('[data-slot="promote-data"]'), 'the data step');
    // Every choice of the first two datasets: move with its checkbox, then share with its Space.
    const [nu, xi, ...rest] = document.querySelectorAll('[data-slot="promote-dataset"]');
    for (const fieldset of rest) {
        await click(fieldset.querySelector('input[value="keep"]')!);
    }
    for (const fieldset of [nu!, xi!]) {
        await click(fieldset.querySelector('input[value="move"]')!);
    }
    dialogsRead();
    await click(xi!.querySelector('input[value="share"]')!);
    await click(nu!.querySelector('input[value="keep"]')!);
    dialogsRead();
    const select = xi!.querySelector<HTMLSelectElement>('[data-slot="promote-space"]')!;
    await act(async () => {
        select.value = 's1';
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle(4);
    await click(next());
    await until(() => !!document.querySelector('[data-slot="promote-confirm"]'), 'the confirmation');
    dialogsRead();
});

it('shows a socio’s Apps on its home page in en-XA, its words loaded on demand', async () => {
    const answer: DotAppsState = {
        enabled: true,
        apps: [
            {
                id: 'a1',
                name: 'Iota',
                description: 'Sigma',
                status: 'promoted',
                owner: true,
                sharedSpaceName: 'Delta',
                liveVersion: 3,
                updatedAt: now - DAY,
            },
            {
                id: 'a2',
                name: 'Kappa',
                description: '',
                status: 'ephemeral',
                owner: true,
                sharedSpaceName: null,
                liveVersion: null,
                updatedAt: now - DAY,
            },
            {
                id: 'a3',
                name: 'Lambda',
                description: '',
                status: 'unpublished',
                owner: false,
                ownerName: 'Eta',
                sharedSpaceName: null,
                liveVersion: null,
                updatedAt: now - DAY,
            },
            {
                id: 'a4',
                name: 'Mu',
                description: '',
                status: 'packaged',
                owner: false,
                sharedSpaceName: null,
                liveVersion: null,
                updatedAt: now - DAY,
            },
        ],
    };
    const fetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) =>
        String(input) === '/api/apps/dots/d1' ? Response.json(answer) : fetch(input, init),
    );
    await open('/dots/d1');
    await until(() => !!document.querySelector('[data-slot="dot-apps-list"]'), 'the socio’s apps');
    expect(fetched).toContain('apps.dot');
    expect(untranslated(readable($('[data-slot="dot-apps"]')))).toEqual([]);
});

it('says a socio has no apps in en-XA', async () => {
    const fetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) =>
        String(input) === '/api/apps/dots/d1' ? Response.json({ enabled: true, apps: [] }) : fetch(input, init),
    );
    await open('/dots/d1');
    await until(() => !!document.querySelector('[data-slot="dot-apps-empty"]'), 'the empty panel');
    expect(untranslated(readable($('[data-slot="dot-apps"]')))).toEqual([]);
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

it('renders nothing on the server for what loads on demand, never its keys', async () => {
    const { PluginInstallDialog } = await import('../src/modules/plugins/PluginDatasetBindings');
    const { UpdateReviewDialog } = await import('../src/modules/plugins/UpdateReviewDialog');
    const { UninstallPluginDialog } = await import('../src/modules/plugins/UninstallPluginDialog');
    const { PromoteDialog } = await import('../src/modules/apps/PromoteDialog');
    for (const Component of [PluginInstallDialog, UpdateReviewDialog, UninstallPluginDialog, PromoteDialog]) {
        const Shown = Component as unknown as ComponentType<Record<string, unknown>>;
        expect(serverRender(<Shown />), Component.displayName).toBe('');
    }
});
