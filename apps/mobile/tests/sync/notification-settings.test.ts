import { describe, expect, it, vi } from 'vitest';

import type { NotificationChannelView } from '@socio/shared/notifications';
import type { UserPreferences } from '@socio/shared/voice/dictation';

import type { AuthedFetch, AuthedRequestInit } from '../../src/net/authed-fetch';
import {
    channelRows,
    outcomeCopy,
    presenceHidden,
    SAVE_FAILED,
    TEST_COPY,
    testLine,
    thisPhoneLabel,
    withChange,
} from '../../src/shell/notification-settings';
import {
    createNotificationSettings,
    mergedNotifications,
    type NotificationSettingsOptions,
} from '../../src/sync/notification-settings';

import { fakeNetwork, OFFLINE, WIFI } from './fakes';

// Settings → Notifications' requests (online only, the whole map the
// web's way) and its view models.

const channel = (over: Partial<NotificationChannelView> = {}): NotificationChannelView => ({
    id: 'push',
    label: 'Push notifications',
    enabled: true,
    content: 'message',
    targets: [],
    ...over,
});

const LISTED = [
    channel({
        targets: [
            { id: 'sub-phone', label: 'Socio app on Pixel' },
            { id: 'sub-mac', label: 'Firefox on Mac' },
        ],
    }),
    channel({ id: 'telegram', label: 'Telegram', enabled: false, content: 'private', note: 'Link Telegram first.' }),
];

