import { createLiveQueryCollection } from '@tanstack/db';
import { afterEach, describe, expect, it } from 'vitest';

import type { ApprovalView } from '@socio/shared/approvals';
import { ROOM_UNREAD_CAP } from '@socio/shared/rooms/rooms';
import type { Conversation, Dot } from '@socio/shared/types';

import { accountView, signOutQuestion, switcherRows, workspaceSummary, workspaceUnread } from '../../src/shell/account';
import { chatList, UNTITLED_CHAT } from '../../src/shell/chat-list';
import { homeSocios, NO_INSTRUCTIONS, socioState } from '../../src/shell/home';
import { attentionCount, inboxView, NOTICE_DAY_MS } from '../../src/shell/inbox';
import { LAST_SCREEN_KEY, lastScreen, SHELL_SCREENS } from '../../src/shell/last-screen';
import { chatsQuery, noticesQuery, shellQuery, shellRows, sociosQuery, spacesQuery } from '../../src/shell/queries';
import { spaceList } from '../../src/shell/spaces';
import { cleanupScopeCollections, createScopeCollections, type ScopeCollections } from '../../src/sync/collections';
import { approval, conversation, type Notice, syncSetup } from '../sync/helpers';

// The shell's view models on a scope's TanStack DB collections,
// seeded through the snapshot sources from a fake server, as the screens read
// them: the same live queries (src/shell/queries.ts), then the view models.

type Setup = Awaited<ReturnType<typeof syncSetup>>;
const open: Setup[] = [];
const made: ScopeCollections[] = [];
afterEach(async () => {
    for (const c of made.splice(0)) {
        await cleanupScopeCollections(c).catch(() => {});
    }
    for (const s of open.splice(0)) {
        await s.close().catch(() => {});
    }
});

const dot = (id: string, name: string, extra: Partial<Dot> = {}) => ({
    id,
    name,
    spaceId: 'everyday',
    spaceIds: ['everyday'],
    instructions: '',
    researchAllowed: true,
    memoryAllowed: true,
    createdAt: 1,
    ...extra,
});
const room = (id: string, title: string, createdAt: number, unread?: number) => ({
    ...conversation(id, title, createdAt),
    ownerId: `room:${id}`,
    kind: 'room',
    roomRole: 'member',
    ...(unread === undefined ? {} : { unread }),
});

/** A workspace seeded with chats, rooms, socios, spaces and a running task, pulled into a scope's collections. */
async function seeded({ rooms = true, paused = false, notices = [] as Notice[] } = {}) {
    const s = await syncSetup();
    open.push(s);
    // Notices of the last 24 h on the server's clock.
    const now = s.clock.server;
    s.server.change('state', (data) => {
        data.settings = { name: 'Acme', paused, rooms: { enabled: rooms } };
        data.notices = notices.map((notice) => ({ ...notice, createdAt: now - 1000 + notice.createdAt }));
        data.tasks = [
            { id: 't1', prompt: 'Digest', status: 'running', dotId: 'manny', createdAt: 1, updatedAt: 1 },
            { id: 't2', prompt: 'Old', status: 'completed', dotId: 'sebas', createdAt: 1, updatedAt: 1 },
        ];
    });
    s.server.change('workspace', (data) => {
        data.conversations = [
            conversation('c1', 'Kickoff', 30),
            { ...conversation('c2', 'Plan', 50), dotId: 'manny' },
            room('r1', 'Team room', 40, 250),
            { ...room('r2', 'Quiet room', 20), roomRole: 'admin' },
            room('r3', 'Busy room', 10, 3),
            conversation('c3', '  ', 30),
            { ...conversation('c4', 'Gone socio', 5), dotId: 'nobody' },
        ];
        data.archived = [{ ...conversation('c0', 'Old', 60), archivedAt: 70 }];
        data.dots = [
            dot('sebas', 'Sebas', { createdAt: 1, character: 'sebas', instructions: 'Keeps the team on track.' }),
            dot('manny', 'Manny', { createdAt: 2, character: 'manny' }),
            dot('ada', 'Ada', { createdAt: 3, character: 'nobody-knows' as never, archivedAt: 9 }),
        ];
        data.spaces = [
            { id: 'later', name: 'Later', description: 'Ideas', createdAt: 5, private: true },
            { id: 'everyday', name: 'Everyday', description: '', createdAt: 1 },
        ];
    });
    await s.state.pull('', null);
    await s.workspace.pull('', null);
    const c = createScopeCollections('ws.1', s.cache, []);
    made.push(c);
    /** A live query's rows, once ready; then it is cleaned up. */
    const rowsOf = async <T>(live: { toArrayWhenReady(): Promise<T[]>; cleanup(): Promise<void> }) => {
        const rows = await live.toArrayWhenReady();
        await live.cleanup();
        return rows;
    };
    return {
        s,
        c,
        shell: shellRows(await rowsOf(createLiveQueryCollection({ query: shellQuery(c), startSync: true }))),
        chats: await rowsOf(createLiveQueryCollection({ query: chatsQuery(c), startSync: true })),
        dots: await rowsOf(createLiveQueryCollection({ query: sociosQuery(c), startSync: true })),
        spaces: await rowsOf(createLiveQueryCollection({ query: spacesQuery(c), startSync: true })),
        notices: await rowsOf(createLiveQueryCollection({ query: noticesQuery(c), startSync: true })),
    };
}

