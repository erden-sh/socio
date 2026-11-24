import { ROOM_NOTIFY_CHOICES, type RoomNotifyLevel } from '@socio/shared/rooms/room-notices';
import type { RoomInvite } from '@socio/shared/rooms/rooms';
import type { State } from '@socio/shared/types';

import type { RoomActionBlock, RoomActionOutcome, RoomActions } from '../sync/room-actions';

import { roomsOn } from './chat-list';
import type { InviteRow } from './inbox';

// Room invites and the room's menu, the web's InvitesDialog and room menu on
// a phone. No React Native, so tests/shell runs it under Node.
// - The invites show only while the workspace has rooms on (the web's
//   `useRoomInvites(roomsOn(state))`), newest first: in the Inbox and above
//   Home's Rooms. A row opens the invite's sheet, which shows the disclosure
//   before Join (accepting posts its version) and Decline.
// - The room's menu: the reader's notification level (shared's
//   `ROOM_NOTIFY_CHOICES`), Members and "Open in your browser".
// - "New room" (Home's Rooms) opens the app's own New room (CB-470, the owner's
//   reversal of the earlier plan for making a room: src/shell/new-room.ts).
// Every outcome is worded here by its kind and code, never the server's text.

export const INVITES_TITLE = 'Invites';
export const JOIN = 'Join';
export const DECLINE = 'Decline';
export const NEW_ROOM = 'New room';
export const NEW_ROOM_HINT = 'People and socios in one conversation';
export const JOIN_HINT = 'Joins the room and shares what the text above says';
/** A room's page on the web, for "Open in your browser" (through useOpenLink). */
export const roomWebHref = (roomId: string) => `/chats/${encodeURIComponent(roomId)}`;
export const NOTIFICATIONS_TITLE = 'Notifications';
export const MEMBERS = 'Members';
export const NOTIFY_OFFLINE = 'Your notification setting shows once you’re online.';

/** The invites the person sees, newest first, as Inbox and Home rows; none while rooms are off. */
export function inviteRows(
    invites: readonly RoomInvite[],
    state: Pick<State, 'settings'> | null | undefined,
): InviteRow[] {
    if (!roomsOn(state)) {
        return [];
    }
    return [...invites]
        .sort((a, b) => b.invitedAt - a.invitedAt || a.title.localeCompare(b.title))
        .map((invite) => {
            const subtitle = invitedLine(invite);
            return {
                id: invite.roomId,
                title: invite.title,
                subtitle,
                accessibilityLabel: `Invite to ${invite.title}, ${subtitle}`,
            };
        });
}

/** "Ana invited you as an admin · 3 people in it", the web's line without its date. */
export function invitedLine(invite: Pick<RoomInvite, 'invitedByName' | 'role' | 'memberCount'>): string {
    const who = invite.invitedByName?.trim() ? `${invite.invitedByName.trim()} invited you` : 'You were invited';
    const people = invite.memberCount === 1 ? 'person' : 'people';
    return `${who}${invite.role === 'admin' ? ' as an admin' : ''} · ${invite.memberCount} ${people} in it`;
}

export interface InviteDetail {
    readonly title: string;
    /** Who asked, the role, how many are in it and, when it runs out, until when. */
    readonly line: string;
    /** What joining shares: the server's disclosure, shown before Join. */
    readonly disclosure: string;
    readonly disclosureVersion: number;
}

/** An invite's sheet. */
export function inviteDetail(invite: RoomInvite, timeZone?: string): InviteDetail {
    const until =
        invite.inviteExpiresAt === null
            ? ''
            : ` · until ${new Date(invite.inviteExpiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone })}`;
    return {
        title: invite.title,
        line: `${invitedLine(invite)}${until}`,
        disclosure: invite.disclosure.text,
        disclosureVersion: invite.disclosure.version,
    };
}

/** Why a request can't go now, in the screens' words. */
export const BLOCK_COPY: Readonly<Record<RoomActionBlock, string>> = {
    offline: 'Needs a connection',
    away: 'Needs a connection',
    'sign-in': 'Sign in again to do this',
    update: 'Update Socio to do this',
};

/** The refusals' words, by code (shared's `RoomRefusal`) or status. */
const REFUSAL_COPY: Readonly<Record<string, string>> = {
    expired: 'This invite has run out. Ask for a new one.',
    rooms_off: 'Rooms are off in this workspace.',
    archived: 'This room is archived.',
    disclosure: 'What joining shares has changed. Open the invite again.',
    'http-401': 'Sign in again to do this',
    'http-429': 'Too many tries. Wait a moment.',
};
export const ACTION_FALLBACK = 'That didn’t work. Try again.';
export const INVITE_GONE = 'This invite isn’t there any more.';
export const ROOM_GONE = 'You are no longer in this room.';
export const NO_ANSWER = 'No answer from the workspace. Check before you try again.';

/** What an outcome says on screen, or null when it worked (or another request is going). */
export function roomActionCopy(outcome: RoomActionOutcome<unknown>, about: 'invite' | 'room'): string | null {
    switch (outcome.kind) {
        case 'done':
        case 'busy':
            return null;
        case 'blocked':
            return BLOCK_COPY[outcome.reason];
        case 'gone':
            return about === 'invite' ? INVITE_GONE : ROOM_GONE;
        case 'no-answer':
            return NO_ANSWER;
        case 'refused':
            return REFUSAL_COPY[outcome.reason] ?? ACTION_FALLBACK;
    }
}

export const NOTIFY_RETRY = 'Try again';

/**
 * When the room menu reads the reader's level again after a read: once the
 * room's other request ends (`when-free`: this one wasn't sent), on Try again
 * (`button`: no answer, gone or refused), or never (read; or offline, which
 * reads again as the connection comes back).
 */
export function notifyReadRetry(outcome: RoomActionOutcome<unknown>): 'when-free' | 'button' | null {
    switch (outcome.kind) {
        case 'done':
        case 'blocked':
            return null;
        case 'busy':
            return 'when-free';
        case 'gone':
        case 'no-answer':
        case 'refused':
            return 'button';
    }
}

/**
 * Calls `then` once, as soon as room `id` has no request going: at once when
 * the other request ended before the subscription was in place, else on the
 * change that frees it. Returns the stop, which the caller runs on unmount.
 */
export function whenRoomFree(
    actions: Pick<RoomActions, 'busy' | 'subscribe'>,
    id: string,
    then: () => void,
): () => void {
    let done = false;
    let off = () => {};
    const check = () => {
        if (!done && !actions.busy(id)) {
            done = true;
            off();
            then();
        }
    };
    off = actions.subscribe(check);
    // The other request may have ended between the refusal and the subscription.
    if (done) {
        off();
    }
    check();
    return () => {
        done = true;
        off();
    };
}

export interface NotifyChoice {
    readonly level: RoomNotifyLevel;
    readonly label: string;
    readonly note: string;
    readonly selected: boolean;
    readonly accessibilityLabel: string;
}

/** The room menu's notification choices, the reader's marked; none marked until it has been read. */
export function notifyChoices(level: RoomNotifyLevel | null): NotifyChoice[] {
    return ROOM_NOTIFY_CHOICES.map((choice) => ({
        level: choice.level,
        label: choice.label,
        note: choice.note,
        selected: choice.level === level,
        accessibilityLabel: `${choice.label}. ${choice.note}`,
    }));
}
