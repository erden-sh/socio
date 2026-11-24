// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { PRESENCE_AWAY_PATH, PRESENCE_HEADER, PRESENCE_INPUT_MS } from '@socio/shared/notifications';

// CB-114: each tab says on its /api/state poll whether it is in use
// (visible, focused, input in the last minute), and sends a beacon when it
// is hidden or closed.

let visibility: DocumentVisibilityState = 'visible';
let focused = true;
const beacon = vi.fn((_url: string, _data?: BodyInit | null) => true);
let stop: (() => void) | undefined;

beforeEach(() => {
    vi.resetModules();
    sessionStorage.clear();
    visibility = 'visible';
    focused = true;
    beacon.mockClear();
    Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => visibility,
    });
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    Object.defineProperty(navigator, 'sendBeacon', {
        configurable: true,
        value: beacon,
    });
    history.replaceState(null, '', '/chats/c1');
});
afterEach(() => {
    stop?.();
    stop = undefined;
    vi.restoreAllMocks();
});

/** A fresh copy of the module, with input watched on a clock the test sets. */
async function load(start = 1_000_000) {
    stop?.();
    const presence = await import('../src/shell/presence');
    let now = start;
    stop = presence.installPresence(() => now);
    return {
        ...presence,
        at: (time: number) => {
            now = time;
        },
    };
}
const input = (type: string) => document.dispatchEvent(new Event(type, { bubbles: true }));

it('keeps one tab id per tab, over a reload, in the form the server takes', async () => {
    const first = await load();
    const tab = first.presenceTab();
    expect(tab).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(first.presenceTab()).toBe(tab);
    vi.resetModules();
    // A reload: a new copy of the module, the same session storage.
    const again = await load();
    expect(again.presenceTab()).toBe(tab);
    sessionStorage.clear();
    vi.resetModules();
    expect((await load()).presenceTab()).not.toBe(tab);
});

it('reports the path while visible, focused and touched in the last minute', async () => {
    const presence = await load();
    const tab = presence.presenceTab();
    // Nothing typed or clicked yet.
    expect(presence.presenceHeader(1_000_000)).toBe(`${tab} -`);
    for (const type of ['keydown', 'pointerdown', 'touchstart', 'wheel', 'scroll']) {
        presence.at(2_000_000);
        input(type);
        expect(presence.presenceHeader(2_000_000 + 1000), type).toBe(`${tab} /chats/c1`);
    }
    expect(presence.presenceHeaders(2_000_000)).toEqual({
        [PRESENCE_HEADER]: `${tab} /chats/c1`,
    });
    // A minute without input.
    expect(presence.presenceHeader(2_000_000 + PRESENCE_INPUT_MS)).toBe(`${tab} -`);
});

it('says "-" while hidden or unfocused, even right after input', async () => {
    const presence = await load();
    const tab = presence.presenceTab();
    presence.at(5000);
    input('keydown');
    focused = false;
    expect(presence.presenceHeader(5001)).toBe(`${tab} -`);
    focused = true;
    visibility = 'hidden';
    expect(presence.presenceHeader(5001)).toBe(`${tab} -`);
    visibility = 'visible';
    expect(presence.presenceHeader(5001)).toBe(`${tab} /chats/c1`);
});

it('catches a scroll inside a panel (it does not bubble)', async () => {
    const presence = await load();
    const panel = document.createElement('div');
    document.body.append(panel);
    presence.at(7000);
    panel.dispatchEvent(new Event('scroll'));
    expect(presence.presenceHeader(7001)).toMatch(/ \/chats\/c1$/);
    panel.remove();
});

it('sends the away beacon when hidden and on pagehide', async () => {
    const presence = await load();
    const tab = presence.presenceTab();
    // Shown again: nothing.
    document.dispatchEvent(new Event('visibilitychange'));
    expect(beacon).not.toHaveBeenCalled();
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(beacon).toHaveBeenCalledTimes(1);
    const [url, body] = beacon.mock.calls[0]!;
    expect(url).toBe(PRESENCE_AWAY_PATH);
    expect(body).toBeInstanceOf(Blob);
    expect((body as Blob).type).toBe('application/json');
    expect(JSON.parse(await (body as Blob).text())).toEqual({ tab });
    window.dispatchEvent(new Event('pagehide'));
    expect(beacon).toHaveBeenCalledTimes(2);
});

it('stops listening when stopped', async () => {
    const presence = await load();
    stop!();
    stop = undefined;
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(beacon).not.toHaveBeenCalled();
    visibility = 'visible';
    input('keydown');
    expect(presence.presenceHeader()).toMatch(/ -$/);
});