describe('the chat list', () => {
    it('lists every chat but the archived, newest first by createdAt, the id breaking ties, with its socio and character', async () => {
        const { chats, dots, shell } = await seeded();
        const rows = chatList(chats, dots, shell.state);
        expect(rows.map((row) => row.id)).toEqual(['c2', 'r1', 'c3', 'c1', 'r2', 'r3', 'c4']);
        expect(rows.find((row) => row.id === 'c2')).toMatchObject({
            title: 'Plan',
            socio: 'Manny',
            character: 'manny',
        });
        expect(rows.find((row) => row.id === 'c1')).toMatchObject({ socio: 'Sebas', character: 'sebas', room: false });
        // No title yet; a socio the scope doesn't hold keeps its id's character.
        expect(rows.find((row) => row.id === 'c3')?.title).toBe(UNTITLED_CHAT);
        expect(rows.find((row) => row.id === 'c4')).toMatchObject({ socio: null });
        expect(rows.find((row) => row.id === 'c4')?.character).toMatch(/^[a-z]+$/);
    });

    it('shows a room’s unread capped at 100, as 99+, and nothing for a room with none or a private chat', async () => {
        const { chats, dots, shell } = await seeded();
        const rows = chatList(chats, dots, shell.state);
        expect(rows.find((row) => row.id === 'r1')).toMatchObject({
            room: true,
            unread: ROOM_UNREAD_CAP,
            unreadLabel: '99+',
            accessibilityLabel: 'Team room, room, with Sebas, 99+ unread',
        });
        expect(rows.find((row) => row.id === 'r3')).toMatchObject({ unread: 3, unreadLabel: '3', roomRole: null });
        // The reader's role where the web's Rooms list shows it: "Admin".
        expect(rows.find((row) => row.id === 'r2')).toMatchObject({
            unread: null,
            unreadLabel: null,
            roomRole: 'Admin',
            accessibilityLabel: 'Quiet room, room, Admin, with Sebas',
        });
        expect(rows.find((row) => row.id === 'c1')).toMatchObject({
            unread: null,
            accessibilityLabel: 'Kickoff, with Sebas',
        });
        // A private chat never shows a count, even with one set.
        const odd = { ...(chats.find((chat) => chat.id === 'c1') as Conversation), unread: 5 };
        expect(chatList([odd], dots, shell.state)[0]?.unread).toBeNull();
    });

    it('leaves rooms out while the workspace has them off, or before the state row comes', async () => {
        const { chats, dots, shell } = await seeded({ rooms: false });
        expect(chatList(chats, dots, shell.state).map((row) => row.id)).toEqual(['c2', 'c3', 'c1', 'c4']);
        expect(chatList(chats, dots, null).map((row) => row.id)).toEqual(['c2', 'c3', 'c1', 'c4']);
    });

    it('follows the collections: a new chat from the next pull shows first', async () => {
        const { s, c } = await seeded();
        s.server.change('workspace', (data) => {
            data.conversations.push(conversation('c9', 'Fresh', 99));
        });
        await s.workspace.pull('', s.workspace.cursor());
        const rows = chatList(c.conversations.toArray, c.dots.toArray, null);
        expect(rows[0]).toMatchObject({ id: 'c9', title: 'Fresh' });
    });
});

