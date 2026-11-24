import { describe, expect, it } from 'vitest';

import {
    chatOnScreen,
    createPushTaps,
    followLaunchTaps,
    isOnScreen,
    notificationTarget,
    parsePushTarget,
    type PushTapDeps,
    type PushTarget,
    switchedText,
    UNKNOWN_WORKSPACE_TEXT,
} from '../../src/push';

// Notification taps: the workspace beside the
// path, a switch first when it names another, once per tap, and the
// foreground's rule for the chat on screen.

const ACME = 'ws-acme';
const BETA = 'ws-beta';

const target = (workspaceId: string, link: string, tag: string | null = null): PushTarget => ({
    workspaceId,
    link,
    tag,
});

function phone(active: string | null, names: Record<string, string> = { [ACME]: 'Acme', [BETA]: 'Beta' }) {
    const state = { active };
    const log: string[] = [];
    const deps: PushTapDeps = {
        active: () => state.active,
        workspace: async (id) => (id in names ? { name: names[id]! } : null),
        switchTo: async (id) => {
            log.push(`switch ${id}`);
            await Promise.resolve();
            state.active = id;
        },
        open: (path) => log.push(`open ${path}`),
        say: (text) => log.push(`say ${text}`),
        generic: () => log.push('generic'),
        onError: (error) => log.push(`error ${String(error)}`),
    };
    return { state, log, taps: createPushTaps(deps), deps };
}

describe('a notification tap', () => {
    it("opens the open workspace's path, with no switch and nothing said", async () => {
        const { taps, log } = phone(ACME);
        await taps.tap(target(ACME, '/chats/room-1', 'room-1'));
        expect(log).toEqual(['open /chats/room-1']);
    });

    it('switches to another workspace first, says so, then opens the path', async () => {
        const { taps, log, state } = phone(ACME);
        await taps.tap(target(BETA, '/chats/room-2', 'room-2'));
        expect(log).toEqual([`switch ${BETA}`, `say ${switchedText('Beta')}`, 'open /chats/room-2']);
        expect(state.active).toBe(BETA);
        expect(switchedText('Beta')).toBe('Switched to Beta');
    });

    it('switches with no workspace open (the lock screen, Add workspace)', async () => {
        const { taps, log } = phone(null);
        await taps.tap(target(ACME, '/'));
        expect(log).toEqual([`switch ${ACME}`, 'say Switched to Acme', 'open /']);
    });

    it("opens nothing for a workspace that isn't on the phone, and says so", async () => {
        const { taps, log, state } = phone(ACME);
        await taps.tap(target('ws-gone', '/chats/x', 'x'));
        expect(log).toEqual([`say ${UNKNOWN_WORKSPACE_TEXT}`]);
        expect(state.active).toBe(ACME);
    });

    it('opens nothing when another switch won while it switched', async () => {
        const { taps, log, deps, state } = phone(ACME);
        const switching = deps.switchTo;
        (deps as { switchTo: PushTapDeps['switchTo'] }).switchTo = async (id) => {
            await switching(id);
            state.active = ACME;
        };
        await createPushTaps(deps).tap(target(BETA, '/chats/b'));
        expect(log).toEqual([`switch ${BETA}`]);
        await taps.tap(target(ACME, '/chats/a'));
        expect(log.at(-1)).toBe('open /chats/a');
    });

    it("with no target (the relay's generic text) opens nothing and pulls the notices", async () => {
        const { taps, log } = phone(ACME);
        await taps.tap(null);
        expect(log).toEqual(['generic']);
    });

    it("is handled once per key: a cold start's response handed over twice opens once", async () => {
        const { taps, log } = phone(ACME);
        const tap = target(BETA, '/chats/room-2', 'room-2');
        await Promise.all([taps.tap(tap, 'notification-1'), taps.tap(tap, 'notification-1')]);
        await taps.tap(tap, 'notification-1');
        expect(log.filter((line) => line.startsWith('open'))).toEqual(['open /chats/room-2']);
        expect(log.filter((line) => line.startsWith('switch'))).toHaveLength(1);
        // Another notification with the same target is another tap.
        await taps.tap(tap, 'notification-2');
        expect(log.filter((line) => line.startsWith('open'))).toHaveLength(2);
    });

    it('runs taps one at a time, in order', async () => {
        const { taps, log } = phone(ACME);
        void taps.tap(target(BETA, '/chats/b'));
        await taps.tap(target(ACME, '/chats/a'));
        expect(log).toEqual([
            `switch ${BETA}`,
            'say Switched to Beta',
            'open /chats/b',
            `switch ${ACME}`,
            'say Switched to Acme',
            'open /chats/a',
        ]);
    });

    it('never rejects: a failed switch is reported and the next tap still runs', async () => {
        const { deps, log } = phone(ACME);
        const taps = createPushTaps({
            ...deps,
            switchTo: () => Promise.reject(new Error('no scope')),
        });
        await expect(taps.tap(target(BETA, '/chats/b'))).resolves.toBeUndefined();
        await taps.tap(target(ACME, '/chats/a'));
        expect(log).toEqual(['error Error: no scope', 'open /chats/a']);
    });
});

