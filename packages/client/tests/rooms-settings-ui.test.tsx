// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', () => ({ api: vi.fn() }));
import { api } from '../src/lib/api';
import { RoomsSetting, useReadinessLine } from '../src/modules/settings/RoomsSetting';

// Settings → General → Rooms (CB-207): off by default, admins switch it.

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    vi.mocked(api).mockReset();
    // The checkbox measures itself (Radix).
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
});

const render = (readOnly: boolean, mutate = vi.fn(async () => true)) =>
    act(async () => root.render(<RoomsSetting settings={undefined} readOnly={readOnly} mutate={mutate} />));
const box = () => host.querySelector<HTMLButtonElement>('[role="checkbox"]')!;

it('shows members the switch, off, with no way to change it or read the counts', async () => {
    await render(true);
    expect(box().getAttribute('aria-checked')).toBe('false');
    expect(box().disabled).toBe(true);
    expect(host.textContent).toContain('Only an admin can change this setting.');
    expect(api).not.toHaveBeenCalled();
    expect(host.querySelector('[data-slot="rooms-readiness"]')).toBeNull();
});

it('lets an admin see that every chat is private, then turn Rooms on', async () => {
    vi.mocked(api).mockResolvedValue({
        enabled: false,
        conversations: { private: 1200, room: 0 },
        allPrivate: true,
    });
    const mutate = vi.fn(async () => true);
    await render(false, mutate);
    expect(api).toHaveBeenCalledWith('/rooms/readiness', 'GET', undefined, expect.any(AbortSignal));
    expect(host.querySelector('[data-slot="rooms-readiness"]')!.textContent).toBe(
        '1,200 chats, all private. Turning Rooms on changes none of them.',
    );
    // The label is the checkbox's: a click or Space on it toggles it.
    await act(async () => box().click());
    expect(box().getAttribute('aria-checked')).toBe('true');
    // It saves as it is checked, no Save button (CB-308).
    expect(host.querySelector('[data-slot="save-status"]')!.textContent).toBe('Saved');
    expect(mutate).toHaveBeenCalledWith('/settings', 'PATCH', {
        rooms: { enabled: true, budgetVisible: false },
    });
});

it('lets an admin show members their room’s use and limits (CB-218)', async () => {
    vi.mocked(api).mockResolvedValue({
        enabled: true,
        conversations: { private: 1, room: 1 },
        allPrivate: false,
    });
    const mutate = vi.fn(async () => true);
    await render(false, mutate);
    const usage = host.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')[1]!;
    expect(usage.getAttribute('aria-checked')).toBe('false');
    expect(host.textContent).toContain('Members see their room’s use and limits');
    await act(async () => usage.click());
    expect(mutate).toHaveBeenCalledWith('/settings', 'PATCH', {
        rooms: { enabled: false, budgetVisible: true },
    });
});

/** What a hook returns, from a component rendered once on its own root. */
function hook<T>(use: () => T): T {
    let value: T | undefined;
    function Probe() {
        value = use();
        return null;
    }
    const probe = createRoot(document.createElement('div'));
    act(() => probe.render(<Probe />));
    act(() => probe.unmount());
    return value as T;
}

it('counts rooms once there are some', () => {
    const readinessLine = hook(useReadinessLine);
    expect(
        readinessLine({
            enabled: true,
            conversations: { private: 1, room: 2 },
            allPrivate: false,
        }),
    ).toBe('1 chat private, 2 rooms. Private chats keep their readers either way.');
});
