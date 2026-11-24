// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { SignInMethods } from '@socio/shared/auth';
import type { Conversation, Role, TelegramStatus, WorkspaceState } from '@socio/shared/types';

import { PASSKEY_CHECK_KEY } from '../src/shell/auth-client';
import { SignInSetup } from '../src/shell/current-user';
import { ShellContext, type Shell } from '../src/shell/shell-context';

import { AppSidebar, SidebarToggle, type AppSidebarProps } from '@/components/app-sidebar';
import { readSidebarOpen, SidebarProvider } from '@/components/ui/sidebar';
import { RECENT_CHATS } from '@/modules/chat/nav';
import { sidebarEntries } from '@/modules/derive';
import { closeReport, useReportRequest } from '@/modules/issues/report';
import { clientModules } from '@/modules/registry';
import type { ModuleContext } from '@/modules/types';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const context = (
    overrides: {
        admin?: boolean;
        tasks?: number;
        memories?: number;
        telegram?: TelegramStatus;
    } = {},
): ModuleContext => {
    const { admin = true, tasks = 3, memories = 2 } = overrides;
    const space = workspace(admin ? 'admin' : 'member');
    space.setup.telegram = overrides.telegram ?? 'not_configured';
    return moduleContext(space, { tasks, memories });
};
const entries = (ctx: ModuleContext) => sidebarEntries(clientModules, ctx);

it('leaves embed navigation to the browser so the new document gets its CSP', () => {
    const space = workspace('admin');
    space.plugins = [
        {
            id: 'planner',
            name: 'Planner',
            description: '',
            display: 'embed',
            mode: 'service',
            openAllow: [],
            openAnyHttps: false,
            routes: false,
            origin: 'https://planner.apps.example',
            entryPath: '/',
        },
    ];
    render({ workspace: space });
    const link = document.querySelector<HTMLAnchorElement>('a[href="/plugins/planner"]')!;
    expect(link).not.toBeNull();
    let intercepted: boolean | undefined;
    const observe = (event: MouseEvent) => {
        intercepted = event.defaultPrevented;
        event.preventDefault(); // jsdom cannot load another document.
    };
    document.addEventListener('click', observe, { once: true });
    act(() => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
    expect(intercepted).toBe(false);
});

it('lists the module items in order, with socios for admins only', () => {
    expect(entries(context()).map((item) => item.id)).toEqual([
        'activity',
        'memories',
        'data',
        'media',
        'approvals',
        'apps',
        'schedules',
        'plugins',
        'learning',
        'issues',
        'runs',
        'dots',
        'connected-agents',
        'settings',
        // Admins' Operations dashboard, in the secondary group (CB-164).
        'operations',
        // Platform: admins since the operator role was retired (CB-390).
        'operator',
        // Help docs and onboarding guides, in the secondary group (CB-253).
        'help',
    ]);
    const member = entries(context({ admin: false }));
    expect(member.map((item) => item.id)).toEqual([
        'activity',
        'memories',
        'data',
        'media',
        'approvals',
        'apps',
        'schedules',
        'learning',
        'issues',
        // A member's own turns (CB-128).
        'runs',
        'settings',
        // Help docs and onboarding guides, in the secondary group (CB-253).
        'help',
    ]);
    // Every admin-only module is hidden from members.
    for (const module of clientModules.filter((entry) => entry.access === 'admin')) {
        expect(member.map((entry) => entry.id)).not.toContain(module.id);
    }
});

it('puts workspace apps and plugins in the Apps section, and groups bottom links by function', () => {
    const space = workspace('admin');
    space.workspaceApps = [
        {
            id: 'songworld',
            name: 'Songworld',
            description: '',
            url: '',
            dotName: 'Socio',
            owner: true,
            sharedSpaceName: null,
        },
    ];
    space.plugins = [
        {
            id: 'calendar',
            name: 'Calendar',
            description: '',
            display: 'embed',
            mode: 'bundled',
            origin: '',
            entryPath: '',
            openAllow: [],
            openAnyHttps: false,
            routes: false,
        },
    ];
    const ctx = moduleContext(space);
    const list = entries(ctx);
    expect(list.find((entry) => entry.id === 'app:songworld')?.section).toBe('apps');
    expect(list.find((entry) => entry.id === 'plugin:calendar')?.section).toBe('apps');
    expect(list.find((entry) => entry.id === 'telegram')?.section).toBe('integrations');
    expect(list.find((entry) => entry.id === 'settings')?.section).toBe('settings');
    expect(list.find((entry) => entry.id === 'operations')?.section).toBe('platform');
});

it('names Learning Skills for members and shows counts as badges', () => {
    const label = (admin: boolean) => entries(context({ admin })).find((item) => item.id === 'learning')?.label;
    expect(label(true)).toBe('Learning');
    expect(label(false)).toBe('Skills');
    const badges = Object.fromEntries(entries(context()).map((item) => [item.id, item.badge]));
    expect(badges).toMatchObject({ activity: '3', memories: '2' });
    expect(badges.settings).toBeUndefined();
});

it('shows Telegram with its status only once it is configured', () => {
    const telegram = (status: TelegramStatus, admin = true) =>
        entries(context({ telegram: status, admin })).find((item) => item.id === 'telegram');
    expect(telegram('not_configured')).toBeUndefined();
    expect(telegram('online')).toMatchObject({
        badge: 'online',
        opens: { path: '/settings/telegram' },
    });
    expect(telegram('failed', false)?.badge).toBe('not connected');
});

it('reads the collapse state shadcn saves in its cookie', () => {
    expect(readSidebarOpen('')).toBe(true);
    expect(readSidebarOpen('sidebar_state=false')).toBe(false);
    expect(readSidebarOpen('a=1; sidebar_state=true; b=2')).toBe(true);
    expect(readSidebarOpen('a=1; sidebar_state=false')).toBe(false);
    expect(readSidebarOpen('my_sidebar_state=false')).toBe(true);
});

let root: Root;
let host: HTMLElement;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    // jsdom has no matchMedia; the sidebar's useIsMobile needs it.
    window.matchMedia = (query: string) =>
        ({
            matches: false,
            media: query,
            addEventListener: () => {},
            removeEventListener: () => {},
        }) as unknown as MediaQueryList;
    consoleError = vi.spyOn(console, 'error');
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
    consoleError.mockRestore();
    document.cookie = 'sidebar_state=; max-age=0; path=/';
    localStorage.clear();
});

