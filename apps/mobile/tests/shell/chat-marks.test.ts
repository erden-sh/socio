import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { ChatRow } from '../../src/shell/chat-list';
import { chatListItem, chatMarks, listTime, ROOM_LINE } from '../../src/shell/chat-marks';

// The chat list's marks (MA 8.1; the PWA comparison's 3.2 to 3.4) under Node:
// "Needs your approval", "Working" and when each chat was last active, from
// the runs and approvals kinds, and a room drawn as a room. Then the screens
// that draw them: the Chats tab and Home's Rooms and Recent chats.

const chat = (id: string, dotId: string, createdAt: number) => ({ id, dotId, createdAt });
const run = (threadId: string, startedAt: number, finishedAt: number | null, status = 'finished') => ({
    threadId,
    status: status as 'running' | 'finished',
    startedAt,
    finishedAt,
});
const approval = (dotId: string, createdAt: number, status = 'pending') => ({
    dotId,
    createdAt,
    status: status as 'pending' | 'approved',
});
const row = (id: string, extra: Partial<ChatRow> = {}): ChatRow => ({
    id,
    title: 'A: new datasets',
    socio: 'Sebas',
    character: 'stoneCrab' as ChatRow['character'],
    room: false,
    roomRole: null,
    unread: null,
    unreadLabel: null,
    accessibilityLabel: 'A: new datasets, with Sebas',
    ...extra,
});

describe('the chat list’s marks', () => {
    const chats = [chat('c1', 'sebas', 100), chat('c2', 'sebas', 200), chat('c3', 'manny', 300)];

    it('count a waiting request against the chat it names, and none when it names no chat', () => {
        const marks = chatMarks({
            chats,
            // c2's run with Sebas was going at 480; the guess would pick c2.
            runs: [run('c1', 400, 500), run('c2', 450, 900)],
            approvals: [
                { ...approval('sebas', 480), threadId: 'c1' },
                { ...approval('sebas', 490), threadId: null },
                { ...approval('sebas', 495), threadId: 'not-listed' },
                { ...approval('sebas', 496, 'approved'), threadId: 'c3' },
            ],
        });
        expect([...marks].map(([id, m]) => [id, m.approvals])).toEqual([
            ['c1', 1],
            ['c2', 0],
            ['c3', 0],
        ]);
    });

    it('mark a chat Working while one of its runs is running, and no other', () => {
        const marks = chatMarks({
            chats,
            runs: [run('c1', 400, 500), run('c2', 600, null, 'running'), run('elsewhere', 700, null, 'running')],
            approvals: [],
        });
        expect([...marks].map(([id, m]) => [id, m.working])).toEqual([
            ['c1', false],
            ['c2', true],
            ['c3', false],
        ]);
    });

    it('count a waiting request against the chat whose run with that socio was going when it was asked', () => {
        const marks = chatMarks({
            chats,
            runs: [run('c1', 400, 500), run('c2', 450, 900), run('c3', 400, 500)],
            approvals: [
                // Asked while c1's and c2's runs both went (same socio): the later run's chat, c2.
                approval('sebas', 480),
                // Only c2's run went then.
                approval('sebas', 800),
                // Decided: no mark.
                approval('sebas', 820, 'approved'),
                // Manny's, asked outside any run the list holds.
                approval('manny', 950),
            ],
        });
        expect([...marks].map(([id, m]) => [id, m.approvals])).toEqual([
            ['c1', 0],
            ['c2', 2],
            ['c3', 0],
        ]);
    });

    it('take a request asked during a run still going, and never another socio’s chat', () => {
        const marks = chatMarks({
            chats,
            runs: [run('c3', 400, null, 'running')],
            approvals: [approval('sebas', 450), approval('manny', 450)],
        });
        expect(marks.get('c3')).toEqual({ approvals: 1, working: true, activeAt: 400 });
        expect(marks.get('c1')?.approvals).toBe(0);
    });

    it('say a chat was last active at its newest run’s end, or start while it runs, else its creation', () => {
        const marks = chatMarks({
            chats,
            runs: [run('c1', 400, 500), run('c1', 600, 650), run('c2', 700, null, 'running')],
            approvals: [],
        });
        expect([...marks].map(([id, m]) => [id, m.activeAt])).toEqual([
            ['c1', 650],
            ['c2', 700],
            ['c3', 300],
        ]);
    });
});

