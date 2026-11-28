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
import { embedCardMarkdown } from '@socio/shared/embed-card';
import type { Page } from '@socio/shared/pages/page-library';
import type { State, WorkspaceState } from '@socio/shared/types';
import type { PageI18n } from '@socio/shared/web/web';

import { PRIVATE_SPACE_COVERS } from '../src/components/private-space';

import { fetchServices, createTestRouter } from './helpers/app-router';

// A Space's page in en-XA, the pseudo-locale, through the app's real
// routes: the page's route asks for its namespaces (route-namespaces.json)
// and gets them in en-XA, nothing more, and what loads on demand (the
// editor's words, the dialogs', the cover picker's, the review card's)
// comes from this server's files (the fetch below). Text that stays plain
// English was never translated, and a raw key means a route doesn't
// inline what its page shows. Only the Pages module's parts are read:
// other modules' (the header's actions, the chat) aren't its.

// The page chat's live chat isn't read here (shell-chat-pseudo-locale's job).
vi.mock('@copilotkit/react-core/v2', () => ({
    CopilotKitProvider: ({ children }: { children: unknown }) => children,
    useHumanInTheLoop: () => {},
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

// What loads on demand: this server's files, which the manifest names and
// the fetch below serves. Only these, named here rather than worked out
// from route-namespaces.json, so a namespace a route should inline but
// doesn't stays missing, and its keys show.
const ON_DEMAND = ['pages.cover', 'pages.dialogs', 'pages.editor', 'pages.review'];
const SERVED = [...ON_DEMAND, 'spaces.promote', 'chat', 'chat.composer', 'chat.model', 'chat.trace'];
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
    spaces: [
        { id: 's1', name: 'Delta', description: '', createdAt: 1, access: 'editor' },
        { id: 's2', name: 'Sigma', description: '', createdAt: 2, access: 'editor' },
    ],
    dots: [{ id: 'd1', name: 'Bob', instructions: '', spaceId: 's1', spaceIds: ['s1'], createdAt: 1 }],
    conversations: [],
    setup: { model: true, voice: false, telegram: 'not_configured', missing: [] },
    calls: [],
    preferences: {},
    permissions: { createSpaces: true },
} as unknown as WorkspaceState;

// The page's clock and time zone, fixed: what the fixtures' times read as
// doesn't depend on when or where the test runs (set in beforeEach).
const now = Date.UTC(2026, 10, 20, 12);
const TIME_ZONE = 'UTC';

const card = embedCardMarkdown({
    url: 'https://example.com/post',
    kind: 'article',
    provider: 'Rho',
    title: 'Tau',
    publishedAt: '2026-11-01T09:00:00.000Z',
    media: [{ kind: 'image', alt: 'Phi' }],
    fetchedAt: '2026-11-02T09:00:00.000Z',
});
const page = (id: string, title: string, extra: Partial<Page> = {}): Page => ({
    id,
    spaceId: 's1',
    parentId: null,
    title,
    content: 'Omicron',
    revision: 1,
    createdAt: 1,
    updatedAt: Date.UTC(2026, 10, 1),
    sourceThreadId: null,
    createdBy: 'u-ada',
    cover: null,
    sourceUrl: null,
    sourceTitle: null,
    folder: false,
    ...extra,
});
const PAGES: Page[] = [
    page('pg1', 'Epsilon', { content: `Omicron\n\n${card}\n` }),
    page('pg2', 'Lambda', { folder: true, content: 'Psi' }),
    page('pg3', 'Kappa', { parentId: 'pg2' }),
    // Front matter: the page opens in Markdown source, which says why.
    page('pg4', 'Zeta', { content: '---\nchi: 1\n---\nOmicron' }),
];
const summary = ({ content: _content, ...rest }: Page) => ({ ...rest, excerpt: '' });

/** The data words: names in the fixtures. */
const FIXTURE_TEXT = [
    'Alpha',
    'Delta',
    'Sigma',
    'Epsilon',
    'Lambda',
    'Kappa',
    'Zeta',
    'Omicron',
    'Psi',
    'Rho',
    'Tau',
    'Phi',
    'chi',
    'Bob',
    'Ada',
    'example.com',
];
/**
 * Shared components' and other modules' words, not this module's: the
 * sidebar's toggle, the breadcrumb's landmark, a dialog's close button,
 * the private Space's lock (components/), and the Ctrl key.
 */
const SHARED_TEXT = [
    'Toggle Sidebar',
    'Collapse sidebar',
    'breadcrumb',
    'Close',
    'Ctrl',
    PRIVATE_SPACE_COVERS,
    'Private: only this Space’s people see it',
    'Private Space',
];

const respond = (path: string): [number, unknown] => {
    if (path === '/api/workspace') {
        return [200, workspace];
    }
    if (path === '/api/state') {
        return [200, state];
    }
    if (path === '/api/spaces/s1/pages') {
        return [200, PAGES.map(summary)];
    }
    const one = /^\/api\/spaces\/s1\/pages\/([^/]+)$/.exec(path);
    const found = one && PAGES.find((item) => item.id === one[1]);
    if (found) {
        return [200, found];
    }
    if (path === '/api/spaces/s1/cover-images') {
        return [200, []];
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
    vi.stubGlobal('EventSource', undefined);
    vi.stubGlobal('fetch', async (input: string) => {
        const file = /^\/i18n\/en-XA\/(.+)\.test\.json$/.exec(String(input));
        if (file) {
            fetched.push(file[1]!);
            return SERVED.includes(file[1]!) ? Response.json(pseudo(file[1]!)) : new Response('', { status: 404 });
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
    vi.useRealTimers();
    if (zone === undefined) {
        delete process.env.TZ;
    } else {
        process.env.TZ = zone;
    }
});

/**
 * The words Intl itself writes for en-XA's dates and times: month and
 * weekday names and day periods (AM, PM). They are the locale's data, as
 * `{{when, datetime}}` and `LocalTime` format them, not copy to translate.
 * Taken from Intl, not listed, so they follow the engine's CLDR.
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
    return words;
})();

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

// The header's slots hold other modules' buttons (Ask a socio, Report issue).
const HEADER_SKIP = ['[data-slot="header-actions"]'];

it('inlines the page view’s words on its route, and loads every other Pages namespace on demand', () => {
    const own = readdirSync(locales)
        .map((name) => name.slice(0, -'.json'.length))
        .filter((ns) => /^pages(\.|$)/.test(ns));
    expect(own.filter((ns) => !inlined.has(ns)).sort()).toEqual(ON_DEMAND);
    expect(routes['spaces:page']).toEqual(['pages']);
});

it('renders a page in en-XA: its header, cover, title, editor, blocks and chat', async () => {
    const asked: string[][] = [];
    await open('/spaces/s1/pages/pg1', asked);
    expect(asked).toContainEqual(routes['spaces:page']);
    await until(() => !!document.querySelector('[data-slot="format-toolbar"]'), 'the editor');
    await until(() => !!document.querySelector('.embed-card'), 'the link card');
    expect(fetched).toContain('pages.editor');
    expect(untranslated(readable($('[data-slot="app-header"]'), HEADER_SKIP))).toEqual([]);
    // The page's whole view, its chat dock included (no live chat until one opens).
    expect(untranslated(readable($('[data-tour="page-document"]')))).toEqual([]);
    expect($('[data-slot="page-chat-dock"]').textContent).toContain('Bob');
});

it('renders a folder, and a page that opens in Markdown source, in en-XA', async () => {
    await open('/spaces/s1/pages/pg2');
    await until(() => !!document.querySelector('[data-slot="folder-contents"]'), 'the folder');
    expect(untranslated(readable($('[data-tour="page-document"]')))).toEqual([]);
    act(() => root!.unmount());
    root = undefined;
    await open('/spaces/s1/pages/pg4');
    await until(() => !!document.querySelector('[data-page-body]'), 'the source');
    expect($('[data-tour="page-document"]').textContent).toContain(
        (pseudo('pages') as { document: { source: { reasons: Record<string, string> } } }).document.source.reasons
            .extended,
    );
    expect(untranslated(readable($('[data-tour="page-document"]')))).toEqual([]);
});

it('says a page isn’t there in en-XA', async () => {
    await open('/spaces/s1/pages/gone');
    await until(() => !!document.querySelector('[data-slot="library-empty"][role="status"]'), 'the missing page');
    expect(untranslated(readable($('[data-slot="app-body"]')))).toEqual([]);
});

it('loads the page’s namespaces with its own loader alone when a page opens from the library', async () => {
    const asked: string[][] = [];
    const router = await open('/spaces/s1', asked);
    expect(asked).toContainEqual(routes['spaces:space']);
    asked.length = 0;
    await act(async () => router.navigate('/spaces/s1/pages/pg1'));
    await until(() => !!document.querySelector('[data-slot="format-toolbar"]'), 'the editor');
    // Only the page's loader runs: the Space's (and the root's) hold.
    expect(asked).toEqual([routes['spaces:page']]);
    expect(fetched).toContain('pages.editor');
    asked.length = 0;
    await act(async () => router.navigate('/spaces/s1/pages/pg2'));
    await until(() => !!document.querySelector('[data-slot="folder-contents"]'), 'the folder');
    // Another page keeps them.
    expect(asked).toEqual([]);
});

/** An instance with the root's namespaces and `namespaces`, in en-XA, as a page that loaded them has. */
function pseudoInstance(namespaces: readonly string[]) {
    const all = [...routes.root!, 'pages', ...namespaces];
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

it('opens the delete, move and new folder dialogs in en-XA', async () => {
    const { DeletePageDialog } = await import('../src/modules/pages/DeletePageDialog');
    const { MovePageDialog } = await import('../src/modules/pages/MovePageDialog');
    const { NewFolderDialog } = await import('../src/modules/pages/NewFolderDialog');
    const pages = PAGES.map(summary);
    await renderWith(
        ['pages.dialogs'],
        <>
            <DeletePageDialog page={pages[1]!} pages={pages} open onOpenChange={() => {}} onDeleted={() => {}} />
            <MovePageDialog
                page={pages[1]!}
                pages={pages}
                spaces={workspace.spaces}
                open
                onOpenChange={() => {}}
                beforeMove={async () => true}
                onMoved={() => {}}
            />
            <NewFolderDialog open onOpenChange={() => {}} onCreate={async () => {}} />
        </>,
    );
    const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
    expect(dialogs).toHaveLength(3);
    for (const dialog of dialogs) {
        expect(untranslated(readable(dialog))).toEqual([]);
    }
});

it('opens the cover picker in en-XA', async () => {
    const { CoverPicker } = await import('../src/modules/pages/PageCover');
    await renderWith(['pages.cover'], <CoverPicker spaceId="s1" onPick={async () => {}} />);
    await settle(4);
    expect(untranslated(readable($('[data-slot="cover-picker"]')))).toEqual([]);
});

it.each<[string, { status: string; receipt: unknown; args?: unknown }]>([
    ['ready', { status: 'executing', receipt: null }],
    ['invalid', { status: 'executing', receipt: null, args: { title: '' } }],
    ['saved', { status: 'complete', receipt: { id: 'pg1', spaceId: 's1', title: 'Epsilon', content: 'Omicron' } }],
])('shows a %s page review card in en-XA', async (_, { status, receipt, args }) => {
    const { PageReviewCard } = await import('../src/modules/pages/PageReviewCard');
    vi.stubGlobal('fetch', async (input: string) =>
        String(input).includes('/reviewed-page/') ? Response.json(receipt) : Response.json({}, { status: 404 }),
    );
    await renderWith(
        ['pages.review'],
        <PageReviewCard
            args={args ?? { title: 'Epsilon', content: 'Omicron', spaceId: 's1' }}
            status={status}
            respond={async () => {}}
            threadId="t1"
            toolCallId="c1"
            onSaved={() => {}}
        />,
    );
    await settle(4);
    const card = $('section[aria-label]');
    // The draft problem's words are shared's (@socio/shared/pages/page-review), not this module's.
    const text = readable(card).map((value) => value.replace(/\([^()[\]]*\)/g, ' '));
    expect(untranslated(text)).toEqual([]);
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
    const { DeletePageDialog } = await import('../src/modules/pages/DeletePageDialog');
    const { MovePageDialog } = await import('../src/modules/pages/MovePageDialog');
    const { NewFolderDialog } = await import('../src/modules/pages/NewFolderDialog');
    const { CoverPicker } = await import('../src/modules/pages/PageCover');
    const { PageReviewCard } = await import('../src/modules/pages/PageReviewCard');
    for (const Component of [DeletePageDialog, MovePageDialog, NewFolderDialog, CoverPicker, PageReviewCard]) {
        const Shown = Component as unknown as ComponentType<{ open: boolean }>;
        expect(serverRender(<Shown open />), Component.displayName).toBe('');
    }
});
