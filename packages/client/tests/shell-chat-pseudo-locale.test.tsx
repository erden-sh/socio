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
import { SOUL_HINTS, SOUL_LABELS, type SoulVersion, type SoulView } from '@socio/shared/soul';
import type { State, WorkspaceState } from '@socio/shared/types';
import type { PageI18n } from '@socio/shared/web/web';

import { fetchServices, createTestRouter } from './helpers/app-router';

// The shell and the chat pages in en-XA, the pseudo-locale, through the
// app's real routes: each loader asks for its route's namespaces
// (route-namespaces.json) and gets them in en-XA, nothing more, and what
// loads on demand comes from this server's files (the fetch below). Text
// that stays plain English was never translated, and a raw key means a
// route doesn't inline what its page shows. Only the shell's and chat's
// own parts of each page are read: other modules aren't translated yet.

// The live chat's agent: a conversation of two messages that connects at once.
const kit = vi.hoisted(() => {
    const agent = {
        agentId: 'chat-c1',
        messages: [
            { id: 'm1', role: 'user', content: 'Delta' },
            { id: 'm2', role: 'assistant', content: 'Epsilon' },
        ] as unknown[],
        setMessages(next: unknown[]) {
            agent.messages = next;
        },
        addMessage(message: unknown) {
            agent.messages = [...agent.messages, message];
        },
        subscribe: () => ({ unsubscribe() {} }),
        requestInit: (): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' } }),
    };
    return {
        agent,
        copilotkit: {
            subscribe: () => ({ unsubscribe() {} }),
            connectAgent: async () => ({ newMessages: [] }),
            runAgent: async () => undefined,
            stopAgent: () => {},
        },
    };
});
vi.mock('@copilotkit/react-core/v2', () => ({
    CopilotKitProvider: ({ children }: { children: unknown }) => children,
    useAgent: () => ({ agent: kit.agent, isReady: true }),
    useCopilotKit: () => ({ copilotkit: kit.copilotkit }),
    useRenderTool: () => {},
    useHumanInTheLoop: () => {},
    CopilotChatToolCallsView: () => null,
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
const shellOrChat = (ns: string) =>
    ns === 'shell' || ns.startsWith('shell.') || ns === 'chat' || ns.startsWith('chat.');

// What loads on demand: this server's files, which the manifest names and
// the fetch below serves. Only these, named here rather than worked out from
// route-namespaces.json, so a namespace a route should inline but doesn't
// stays missing, and its keys show.
const ON_DEMAND = [
    'chat.drafts',
    'chat.report',
    'chat.result',
    'shell.add-device',
    'shell.help',
    'shell.palette',
    'shell.status',
];
// The live chat's (client-only, ClientChat): some chat pages inline them,
// the others load them on demand, as does the Ask panel.
const LIVE_CHAT = ['chat', 'chat.composer', 'chat.model', 'chat.trace'];
const manifest = {
    release: '1.0.0',
    locales: {
        'en-XA': {
            coverage: 1,
            ns: Object.fromEntries(
                readdirSync(locales)
                    .map((name) => name.slice(0, -'.json'.length))
                    .filter((ns) => !inlined.has(ns) || LIVE_CHAT.includes(ns))
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
    conversations: [{ id: 'c1', dotId: 'd1', ownerId: 'u-ada', title: 'Gamma', createdAt: 2 }],
    setup: { model: true, voice: false, telegram: 'not_configured', missing: [] },
    calls: [],
    preferences: {},
} as unknown as WorkspaceState;

/** The data words: names in the fixtures. */
const FIXTURE_TEXT = ['Alpha', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Theta', 'Iota', 'Kappa', 'Eta', 'Bob', 'Ada'];
/**
 * Shared components' words, not translated yet: the sidebar's toggle, the
 * breadcrumb's landmark, a dialog's close button and the palette's list
 * (components/, cmdk), the mascot's label (locals/), and the Ctrl key.
 */
const SHARED_TEXT = [
    'Toggle Sidebar',
    'Collapse sidebar',
    'breadcrumb',
    'Close',
    'Suggestions',
    'Socio is idle',
    'is idle',
    'Ctrl',
];

/** Bob's Soul: two versions, Ada may edit it. */
const version = (n: number, source: SoulVersion['source'], createdBy: string): SoulVersion => ({
    version: n,
    createdAt: Date.UTC(2026, 10, n),
    createdBy,
    source,
    restoredFrom: null,
    instructions: `Zeta ${n}`,
    voice: 'Eta',
    values: 'Theta',
    style: n === 2 ? 'Iota' : 'Kappa',
});
const soul: SoulView = {
    dot: { id: 'd1', name: 'Bob', ownerId: null, archived: false },
    versions: [version(2, 'edited', 'u-ada'), version(1, 'created', 'system')],
    canEdit: true,
    users: { 'u-ada': 'Ada' },
};

let signedIn = true;
const respond = (path: string): [number, unknown] => {
    if (path === '/api/workspace' || path === '/api/state') {
        return signedIn ? [200, path === '/api/state' ? state : workspace] : [401, { error: 'Sign in.' }];
    }
    if (path === '/api/dots/d1/soul') {
        return [200, soul];
    }
    if (path === '/api/auth/session') {
        return [
            200,
            {
                provider: 'better-auth',
                methods: {
                    passkey: true,
                    password: true,
                    providers: [],
                    signUp: true,
                    emailReset: true,
                    signInLink: true,
                },
            },
        ];
    }
    return [404, { error: 'Not found.' }];
};

let host: HTMLElement;
let root: Root | undefined;
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    signedIn = true;
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
            return ON_DEMAND.includes(file[1]!) || LIVE_CHAT.includes(file[1]!)
                ? Response.json(pseudo(file[1]!))
                : new Response('', { status: 404 });
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
}

const $ = (selector: string) => {
    const found = document.querySelector(selector);
    expect(found, selector).not.toBeNull();
    return found!;
};

// The Soul's part names and hints are packages/shared's (SOUL_LABELS, SOUL_HINTS).
const SOUL_SKIP: string[] = [];
SHARED_TEXT.push(...Object.values(SOUL_LABELS), ...Object.values(SOUL_HINTS));

// The header's slots hold other modules' buttons (Ask a socio, Report issue).
const HEADER_SKIP = ['[data-slot="header-actions"]'];

it('loads on demand only what no route inlines, and every shell and chat namespace has a home', () => {
    const own = readdirSync(locales)
        .map((name) => name.slice(0, -'.json'.length))
        .filter(shellOrChat);
    expect(own.filter((ns) => !inlined.has(ns)).sort()).toEqual(ON_DEMAND);
    for (const id of ['home', 'shell:signed-out', 'chat:thread', 'chat:dot', 'chat:dot-home', 'chat:dot-soul']) {
        expect(routes[id], id).toBeDefined();
    }
});

it('renders the sign-in screen in en-XA with only its namespaces', async () => {
    signedIn = false;
    await open('/');
    const main = $('main');
    expect(main.querySelector('form')).not.toBeNull();
    expect(untranslated(readable(main))).toEqual([]);
});

it('renders Home, the header and the chat sidebar in en-XA with only their namespaces', async () => {
    await open('/');
    expect(untranslated(readable($('[data-slot="app-header"]'), HEADER_SKIP))).toEqual([]);
    // The launcher's cards are the modules' own titles (the registry), and
    // What's new and the widgets are other modules'.
    expect(
        untranslated(
            readable($('[data-slot="home"]'), [
                '[data-slot="module-card"]',
                '[data-slot="home-whats-new"]',
                '[data-slot="home-glance"]',
            ]),
        ),
    ).toEqual([]);
    expect(untranslated(readable($('[data-nav="chat-socios"]')))).toEqual([]);
    expect(untranslated(readable($('[data-nav="chat-recent"]')))).toEqual([]);
});

it('renders a socio’s home page in en-XA with only its namespaces', async () => {
    await open('/dots/d1');
    expect(untranslated(readable($('[data-slot="app-header"]'), HEADER_SKIP))).toEqual([]);
    // Other modules' panels (approvals, issues, goals, schedules) and apps fill its slots.
    const others = [
        '[data-slot="dot-panel"]:not([data-panel="active-chats"], [data-panel="running"], [data-panel="archived-chats"], [data-panel="recent-runs"])',
        '[data-slot="dot-apps"]',
    ];
    expect(untranslated(readable($('[data-slot="app-body"]'), others))).toEqual([]);
});

it('renders a socio’s Soul in en-XA with only its namespaces: the version in use, its history and the editor', async () => {
    await open('/dots/d1/soul');
    expect(untranslated(readable($('[data-slot="app-header"]'), HEADER_SKIP))).toEqual([]);
    $('[data-slot="soul-current"]');
    $('[data-slot="soul-history"]');
    // A past version's changes, then the editor.
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-slot="soul-version"] button')) {
        await act(async () => button.click());
    }
    await settle();
    expect(untranslated(readable($('[data-slot="app-body"]'), SOUL_SKIP))).toEqual([]);
    const edit = document.querySelector<HTMLButtonElement>('[data-slot="soul-current"] button');
    await act(async () => edit!.click());
    await settle();
    $('[data-slot="soul-editor"]');
    expect(untranslated(readable($('[data-slot="app-body"]'), SOUL_SKIP))).toEqual([]);
});

it.each(['/chats/c1', '/dots/d1/new'])('renders the chat page %s in en-XA with only its namespaces', async (path) => {
    await open(path);
    await settle(20);
    // The live chat (or a new chat's composer), not its loading state.
    expect(document.querySelector('[data-slot="app-body"] textarea'), path).not.toBeNull();
    expect(untranslated(readable($('[data-slot="app-header"]'), HEADER_SKIP))).toEqual([]);
    const body = $('[data-slot="app-body"]');
    expect(untranslated(readable(body))).toEqual([]);
});

it('opens the palette, the Help menu and the connection details with their on-demand words', async () => {
    await open('/');
    await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    });
    await settle();
    const palette = $('[role="dialog"]');
    // The rows are the modules' commands (the registry), not the palette's words.
    expect(untranslated(readable(palette, ['[cmdk-item]']))).toEqual([]);
    await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    });
    await settle();
    await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
    });
    await settle();
    expect(untranslated(readable($('[data-slot="shortcuts-dialog"]')))).toEqual([]);
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
    const { AddDeviceDialog } = await import('../src/shell/AddDeviceDialog');
    const { GetTheAppDialog } = await import('../src/shell/GetTheApp');
    const { ThemeSubmenu } = await import('../src/components/theme-toggle');
    expect(serverRender(<AddDeviceDialog onClose={() => {}} />)).toBe('');
    expect(serverRender(<GetTheAppDialog link="https://example.com/w/app" onClose={() => {}} />)).toBe('');
    expect(serverRender(<ThemeSubmenu />)).toBe('');
});
