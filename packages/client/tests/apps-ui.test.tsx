// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type {
    AppAttemptSummary,
    AppAttemptsState,
    AppView,
    AppsState,
    PromotionPlan,
    WorkspaceAppEntry,
} from '@socio/shared/apps/app-types';
import type { Role, State, WorkspaceState } from '@socio/shared/types';

import { createTestRouter } from './helpers/app-router';

vi.mock('@copilotkit/react-core/v2', () => ({
    CopilotKitProvider: ({ children }: { children: unknown }) => children,
}));

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const state: State = {
    settings: {
        name: 'Brain',
        paused: false,
        researchAllowed: false,
        memoryAllowed: true,
    },
    tasks: [],
    memories: [],
    mode: 'live',
    configured: false,
};
const users = {
    alice: { id: 'alice', name: 'Alice', role: 'admin' as Role },
    bob: { id: 'bob', name: 'Bob', role: 'member' as Role },
};
let me: keyof typeof users = 'bob';
const workspace = (): WorkspaceState => ({
    user: users[me],
    spaces: [{ id: 's1', name: 'Everyday', description: '', createdAt: 1 }],
    dots: [
        {
            id: 'd1',
            spaceId: 's1',
            spaceIds: ['s1'],
            name: 'Socio',
            instructions: 'Socio helps.',
            researchAllowed: false,
            memoryAllowed: false,
            createdAt: 1,
        },
    ],
    conversations: [],
    setup: {
        model: false,
        voice: false,
        telegram: 'not_configured',
        missing: ['model'],
    },
    calls: [],
    workspaceApps,
});
let workspaceApps: WorkspaceAppEntry[] = [];
const plan = (): PromotionPlan => ({
    appId: 'tracker--dot-d1',
    name: 'Tracker',
    dotName: 'Socio',
    version: {
        version: 1,
        manifest: {
            name: 'Tracker',
            description: 'Prices over time',
            entry: 'server.ts',
            runtime: 'bun',
            datasets: [{ id: 'scratch', access: 'write' }],
            egress: ['api.example.com:443'],
            env: { CURRENCY: 'Which currency to show' },
        },
        files: 3,
        sizeBytes: 2048,
        sha256: 'f'.repeat(64),
        createdAt: 1,
        createdByDotName: 'Socio',
        changes: ['First version.'],
    },
    files: [
        { path: 'server.ts', size: 1500 },
        { path: 'package.json', size: 40 },
        { path: 'bun.lock', size: 508 },
    ],
    datasets: [
        {
            ref: 'scratch',
            access: 'write',
            datasetId: 'ds-scratch',
            name: 'Socio scratch',
            kind: 'scratch',
            sizeBytes: 8192,
            tableNames: ['prices'],
            sharedSpaceId: null,
            choices: ['move', 'share', 'keep'],
        },
    ],
    runtime: true,
    promoted: false,
});
/** Two attempts: version 2's start failed, version 1's runs (CB-146). */
const attempts: AppAttemptSummary[] = [
    {
        attempt: 2,
        version: 2,
        kind: 'start',
        state: 'failed',
        reason: 'exit',
        exitCode: 1,
        signal: null,
        message: 'Version 2 exited while starting (code 1).',
        startedAt: 2,
        upAt: null,
        endedAt: 3,
    },
    {
        attempt: 1,
        version: 1,
        kind: 'start',
        state: 'running',
        reason: null,
        exitCode: null,
        signal: null,
        message: null,
        startedAt: 1,
        upAt: 1,
        endedAt: null,
    },
];
const attemptsState = (search: URLSearchParams): AppAttemptsState => {
    const chosen = attempts.find((item) => item.attempt === Number(search.get('attempt'))) ?? attempts[0];
    return {
        attempts,
        attempt: {
            ...chosen,
            lines:
                chosen.version === 2
                    ? ['2026-10-08T00:00:01Z err Error: v2 cannot find ./missing.ts']
                    : ['2026-10-08T00:00:00Z runtime version 1 is up'],
            dropped: 0,
        },
    };
};
const app = (extra: Partial<AppView> = {}): AppView => ({
    id: 'tracker--dot-d1',
    name: 'Tracker',
    description: 'Prices over time',
    dotId: 'd1',
    dotName: 'Socio',
    owner: true,
    port: 3000,
    datasets: ['scratch'],
    datasetNames: ['Scratch'],
    sharedSpaceId: null,
    sharedSpaceName: null,
    startCommand: null,
    status: 'ephemeral',
    url: 'http://tracker--dot-d1.apps.localhost:4310',
    createdAt: 1,
    updatedAt: 1,
    computer: 'running',
    answering: true,
    ...extra,
});
let apps: AppView[] = [];
let enabled = true;
let calls: Array<{ method: string; path: string; body?: unknown }> = [];

