// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { useDraftGuard } from '../src/modules/chat/use-draft-guard';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

// A shell with the guard, and a page that reports an unsaved draft.
let dirty = false;
let setDirty: (value: boolean) => void = () => {};
function Shell() {
    setDirty = useDraftGuard().setDirty;
    return <Outlet />;
}
function Draft() {
    useEffect(() => {
        setDirty(dirty);
        return () => setDirty(false);
    }, []);
    return <p>editing</p>;
}

let root: Root;
let confirm: ReturnType<typeof vi.fn>;
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    root = createRoot(document.createElement('div'));
});
afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
});

function start(withDraft: boolean) {
    dirty = withDraft;
    const router = createMemoryRouter(
        [
            {
                path: '/',
                element: <Shell />,
                children: [
                    { index: true, element: <p>home</p> },
                    { path: 'spaces/s1/pages/:pageId', element: <Draft /> },
                    { path: 'memories', element: <p>memories</p> },
                ],
            },
        ],
        { initialEntries: ['/', '/spaces/s1/pages/p1'], initialIndex: 1 },
    );
    act(() => root.render(<RouterProvider router={router} />));
    return router;
}
const at = (router: ReturnType<typeof createMemoryRouter>) => router.state.location.pathname;

it('asks before leaving an unsaved draft, and stays when told to', async () => {
    const router = start(true);
    await act(() => router.navigate('/memories'));
    expect(confirm).toHaveBeenCalledWith('Leave your unsaved page draft?');
    expect(at(router)).toBe('/spaces/s1/pages/p1');
    // Back and forward are navigations too.
    await act(() => router.navigate(-1));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(at(router)).toBe('/spaces/s1/pages/p1');
    // A hash on the same page isn't leaving it.
    await act(() => router.navigate('/spaces/s1/pages/p1#notes'));
    expect(confirm).toHaveBeenCalledTimes(2);
    // Agreeing leaves, once.
    confirm.mockReturnValue(true);
    await act(() => router.navigate('/memories'));
    expect(at(router)).toBe('/memories');
    expect(confirm).toHaveBeenCalledTimes(3);
    await act(() => router.navigate(-1));
    expect(confirm).toHaveBeenCalledTimes(3);
});

it('never asks without unsaved changes', async () => {
    const router = start(false);
    await act(() => router.navigate('/memories'));
    await act(() => router.navigate(-1));
    expect(at(router)).toBe('/spaces/s1/pages/p1');
    expect(confirm).not.toHaveBeenCalled();
});

it('asks the browser to confirm a reload or close with unsaved changes', async () => {
    start(true);
    const leave = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(true);
    act(() => setDirty(false));
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
});
