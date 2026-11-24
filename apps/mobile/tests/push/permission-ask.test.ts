import { describe, expect, it } from 'vitest';

import type { PushDevice } from '../../src/data/registry';
import {
    ASK_TEXT,
    type AskInput,
    askDecision,
    createNotificationAsk,
    effectivePermission,
    NOT_NOW_MS,
    notificationsDenied,
    type NotificationAskDeps,
    settingsRow,
} from '../../src/push/permission-ask';
import type { PushPermission } from '../../src/push/subscription';

// The notification ask: its rules with an injected clock, and the
// manager over a fake registry, permission and system prompt.

const T0 = Date.UTC(2026, 10, 9, 12);
const DAY = 24 * 60 * 60 * 1000;

const ready: AskInput = {
    firstLaunch: false,
    foreground: true,
    availability: 'available',
    permission: 'undetermined',
    declinedAt: null,
    showing: false,
    now: T0,
};

describe('askDecision', () => {
    it('asks in the foreground, past the first launch, while the phone can still prompt', () => {
        expect(askDecision(ready)).toEqual({ kind: 'ask' });
    });

    it.each([
        [{ firstLaunch: true }, 'first-launch'],
        [{ foreground: false }, 'background'],
        [{ availability: 'build' }, 'build'],
        [{ availability: 'unknown' }, 'unknown'],
        [{ permission: null }, 'unknown'],
        [{ permission: 'granted' }, 'granted'],
        [{ permission: 'denied' }, 'denied'],
        [{ showing: true }, 'showing'],
    ] as const)('skips with %o: %s', (change, reason) => {
        expect(askDecision({ ...ready, ...change })).toEqual({ kind: 'skip', reason });
    });

    it('a Personal Team build never asks, whatever else holds', () => {
        expect(askDecision({ ...ready, availability: 'build', firstLaunch: true, permission: 'denied' })).toEqual({
            kind: 'skip',
            reason: 'build',
        });
    });

    it('holds the ask for NOT_NOW_MS after Not now, then asks again', () => {
        expect(askDecision({ ...ready, declinedAt: T0, now: T0 + DAY })).toEqual({ kind: 'skip', reason: 'not-now' });
        expect(askDecision({ ...ready, declinedAt: T0, now: T0 + NOT_NOW_MS - 1 })).toEqual({
            kind: 'skip',
            reason: 'not-now',
        });
        expect(askDecision({ ...ready, declinedAt: T0, now: T0 + NOT_NOW_MS })).toEqual({ kind: 'ask' });
    });

    it('a clock set back since Not now never holds the ask forever', () => {
        expect(askDecision({ ...ready, declinedAt: T0, now: T0 - DAY })).toEqual({ kind: 'ask' });
    });
});

describe('settingsRow', () => {
    it('says Turn on notifications before any ask, with the ask’s words', () => {
        expect(settingsRow('available', 'undetermined')).toMatchObject({
            kind: 'turn-on',
            title: 'Turn on notifications',
            subtitle: ASK_TEXT,
        });
    });

    it('sends a denied phone to its Settings, the Inbox too', () => {
        expect(settingsRow('available', 'denied')).toMatchObject({ kind: 'denied', title: 'Notifications are off' });
        expect(notificationsDenied({ availability: 'available', permission: 'denied' })).toBe(true);
        expect(notificationsDenied({ availability: 'available', permission: 'undetermined' })).toBe(false);
        expect(notificationsDenied({ availability: 'build', permission: 'denied' })).toBe(false);
    });

    it('says a Personal Team build can’t have them', () => {
        expect(settingsRow('build', null)).toMatchObject({
            kind: 'unavailable',
            title: 'Notifications aren’t available in this build',
        });
    });

    it('shows nothing while unknown or on', () => {
        expect(settingsRow('unknown', 'undetermined')).toBeNull();
        expect(settingsRow('available', null)).toBeNull();
        expect(settingsRow('available', 'granted')).toBeNull();
    });

    it('names only what arrives before approvals are pushed', () => {
        expect(ASK_TEXT).toBe(
            'Get told when someone mentions you, a socio replies in a room, or a socio sends a report.',
        );
    });
});

describe('effectivePermission', () => {
    it('takes Android’s denied before any prompt as undetermined', () => {
        expect(effectivePermission({ status: 'denied', canAskAgain: true }, null)).toBe('undetermined');
    });

    it('keeps denied once the app prompted, or when the phone can’t ask again', () => {
        expect(effectivePermission({ status: 'denied', canAskAgain: true }, T0)).toBe('denied');
        expect(effectivePermission({ status: 'denied', canAskAgain: false }, null)).toBe('denied');
        expect(effectivePermission({ status: 'granted', canAskAgain: true }, null)).toBe('granted');
        expect(effectivePermission({ status: 'undetermined', canAskAgain: true }, T0)).toBe('undetermined');
    });
});

