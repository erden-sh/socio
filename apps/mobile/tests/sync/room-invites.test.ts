import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import type { RoomInvite } from '@socio/shared/rooms/rooms';

import { linkTarget } from '../../src/chat/markdown-links';
import type { AuthedFetch, AuthedRequestInit } from '../../src/net/authed-fetch';
import { inboxView } from '../../src/shell/inbox';
import {
    ACTION_FALLBACK,
    INVITE_GONE,
    inviteDetail,
    invitedLine,
    inviteRows,
    notifyChoices,
    notifyReadRetry,
    roomActionCopy,
    roomWebHref,
    whenRoomFree,
} from '../../src/shell/room-invites';
import { SnapshotShapeError } from '../../src/sync/errors';
import { ROOM_INVITES_KIND } from '../../src/sync/kinds';
import { createRoomActions, type RoomActionsOptions } from '../../src/sync/room-actions';
import { ROOM_INVITES, ROOM_INVITES_SNAPSHOT } from '../../src/sync/room-invites';

import { fakeNetwork, OFFLINE, WIFI } from './fakes';

// The room invites kind, the online-only room actions (accept,
// decline, the notification level) and their view models.

const ROOMS_ON = { settings: { rooms: { enabled: true } } } as never;
const ROOMS_OFF = { settings: { rooms: { enabled: false } } } as never;

const invite = (over: Partial<RoomInvite> = {}): RoomInvite => ({
    roomId: 'room-1',
    title: 'Launch',
    role: 'member',
    invitedBy: 'u-ana',
    invitedByName: 'Ana',
    invitedAt: 1_000,
    inviteExpiresAt: null,
    memberCount: 3,
    disclosure: { version: 1, text: 'Everyone in the room reads its whole history.' },
    ...over,
});

interface Call {
    readonly url: string;
    readonly init: AuthedRequestInit | undefined;
}