const chat = (index: number, extra: Partial<Conversation> = {}) => ({
    id: `c${index}`,
    dotId: index % 2 ? 'd2' : 'd1',
    ownerId: 'alice',
    title: `Chat ${index}`,
    createdAt: index,
    ...extra,
});

function workspace(role: Role, chats = 3): WorkspaceState {
    return {
        user: { id: role, name: role === 'admin' ? 'Alice' : 'Bob', role },
        spaces: [
            { id: 's1', name: 'Everyday', description: '', createdAt: 1 },
            { id: 's2', name: 'Engineering', description: '', createdAt: 2 },
        ],
        dots: ['Socio', 'Fulano'].map((name, index) => ({
            id: `d${index + 1}`,
            spaceId: 's1',
            spaceIds: ['s1'],
            name,
            instructions: '',
            researchAllowed: false,
            memoryAllowed: false,
            createdAt: index,
        })),
        conversations: Array.from({ length: chats }, (_, index) => chat(index, index === 0 ? { team: true } : {})),
        setup: {
            model: true,
            voice: false,
            telegram: 'online',
            missing: [],
        },
        calls: [],
        permissions: { createSpaces: true },
    };
}

// Where the router is after a click.
let path = '';
function Location() {
    path = useLocation().pathname;
    return null;
}

function moduleContext(space: WorkspaceState, counts = { tasks: 4, memories: 1 }, configured = true): ModuleContext {
    const item = (id: string) => ({ id, text: '', createdAt: 0 });
    return {
        admin: space.user.role === 'admin',
        workspace: space,
        state: {
            settings: {
                name: 'Brain',
                paused: false,
                researchAllowed: false,
                memoryAllowed: true,
            },
            tasks: Array.from({ length: counts.tasks }, (_, index) => ({
                ...item(`t${index}`),
            })) as unknown as ModuleContext['state']['tasks'],
            memories: Array.from({ length: counts.memories }, (_, index) => item(`m${index}`)),
            mode: 'live',
            configured,
        },
        configured,
        homeDot: space.dots[0]!,
    };
}

