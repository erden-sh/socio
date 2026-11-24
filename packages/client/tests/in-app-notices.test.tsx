// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { InAppNotice } from '@socio/shared/notifications';

// CB-114: a Dot's notification while its person is in the brain shows as
// a toast in the tab they look at, once, and is then marked seen.

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const toast = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast }));
const { useInAppNotices, SHOWN_NOTICES_KEY } = await import('../src/shell/in-app-notices');

const notice = (id: string, link = `/chats/${id}`): InAppNotice => ({
    id,
    title: `Scout: ${id}`,
    body: `Body ${id}`,
    link,
    createdAt: 1,
});

let root: Root;
let host: HTMLElement;
let visibility: DocumentVisibilityState = 'visible';
let seen: string[][] = [];
const open = vi.fn();

function Probe({ notices }: { notices?: InAppNotice[] }) {
    useInAppNotices(notices, open);
    return null;
}
const render = (notices?: InAppNotice[]) =>
    act(async () => {
        root.render(<Probe notices={notices} />);
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

beforeEach(() => {
    toast.mockClear();
    open.mockClear();
    localStorage.clear();
    seen = [];
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => visibility,
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        if (String(url) === '/api/notifications/in-app/seen') {
            seen.push((JSON.parse(String(init?.body)) as { ids: string[] }).ids);
        }
        return Response.json({ ok: true });
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
});

it('shows each notice once, with Open, and marks them seen', async () => {
    await render([notice('n1'), notice('n2')]);
    expect(toast).toHaveBeenCalledTimes(2);
    const [title, options] = toast.mock.calls[0]!;
    expect(title).toBe('Scout: n1');
    expect(options).toMatchObject({
        id: 'in-app-n1',
        description: 'Body n1',
        action: { label: 'Open' },
    });
    (options as { action: { onClick: () => void } }).action.onClick();
    expect(open).toHaveBeenCalledWith('/chats/n1');
    expect(seen).toEqual([['n1', 'n2']]);

    // The next poll, before the server dropped them, and a re-render.
    await render([notice('n1'), notice('n2')]);
    await render([notice('n1'), notice('n2'), notice('n3')]);
    expect(toast).toHaveBeenCalledTimes(3);
    expect(toast.mock.calls[2]![0]).toBe('Scout: n3');
    expect(seen).toEqual([['n1', 'n2'], ['n3']]);
    await render([]);
    await render(undefined);
    expect(toast).toHaveBeenCalledTimes(3);
});

it('leaves them to the tab in view, and shows them once this one is', async () => {
    visibility = 'hidden';
    await render([notice('n1')]);
    expect(toast).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
    visibility = 'visible';
    await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([['n1']]);
});

it('does not show one another tab of this browser already showed', async () => {
    localStorage.setItem(SHOWN_NOTICES_KEY, JSON.stringify(['n1']));
    await render([notice('n1'), notice('n2')]);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0]![0]).toBe('Scout: n2');
    // Still marked seen, in case the other tab's mark was lost.
    expect(seen).toEqual([['n1', 'n2']]);
    expect(JSON.parse(localStorage.getItem(SHOWN_NOTICES_KEY)!)).toEqual(['n1', 'n2']);
});

it('opens only paths in the brain', async () => {
    await render([notice('n1', 'https://evil.example/'), notice('n2', '//x')]);
    for (const [, options] of toast.mock.calls) {
        (options as { action: { onClick: () => void } }).action.onClick();
    }
    expect(open.mock.calls).toEqual([['/'], ['/']]);
});