function setup(answers: Record<string, () => Response | Promise<Response>>, options: Partial<RoomActionsOptions> = {}) {
    const calls: Call[] = [];
    const fetch: AuthedFetch = async (url, init) => {
        calls.push({ url, init });
        const answer = answers[`${init?.method ?? 'GET'} ${url}`];
        if (answer === undefined) {
            throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`);
        }
        return answer();
    };
    const network = fakeNetwork(WIFI);
    const invitesChanged = vi.fn();
    const joined = vi.fn(async () => {});
    const actions = createRoomActions({
        fetch,
        network,
        away: () => false,
        hold: () => null,
        invitesChanged,
        joined,
        ...options,
    });
    return { actions, calls, network, invitesChanged, joined };
}

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('the room invites kind', () => {
    it('keys the invites by room, pulled only while the Inbox or Home shows, every 60 s', () => {
        const [items] = ROOM_INVITES_SNAPSHOT.split([invite(), invite({ roomId: 'room-2' })]);
        expect(items!.map((item) => item.key)).toEqual(['room-1', 'room-2']);
        expect(ROOM_INVITES_SNAPSHOT).toMatchObject({ path: '/api/rooms/invites', hashBody: true });
        expect(ROOM_INVITES_KIND).toMatchObject({ visiblePoll: 60_000, inView: true, collections: [ROOM_INVITES] });
        expect(() => ROOM_INVITES_SNAPSHOT.split({})).toThrow(SnapshotShapeError);
        expect(() => ROOM_INVITES_SNAPSHOT.split([{ title: 'No id' }])).toThrow(SnapshotShapeError);
    });
});

describe('accepting and declining, online only', () => {
    it('refuses offline, away or held with no request', async () => {
        const s = setup({});
        await Promise.resolve();
        s.network.set(OFFLINE);
        expect(await s.actions.accept('room-1', 1)).toEqual({ kind: 'blocked', reason: 'offline' });
        expect(await s.actions.decline('room-1')).toEqual({ kind: 'blocked', reason: 'offline' });
        expect(await s.actions.setNotifyLevel('room-1', 'all')).toEqual({ kind: 'blocked', reason: 'offline' });
        expect(await s.actions.notifyLevel('room-1')).toEqual({ kind: 'blocked', reason: 'offline' });
        const away = setup({}, { away: () => true });
        expect(await away.actions.accept('room-1', 1)).toEqual({ kind: 'blocked', reason: 'away' });
        const held = setup({}, { hold: () => 'sign-in' });
        expect(await held.actions.decline('room-1')).toEqual({ kind: 'blocked', reason: 'sign-in' });
        expect([...s.calls, ...away.calls, ...held.calls]).toEqual([]);
        expect(s.invitesChanged).not.toHaveBeenCalled();
    });

    it('posts the disclosure version shown, waits for the room in the chat list, then reads the invites again', async () => {
        const view = { id: 'room-1', title: 'Launch' };
        const s = setup({ 'POST /api/rooms/room-1/accept': () => json(200, view) });
        const outcome = await s.actions.accept('room-1', 1);
        expect(outcome).toEqual({ kind: 'done', value: view });
        expect(s.calls).toEqual([
            { url: '/api/rooms/room-1/accept', init: { method: 'POST', json: { disclosureVersion: 1 } } },
        ]);
        expect(s.joined).toHaveBeenCalledWith('room-1');
        expect(s.invitesChanged).toHaveBeenCalledTimes(1);
    });

    it('reads the invites again when the server no longer has the invite', async () => {
        const s = setup({
            'POST /api/rooms/room-1/accept': () => json(404, { code: 'not_found' }),
            'POST /api/rooms/room-1/decline': () => json(404, { code: 'not_found' }),
        });
        expect(await s.actions.accept('room-1', 1)).toEqual({ kind: 'gone' });
        expect(await s.actions.decline('room-1')).toEqual({ kind: 'gone' });
        expect(s.invitesChanged).toHaveBeenCalledTimes(2);
        expect(s.joined).not.toHaveBeenCalled();
        expect(roomActionCopy({ kind: 'gone' }, 'invite')).toBe(INVITE_GONE);
    });

    it('words a refusal by its code, never the server’s text, and a lost answer', async () => {
        const s = setup({
            'POST /api/rooms/room-1/accept': () => json(409, { code: 'expired', error: 'server words' }),
            'POST /api/rooms/room-2/accept': () => Promise.reject(new Error('broke off')),
            'POST /api/rooms/room-3/accept': () => json(500, {}),
        });
        const expired = await s.actions.accept('room-1', 1);
        expect(expired).toEqual({ kind: 'refused', reason: 'expired' });
        expect(roomActionCopy(expired, 'invite')).not.toContain('server words');
        expect(roomActionCopy(expired, 'invite')).toMatch(/run out/);
        expect(await s.actions.accept('room-2', 1)).toEqual({ kind: 'no-answer' });
        const failed = await s.actions.accept('room-3', 1);
        expect(roomActionCopy(failed, 'invite')).toBe(ACTION_FALLBACK);
        expect(roomActionCopy({ kind: 'blocked', reason: 'offline' }, 'invite')).toBe('Needs a connection');
        expect(s.invitesChanged).not.toHaveBeenCalled();
    });

    it('sends one request per room at a time', async () => {
        let release = () => {};
        const s = setup({
            'POST /api/rooms/room-1/decline': () =>
                new Promise<Response>((resolve) => {
                    release = () => resolve(json(200, { ok: true }));
                }),
        });
        const first = s.actions.decline('room-1');
        expect(s.actions.busy('room-1')).toBe(true);
        expect(await s.actions.accept('room-1', 1)).toEqual({ kind: 'busy' });
        release();
        expect(await first).toEqual({ kind: 'done', value: null });
        expect(s.actions.busy('room-1')).toBe(false);
        expect(s.calls).toHaveLength(1);
    });

    it('stays busy while a taken Join waits for the chat list, so Decline sends nothing after it', async () => {
        let listed: (() => void) | null = null;
        const s = setup(
            { 'POST /api/rooms/room-1/accept': () => json(200, { id: 'room-1' }) },
            {
                joined: () =>
                    new Promise<void>((resolve) => {
                        listed = resolve;
                    }),
            },
        );
        const joining = s.actions.accept('room-1', 1);
        await vi.waitFor(() => expect(listed).not.toBeNull());
        expect(s.actions.busy('room-1')).toBe(true);
        expect(await s.actions.decline('room-1')).toEqual({ kind: 'busy' });
        listed!();
        expect(await joining).toMatchObject({ kind: 'done' });
        expect(s.actions.busy('room-1')).toBe(false);
        expect(s.calls.map((call) => call.url)).toEqual(['/api/rooms/room-1/accept']);
    });

    it('disables Join and Decline both while either runs', () => {
        const sheet = readFileSync(new URL('../../src/screens/room-invite.tsx', import.meta.url), 'utf8');
        expect(sheet).toContain("disabled={blocked !== null || ((busy || working !== null) && working !== 'decline')}");
        expect(sheet).toContain("disabled={blocked !== null || ((busy || working !== null) && working !== 'join')}");
    });
});

describe('the room’s notification level', () => {
    it('reads it and sets it, online only; a read still goes while writes wait', async () => {
        const s = setup({
            'GET /api/rooms/room-1/notifications': () => json(200, { level: 'mentions' }),
            'PUT /api/rooms/room-1/notifications': () => json(200, { level: 'mute' }),
        });
        expect(await s.actions.notifyLevel('room-1')).toEqual({ kind: 'done', value: 'mentions' });
        expect(await s.actions.setNotifyLevel('room-1', 'mute')).toEqual({ kind: 'done', value: 'mute' });
        expect(s.calls[1]).toEqual({
            url: '/api/rooms/room-1/notifications',
            init: { method: 'PUT', json: { level: 'mute' } },
        });
        const held = setup(
            { 'GET /api/rooms/room-1/notifications': () => json(200, { level: 'all' }) },
            {
                hold: () => 'update',
            },
        );
        expect(await held.actions.notifyLevel('room-1')).toEqual({ kind: 'done', value: 'all' });
        expect(await held.actions.setNotifyLevel('room-1', 'mute')).toEqual({ kind: 'blocked', reason: 'update' });
    });

    it('reads the level again after a failed read: on Try again, or once the room’s other request ends', () => {
        expect(notifyReadRetry({ kind: 'no-answer' })).toBe('button');
        expect(notifyReadRetry({ kind: 'refused', reason: 'http-500' })).toBe('button');
        expect(notifyReadRetry({ kind: 'gone' })).toBe('button');
        expect(notifyReadRetry({ kind: 'busy' })).toBe('when-free');
        // Offline reads again as the connection comes back; a read needs nothing more.
        expect(notifyReadRetry({ kind: 'blocked', reason: 'offline' })).toBeNull();
        expect(notifyReadRetry({ kind: 'done', value: 'all' })).toBeNull();
        const menu = readFileSync(new URL('../../src/screens/room-menu.tsx', import.meta.url), 'utf8');
        expect(menu).toContain('notifyReadRetry(outcome)');
        expect(menu).toContain('label={NOTIFY_RETRY}');
        expect(menu).toMatch(/\[actions, id, level, offline, attempt\]/);
    });

    it('reads again when the other request ended before the menu subscribed, never waiting forever', () => {
        const listeners = new Set<() => void>();
        const state = { busy: true };
        const actions = {
            busy: () => state.busy,
            subscribe: (listener: () => void) => {
                listeners.add(listener);
                return () => {
                    listeners.delete(listener);
                };
            },
        };
        // The other request ended between the refusal ('busy') and the subscription: no change will come.
        state.busy = false;
        let reads = 0;
        whenRoomFree(actions, 'room-1', () => (reads += 1));
        expect(reads).toBe(1);
        expect(listeners.size).toBe(0);

        // Still going: once it ends, and only once.
        state.busy = true;
        whenRoomFree(actions, 'room-1', () => (reads += 1));
        expect(reads).toBe(1);
        state.busy = false;
        for (const listener of [...listeners]) {
            listener();
        }
        for (const listener of [...listeners]) {
            listener();
        }
        expect(reads).toBe(2);
        expect(listeners.size).toBe(0);

        // Stopped (the menu closed): never.
        state.busy = true;
        const stop = whenRoomFree(actions, 'room-1', () => (reads += 1));
        stop();
        state.busy = false;
        expect(listeners.size).toBe(0);
        expect(reads).toBe(2);
        const menu = readFileSync(new URL('../../src/screens/room-menu.tsx', import.meta.url), 'utf8');
        expect(menu).toContain('whenRoomFree(actions, id,');
    });

    it('marks the level read, none before', () => {
        expect(notifyChoices(null).map((choice) => choice.selected)).toEqual([false, false, false]);
        expect(notifyChoices('mentions').map((choice) => [choice.label, choice.selected])).toEqual([
            ['Everything', false],
            ['Mentions and my turns', true],
            ['Muted', false],
        ]);
    });
});

describe('the invite rows and sheet', () => {
    it('shows the invites newest first only while rooms are on, in the Inbox’s invites part', () => {
        const invites = [invite(), invite({ roomId: 'room-2', title: 'Ops', invitedAt: 2_000, role: 'admin' })];
        const rows = inviteRows(invites, ROOMS_ON);
        expect(rows.map((row) => [row.id, row.subtitle])).toEqual([
            ['room-2', 'Ana invited you as an admin · 3 people in it'],
            ['room-1', 'Ana invited you · 3 people in it'],
        ]);
        expect(rows[0]!.accessibilityLabel).toBe('Invite to Ops, Ana invited you as an admin · 3 people in it');
        expect(inviteRows(invites, ROOMS_OFF)).toEqual([]);
        expect(inboxView([], [], [], [], ROOMS_ON, { invites: rows }).sections).toEqual(['invites']);
        expect(invitedLine({ invitedByName: null, role: 'member', memberCount: 1 })).toBe(
            'You were invited · 1 person in it',
        );
    });

    it('shows the disclosure before Join, with its version', () => {
        const detail = inviteDetail(invite({ inviteExpiresAt: Date.UTC(2026, 10, 12, 12) }), 'UTC');
        expect(detail).toEqual({
            title: 'Launch',
            line: 'Ana invited you · 3 people in it · until Nov 12',
            disclosure: 'Everyone in the room reads its whole history.',
            disclosureVersion: 1,
        });
        const sheet = readFileSync(new URL('../../src/screens/room-invite.tsx', import.meta.url), 'utf8');
        expect(sheet).toContain('actions\n            .accept(roomId, detail.disclosureVersion)');
    });

    it('opens the room in the browser through useOpenLink, and a new room in the app (CB-470)', () => {
        const origin = 'https://brain.example.test';
        expect(roomWebHref('room 1')).toBe('/chats/room%201');
        expect(linkTarget(roomWebHref('room 1'), origin)).toMatchObject({ kind: 'workspace' });
        const menu = readFileSync(new URL('../../src/screens/room-menu.tsx', import.meta.url), 'utf8');
        expect(menu).toContain('useOpenLink()');
        expect(menu).toContain('openLink(roomWebHref(id))');
        expect(menu).not.toMatch(/Linking|WebBrowser/);
        // Home's Rooms ends with New room, which opens the app's own form, never the web.
        const home = readFileSync(new URL('../../src/screens/home.tsx', import.meta.url), 'utf8');
        expect(home).toContain("onNewRoom={() => navigation.navigate('NewRoom')}");
        expect(home).not.toContain('openLink(');
        const parts = readFileSync(new URL('../../src/screens/home-parts.tsx', import.meta.url), 'utf8');
        expect(parts).not.toContain('external-link');
    });
});

describe('the notification ask after joining', () => {
    it('asks with the invite trigger once Join succeeds, never after a refusal', () => {
        const sheet = readFileSync(new URL('../../src/screens/room-invite.tsx', import.meta.url), 'utf8');
        const join = sheet.slice(sheet.indexOf('const join = () => {'), sheet.indexOf('const decline = () => {'));
        expect(join).toMatch(
            /if \(outcome\.kind === 'done'\) \{[\s\S]*?navigation\.dispatch\(chatAction\(roomId\)\);\s*void askForNotifications\('invite'\);\s*return;/,
        );
        expect(sheet.match(/askForNotifications\(/g)).toHaveLength(1);
        expect(sheet).not.toContain('comes with NT1');
    });
});