function render(
    overrides: Partial<AppSidebarProps> & {
        role?: Role;
        at?: string;
        workspace?: WorkspaceState;
        configured?: boolean;
        /** Better Auth's sign-in methods; none (mock auth) by default. */
        methods?: SignInMethods;
    } = {},
) {
    const {
        role = 'admin',
        at = '/',
        workspace: space = workspace(role),
        configured = true,
        methods,
        ...rest
    } = overrides;
    const props: AppSidebarProps = {
        context: moduleContext(space, undefined, configured),
        activeDotId: 'd1',
        onNewChat: vi.fn(),
        onEditDot: vi.fn(),
        onCreateDot: vi.fn(),
        onCreateSpace: vi.fn(),
        onDialog: vi.fn(),
        onSearch: vi.fn(),
        onSwitchUser: vi.fn(),
        ...rest,
    };
    act(() =>
        root.render(
            <MemoryRouter initialEntries={[at]}>
                {/* The Dot menu saves through the shell. */}
                <ShellContext.Provider value={{ refresh: vi.fn() } as unknown as Shell}>
                    <SignInSetup.Provider value={methods}>
                        <SidebarProvider>
                            <AppSidebar {...props} />
                            <SidebarToggle />
                        </SidebarProvider>
                    </SignInSetup.Provider>
                </ShellContext.Provider>
                <Location />
            </MemoryRouter>,
        ),
    );
    return props;
}

const byLabel = (label: string) => document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
const button = (text: string) =>
    [...document.querySelectorAll<HTMLElement>('[data-sidebar="menu-button"], [data-sidebar="menu-sub-button"]')].find(
        (element) => element.textContent?.trim() === text && !element.matches('a[aria-label$=" home"]'),
    );
const click = (element: HTMLElement | null | undefined) => {
    expect(element).toBeTruthy();
    act(() => element!.click());
};

