// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { WorkspaceState } from '@socio/shared/types';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// CB-171: the App's sign-out warning. It belongs to the session it was
// opened in: when the session ends some other way, it must not come back
// over the next person's shell.
vi.mock('../src/shell/AppShell', () => ({
    AppShell: ({ onSwitchUser, onSessionEnded }: { onSwitchUser: () => void; onSessionEnded: () => void }) => (
        <>
            <button data-testid="sign-out" onClick={onSwitchUser}>
                Sign out
            </button>
            <button data-testid="revoked" onClick={onSessionEnded}>
                Revoked
            </button>
        </>
    ),
}));
vi.mock('../src/shell/SignIn', () => ({
    SignIn: () => <p data-testid="sign-in">Sign in</p>,
}));
vi.mock('@copilotkit/react-core/v2', () => ({
    CopilotKitProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('../src/shell/auth-client', () => ({
    authSession: () => new Promise(() => {}),
}));

const { App } = await import('../src/shell/App');
const { writeDraft } = await import('../src/modules/chat/chat-drafts');
const { closeAuthChannel } = await import('../src/shell/auth-channel');

const workspace = (id: string) =>
    ({
        user: { id, name: id },
        dots: [{ id: 'd1', name: 'Mingo', archivedAt: undefined }],
        conversations: [],
        archived: [],
        setup: { missing: [] },
    }) as unknown as WorkspaceState;
const signedIn = (id: string) => ({
    session: 'signed-in',
    state: {},
    workspace: workspace(id),
});

let root: Root;
let host: HTMLElement;
let data: unknown;
beforeEach(() => {
    localStorage.clear();
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    closeAuthChannel();
    vi.restoreAllMocks();
});

const mount = async () => {
    const router = createMemoryRouter([{ path: '/', loader: () => data, element: <App /> }], { initialEntries: ['/'] });
    await act(async () => root.render(<RouterProvider router={router} />));
    return router;
};
const warning = () => document.querySelector('[data-slot="unsent-drafts-warning"]');
const click = (selector: string) => act(async () => document.querySelector<HTMLElement>(selector)!.click());

it('asks first when there is a recent draft', async () => {
    data = signedIn('u1');
    await mount();
    writeDraft('u1', 'new:d1', 'half a thought');
    await click('[data-testid="sign-out"]');
    expect(warning()?.textContent).toContain('1 unsent draft');
});

it('does not bring the warning back after another tab signed out', async () => {
    data = signedIn('u2');
    const router = await mount();
    writeDraft('u2', 'new:d1', 'another thought');
    await click('[data-testid="sign-out"]');
    expect(warning()).not.toBeNull();

    // Another tab signs out: this one shows sign-in at once.
    const other = new BroadcastChannel('socio:auth');
    await act(async () => {
        other.postMessage('signed-out');
        await new Promise((resolve) => setTimeout(resolve, 20));
    });
    other.close();
    expect(document.querySelector('[data-testid="sign-in"]')).not.toBeNull();
    expect(warning()).toBeNull();

    // The next person signs in on this tab: the shell, and no warning.
    data = signedIn('u3');
    await act(async () => router.revalidate());
    expect(document.querySelector('[data-testid="sign-out"]')).not.toBeNull();
    expect(warning()).toBeNull();
});

it('does not warn after the session was revoked elsewhere (sign out everywhere)', async () => {
    data = signedIn('u4');
    await mount();
    writeDraft('u4', 'new:d1', 'a draft');
    await click('[data-testid="revoked"]');
    expect(warning()).toBeNull();
});

it('drops the warning when loader data for another person arrives', async () => {
    data = signedIn('a1');
    const router = await mount();
    writeDraft('a1', 'new:d1', 'a1 draft');
    await click('[data-testid="sign-out"]');
    expect(warning()).not.toBeNull();
    data = signedIn('b1');
    await act(async () => router.revalidate());
    expect(document.querySelector('[data-testid="sign-out"]')).not.toBeNull();
    expect(warning()).toBeNull();
});