const respond = (url: URL, init?: RequestInit): [number, unknown] => {
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: `${path}${url.search}`, body });
    if (path === '/api/state') {
        return [200, state];
    }
    if (path === '/api/workspace') {
        return [200, workspace()];
    }
    if (path === '/api/issues') {
        return [200, { issues: [], users: {} }];
    }
    if (path.startsWith('/api/learning/')) {
        return [200, []];
    }
    if (path === '/api/apps') {
        return [200, { enabled, apps, host: 'apps.localhost' } satisfies AppsState];
    }
    if (path.endsWith('/launch')) {
        return [200, { url: 'http://tracker--dot-d1.apps.localhost:4310/__cb/auth?code=c' }];
    }
    if (path === '/api/apps/tracker--dot-d1/promotion') {
        return [200, plan()];
    }
    if (path === '/api/apps/tracker--dot-d1/promote') {
        return [200, { outcome: 'Promoted “Tracker”.', app: apps[0] }];
    }
    if (path === '/api/apps/tracker--dot-d1/attempts') {
        return [200, attemptsState(url.searchParams)];
    }
    if (path === '/api/apps/tracker--dot-d1/delete') {
        return [200, { ok: true, deletedDatasets: [] }];
    }
    if (['rollback', 'unpublish', 'publish'].some((verb) => path === `/api/apps/tracker--dot-d1/${verb}`)) {
        return [200, { app: apps[0] }];
    }
    if (path === '/api/apps/tracker--dot-d1' && method === 'DELETE') {
        apps = apps.filter((item) => item.id !== 'tracker--dot-d1');
        return [200, { ok: true }];
    }
    if (path === '/api/apps/tracker--dot-d1' && method === 'PATCH') {
        apps = [app({ sharedSpaceId: body.sharedSpaceId })];
        return [200, apps[0]];
    }
    return [404, { error: 'Not found.' }];
};

let root: Root;
let host: HTMLElement;
vi.setConfig({ testTimeout: 20_000 });
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    window.matchMedia = (query: string) =>
        ({
            matches: false,
            media: query,
            addEventListener: () => {},
            removeEventListener: () => {},
        }) as unknown as MediaQueryList;
    me = 'bob';
    calls = [];
    enabled = true;
    workspaceApps = [];
    apps = [
        app(),
        app({
            id: 'board--dot-d1',
            name: 'Board',
            owner: false,
            ownerName: 'Alice',
            datasetNames: [],
            sharedSpaceId: 's1',
            sharedSpaceName: 'Everyday',
            computer: 'stopped',
            answering: null,
        }),
    ];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const [status, body] = respond(new URL(input, 'http://app.test'), init);
        return new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
        });
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