it('renders every destination for an admin, with management controls', () => {
    const props = render();
    expect(consoleError).not.toHaveBeenCalled();
    for (const text of [
        'New chat',
        'Socio',
        'Fulano',
        'Everyday',
        'Engineering',
        'Scheduled & activity',
        'Memories',
        'Learning',
        'Issues',
        'Runs',
        'Telegram',
        'Settings & setup',
    ]) {
        expect(button(text), text).toBeTruthy();
    }
    for (const label of ['Create socio', 'Create Space', 'Socio options', 'Fulano options']) {
        expect(byLabel(label), label).not.toBeNull();
    }
    // The selected Dot is marked for chat; the Telegram status shows.
    expect(button('Socio')?.getAttribute('aria-current')).toBe('page');
    expect(document.body.textContent).toContain('online');
    expect(document.body.textContent).toContain('Alice');
    expect(document.body.textContent).toContain('Admin');

    // App items are links to their routes, active from the URL.
    expect(button('Runs')?.getAttribute('href')).toBe('/runs');
    click(button('Runs'));
    expect(path).toBe('/runs');
    expect(button('Runs')?.getAttribute('aria-current')).toBe('page');
    click(button('Scheduled & activity'));
    expect(path).toBe('/activity');
    expect(button('Runs')?.getAttribute('aria-current')).toBeNull();
    // Bottom links are grouped by function and shown small.
    const settings = button('Settings & setup');
    expect(settings?.getAttribute('data-size')).toBe('sm');
    expect(button('Telegram')?.getAttribute('data-size')).toBe('sm');
    // Telegram and Settings are now in their own sections under a common bottom
    // wrapper (CB-276).
    const bottom = document.querySelector<HTMLElement>('[data-slot="sidebar-content"] > .mt-auto');
    expect(bottom?.contains(settings ?? null)).toBe(true);
    expect(bottom?.contains(button('Telegram') ?? null)).toBe(true);
    expect(button('Runs')?.getAttribute('data-size')).toBe('default');
    // Settings and Telegram are settings pages (CB-95), not dialogs.
    expect(button('Settings & setup')?.getAttribute('href')).toBe('/settings/workspace');
    click(button('Settings & setup'));
    expect(path).toBe('/settings/workspace');
    expect(button('Settings & setup')?.getAttribute('aria-current')).toBe('page');
    click(button('Telegram'));
    expect(path).toBe('/settings/telegram');
    expect(props.onDialog).not.toHaveBeenCalled();
    // A Dot's ⋯ opens its menu; All settings… opens the full dialog.
    act(() => {
        byLabel('Fulano options')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    const menuItem = (text: string) =>
        [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
            (element) => element.textContent?.trim() === text,
        );
    expect(
        [...document.querySelectorAll('[data-slot="dot-menu"] [role^="menuitem"]')].map((element) =>
            element.textContent?.trim(),
        ),
    ).toEqual([
        'New chat',
        'Rename',
        'Public-page research',
        'Use saved memories',
        'File to the Improvements board',
        'Activity',
        'Soul',
        'Archive…',
        'All settings…',
    ]);
    click(menuItem('All settings…'));
    expect(props.onEditDot).toHaveBeenCalledWith(expect.objectContaining({ id: 'd2' }));
    click(byLabel('Create Space'));
    expect(props.onCreateSpace).toHaveBeenCalled();
    // A Dot always opens its home page (CB-89), though it has chats (c1).
    click(button('Fulano'));
    expect(path).toBe('/dots/d2');
    click(button('Socio'));
    expect(path).toBe('/dots/d1');
    click(byLabel('Socio home'));
    expect(path).toBe('/');
});

it('saves a socio menu toggle with the rest of its settings as they are', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}));
    render();
    act(() => {
        byLabel('Fulano options')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    const memories = [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find(
        (element) => element.textContent?.trim() === 'Use saved memories',
    );
    await act(async () => memories!.click());
    expect(fetch).toHaveBeenCalledWith('/api/dots/d2', expect.objectContaining({ method: 'PUT' }));
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({
        // Never its instructions: they are its Soul's (CB-179).
        name: 'Fulano',
        researchAllowed: false,
        memoryAllowed: true,
        issuesAllowed: false,
        learningContainerId: null,
        skillDeliveryEnabled: false,
        spaceIds: ['s1'],
        spaceId: 's1',
        inference: null,
    });
    // The menu stays open for the next toggle.
    expect(document.querySelector('[data-slot="dot-menu"]')).not.toBeNull();
    fetch.mockRestore();
});

it('hides admin items and controls from members', () => {
    render({ role: 'member' });
    // Runs is everyone's: a member's own turns (CB-128).
    expect(button('Runs')).toBeTruthy();
    expect(button('Socios')).toBeUndefined();
    expect(button('Learning')).toBeUndefined();
    expect(button('Skills')).toBeTruthy();
    expect(byLabel('Socio options')).toBeNull();
    // Anyone makes a Dot of their own, and a private Space while the
    // server's create-Spaces permission lets them (CB-181).
    expect(byLabel('Create socio')).toBeTruthy();
    expect(byLabel('Create Space')).toBeTruthy();
    expect(document.body.textContent).toContain('Member');
});

it('shows Create Space only when the server’s permission allows it, whatever the role', () => {
    for (const role of ['member', 'admin'] as const) {
        render({ workspace: { ...workspace(role), permissions: { createSpaces: false } } });
        expect(byLabel('Create Space'), role).toBeNull();
        render({ workspace: { ...workspace(role), permissions: undefined } });
        expect(byLabel('Create Space'), `${role}, an older server`).toBeNull();
        render({ workspace: workspace(role) });
        expect(byLabel('Create Space'), `${role}, allowed`).toBeTruthy();
    }
});

it('persists collapsible section state per person in localStorage', () => {
    render();
    const trigger = (section: string) => document.querySelector<HTMLElement>(`button[data-section="${section}"]`);
    const content = (section: string) => document.getElementById(`sidebar-section-${section}`);
    expect(trigger('settings')?.getAttribute('aria-expanded')).toBe('true');
    expect(content('settings')?.getAttribute('data-state')).toBe('open');
    click(trigger('settings'));
    expect(trigger('settings')?.getAttribute('aria-expanded')).toBe('false');
    expect(content('settings')?.getAttribute('data-state')).toBe('closed');
    expect(localStorage.getItem('socio:sidebar:sections:admin')).toContain('"settings":false');
    click(trigger('settings'));
    expect(trigger('settings')?.getAttribute('aria-expanded')).toBe('true');
    expect(content('settings')?.getAttribute('data-state')).toBe('open');
});

it('marks team chats, caps recent chats and opens a thread', () => {
    render({
        workspace: workspace('admin', RECENT_CHATS + 3),
        at: '/chats/c1',
    });
    const titles = () => [...document.querySelectorAll('[data-thread-title]')].map((element) => element.textContent);
    expect(titles()).toHaveLength(RECENT_CHATS);
    expect(document.querySelector('[aria-label="Team conversation"]')).not.toBe(null);
    expect(document.body.textContent).toContain('Socio · Team');
    const thread = document.querySelector('[data-thread-title]')?.closest<HTMLElement>('a');
    expect(thread?.getAttribute('href')).toBe('/chats/c0');
    click(thread);
    expect(path).toBe('/chats/c0');
    click(button(`Show all ${RECENT_CHATS + 3}`));
    expect(titles()).toHaveLength(RECENT_CHATS + 3);
    // The active thread is marked as the current page.
    const active = [...document.querySelectorAll('[data-thread-title]')]
        .find((element) => element.textContent === 'Chat 0')
        ?.closest('a');
    expect(active?.getAttribute('aria-current')).toBe('page');
});

it('keeps the selected chat visible beyond the cap', () => {
    render({
        workspace: workspace('admin', RECENT_CHATS + 3),
        at: `/chats/c${RECENT_CHATS + 2}`,
    });
    const titles = [...document.querySelectorAll('[data-thread-title]')].map((element) => element.textContent);
    expect(titles).toHaveLength(RECENT_CHATS + 1);
    expect(titles).toContain(`Chat ${RECENT_CHATS + 2}`);
});

it('asks for setup instead of listing chats when chat is not configured', () => {
    render({ configured: false });
    expect(document.body.textContent).toContain('Set up text chat to begin a persistent conversation.');
    expect(button('New chat')?.hasAttribute('disabled')).toBe(true);
    expect(byLabel('New conversation')).toBeNull();
});

it('highlights a plugin on its deep links, and only its own (CB-446)', () => {
    const space = workspace('admin');
    space.plugins = ['planner', 'plan'].map((id) => ({
        id,
        name: id === 'planner' ? 'Planner' : 'Plan',
        description: '',
        display: 'embed' as const,
        mode: 'service' as const,
        openAllow: [],
        openAnyHttps: false,
        routes: true,
        origin: `https://${id}.apps.example`,
        entryPath: '/',
    }));
    for (const at of ['/plugins/planner', '/plugins/planner/', '/plugins/planner/events/42?tab=a#b']) {
        render({ workspace: space, at, activeDotId: undefined });
        expect(button('Planner')?.getAttribute('aria-current'), at).toBe('page');
        expect(button('Planner')?.getAttribute('data-active'), at).toBe('true');
        expect(button('Plan')?.getAttribute('aria-current'), at).toBeNull();
        act(() => root.unmount());
        root = createRoot(host);
    }
    // A plugin's settings page is not the plugin.
    render({ workspace: space, at: '/settings/plugins/planner', activeDotId: undefined });
    expect(button('Planner')?.getAttribute('aria-current')).toBeNull();
});

it('opens Spaces by link and highlights the open one', () => {
    render({ at: '/spaces/s2', activeDotId: undefined });
    const engineering = button('Engineering');
    expect(engineering?.getAttribute('href')).toBe('/spaces/s2');
    expect(engineering?.getAttribute('aria-current')).toBe('page');
    expect(button('Socio')?.getAttribute('aria-current')).toBeNull();
    click(button('Everyday'));
    expect(path).toBe('/spaces/s1');
    expect(button('Everyday')?.getAttribute('aria-current')).toBe('page');
    expect(engineering?.getAttribute('aria-current')).toBeNull();
    expect(byLabel('Expand Everyday')?.getAttribute('aria-expanded')).toBe('false');
});

it('collapses with the toggle and Ctrl+B, but not from a rich-text editor', () => {
    render();
    const state = () => document.querySelector('[data-slot="sidebar"]')?.getAttribute('data-state');
    click(byLabel('Collapse sidebar'));
    expect(state()).toBe('collapsed');
    expect(document.cookie).toContain('sidebar_state=false');
    expect(byLabel('Expand sidebar')).not.toBeNull();
    act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true }));
    });
    expect(state()).toBe('expanded');
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    // jsdom does not implement isContentEditable.
    Object.defineProperty(editor, 'isContentEditable', { value: true });
    document.body.append(editor);
    act(() => {
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }));
    });
    expect(state()).toBe('expanded');
    // A key the page already handled (e.g. bold in a field) is left alone too.
    const handled = new KeyboardEvent('keydown', {
        key: 'b',
        metaKey: true,
        cancelable: true,
    });
    handled.preventDefault();
    act(() => {
        window.dispatchEvent(handled);
    });
    expect(state()).toBe('expanded');
    editor.remove();
});