describe('what needs attention, at the top of Chats (the Inbox until CB-455)', () => {
    const notice = (id: string, title: string, createdAt: number, body = '') => ({
        id,
        title,
        body,
        link: `/chats/${id}`,
        createdAt,
    });

    it('lists the notices newest first, then the rooms with unread in the chat list’s order', async () => {
        const { chats, dots, shell, notices } = await seeded({
            notices: [notice('n1', 'Older', 10, 'Sebas finished'), notice('n2', 'Newer', 20)],
        });
        const view = inboxView([], notices, chats, dots, shell.state);
        expect(view.sections).toEqual(['notices', 'rooms']);
        expect(view.notices.map((row) => row.id)).toEqual(['n2', 'n1']);
        expect(view.notices[0]).toMatchObject({ title: 'Newer', body: null, accessibilityLabel: 'Newer' });
        expect(view.notices[1]).toMatchObject({ body: 'Sebas finished', accessibilityLabel: 'Older, Sebas finished' });
        // r2 has no unread; private chats never show here.
        expect(view.rooms.map((row) => row.id)).toEqual(['r1', 'r3']);
        expect(view.rooms[0]).toMatchObject({ unreadLabel: '99+' });
        expect(view.empty).toBe(false);
    });

    it('shows no room while rooms are off, and is empty with nothing new', async () => {
        const { chats, dots, shell, notices } = await seeded({ rooms: false });
        const view = inboxView([], notices, chats, dots, shell.state);
        expect(view).toMatchObject({ sections: [], notices: [], rooms: [], invites: [], empty: true });
    });

    it('puts the approvals waiting first, then notices, invites, rooms and the notifications row', async () => {
        const { chats, dots, shell, notices } = await seeded({ notices: [notice('n1', 'Mentioned you', 10)] });
        const approvals = [approval('w1'), approval('done', 'approved')] as unknown as ApprovalView[];
        const invite = { id: 'i1', title: 'Plans', subtitle: null, accessibilityLabel: 'Plans' };
        const view = inboxView(approvals, notices, chats, dots, shell.state, {
            invites: [invite],
            notificationsDenied: true,
        });
        expect(view.sections).toEqual(['approvals', 'notices', 'invites', 'rooms', 'notifications']);
        expect(view.approvals.rows.map((row) => row.id)).toEqual(['w1']);
        expect(view.invites).toEqual([invite]);

        // Decided requests alone make no approvals section; nothing new is empty.
        const decided = inboxView([approval('done', 'approved')] as unknown as ApprovalView[], [], [], dots, null);
        expect(decided).toMatchObject({ sections: [], empty: true });
    });

    it('shows only the last day’s notices with the clock, so old ones never hold the section open (CB-455)', async () => {
        const now = 10 * NOTICE_DAY_MS;
        const { chats, dots, shell } = await seeded({ rooms: false });
        // As the device keeps them, past the server's day.
        const notices = [notice('old', 'Yesterday', now - NOTICE_DAY_MS - 1), notice('new', 'Today', now - 60_000)];
        expect(inboxView([], notices, chats, dots, shell.state, { now }).notices.map((row) => row.id)).toEqual(['new']);
        const old = notices.filter((row) => row.id === 'old');
        expect(inboxView([], old, chats, dots, shell.state, { now })).toMatchObject({ sections: [], empty: true });
    });

    it('badges Chats with each approval waiting, invite and room with unread, not notices nor pages (CB-455)', async () => {
        const { chats, dots, shell, notices } = await seeded({ notices: [notice('n1', 'Mentioned you', 10)] });
        const approvals = [approval('w1'), approval('w2'), approval('done', 'approved')] as unknown as ApprovalView[];
        const invite = { id: 'i1', title: 'Plans', subtitle: null, accessibilityLabel: 'Plans' };
        const view = inboxView(approvals, notices, chats, dots, shell.state, {
            invites: [invite],
            notificationsDenied: true,
        });
        // 2 waiting, 1 invite, 2 rooms with unread (r1 and r3); pages changed are the Spaces tab's.
        expect(attentionCount(view)).toBe(5);
        const quiet = inboxView([], notices, [], dots, shell.state, { notificationsDenied: true });
        expect(quiet.empty).toBe(false);
        expect(attentionCount(quiet)).toBe(0);
    });
});