async function until(check: () => boolean, what: string) {
    for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${document.body.textContent}`);
}
async function open(path: string) {
    const router = createTestRouter(path);
    act(() => root.render(<RouterProvider router={router} />));
    await until(() => !!host.querySelector('[data-slot="app-header"]'), 'shell');
    return router;
}
const text = () => host.textContent ?? '';
const cards = () => [...host.querySelectorAll<HTMLElement>('[data-slot="app-card"]')];

it('lists apps as ephemeral, with owner controls on the owner’s only', async () => {
    await open('/apps');
    await until(() => cards().length === 2, 'the apps');
    expect(text()).toContain('promote it into a workspace app');
    const [mine, shared] = cards();
    expect(mine.textContent).toContain('Ephemeral');
    expect(mine.textContent).toContain('Running');
    expect(mine.textContent).toContain('Data it may use: Scratch');
    expect(mine.querySelector('[data-slot="app-share"]')).not.toBeNull();
    expect(shared.textContent).toContain('shared by Alice');
    expect(shared.textContent).toContain('Computer stopped');
    expect(shared.querySelector('[data-slot="app-share"]')).toBeNull();
    expect(shared.textContent).not.toContain('Unregister');
    // Sharing with a Space.
    const select = mine.querySelector<HTMLSelectElement>('[data-slot="app-share"]')!;
    await act(async () => {
        select.value = 's1';
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await until(() => calls.some((call) => call.method === 'PATCH'), 'the share request');
    expect(calls.find((call) => call.method === 'PATCH')).toMatchObject({
        path: '/api/apps/tracker--dot-d1',
        body: { sharedSpaceId: 's1' },
    });
});

it('opens an app in a new tab through a one-time launch link', async () => {
    const tab = { opener: {} as unknown, location: { href: '' }, close: vi.fn() };
    const opened = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    await open('/apps');
    await until(() => cards().length === 2, 'the apps');
    const openButton = [...cards()[0].querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Open')!;
    await act(async () => openButton.click());
    await until(() => !!tab.location.href, 'the launch');
    expect(opened).toHaveBeenCalledWith('about:blank', '_blank');
    expect(tab.opener).toBeNull();
    expect(tab.location.href).toBe('http://tracker--dot-d1.apps.localhost:4310/__cb/auth?code=c');
    expect(calls.find((call) => call.path.endsWith('/launch'))).toMatchObject({
        method: 'POST',
        path: '/api/apps/tracker--dot-d1/launch',
    });
});

it('says when mini apps are not set up', async () => {
    enabled = false;
    apps = [];
    await open('/apps');
    await until(() => text().includes('Mini apps are not set up'), 'the notice');
});

const button = (scope: ParentNode, label: string | RegExp) =>
    [...scope.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
        typeof label === 'string' ? item.textContent?.trim() === label : label.test(item.textContent ?? ''),
    );
const dialog = (slot: string) => document.querySelector<HTMLElement>(`[data-slot="${slot}"]`);

it('asks before unregistering an app, in a dialog (CB-64)', async () => {
    await open('/apps');
    await until(() => cards().length === 2, 'the apps');
    const deletes = () => calls.filter((call) => call.method === 'DELETE');
    await act(async () => button(cards()[0], 'Unregister')!.click());
    await until(() => !!dialog('unregister-app-dialog'), 'the confirm');
    const confirm = dialog('unregister-app-dialog')!;
    expect(confirm.textContent).toContain('Unregister Tracker?');
    expect(confirm.textContent).toContain('Its address stops working');
    await act(async () => button(confirm, 'Cancel')!.click());
    await until(() => !dialog('unregister-app-dialog'), 'closed');
    expect(deletes()).toEqual([]);
    await act(async () => button(cards()[0], 'Unregister')!.click());
    await until(() => !!dialog('unregister-app-dialog'), 'the confirm again');
    await act(async () => button(dialog('unregister-app-dialog')!, 'Unregister')!.click());
    await until(() => cards().length === 1, 'the app gone');
    expect(deletes()).toMatchObject([{ path: '/api/apps/tracker--dot-d1' }]);
});

it('promotes a packaged app through the wizard: review, a choice per dataset, promote', async () => {
    apps = [app({ status: 'packaged' })];
    await open('/apps');
    await until(() => cards().length === 1, 'the app');
    expect(cards()[0].textContent).toContain('Packaged');
    await act(async () => button(cards()[0], /Promote/)!.click());
    await until(() => !!dialog('promote-review'), 'the review step');
    const review = dialog('promote-review')!;
    expect(review.textContent).toContain('server.ts (bun)');
    expect(review.textContent).toContain('api.example.com:443');
    expect(review.textContent).toContain('CURRENCY');
    const env = review.querySelector<HTMLInputElement>('[data-slot="promote-env"]')!;
    await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(env, 'EUR');
        env.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button(dialog('promote-dialog')!, 'Next')!.click());
    await until(() => !!dialog('promote-data'), 'the data step');
    // Nothing moves without a choice.
    expect(button(dialog('promote-dialog')!, 'Next')!.disabled).toBe(true);
    const share = dialog('promote-data')!.querySelector<HTMLInputElement>('input[value="share"]')!;
    await act(async () => share.click());
    // Sharing needs a Space.
    expect(button(dialog('promote-dialog')!, 'Next')!.disabled).toBe(true);
    const space = dialog('promote-data')!.querySelector<HTMLSelectElement>('[data-slot="promote-space"]')!;
    await act(async () => {
        space.value = 's1';
        space.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const move = dialog('promote-data')!.querySelector<HTMLInputElement>('input[value="move"]')!;
    await act(async () => move.click());
    expect(button(dialog('promote-dialog')!, 'Next')!.disabled).toBe(false);
    await act(async () => button(dialog('promote-dialog')!, 'Next')!.click());
    await until(() => !!dialog('promote-confirm'), 'the confirm step');
    expect(dialog('promote-confirm')!.textContent).toContain('Move into “Tracker data” (the socio keeps read access)');
    await act(async () => button(dialog('promote-dialog')!, 'Promote')!.click());
    await until(() => calls.some((call) => call.path.endsWith('/promote')), 'the promote request');
    expect(calls.find((call) => call.path.endsWith('/promote'))).toMatchObject({
        method: 'POST',
        body: {
            version: 1,
            datasets: [{ ref: 'scratch', choice: 'move', spaceId: 's1' }],
            env: { CURRENCY: 'EUR' },
        },
    });
    await until(() => !dialog('promote-dialog'), 'the wizard to close');
});

it('opens the wizard from a link (an approval card’s “choose yourself”)', async () => {
    apps = [app({ status: 'packaged' })];
    await open('/apps?promote=tracker--dot-d1');
    await until(() => !!dialog('promote-review'), 'the wizard');
});

it('rolls back, unpublishes, shows logs and deletes a promoted app with an explicit data choice', async () => {
    apps = [
        app({
            status: 'promoted',
            runtime: 'running',
            liveVersion: 2,
            previousVersion: 1,
            datasetNames: ['Prices (write)'],
            lastAttempt: attempts[0],
            versions: [
                {
                    version: 2,
                    manifest: plan().version.manifest,
                    files: 3,
                    sizeBytes: 2048,
                    sha256: 'a'.repeat(64),
                    createdAt: 2,
                    createdByDotName: 'Socio',
                    changes: ['Changed: server.ts'],
                },
                { ...plan().version, createdAt: 1 },
            ],
        }),
    ];
    await open('/apps');
    await until(() => cards().length === 1, 'the app');
    const card = cards()[0];
    expect(card.textContent).toContain('Workspace app');
    expect(card.textContent).toContain('Running');
    expect(card.textContent).toContain('version 2');
    // The newest attempt failed: the card says how (CB-146).
    expect(card.querySelector('[data-slot="app-last-attempt"]')!.textContent).toMatch(
        /The last start failed.*Version 2 exited while starting \(code 1\)/,
    );
    expect(card.querySelector('[data-slot="app-versions"]')!.textContent).toMatch(
        /Version 2 \(live\)[\s\S]*Changed: server.ts[\s\S]*Version 1 \(previous\)/,
    );
    await act(async () => button(card, /Roll back to version 1/)!.click());
    await until(() => calls.some((call) => call.path.endsWith('/rollback')), 'the rollback');
    await act(async () => button(cards()[0], /Unpublish/)!.click());
    await until(() => calls.some((call) => call.path.endsWith('/unpublish')), 'the unpublish');
    await act(async () => button(cards()[0], /Logs/)!.click());
    // The newest attempt first, with its own exit reason and output.
    await until(() => !!dialog('app-logs-dialog')?.textContent?.includes('missing.ts'), 'the logs');
    const logs = dialog('app-logs-dialog')!;
    expect(logs.querySelector('[data-slot="app-attempt-summary"]')!.textContent).toMatch(
        /Start of version 2 · failed, exit 1[\s\S]*exited while starting \(code 1\)/,
    );
    expect(logs.textContent).not.toContain('version 1 is up');
    // Another attempt by its number.
    const select = logs.querySelector<HTMLSelectElement>('select[data-slot="app-attempt"]')!;
    expect([...select.options].map((option) => option.value)).toEqual(['2', '1']);
    await act(async () => {
        select.value = '1';
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await until(() => !!dialog('app-logs-dialog')?.textContent?.includes('version 1 is up'), 'the first attempt');
    expect(calls.map((call) => call.path)).toContain('/api/apps/tracker--dot-d1/attempts?attempt=1');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    await until(() => !dialog('app-logs-dialog'), 'the logs to close');
    await act(async () => button(cards()[0], /Delete/)!.click());
    await until(() => !!dialog('delete-app-dialog'), 'the delete dialog');
    const remove = button(dialog('delete-app-dialog')!, 'Delete')!;
    // No default: the data's fate is chosen.
    expect(remove.disabled).toBe(true);
    const keep = dialog('delete-app-dialog')!.querySelector<HTMLInputElement>('input[type="radio"]')!;
    await act(async () => keep.click());
    await act(async () => button(dialog('delete-app-dialog')!, 'Delete')!.click());
    await until(() => calls.some((call) => call.path.endsWith('/delete')), 'the delete');
    expect(calls.find((call) => call.path.endsWith('/delete'))).toMatchObject({
        method: 'POST',
        body: { data: 'keep' },
    });
});

it('shows promoted apps in the launcher and the sidebar', async () => {
    workspaceApps = [
        {
            id: 'tracker--dot-d1',
            name: 'Tracker',
            description: '',
            url: 'http://tracker--dot-d1.apps.localhost:4310',
            dotName: 'Socio',
            sharedSpaceName: 'Everyday',
            owner: false,
        },
    ];
    await open('/');
    await until(() => !!host.querySelector('[data-module="app:tracker--dot-d1"]'), 'the launcher card');
    const card = host.querySelector<HTMLAnchorElement>('[data-module="app:tracker--dot-d1"]')!;
    expect(card.getAttribute('href')).toBe('/apps/tracker--dot-d1/open');
    // The launcher row shows the first clause; the whole line is its title.
    expect(card.textContent).toContain('A workspace app from Socio');
    expect(card.title).toBe('A workspace app from Socio, shared with Everyday.');
    const links = [...host.querySelectorAll<HTMLAnchorElement>('a')].filter(
        (link) => link.getAttribute('href') === '/apps/tracker--dot-d1/open',
    );
    // The card and the sidebar entry.
    expect(links.length).toBeGreaterThanOrEqual(2);
});