function harness(
    options: {
        firstLaunch?: boolean;
        canRegister?: boolean;
        answer?: PushPermission;
        initial?: PushPermission;
        canAskAgain?: boolean;
    } = {},
) {
    let device: PushDevice = { showText: true, refreshedAt: null, askDeclinedAt: null, askPromptedAt: null };
    let permission: PushPermission = options.initial ?? 'undetermined';
    let now = T0;
    let foreground = true;
    const prompts: number[] = [];
    let granted = 0;
    const deps: NotificationAskDeps = {
        registry: {
            pushDevice: async () => device,
            setPushDevice: async (change) => {
                device = { ...device, ...change };
            },
        },
        permission: async () => ({ status: permission, canAskAgain: options.canAskAgain ?? true }),
        requestPermission: async () => {
            prompts.push(now);
            permission = options.answer ?? 'granted';
            return { status: permission, canAskAgain: true };
        },
        canRegister: async () => options.canRegister ?? true,
        foreground: () => foreground,
        firstLaunch: options.firstLaunch ?? false,
        now: () => now,
        onGranted: () => {
            granted += 1;
        },
    };
    const ask = createNotificationAsk(deps);
    return {
        ask,
        prompts,
        granted: () => granted,
        device: () => device,
        setPermission: (next: PushPermission) => {
            permission = next;
        },
        advance: (ms: number) => {
            now += ms;
        },
        setForeground: (next: boolean) => {
            foreground = next;
        },
    };
}

describe('createNotificationAsk', () => {
    it('shows the explanation, and only Allow brings the system prompt', async () => {
        const h = harness();
        let heard = 0;
        h.ask.subscribe(() => {
            heard += 1;
        });
        expect(await h.ask.request('room-turn')).toEqual({ kind: 'ask' });
        expect(h.ask.get()).toEqual({ availability: 'available', permission: 'undetermined', showing: 'room-turn' });
        expect(h.prompts).toEqual([]);
        expect(heard).toBeGreaterThan(0);
        // A second trigger while it shows doesn't stack another.
        expect(await h.ask.request('invite')).toEqual({ kind: 'skip', reason: 'showing' });

        await h.ask.allow();
        expect(h.prompts).toEqual([T0]);
        expect(h.ask.get()).toMatchObject({ permission: 'granted', showing: null });
        expect(h.granted()).toBe(1);
        expect(await h.ask.request('room-turn')).toEqual({ kind: 'skip', reason: 'granted' });
    });

    it('a denial at the system prompt leaves the denied row', async () => {
        const h = harness({ answer: 'denied' });
        await h.ask.request('invite');
        await h.ask.allow();
        expect(h.granted()).toBe(0);
        expect(h.device().askPromptedAt).toBe(T0);
        expect(notificationsDenied(h.ask.get())).toBe(true);
        expect(settingsRow(h.ask.get().availability, h.ask.get().permission)?.kind).toBe('denied');
        // Android still says it can ask again after one denial: it stays denied, read again.
        await h.ask.refresh();
        expect(notificationsDenied(h.ask.get())).toBe(true);
    });

    it('asks on Android before any prompt, where the phone already answers denied', async () => {
        const h = harness({ initial: 'denied', canAskAgain: true });
        expect(await h.ask.request('room-turn')).toEqual({ kind: 'ask' });
        await h.ask.allow();
        expect(h.prompts).toEqual([T0]);
        expect(h.ask.get().permission).toBe('granted');
    });

    it('Not now keeps its time and holds every trigger for NOT_NOW_MS', async () => {
        const h = harness();
        await h.ask.request('room-turn');
        await h.ask.notNow();
        expect(h.prompts).toEqual([]);
        expect(h.device().askDeclinedAt).toBe(T0);
        expect(h.ask.get().showing).toBeNull();
        h.advance(NOT_NOW_MS - 1);
        expect(await h.ask.request('invite')).toEqual({ kind: 'skip', reason: 'not-now' });
        h.advance(1);
        expect(await h.ask.request('invite')).toEqual({ kind: 'ask' });
    });

    it('never asks on the first launch, nor in the background', async () => {
        const first = harness({ firstLaunch: true });
        expect(await first.ask.request('room-turn')).toEqual({ kind: 'skip', reason: 'first-launch' });
        const h = harness();
        h.setForeground(false);
        expect(await h.ask.request('room-turn')).toEqual({ kind: 'skip', reason: 'background' });
        expect(h.ask.get().showing).toBeNull();
    });

    it('a Personal Team build never asks, and Turn on does nothing there', async () => {
        const h = harness({ canRegister: false });
        expect(await h.ask.request('room-turn')).toEqual({ kind: 'skip', reason: 'build' });
        await h.ask.turnOn();
        expect(h.prompts).toEqual([]);
        expect(settingsRow(h.ask.get().availability, h.ask.get().permission)?.kind).toBe('unavailable');
    });

    it('Settings’ Turn on goes straight to the system prompt, even past a Not now', async () => {
        const h = harness();
        await h.ask.request('room-turn');
        await h.ask.notNow();
        await h.ask.turnOn();
        expect(h.prompts).toEqual([T0]);
        expect(h.ask.get().permission).toBe('granted');
        expect(h.granted()).toBe(1);
    });

    it('reads the permission again on refresh (changed in the phone’s Settings)', async () => {
        const h = harness({ canAskAgain: false });
        await h.ask.refresh();
        expect(h.ask.get().permission).toBe('undetermined');
        h.setPermission('denied');
        await h.ask.refresh();
        expect(notificationsDenied(h.ask.get())).toBe(true);
        expect(await h.ask.request('room-turn')).toEqual({ kind: 'skip', reason: 'denied' });
    });

    it('Allow and Not now do nothing with no explanation up', async () => {
        const h = harness();
        await h.ask.allow();
        await h.ask.notNow();
        expect(h.prompts).toEqual([]);
        expect(h.device().askDeclinedAt).toBeNull();
    });
});