interface Call {
    readonly url: string;
    readonly init: AuthedRequestInit | undefined;
}

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(
    answers: Record<string, (init: AuthedRequestInit | undefined) => Response | Promise<Response>>,
    options: Partial<NotificationSettingsOptions> = {},
) {
    const calls: Call[] = [];
    const fetch: AuthedFetch = async (url, init) => {
        calls.push({ url, init });
        const answer = answers[`${init?.method ?? 'GET'} ${url}`];
        if (answer === undefined) {
            throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`);
        }
        return answer(init);
    };
    const network = fakeNetwork(WIFI);
    const confirmed: UserPreferences[] = [];
    let stored: UserPreferences | undefined = {
        dictation: null,
        // A channel this server doesn't list now: kept as stored.
        notifications: { email: { enabled: true, content: 'private' }, push: { enabled: false, content: 'private' } },
    };
    const settings = createNotificationSettings({
        fetch,
        network,
        away: () => false,
        hold: () => null,
        stored: () => stored,
        confirmPreferences: (preferences) => {
            confirmed.push(preferences);
            stored = preferences;
        },
        ...options,
    });
    return { settings, calls, network, confirmed };
}

describe('the whole notifications map', () => {
    it('is the stored preferences, then the listed channels, then the change (the web’s merge)', () => {
        const merged = mergedNotifications(
            { email: { enabled: true, content: 'private' }, push: { enabled: false, content: 'private' } },
            LISTED,
            'telegram',
            { enabled: true },
        );
        expect(merged).toEqual({
            // The server didn't list it: kept.
            email: { enabled: true, content: 'private' },
            // Listed: as shown, over the stored.
            push: { enabled: true, content: 'message' },
            telegram: { enabled: true, content: 'private' },
        });
        expect(mergedNotifications(undefined, LISTED, 'push', { content: 'private' })).toEqual({
            push: { enabled: true, content: 'private' },
            telegram: { enabled: false, content: 'private' },
        });
        expect(() => mergedNotifications(undefined, LISTED, 'sms', { enabled: true })).toThrow();
    });
});

describe('the notification settings, online only', () => {
    it('reads the channels, and PATCHes the whole map, handing the answer to the shell row', async () => {
        const answer: UserPreferences = {
            dictation: null,
            notifications: {
                email: { enabled: true, content: 'private' },
                push: { enabled: true, content: 'private' },
                telegram: { enabled: false, content: 'private' },
            },
        };
        const s = setup({
            'GET /api/notifications/channels': () => json(200, { channels: LISTED, pushKey: 'BKey' }),
            'PATCH /api/preferences': () => json(200, answer),
        });
        expect(await s.settings.channels()).toEqual({ kind: 'done', value: { channels: LISTED } });
        expect(await s.settings.saveChannel(LISTED, 'push', { content: 'private' })).toEqual({
            kind: 'done',
            value: answer,
        });
        expect(s.calls[1]!.init).toEqual({
            method: 'PATCH',
            json: {
                notifications: {
                    email: { enabled: true, content: 'private' },
                    push: { enabled: true, content: 'private' },
                    telegram: { enabled: false, content: 'private' },
                },
            },
        });
        expect(s.confirmed).toEqual([answer]);
    });

    it('sends room presence and the test', async () => {
        const s = setup({
            'PATCH /api/preferences': (init) => json(200, { dictation: null, ...(init?.json as object) }),
            'POST /api/notifications/test': () =>
                json(200, {
                    channels: [
                        { channel: 'push', sent: 2, failed: 1 },
                        { channel: 'telegram', sent: 0, failed: 0 },
                    ],
                }),
        });
        expect(await s.settings.setRoomPresence(true)).toMatchObject({ kind: 'done' });
        expect(s.calls[0]!.init).toEqual({ method: 'PATCH', json: { roomPresence: 'hidden' } });
        expect(s.confirmed).toEqual([{ dictation: null, roomPresence: 'hidden' }]);
        const tested = await s.settings.sendTest();
        expect(tested).toEqual({
            kind: 'done',
            value: [
                { channel: 'push', sent: 2, failed: 1 },
                { channel: 'telegram', sent: 0, failed: 0 },
            ],
        });
        expect(s.calls[1]!.init).toEqual({ method: 'POST', json: {} });
    });

    it('sends nothing offline, away or while writes wait; reading goes while writes wait', async () => {
        const s = setup({ 'GET /api/notifications/channels': () => json(200, { channels: [] }) });
        await Promise.resolve();
        s.network.set(OFFLINE);
        expect(s.settings.blocked()).toBe('offline');
        expect(await s.settings.channels()).toEqual({ kind: 'blocked', reason: 'offline' });
        expect(await s.settings.saveChannel(LISTED, 'push', { enabled: false })).toEqual({
            kind: 'blocked',
            reason: 'offline',
        });
        expect(await s.settings.setRoomPresence(false)).toEqual({ kind: 'blocked', reason: 'offline' });
        expect(await s.settings.sendTest()).toEqual({ kind: 'blocked', reason: 'offline' });
        expect(s.calls).toEqual([]);
        expect(s.confirmed).toEqual([]);

        const away = setup({}, { away: () => true });
        expect(await away.settings.sendTest()).toEqual({ kind: 'blocked', reason: 'away' });
        expect(await away.settings.channels()).toEqual({ kind: 'blocked', reason: 'away' });
        expect(away.calls).toEqual([]);

        const held = setup(
            { 'GET /api/notifications/channels': () => json(200, { channels: LISTED }) },
            {
                hold: () => 'sign-in',
            },
        );
        expect(await held.settings.saveChannel(LISTED, 'push', { enabled: false })).toEqual({
            kind: 'blocked',
            reason: 'sign-in',
        });
        expect(await held.settings.channels()).toMatchObject({ kind: 'done' });
        expect(held.calls.map((call) => call.url)).toEqual(['/api/notifications/channels']);
    });

    it('takes one request at a time, and tells refusals and no answer apart', async () => {
        let release: () => void = () => {};
        const s = setup({
            'POST /api/notifications/test': () =>
                new Promise<Response>((resolve) => {
                    release = () => resolve(json(200, { channels: [] }));
                }),
            'PATCH /api/preferences': () => json(400, { error: 'Use supported preferences.' }),
            'GET /api/notifications/channels': () => {
                throw new TypeError('Network request failed');
            },
        });
        const listener = vi.fn();
        s.settings.subscribe(listener);
        const first = s.settings.sendTest();
        expect(s.settings.busy()).toBe(true);
        expect(await s.settings.saveChannel(LISTED, 'push', { enabled: false })).toEqual({ kind: 'busy' });
        release();
        expect(await first).toEqual({ kind: 'done', value: [] });
        expect(s.settings.busy()).toBe(false);
        expect(listener).toHaveBeenCalled();
        expect(await s.settings.saveChannel(LISTED, 'push', { enabled: false })).toEqual({
            kind: 'refused',
            reason: 'http-400',
        });
        expect(s.confirmed).toEqual([]);
        expect(await s.settings.channels()).toEqual({ kind: 'no-answer' });
    });

    it('reads the channels once the request in flight ends, never answering busy', async () => {
        let release: () => void = () => {};
        const s = setup({
            'POST /api/notifications/test': () =>
                new Promise<Response>((resolve) => {
                    release = () => resolve(json(200, { channels: [] }));
                }),
            'GET /api/notifications/channels': () => json(200, { channels: LISTED }),
        });
        const test = s.settings.sendTest();
        const read = s.settings.channels();
        const another = s.settings.channels();
        await new Promise((resolve) => setTimeout(resolve, 0));
        // Nothing more went while the test was in flight.
        expect(s.calls.map((call) => call.url)).toEqual(['/api/notifications/test']);
        release();
        expect(await test).toEqual({ kind: 'done', value: [] });
        expect(await read).toEqual({ kind: 'done', value: { channels: LISTED } });
        expect(await another).toEqual({ kind: 'done', value: { channels: LISTED } });
        expect(s.calls.map((call) => call.url)).toEqual([
            '/api/notifications/test',
            '/api/notifications/channels',
            '/api/notifications/channels',
        ]);
    });

    it('wakes reads waiting on a request in flight when disposed, with no answer and no GET', async () => {
        let release: () => void = () => {};
        const s = setup({
            'POST /api/notifications/test': () =>
                new Promise<Response>((resolve) => {
                    release = () => resolve(json(200, { channels: [] }));
                }),
            'GET /api/notifications/channels': () => json(200, { channels: LISTED }),
        });
        const test = s.settings.sendTest();
        const answers: unknown[] = [];
        const reads = [s.settings.channels(), s.settings.channels()].map((read) =>
            read.then((outcome) => answers.push(outcome)),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        s.settings.dispose();
        await new Promise((resolve) => setTimeout(resolve, 0));
        // Woken by the dispose, before the request in flight ended.
        expect(answers).toEqual([{ kind: 'no-answer' }, { kind: 'no-answer' }]);
        release();
        await test;
        await Promise.all(reads);
        expect(await s.settings.channels()).toEqual({ kind: 'no-answer' });
        expect(s.calls.map((call) => call.url)).toEqual(['/api/notifications/test']);
    });

    it('refuses an answer it can’t read', async () => {
        const s = setup({
            'GET /api/notifications/channels': () => json(200, { channels: [{ id: 'push' }] }),
            'PATCH /api/preferences': () => json(200, ['not', 'preferences']),
        });
        expect(await s.settings.channels()).toEqual({ kind: 'refused', reason: 'http-200' });
        expect(await s.settings.setRoomPresence(false)).toEqual({ kind: 'refused', reason: 'http-200' });
        expect(s.confirmed).toEqual([]);
    });
});

describe('the Notifications screen’s view models', () => {
    it('words each channel’s reach, shows a change at once and finds this phone', () => {
        expect(channelRows(LISTED).map((row) => [row.id, row.reaches, row.testID])).toEqual([
            ['push', 'Goes to Socio app on Pixel, Firefox on Mac.', 'notifications-channel-push'],
            ['telegram', 'Link Telegram first.', 'notifications-channel-telegram'],
        ]);
        expect(channelRows([channel({ id: 'email' })])[0]!.reaches).toBe('It reaches nowhere yet.');
        expect(withChange(LISTED, 'telegram', { enabled: true })[1]).toMatchObject({ enabled: true });
        expect(withChange(LISTED, 'telegram', { enabled: true })[0]).toBe(LISTED[0]);
        expect(thisPhoneLabel(LISTED, 'sub-phone')).toBe('Socio app on Pixel');
        expect(thisPhoneLabel(LISTED, 'sub-gone')).toBeNull();
        expect(thisPhoneLabel(LISTED, null)).toBeNull();
    });

    it('says what the test reached, the web’s words', () => {
        expect(
            testLine(
                [
                    { channel: 'push', sent: 2, failed: 0 },
                    { channel: 'telegram', sent: 0, failed: 1 },
                    { channel: 'email', sent: 0, failed: 0 },
                ],
                LISTED,
            ),
        ).toBe('Sent to Push notifications (2 sent) and Telegram (1 failed).');
        expect(testLine([{ channel: 'push', sent: 0, failed: 0 }], LISTED)).toBe(TEST_COPY.nothing);
        expect(testLine([{ channel: 'sms', sent: 1, failed: 0 }], LISTED)).toBe('Sent to sms (1 sent).');
    });

    it('words outcomes from their kind, never the server’s text', () => {
        expect(outcomeCopy({ kind: 'done', value: null }, SAVE_FAILED)).toBeNull();
        expect(outcomeCopy({ kind: 'busy' }, SAVE_FAILED)).toBeNull();
        expect(outcomeCopy({ kind: 'blocked', reason: 'offline' }, SAVE_FAILED)).toBe('Needs a connection');
        expect(outcomeCopy({ kind: 'blocked', reason: 'update' }, SAVE_FAILED)).toBe('Update Socio to do this');
        expect(outcomeCopy({ kind: 'refused', reason: 'http-401' }, SAVE_FAILED)).toBe('Sign in again to do this');
        expect(outcomeCopy({ kind: 'refused', reason: 'http-500' }, SAVE_FAILED)).toBe(SAVE_FAILED);
        expect(outcomeCopy({ kind: 'no-answer' }, SAVE_FAILED)).toMatch(/No answer/);
    });

    it('hides presence only when the person chose it', () => {
        expect(presenceHidden(undefined)).toBe(false);
        expect(presenceHidden({ dictation: null })).toBe(false);
        expect(presenceHidden({ dictation: null, roomPresence: 'shown' })).toBe(false);
        expect(presenceHidden({ dictation: null, roomPresence: 'hidden' })).toBe(true);
    });
});
