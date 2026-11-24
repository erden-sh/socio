import type { ApprovalView } from '@socio/shared/approvals';
import type { InAppNotice } from '@socio/shared/notifications';
import { pageTitle } from '@socio/shared/pages/page-draft';
import type { Conversation, Dot, State } from '@socio/shared/types';

import type { PageConflict } from '../sync/page-conflicts';

import { type InboxApprovals, inboxApprovals } from './approvals';
import { byNewest, type ChatRow, chatList } from './chat-list';
import { UNTITLED_PAGE } from './space-library';

// What needs the person's attention, at the top of Chats (CB-455; it was the
// Inbox tab until the owner dropped it, 2026-11-19). Until the server keeps a
// notification history, the app builds it from what the scope holds, in this
// order (`sections`):
// 1. the approvals waiting for the person (approvals.ts: the newest few, then
//    See all);
// 2. the in-app notices, the server's mentions among them, newest first: with
//    `now`, only the last day's (the server's 24 h), since the device keeps up
//    to 200 and each already showed as a banner: older ones would hold the
//    section open at the top of Chats for good;
// 3. the room invites (room-invites.ts's `inviteRows`: none while rooms are off);
// 4. the rooms with unread, from the chat list's own rows (so the same rules:
//    no archived chat, rooms only while they're on, unread capped);
// 5. the row saying notifications are off (the phone's permission is denied).
// A part with nothing in it isn't a section. The Chats tab's badge
// (`attentionCount`) counts what waits on the person: each approval waiting,
// room invite and room with unread; not the notices, which showed as banners,
// nor the notifications row, a setting.
// What the Inbox held about Spaces is at the top of the Spaces tab's list
// instead (the owner, 2026-11-20; `spacesAttentionView`): the pages changed
// elsewhere while the person's edits waited (one row per page with a
// conflict, oldest first, each opening the page under the conflict banner),
// which the Spaces tab's badge counts (`spacesAttention`). No React Native,
// so tests/shell runs it under Node.

export interface NoticeRow {
    readonly id: string;
    readonly title: string;
    /** The notice's words, or null when it has none. */
    readonly body: string | null;
    /** The web path it opens (opening it comes later). */
    readonly link: string;
    /** What a screen reader says for the row. */
    readonly accessibilityLabel: string;
}

/** A room invite, from the scope's `roomInvites` (room-invites.ts's `inviteRows`). */
export interface InviteRow {
    readonly id: string;
    readonly title: string;
    readonly subtitle: string | null;
    readonly accessibilityLabel: string;
}

/** A page changed elsewhere while the person's edits to it waited: it opens the page, under the conflict banner. */
export interface PageConflictRow {
    /** The page's id: one row per page. */
    readonly id: string;
    readonly spaceId: string;
    readonly title: string;
    /** The Space's name, and how many versions of the person's wait when more than one. */
    readonly subtitle: string;
    readonly accessibilityLabel: string;
}

/** The heading over the pages with conflicts, at the top of the Spaces list. */
export const PAGES_CHANGED = 'Pages changed elsewhere';
/** A Space the phone doesn't list. */
const SOME_SPACE = 'A Space';

/**
 * One row per page with conflicts (`allPageConflicts`, oldest first), in the
 * order of each page's oldest: the page's title as it is now (theirs), else as
 * the person wrote it. `spaceName` is the Space's name, or null when the phone
 * doesn't list it.
 */
export function pageConflictRows(
    conflicts: readonly PageConflict[],
    spaceName: (spaceId: string) => string | null,
): PageConflictRow[] {
    const byPage = new Map<string, PageConflict[]>();
    for (const conflict of conflicts) {
        const list = byPage.get(conflict.pageId);
        if (list === undefined) {
            byPage.set(conflict.pageId, [conflict]);
        } else {
            list.push(conflict);
        }
    }
    return [...byPage.values()].map((list) => {
        const [oldest] = list as [PageConflict, ...PageConflict[]];
        const title = pageTitle(oldest.theirs?.title ?? oldest.mine.title) || UNTITLED_PAGE;
        const spaceId = oldest.theirs?.spaceId ?? oldest.spaceId;
        const space = spaceName(spaceId) ?? SOME_SPACE;
        const versions = list.length > 1 ? `${list.length} versions of yours wait` : null;
        const subtitle = versions === null ? space : `${space} · ${versions}`;
        return {
            id: oldest.pageId,
            spaceId,
            title,
            subtitle,
            accessibilityLabel: [title, 'changed elsewhere', `in ${space}`, versions].filter(Boolean).join(', '),
        };
    });
}

