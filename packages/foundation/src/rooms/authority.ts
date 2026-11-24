import { turnContextProblems, type ConversationKind, type TurnContext } from '@socio/shared/rooms/rooms';
import type { RunActor } from '@socio/shared/runs/run-trace';

/**
 * Execution authority in rooms (CB-209): whose
 * access, resources, subscription and approvals a turn uses. A room turn
 * runs as the person who sent the message: their
 * computer home, data space, connections, memories they share with team
 * chats, approvals and subscription. When they may not work there the
 * socio stops and says so; it never falls back to the room's creator, a
 * room admin or a socio's owner. Every tool, Data, computer, MCP and
 * inference path keys on the turn's person (`DotTurn.userId`), which is
 * what this decides, so none of them needs room rules of its own.
 *
 * It is also where a turn's person must still be active (CB-528): a
 * deactivated person's chat, Telegram, scheduled, goal, work cycle or
 * approval turn is refused here, before any tool runs, and a watcher
 * stops a running turn (its tools and action skills such as `/compact`
 * too) once they are deactivated mid-turn.
 */

/**
 * Why a turn may not run as anyone: a room turn nobody sent, one whose
 * acting person is not its sender, a personal socio in a room (company
 * socios only in v1) or for someone not its owner, a context that breaks
 * the rules, a sender who may not work in the room now, or a person who is
 * no longer active (deactivated, CB-528).
 */
export type TurnAuthorityRefusal =
    | 'no_person'
    | 'not_sender'
    | 'personal_socio'
    | 'context'
    | 'room_access'
    | 'inactive';

export type TurnAuthority = { ok: true; actingUserId: string } | { ok: false; reason: TurnAuthorityRefusal };

export interface TurnAuthorityInput {
    conversation: { id: string; kind?: ConversationKind; ownerId: string };
    socio: { id: string; ownerId?: string | null };
    /** The work cycle's context, when the turn is a step of one (CB-211). */
    context?: TurnContext;
    /** Set by the server for a channel turn (a Telegram topic's sender). */
    actingUserId?: string;
    /** Who started the turn (CB-185): in a room, the person who sent it. */
    trigger?: RunActor;
    /** Whether a person may send in the conversation now (`roomAllows`). */
    maySend: (userId: string) => boolean;
    /** Whether a person is still active: not deactivated (CB-528). */
    active: (userId: string) => boolean;
}

/**
 * The one answer to "whose turn is this": the context's acting person,
 * else the channel's, else in a room the sender and in a private chat its
 * owner. A room turn never acts for anyone but the person who started it,
 * who must still be allowed to send there.
 */
export function turnAuthority(input: TurnAuthorityInput): TurnAuthority {
    const { conversation, socio, context, trigger } = input;
    const room = conversation.kind === 'room';
    const sender = trigger?.kind === 'person' && trigger.id ? trigger.id : undefined;
    let actingUserId: string | undefined;
    if (context) {
        if (
            turnContextProblems(context).length ||
            context.conversationId !== conversation.id ||
            context.socio.dotId !== socio.id ||
            (input.actingUserId !== undefined && input.actingUserId !== context.actingUserId)
        ) {
            return { ok: false, reason: 'context' };
        }
        actingUserId = context.actingUserId;
    } else if (room) {
        // The person who sent it; a server-set acting person must be them.
        if (input.actingUserId !== undefined && sender !== undefined && input.actingUserId !== sender) {
            return { ok: false, reason: 'not_sender' };
        }
        actingUserId = input.actingUserId ?? sender;
    } else {
        actingUserId = input.actingUserId ?? conversation.ownerId;
    }
    if (!actingUserId) {
        return { ok: false, reason: 'no_person' };
    }
    // Nothing acts for a deactivated person, whatever started the turn.
    if (!input.active(actingUserId)) {
        return { ok: false, reason: 'inactive' };
    }
    if (room) {
        // Company socios only: nobody's own socio, its owner's
        // computer, data and connections, ever runs in a room.
        if (socio.ownerId) {
            return { ok: false, reason: 'personal_socio' };
        }
        if (!input.maySend(actingUserId)) {
            return { ok: false, reason: 'room_access' };
        }
    } else if (socio.ownerId && socio.ownerId !== actingUserId)
    // Today's rule: a person's own socio works only for them.
    {
        return { ok: false, reason: 'personal_socio' };
    }
    return { ok: true, actingUserId };
}

/** What an approval's requester is told when their standing is gone. */
export const ROOM_APPROVAL_GONE =
    'You can no longer work in this room, so this request can’t be decided or carried out.';

/** What an approval's requester is told once they are deactivated (CB-528). */
export const PERSON_INACTIVE_APPROVAL = 'Its person is deactivated, so this request can’t be decided or carried out.';

/**
 * Whether a request's person may still decide it, and its action still
 * run (CB-209): never once they are deactivated (CB-528), and in a room
 * only while they may send there (an active member, the room not
 * archived, Rooms on). Undefined: they may; else why not. Private chats
 * and requests from no conversation need only an active person.
 * A room admin is never a resource approver: only the person whose access
 * the request uses decides it.
 */
export function requesterStanding(
    workspace: {
        thread: (id: string) => { id: string; kind?: ConversationKind } | undefined;
        allows: (userId: string, id: string, action: 'send') => boolean;
        /** Whether a person is deactivated (CB-528). */
        isDeactivated: (userId: string) => boolean;
    },
    request: { userId: string; threadId: string | null },
): string | undefined {
    if (workspace.isDeactivated(request.userId)) {
        return PERSON_INACTIVE_APPROVAL;
    }
    if (!request.threadId) {
        return undefined;
    }
    const thread = workspace.thread(request.threadId);
    if (thread?.kind !== 'room') {
        return undefined;
    }
    return workspace.allows(request.userId, thread.id, 'send') ? undefined : ROOM_APPROVAL_GONE;
}

/**
 * The line an approval from a room carries for its person (CB-209): where
 * it was asked and who will read what comes of it, so they decide knowing
 * the disclosure. The request and its result stay theirs; the socio's
 * reply in the room is read by every member.
 */
export const roomApprovalLine = (title: string) =>
    // oxlint-disable-next-line no-control-regex -- one line of text
    `Asked in the room “${title.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 120)}”. Only you can decide it and see these details; the socio’s reply there is read by everyone in the room, so it shares only what you ask it to.`;