describe('a chat’s time in the list', () => {
    const now = new Date(2026, 10, 11, 15, 30).getTime();
    const at = (...parts: [number, number, number, number?, number?]) =>
        listTime(new Date(parts[0], parts[1], parts[2], parts[3] ?? 0, parts[4] ?? 0).getTime(), now);

    it('is short to see and whole to hear, as Messages, Slack and ChatGPT say it', () => {
        expect(listTime(now - 20_000, now)).toEqual({ short: 'Now', spoken: 'Just now' });
        expect(listTime(now + 60_000, now)).toEqual({ short: 'Now', spoken: 'Just now' });
        expect(listTime(now - 60_000, now)).toEqual({ short: '1m', spoken: '1 minute ago' });
        expect(listTime(now - 2 * 60_000, now)).toEqual({ short: '2m', spoken: '2 minutes ago' });
        expect(at(2026, 10, 11, 12, 10)).toEqual({ short: '3h', spoken: '3 hours ago' });
        expect(at(2026, 10, 11, 0, 5)).toEqual({ short: '15h', spoken: '15 hours ago' });
        expect(at(2026, 10, 10, 23, 0)).toEqual({ short: 'Yesterday', spoken: 'Yesterday' });
        expect(at(2026, 10, 9, 9)).toEqual({ short: 'Mon', spoken: 'Monday' });
        expect(at(2026, 10, 5, 9)).toEqual({ short: 'Thu', spoken: 'Thursday' });
        expect(at(2026, 10, 4, 9)).toEqual({ short: 'Nov 4', spoken: 'November 4' });
        expect(at(2025, 11, 31, 9)).toEqual({ short: 'Dec 31, 2025', spoken: 'December 31, 2025' });
    });
});

describe('a chat list row', () => {
    const now = new Date(2026, 10, 11, 15, 30).getTime();

    it('shows its marks and time, and says them all to a screen reader', () => {
        const item = chatListItem(row('c1'), { approvals: 2, working: true, activeAt: now - 5 * 60_000 }, now);
        expect([item.subtitle, item.approval, item.working, item.time?.short]).toEqual([
            'Sebas',
            'Needs your approval',
            'Working',
            '5m',
        ]);
        expect(item.accessibilityLabel).toBe(
            'A: new datasets, with Sebas, Needs your approval, 2 requests, Working, 5 minutes ago',
        );
        const one = chatListItem(row('c1'), { approvals: 1, working: false, activeAt: now }, now);
        expect([one.approval, one.working, one.accessibilityLabel]).toEqual([
            'Needs your approval',
            null,
            'A: new datasets, with Sebas, Needs your approval, Just now',
        ]);
    });

    it('shows no mark and no time when the marks don’t cover it', () => {
        const item = chatListItem(row('c1'), undefined, now);
        expect([item.approval, item.working, item.time, item.accessibilityLabel]).toEqual([
            null,
            null,
            null,
            'A: new datasets, with Sebas',
        ]);
    });

    it('draws a room as a room: “Room”, with the reader’s role where the web shows it, not the socio', () => {
        const admin = row('r1', { room: true, roomRole: 'Admin', title: 'A: launch room' });
        expect(chatListItem(admin, undefined, now).subtitle).toBe(`${ROOM_LINE} · Admin`);
        expect(chatListItem(row('r2', { room: true }), undefined, now).subtitle).toBe(ROOM_LINE);
    });
});

describe('the screens that draw the chat list', () => {
    const source = (name: string) => readFileSync(new URL(`../../src/screens/${name}`, import.meta.url), 'utf8');

    it('draw every chat row with its marks, a room with the room tile, and keep runs and approvals pulled', () => {
        const rows = source('chat-rows.tsx');
        expect(rows).toContain('leading={row.room ? <RoomTile /> : <SocioAvatar character={row.character} />}');
        expect(rows).toContain('accessibilityLabel={item.accessibilityLabel}');
        expect(rows).toContain("export const CHAT_MARK_KINDS = ['runs', 'approvals'] as const;");
        for (const [file, synced] of [
            ['chats.tsx', 'const SYNCED = [...new Set([...ATTENTION_SYNCED, ...CHAT_MARK_KINDS])];'],
            [
                'home.tsx',
                "const SYNCED = ['shell', 'conversations', 'spaces', 'dots', 'room-invites', ...CHAT_MARK_KINDS] as const;",
            ],
        ] as const) {
            const screen = source(file);
            expect(screen, file).toContain(synced);
            expect(screen, file).toContain('useChatListItems(');
        }
        expect(source('chats.tsx')).toContain('<ChatListRow');
        expect(source('home-parts.tsx')).toContain('<ChatListRow');
        expect(source('home-parts.tsx')).not.toContain('<SocioAvatar character={chat.character} />');
    });
});