/** What the attention section at the top of Chats shows, in order. */
export type InboxSection = 'approvals' | 'notices' | 'invites' | 'rooms' | 'notifications';

/** What the attention section takes beyond the scope's collections: room invites and the notification permission. */
export interface InboxExtras {
    readonly invites?: readonly InviteRow[];
    /** The phone's notifications are denied for Socio (the notification ask's `notificationsDenied`). */
    readonly notificationsDenied?: boolean;
    /** The clock, in ms: given, only the notices of the last day (`NOTICE_DAY_MS`) show. */
    readonly now?: number;
}

/** How long a notice stays in the attention section: the server's day. */
export const NOTICE_DAY_MS = 24 * 60 * 60_000;

// The denied row's words are Settings' too (src/push/permission-ask.ts).
export { NOTIFICATIONS_OFF, NOTIFICATIONS_OFF_HINT } from '../push/permission-ask';

export interface InboxView {
    /** The sections that have something, in the Inbox's order. */
    readonly sections: readonly InboxSection[];
    readonly approvals: InboxApprovals;
    /** Newest first. */
    readonly notices: readonly NoticeRow[];
    /** Rooms with unread, in the chat list's order. */
    readonly rooms: readonly ChatRow[];
    readonly invites: readonly InviteRow[];
    readonly notificationsDenied: boolean;
    /** Nothing to show. */
    readonly empty: boolean;
}

export function inboxView(
    approvals: readonly ApprovalView[],
    notices: readonly InAppNotice[],
    conversations: readonly Conversation[],
    dots: readonly Dot[],
    state: Pick<State, 'settings'> | null | undefined,
    extras: InboxExtras = {},
): InboxView {
    const waiting = inboxApprovals(approvals);
    const now = extras.now;
    const recent = now === undefined ? notices : notices.filter((notice) => now - notice.createdAt < NOTICE_DAY_MS);
    const noticeRows = [...recent].sort(byNewest).map((notice) => {
        const title = notice.title.trim() === '' ? 'Notice' : notice.title;
        const body = notice.body.trim() === '' ? null : notice.body;
        return {
            id: notice.id,
            title,
            body,
            link: notice.link,
            accessibilityLabel: body === null ? title : `${title}, ${body}`,
        };
    });
    const rooms = chatList(conversations, dots, state).filter((row) => row.room && row.unread !== null);
    const invites = extras.invites ?? [];
    const notificationsDenied = extras.notificationsDenied === true;
    const sections: InboxSection[] = [];
    if (waiting.waiting > 0) {
        sections.push('approvals');
    }
    if (noticeRows.length > 0) {
        sections.push('notices');
    }
    if (invites.length > 0) {
        sections.push('invites');
    }
    if (rooms.length > 0) {
        sections.push('rooms');
    }
    if (notificationsDenied) {
        sections.push('notifications');
    }
    return {
        sections,
        approvals: waiting,
        notices: noticeRows,
        rooms,
        invites,
        notificationsDenied,
        empty: sections.length === 0,
    };
}

/** What the top of the Spaces list shows (the owner, 2026-11-20): the pages changed elsewhere, by their oldest conflict. */
export interface SpacesAttentionView {
    readonly pageConflicts: readonly PageConflictRow[];
    /** Nothing to show: no section. */
    readonly empty: boolean;
}

export function spacesAttentionView(pageConflicts: readonly PageConflictRow[]): SpacesAttentionView {
    return { pageConflicts, empty: pageConflicts.length === 0 };
}

/**
 * What the Spaces tab's badge counts (CB-459): the pages changed elsewhere while the person's edits
 * waited, one per page however many of its saves met the change (as the rows group them).
 */
export function spacesAttention(conflicts: readonly PageConflict[]): number {
    return new Set(conflicts.map((conflict) => conflict.pageId)).size;
}

/** What the Chats tab's badge counts: each approval waiting, room invite and room with unread (the pages are Spaces'). */
export function attentionCount(view: InboxView): number {
    return view.approvals.waiting + view.invites.length + view.rooms.length;
}