describe("a notification's target", () => {
    it('takes the workspace, a web path and the tag, and nothing else', () => {
        expect(parsePushTarget({ workspaceId: ACME, link: '/chats/a', tag: 'a', title: 'x' })).toEqual(
            target(ACME, '/chats/a', 'a'),
        );
        expect(parsePushTarget({ workspaceId: ACME, link: '/' })).toEqual(target(ACME, '/'));
        expect(parsePushTarget({ workspaceId: ACME, link: '/', tag: '' })).toEqual(target(ACME, '/'));
    });

    it.each([
        ['no workspace', { link: '/' }],
        ['a workspace id that is no id', { workspaceId: '../x', link: '/' }],
        ['a URL', { workspaceId: ACME, link: 'https://evil.example/chats/a' }],
        ['a protocol-relative link', { workspaceId: ACME, link: '//evil.example' }],
        ['a scheme link', { workspaceId: ACME, link: 'socio://w/ws-beta/chats/a' }],
        ['a tag that is no string', { workspaceId: ACME, link: '/', tag: 3 }],
        ['an array', [ACME, '/']],
        ['nothing', null],
    ])('refuses %s', (_, value) => {
        expect(parsePushTarget(value)).toBeNull();
    });

    it("reads a remote notification's whole userInfo, and a local one's data (iOS)", () => {
        const socio = { workspaceId: ACME, link: '/chats/a', tag: 'a' };
        expect(
            notificationTarget({ content: { data: null }, trigger: { type: 'push', payload: { aps: {}, socio } } }),
        ).toEqual(target(ACME, '/chats/a', 'a'));
        expect(notificationTarget({ content: { data: { socio } }, trigger: null })).toEqual(
            target(ACME, '/chats/a', 'a'),
        );
        // Before the extension rewrites it (or when it failed): the relay's payload, no target.
        expect(
            notificationTarget({ content: { data: null }, trigger: { type: 'push', payload: { s: 'r', p: 'x' } } }),
        ).toBeNull();
        expect(notificationTarget(undefined)).toBeNull();
    });
});

describe('the chat on screen', () => {
    it('is only a chat or room path, in the open workspace', () => {
        expect(chatOnScreen(ACME, '/chats/a')).toEqual({ workspaceId: ACME, path: '/chats/a' });
        // An invite links to `/`: Home must not swallow it.
        expect(chatOnScreen(ACME, '/')).toBeNull();
        expect(chatOnScreen(ACME, '/settings')).toBeNull();
        expect(chatOnScreen(null, '/chats/a')).toBeNull();
    });

    it("hides only that chat's notification in the foreground (iOS's handler)", () => {
        const screen = chatOnScreen(ACME, '/chats/room%201');
        expect(isOnScreen(target(ACME, '/chats/room%201', 'room 1'), screen)).toBe(true);
        expect(isOnScreen(target(ACME, '/chats/room%201#message-9', 'room 1'), screen)).toBe(true);
        expect(isOnScreen(target(ACME, '/chats/other', 'other'), screen)).toBe(false);
        expect(isOnScreen(target(BETA, '/chats/room%201', 'room 1'), screen)).toBe(false);
        expect(isOnScreen(target(ACME, '/'), screen)).toBe(false);
        expect(isOnScreen(null, screen)).toBe(false);
        expect(isOnScreen(target(ACME, '/chats/a'), null)).toBe(false);
    });
});

describe("Android's tap on the activity's intent", () => {
    function android(initial = 'active') {
        const listeners = new Set<(state: string) => void>();
        const state = { now: initial, intent: null as PushTarget | null, takes: 0 };
        const tapped: PushTarget[] = [];
        const stop = followLaunchTaps({
            take: async () => {
                state.takes += 1;
                const tap = state.intent;
                state.intent = null;
                return tap;
            },
            tapped: (tap) => tapped.push(tap),
            appState: {
                current: () => state.now,
                subscribe(listener) {
                    listeners.add(listener);
                    return () => listeners.delete(listener);
                },
            },
        });
        const move = async (next: string) => {
            state.now = next;
            for (const listener of [...listeners]) {
                listener(next);
            }
            await Promise.resolve();
            await Promise.resolve();
        };
        return { state, tapped, move, stop, listeners };
    }

    it('takes the launch tap once at start', async () => {
        const { state, tapped, move } = android();
        await move('active');
        expect(state.takes).toBe(1);
        expect(tapped).toEqual([]);
    });

    it('takes a tap that recreated the activity in a live process on the return to active', async () => {
        const { state, tapped, move } = android();
        await move('background');
        state.intent = target(BETA, '/chats/b', 'b');
        await move('active');
        expect(tapped).toEqual([target(BETA, '/chats/b', 'b')]);
        // Taken once: the next return finds nothing.
        await move('background');
        await move('active');
        expect(tapped).toHaveLength(1);
        expect(state.takes).toBe(3);
    });

    it('stops following when unsubscribed', async () => {
        const { state, move, stop, listeners } = android('background');
        stop();
        expect(listeners.size).toBe(0);
        await move('active');
        expect(state.takes).toBe(1);
    });
});