it('has Report issue in the account menu, for the page’s module (CB-66b)', () => {
    let request: ReturnType<typeof useReportRequest>;
    function Probe() {
        request = useReportRequest();
        return null;
    }
    const probe = createRoot(document.createElement('div'));
    act(() => probe.render(<Probe />));
    render({ role: 'member', moduleId: 'runs' });
    act(() => {
        byLabel('Account: Bob')!.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
                cancelable: true,
            }),
        );
    });
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) => item.textContent);
    // Above Account and Switch user; on phones it is the only one.
    expect(items.indexOf('Report issue')).toBeGreaterThanOrEqual(0);
    expect(items.indexOf('Report issue')).toBeLessThan(items.indexOf('Switch user'));
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (element) => element.textContent === 'Report issue',
    )!;
    click(item);
    expect(request?.draft).toEqual({ area: 'runs' });
    act(() => closeReport());
    act(() => probe.unmount());
});

it('asks for the passkey list only after a sign-in without one (CB-68)', async () => {
    const methods: SignInMethods = {
        passkey: true,
        password: true,
        signUp: false,
        emailReset: false,
        signInLink: false,
        providers: [],
    };
    const requests: string[] = [];
    let passkeys: unknown[] = [];
    vi.stubGlobal('fetch', async (input: string) => {
        requests.push(new URL(input, 'http://app.test').pathname);
        return new Response(JSON.stringify(passkeys), {
            headers: { 'Content-Type': 'application/json' },
        });
    });
    const settle = () => act(() => new Promise((done) => setTimeout(done, 20)));
    const prompt = () => byLabel('Add a passkey');
    const list = '/api/auth/passkey/list-user-passkeys';
    try {
        // An ordinary page load: no request, no suggestion.
        render({ methods });
        await settle();
        expect(requests).not.toContain(list);
        expect(prompt()).toBeNull();
        // Just signed in by password: asked once, and suggested.
        sessionStorage.setItem(PASSKEY_CHECK_KEY, 'pending');
        act(() => root.unmount());
        root = createRoot(host);
        render({ methods });
        await settle();
        expect(requests.filter((path) => path === list)).toHaveLength(1);
        expect(prompt()).toBeTruthy();
        // Reloads keep the suggestion without asking again.
        for (let reload = 0; reload < 3; reload++) {
            act(() => root.unmount());
            root = createRoot(host);
            render({ methods });
            await settle();
            expect(prompt()).toBeTruthy();
        }
        expect(requests.filter((path) => path === list)).toHaveLength(1);
        // Someone who has a passkey isn't asked again after the check.
        passkeys = [{ id: 'p1' }];
        sessionStorage.setItem(PASSKEY_CHECK_KEY, 'pending');
        act(() => root.unmount());
        root = createRoot(host);
        render({ methods });
        await settle();
        expect(prompt()).toBeNull();
        act(() => root.unmount());
        root = createRoot(host);
        render({ methods });
        await settle();
        expect(requests.filter((path) => path === list)).toHaveLength(2);
    } finally {
        sessionStorage.clear();
        vi.unstubAllGlobals();
    }
});

it('shows the client identity, and the server version in the account row for everyone (CB-308)', () => {
    const ctx = context();
    ctx.state.settings.branding = {
        name: 'Acme Company Brain',
        logo: '/acme.png',
    };
    ctx.state.version = '0.12.1';
    ctx.workspace.user = { ...ctx.workspace.user, role: 'member' };
    render({ context: ctx });
    const home = byLabel('Acme Company Brain home');
    expect(home?.textContent).toBe('Acme Company Brain');
    expect(home?.querySelector('[data-slot=server-version]')).toBeNull();
    expect(home?.querySelector('img')?.getAttribute('src')).toBe('/acme.png');
    const account = document.querySelector<HTMLElement>('[aria-label^="Account: "]');
    expect(account?.textContent).toContain('Member · v0.12.1');
    expect(account?.querySelector('[data-slot=server-version]')?.textContent).toBe('v0.12.1');
    // The connection's dot sits beside the account row, not inside it.
    const dot = document.querySelector('[data-slot=connection-dot]');
    expect(dot?.getAttribute('aria-label')).toMatch(/^Connection: /);
    expect(account?.contains(dot!)).toBe(false);
    expect(host.textContent).not.toContain('Self-hosted');
});
