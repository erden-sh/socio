import type { ApprovalView } from '@socio/shared/approvals';
import type { AgentRunSummary, Conversation } from '@socio/shared/types';

import { NEEDS_YOUR_APPROVAL } from '../chat/approval-card';

import type { ChatRow } from './chat-list';
import { SOCIO_STATE_LABEL } from './home';

// The chat list's marks (the PWA comparison's 3.2 to 3.4): on the Chats tab
// and Home's Rooms and Recent chats, a chat says "Needs your approval"
// while a request it asked waits, "Working" while a socio's reply runs, and
// when it was last active, in the list's short words ("2m", "Yesterday").
// All from what the scope syncs; no React Native, so tests/shell runs it
// under Node.
// - **Working** and **last active** come from the `runs` kind (`/api/runs`,
//   the latest 200 turns the person may list: their own, everyone's in a
//   room for its admin): a run still `running`, and the newest start or end,
//   never older than the chat itself.
// - **Needs your approval** joins the `approvals` kind (the person's own
//   requests). A request names the chat that asked it (`threadId`),
//   and marks that chat; `null` means no chat asked, so
//   it marks none. Servers older than that omit the field (`undefined`): then
//   the request goes to the chat with its socio whose run was going when it
//   was asked (the latest such run when two were), and one asked outside a
//   turn the list holds, or by a turn older than the latest 200, marks none.
// The rows keep the web's order (`createdAt` DESC, chat-list.ts).

export interface ChatMarks {
    /** The person's requests waiting that this chat's turns asked. */
    readonly approvals: number;
    /** A socio's reply runs in it now. */
    readonly working: boolean;
    /** When it was last active: its newest turn's end or start, else its creation. */
    readonly activeAt: number;
}

type MarkedChat = Pick<Conversation, 'id' | 'dotId' | 'createdAt'>;
type MarkRun = Pick<AgentRunSummary, 'threadId' | 'status' | 'startedAt' | 'finishedAt'>;
type MarkApproval = Pick<ApprovalView, 'dotId' | 'status' | 'createdAt' | 'threadId'>;

export function chatMarks(input: {
    readonly chats: readonly MarkedChat[];
    readonly runs: readonly MarkRun[];
    readonly approvals: readonly MarkApproval[];
}): ReadonlyMap<string, ChatMarks> {
    const chats = new Map(input.chats.map((chat) => [chat.id, chat]));
    const runs = input.runs.filter((run) => chats.has(run.threadId));
    const asked = new Map<string, number>();
    for (const approval of input.approvals) {
        if (approval.status !== 'pending') {
            continue;
        }
        if (approval.threadId !== undefined) {
            if (approval.threadId !== null && chats.has(approval.threadId)) {
                asked.set(approval.threadId, (asked.get(approval.threadId) ?? 0) + 1);
            }
            continue;
        }
        let during: MarkRun | null = null;
        for (const run of runs) {
            const going =
                chats.get(run.threadId)?.dotId === approval.dotId &&
                run.startedAt <= approval.createdAt &&
                (run.finishedAt === null || approval.createdAt <= run.finishedAt);
            if (going && (during === null || run.startedAt > during.startedAt)) {
                during = run;
            }
        }
        if (during !== null) {
            asked.set(during.threadId, (asked.get(during.threadId) ?? 0) + 1);
        }
    }
    const marks = new Map<string, ChatMarks>();
    for (const chat of input.chats) {
        const own = runs.filter((run) => run.threadId === chat.id);
        marks.set(chat.id, {
            approvals: asked.get(chat.id) ?? 0,
            working: own.some((run) => run.status === 'running'),
            activeAt: Math.max(chat.createdAt, ...own.map((run) => run.finishedAt ?? run.startedAt)),
        });
    }
    return marks;
}

/** A chat's time in the list: short to see ("2m"), whole to hear ("2 minutes ago"). */
export interface ListTime {
    readonly short: string;
    readonly spoken: string;
}

const MONTHS = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'} ago`;

/** Midnight of `at`'s day, on the phone's clock. */
const dayStart = (at: number) => {
    const date = new Date(at);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

/** Whole days from `at`'s day to `now`'s, on the phone's calendar (a clock change doesn't count). */
const daysBetween = (at: number, now: number) => Math.round((dayStart(now) - dayStart(at)) / 86_400_000);

/**
 * When a chat was last active, as Messages, Slack and ChatGPT's lists say it,
 * on the phone's calendar: "Now" under a minute, "5m" under an hour, "3h"
 * the same day, "Yesterday", the weekday ("Mon") within the week, then the
 * date ("Nov 8"), with its year when it isn't this one. A time ahead of the
 * phone's clock (a server's) reads as now.
 */
export function listTime(at: number, now: number): ListTime {
    const minutes = Math.floor(Math.max(0, now - at) / 60_000);
    if (minutes < 1) {
        return { short: 'Now', spoken: 'Just now' };
    }
    if (minutes < 60) {
        return { short: `${minutes}m`, spoken: unit(minutes, 'minute') };
    }
    const days = daysBetween(at, now);
    if (days <= 0) {
        const hours = Math.floor(minutes / 60);
        return { short: `${hours}h`, spoken: unit(hours, 'hour') };
    }
    if (days === 1) {
        return { short: 'Yesterday', spoken: 'Yesterday' };
    }
    const date = new Date(at);
    if (days < 7) {
        const weekday = WEEKDAYS[date.getDay()]!;
        return { short: weekday.slice(0, 3), spoken: weekday };
    }
    const month = MONTHS[date.getMonth()]!;
    const day = `${month.slice(0, 3)} ${date.getDate()}`;
    const spoken = `${month} ${date.getDate()}`;
    return date.getFullYear() === new Date(now).getFullYear()
        ? { short: day, spoken }
        : { short: `${day}, ${date.getFullYear()}`, spoken: `${spoken}, ${date.getFullYear()}` };
}

/** What a room row says under its title: that it's a room, and the reader's role (the web's "Admin"). */
export const ROOM_LINE = 'Room';

/** One row of the chat list as the Chats tab and Home draw it. */
export interface ChatListItem {
    readonly row: ChatRow;
    /** Under the title: the socio for a chat; "Room", with "Admin" when the reader is one, for a room. */
    readonly subtitle: string | null;
    /** "Needs your approval" while a request it asked waits; else null. */
    readonly approval: string | null;
    /** "Working" while a reply runs; else null. */
    readonly working: string | null;
    /** When it was last active; null when the marks don't cover it. */
    readonly time: ListTime | null;
    /** Everything the row shows, marks and time included, for a screen reader. */
    readonly accessibilityLabel: string;
}

/** A chat row with its marks, at `now`. A row the marks don't cover shows none, and no time. */
export function chatListItem(row: ChatRow, marks: ChatMarks | undefined, now: number): ChatListItem {
    const approvals = marks?.approvals ?? 0;
    const approval = approvals > 0 ? NEEDS_YOUR_APPROVAL : null;
    const working = marks?.working === true ? SOCIO_STATE_LABEL.working : null;
    const time = marks === undefined ? null : listTime(marks.activeAt, now);
    const subtitle = row.room ? [ROOM_LINE, row.roomRole].filter((part) => part !== null).join(' · ') : row.socio;
    return {
        row,
        subtitle,
        approval,
        working,
        time,
        accessibilityLabel: [
            row.accessibilityLabel,
            approval === null ? null : approvals > 1 ? `${approval}, ${approvals} requests` : approval,
            working,
            time?.spoken ?? null,
        ]
            .filter((part) => part !== null)
            .join(', '),
    };
}