describe('Home’s socios', () => {
    it('lists the socios not archived, oldest first, Working while one of their tasks runs, else Idle', async () => {
        const { dots, shell } = await seeded();
        expect(homeSocios(dots, shell.state)).toEqual([
            {
                id: 'sebas',
                name: 'Sebas',
                character: 'sebas',
                characterKind: 'stone crab',
                blurb: 'Keeps the team on track.',
                state: 'idle',
                stateLabel: 'Idle',
                accessibilityLabel: 'Sebas, Idle',
            },
            {
                id: 'manny',
                name: 'Manny',
                character: 'manny',
                characterKind: 'manatee',
                blurb: NO_INSTRUCTIONS,
                state: 'working',
                stateLabel: 'Working',
                accessibilityLabel: 'Manny, Working',
            },
        ]);
    });

    it('shows every socio Paused while the workspace is paused, and Idle before the state row comes', async () => {
        const { dots, shell } = await seeded({ paused: true });
        expect(homeSocios(dots, shell.state).map((row) => row.state)).toEqual(['paused', 'paused']);
        expect(homeSocios(dots, null).map((row) => row.state)).toEqual(['idle', 'idle']);
        expect(socioState('manny', undefined)).toBe('idle');
    });
});

describe('the Spaces list', () => {
    it('lists the spaces in the server’s order (createdAt), a private one marked, an empty description left out', async () => {
        const { spaces } = await seeded();
        expect(spaceList(spaces)).toEqual([
            { id: 'everyday', name: 'Everyday', description: null, private: false, accessibilityLabel: 'Everyday' },
            { id: 'later', name: 'Later', description: 'Ideas', private: true, accessibilityLabel: 'Later, private' },
        ]);
    });
});

describe('the account sheet', () => {
    it('names the workspace from its branding, else its host; the person from the server’s rows, else the registry’s', async () => {
        const { shell } = await seeded();
        const row = {
            origin: 'https://brain.example.test:8443',
            name: 'Registry name',
            personName: 'Ada L.',
            personEmail: 'ada@example.test',
        };
        // settings.name is the default socio's name, never the workspace's.
        expect(accountView(row, shell.workspace, shell.state)).toEqual({
            workspaceName: 'brain.example.test:8443',
            host: 'brain.example.test:8443',
            personName: shell.workspace?.user.name,
            personEmail: 'ada@example.test',
            role: expect.any(String),
        });
        expect(accountView(row, null, null)).toEqual({
            workspaceName: 'Registry name',
            host: 'brain.example.test:8443',
            personName: 'Ada L.',
            personEmail: 'ada@example.test',
            role: null,
        });
    });

    it('shows an older server’s retired operator role as Admin, never Operator (CB-390)', async () => {
        const { shell } = await seeded();
        const row = {
            origin: 'https://brain.example.test',
            name: 'W',
            personName: 'Ada',
            personEmail: 'a@example.test',
        };
        const workspace = { ...shell.workspace!, user: { ...shell.workspace!.user, role: 'operator' as never } };
        expect(accountView(row, workspace, shell.state).role).toBe('Admin');
        const member = { ...shell.workspace!, user: { ...shell.workspace!.user, role: 'member' as const } };
        expect(accountView(row, member, shell.state).role).toBe('Member');
    });
});

