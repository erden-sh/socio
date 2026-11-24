import { FileText } from 'lucide-react';
import { afterEach, expect, it, vi } from 'vitest';

import type { Page, PageTitle } from '@socio/shared/pages/page-library';
import { searchCommands } from '@socio/shared/search/rank';
import type { User, WorkspaceState } from '@socio/shared/types';

import { spacePath } from '../../packages/client/src/modules/pages/page-navigation.js';
import { spacesModule } from '../../packages/client/src/modules/spaces/module.js';
import type { ModuleContext, PaletteCommand } from '../../packages/client/src/modules/types.js';
import { MockAuthProvider } from '../../src/server/auth/mock.js';
import { makeTestRuntime } from '../helpers/test-runtime.js';

// The ⌘K palette's page search reads titles only (GET /api/pages/titles)
// instead of every Space's full page list. Same results, less data.
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.unstubAllGlobals();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const USERS: User[] = [
    { id: 'alice', name: 'Alice', role: 'admin' },
    { id: 'bob', name: 'Bob', role: 'member' },
];

async function fixture() {
    const { app, workspace, dispose } = await makeTestRuntime({
        config: {
            baseUrl: '',
            apiKey: '',
            model: '',
            runtimeUrl: '',
        },
        app: {
            config: { mode: 'live', baseUrl: '' },
            auth: {
                provider: new MockAuthProvider(USERS, 'secret-0123456789abcdef-xyz'),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    for (const user of USERS) {
        workspace.recordUser(user);
    }
    const as = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
        const call = (path: string, method = 'GET', body?: unknown) =>
            app.request(`/api${path}`, {
                method,
                headers: {
                    cookie,
                    ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
        return Object.assign(call, { cookie });
    };
    return { app, workspace, alice: await as('alice'), bob: await as('bob') };
}
const json = async <T>(response: Response | Promise<Response>) => (await (await response).json()) as T;

/** The palette's page entries as they were built before (every Space's
 * full page list, bodies included). */
async function legacyPageCommands(
    workspace: WorkspaceState,
    get: (path: string) => Response | Promise<Response>,
): Promise<PaletteCommand[]> {
    const lists = await Promise.all(
        workspace.spaces.map(async (item) => {
            const response = await get(`/spaces/${item.id}/pages`);
            if (!response.ok) {
                return [];
            }
            const pages = (await response.json()) as Page[];
            return pages.map((page) => ({ page, space: item }));
        }),
    );
    return lists.flat().map(({ page, space: item }): PaletteCommand => ({
        id: `page:${page.id}`,
        label: page.title || 'Untitled page',
        group: 'Pages',
        hint: item.name,
        keywords: ['page'],
        icon: FileText,
        searchOnly: true,
        run: ({ navigate }) => navigate(spacePath(item.id, page.id)),
    }));
}

/** What a result shows and where it goes (the freshness note aside). */
const shown = (commands: PaletteCommand[]) =>
    commands.map(({ run, icon, note: _, ...rest }) => {
        let path = '';
        void run({
            navigate: (to: string) => (path = to),
        } as unknown as Parameters<PaletteCommand['run']>[0]);
        return { ...rest, icon: icon === FileText, path };
    });

it('finds exactly the same pages from titles only as from the full page lists', async () => {
    const { workspace, bob } = await fixture();
    const everyday = workspace.spaces()[0]!;
    const research = workspace.createSpace('Research', 'Notes and plans');
    const gone = workspace.createSpace('Gone', '');
    const create = async (space: string, title: string, parentId?: string) => {
        const response = await bob(`/spaces/${space}/pages`, 'POST', {
            title,
            content: `# ${title}\n\n${'Body text about plans. '.repeat(40)}`,
            parentId: parentId ?? null,
        });
        expect(response.status).toBe(201);
        return json<Page>(response);
    };
    // More matches than a group shows, ties in score, accents, prefixes,
    // the same title in two Spaces, subpages.
    for (let index = 0; index < 12; index++) {
        await create(index % 2 ? research.id : everyday.id, `Plan ${index} for Q${(index % 4) + 1}`);
    }
    await create(everyday.id, 'Café notes');
    const cafe = await create(research.id, 'Café notes');
    await create(research.id, 'Notes on planning', cafe.id);
    await create(everyday.id, 'Roadmap');
    await create(gone.id, 'Plan in a gone Space');
    const deleted = await create(everyday.id, 'Plan deleted');
    expect((await bob(`/spaces/${everyday.id}/pages/${deleted.id}`, 'DELETE')).status).toBe(200);
    // The sidebar still lists the Space when it is deleted (a stale poll).
    const shell = await json<WorkspaceState>(bob('/workspace'));
    workspace.db.prepare("UPDATE spaces SET deletedAt=?, deletedBy='alice' WHERE id=?").run(Date.now(), gone.id);
    expect(shell.spaces.map((item) => item.id)).toContain(gone.id);

    const before = await legacyPageCommands(shell, (path) => bob(path));
    vi.stubGlobal('fetch', (input: string, init: RequestInit = {}) => bob(input.replace(/^\/api/, ''), init.method));
    const after = await spacesModule.loadCommands!({ workspace: shell } as ModuleContext, new AbortController().signal);
    expect(after.length).toBe(16);
    expect(shown(after)).toEqual(shown(before));
    // Each page row now says how fresh it is.
    expect(new Set(after.map((command) => command.note))).toEqual(new Set(['Edited today']));
    for (const query of [
        '',
        'plan',
        'pl',
        'plan 1',
        'q3',
        'q2 plan',
        'cafe',
        'CAFÉ notes',
        'notes',
        'research',
        'everyday plan',
        'research café',
        'page',
        'road',
        'gone',
        'deleted',
        'nothing like this',
    ]) {
        expect(shown(searchCommands(after, query)), query).toEqual(shown(searchCommands(before, query)));
    }
});

it('lists titles only, of live pages in live Spaces, to every signed-in user', async () => {
    const { app, workspace, alice, bob } = await fixture();
    const everyday = workspace.spaces()[0]!;
    const other = workspace.createSpace('Other', '');
    const gone = workspace.createSpace('Gone', '');
    const create = async (space: string, title: string) =>
        json<Page>(
            alice(`/spaces/${space}/pages`, 'POST', {
                title,
                content: 'Secret body',
            }),
        );
    const first = await create(everyday.id, 'First');
    const second = await create(other.id, 'Second');
    const removed = await create(everyday.id, 'Removed');
    await create(gone.id, 'In a deleted Space');
    expect((await alice(`/spaces/${everyday.id}/pages/${removed.id}`, 'DELETE')).status).toBe(200);
    workspace.db.prepare("UPDATE spaces SET deletedAt=?, deletedBy='alice' WHERE id=?").run(Date.now(), gone.id);

    // A member reads every live Space (Spaces are the team's), and only
    // their live pages: id, Space, title and freshness, nothing else.
    const response = await bob('/pages/titles');
    expect(response.status).toBe(200);
    const titles = await json<PageTitle[]>(response);
    expect(titles).toEqual([
        {
            id: first.id,
            spaceId: everyday.id,
            title: 'First',
            freshness: { basis: 'edited', at: first.updatedAt },
        },
        {
            id: second.id,
            spaceId: other.id,
            title: 'Second',
            freshness: { basis: 'edited', at: second.updatedAt },
        },
    ]);
    expect(JSON.stringify(titles)).not.toContain('Secret body');
    // The Spaces a member can read are the ones their sidebar lists.
    const spaces = (await json<WorkspaceState>(bob('/workspace'))).spaces.map((space) => space.id);
    expect(titles.every((page) => spaces.includes(page.spaceId))).toBe(true);
    expect(await json(alice('/pages/titles'))).toEqual(titles);
    // Signed out: nothing.
    expect((await app.request('/api/pages/titles')).status).toBe(401);
});