describe('the switcher', () => {
    const row = (id: string, fields: Partial<Parameters<typeof switcherRows>[0][number]> = {}) => ({
        id,
        origin: `https://brain.${id}.example.test`,
        state: 'ready',
        name: id.toUpperCase(),
        personName: 'Ada',
        personEmail: 'ada@example.test',
        lastUsed: 1,
        endedAt: null,
        leaseLockedAt: null,
        unread: null,
        waiting: null,
        ...fields,
    });

    it('lists ready workspaces, the open one first, then the most recently used, with state and unread', () => {
        const rows = switcherRows(
            [
                row('a', { lastUsed: 5 }),
                row('b', { lastUsed: 9, unread: 3 }),
                row('c', { lastUsed: 7, endedAt: 2 }),
                row('d', { lastUsed: 8, leaseLockedAt: 4, unread: 0 }),
                row('e', { lastUsed: 10, state: 'wiping' }),
                row('f', { lastUsed: 11, state: 'pending' }),
                row('g', { lastUsed: 1, unread: ROOM_UNREAD_CAP * 2 }),
            ],
            'a',
        );
        expect(rows.map((r) => [r.id, r.badge, r.unreadLabel, r.open])).toEqual([
            ['a', 'open', null, true],
            ['b', 'signed-in', '3', false],
            ['d', 'locked', null, false],
            ['c', 'ended', null, false],
            ['g', 'signed-in', '99+', false],
        ]);
        expect(rows[1]).toMatchObject({
            host: 'brain.b.example.test',
            accessibilityLabel: 'B, brain.b.example.test, Ada, ada@example.test, Signed in, 3 unread',
        });
    });

    it('says when the workspace the app shows didn’t open', () => {
        const rows = switcherRows([row('a', { lastUsed: 5 }), row('b', { lastUsed: 9 })], 'a', { failed: true });
        expect(rows.map((r) => [r.id, r.badge, r.badgeLabel, r.open])).toEqual([
            ['a', 'failed', 'Didn’t open', true],
            ['b', 'signed-in', 'Signed in', false],
        ]);
    });

    it('says “Waiting to send” for another workspace whose outbox holds rows, never for the open one', () => {
        const rows = switcherRows(
            [row('a', { lastUsed: 5, waiting: 2 }), row('b', { lastUsed: 9, waiting: 1 }), row('c', { waiting: 0 })],
            'a',
        );
        expect(rows.map((r) => [r.id, r.waitingLabel])).toEqual([
            ['a', null],
            ['b', 'Waiting to send'],
            ['c', null],
        ]);
        expect(rows[1]?.accessibilityLabel).toBe(
            'B, brain.b.example.test, Ada, ada@example.test, Signed in, Waiting to send',
        );
    });

    it('sums the open workspace’s unread from its chat list, and takes its name from the branding, else the host', () => {
        expect(workspaceUnread([{ unread: null }, { unread: 2 }, { unread: ROOM_UNREAD_CAP }])).toBe(
            2 + ROOM_UNREAD_CAP,
        );
        expect(workspaceUnread([])).toBe(0);
        const row = { name: 'Dot', origin: 'https://acme.example.test' };
        expect(
            workspaceSummary(
                { settings: { name: 'Dot', branding: { name: ' Acme ', logo: '' } } } as never,
                [{ unread: 1 }],
                row,
            ),
        ).toEqual({ name: 'Acme', unread: 1 });
        // No branding, or the product's default: the host, never the default socio's name.
        expect(workspaceSummary({ settings: { name: 'Dot' } } as never, [], row)).toEqual({
            name: 'acme.example.test',
            unread: 0,
        });
        expect(
            workspaceSummary({ settings: { name: 'Dot', branding: { name: 'Socio', logo: '' } } } as never, [], row),
        ).toEqual({ name: 'acme.example.test', unread: 0 });
    });
});

describe('the last screen', () => {
    it('opens a kept shell screen, and Home for anything else', () => {
        expect(LAST_SCREEN_KEY).toBe('lastScreen');
        for (const screen of SHELL_SCREENS) {
            expect(lastScreen(screen)).toBe(screen);
        }
        for (const value of [null, undefined, '', 'Diagnostics', 'Account', 'chats']) {
            expect(lastScreen(value)).toBe('Home');
        }
    });
});

describe('signOutQuestion', () => {
    it('asks nothing with no unsent items', () => {
        expect(signOutQuestion(0)).toBeNull();
    });

    it('names the unsent items, and never takes a count that failed as none', () => {
        expect(signOutQuestion(1)?.message).toBe(
            '1 unsent item will be deleted from this phone with the rest of this workspace.',
        );
        expect(signOutQuestion(3)?.message).toMatch(/^3 unsent items will be deleted/);
        expect(signOutQuestion(null)).toMatchObject({ title: 'Sign out?', confirm: 'Sign out', cancel: 'Cancel' });
        expect(signOutQuestion(null)?.message).toMatch(/^Anything you haven't sent yet will be deleted/);
    });
});
