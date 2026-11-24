import type { RunActor } from '../runs/run-trace.js';

/**
 * Rooms (CB-205): the contract every Rooms lane
 * builds against. A room is a conversation (`thread_bindings` row, same id,
 * links and history) of kind `room`, whose lead socio is its `dotId` and
 * whose people and socios are in the rooms module's own tables. Types and
 * pure rules only: nothing here reads storage or is wired into a route.
 */

// ---- Conversations and their owners --------------------------------------

/** `thread_bindings.kind`: every existing chat is `private`. */
export const CONVERSATION_KINDS = ['private', 'room'] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

/**
 * A room's `thread_bindings.ownerId`: no person, so every owner-only check
 * that has not moved to the room rules fails closed.
 */
export const ROOM_OWNER_PREFIX = 'room:';
/** A legacy Telegram team topic's owner (`teamOwner`, telegram-channel.ts). */
export const TEAM_OWNER_PREFIX = 'telegram-team:';
export const roomOwnerId = (roomId: string) => `${ROOM_OWNER_PREFIX}${roomId}`;
export const isRoomOwnerId = (ownerId: string) => ownerId.startsWith(ROOM_OWNER_PREFIX);
export const isTeamOwnerId = (ownerId: string) => ownerId.startsWith(TEAM_OWNER_PREFIX);
/** Owner ids no person may have (a user id with one is refused). */
export const reservedOwnerId = (id: string) => isRoomOwnerId(id) || isTeamOwnerId(id);

/** What the room rules need of a conversation row. */
export interface ConversationRecord {
    id: string;
    kind: ConversationKind;
    ownerId: string;
    /** Set while it is archived. */
    archivedAt?: number | null;
}

/** A conversation's shape for the rules: a person's, a legacy topic or a room. */
export type ConversationShape = 'private' | 'legacy-topic' | 'room';
export function conversationShape(thread: Pick<ConversationRecord, 'kind' | 'ownerId'>): ConversationShape {
    if (thread.kind === 'room') {
        return 'room';
    }
    return isTeamOwnerId(thread.ownerId) ? 'legacy-topic' : 'private';
}

// ---- Members ---------------------------------------------------------------

export const ROOM_ROLES = ['admin', 'member'] as const;
export type RoomRole = (typeof ROOM_ROLES)[number];

/**
 * A person's membership: invited until they accept (no history before),
 * active, or ended. An ended row stays, for the audit and so that a legacy
 * topic reader who was removed does not read on.
 */
export const ROOM_MEMBER_STATUSES = ['invited', 'active', 'declined', 'expired', 'left', 'removed'] as const;
export type RoomMemberStatus = (typeof ROOM_MEMBER_STATUSES)[number];

/** A `room_members` row. */
export interface RoomMember {
    roomId: string;
    userId: string;
    role: RoomRole;
    status: RoomMemberStatus;
    invitedBy: string | null;
    invitedAt: number;
    /** When an invite stops working; null: it does not expire. */
    inviteExpiresAt: number | null;
    acceptedAt: number | null;
    /** The history disclosure they accepted (`ROOM_DISCLOSURE_VERSION`). */
    disclosureVersion: number | null;
    endedAt: number | null;
    endedBy: string | null;
}

/** Bumped when the text shown before joining changes; acceptance records it. */
export const ROOM_DISCLOSURE_VERSION = 1;
/**
 * What a person is told before they join, at `ROOM_DISCLOSURE_VERSION`:
 * accepting records that version. Shown again, in other words, before a
 * private chat becomes a room.
 */
export const ROOM_DISCLOSURE_TEXT =
    'Joining gives you the room’s whole shared history, from before you joined too, and everyone in the room reads what you write in it. What a socio did with another member’s own access (their files, data, connections) stays theirs.';
/**
 * What the person converting their private chat confirms (CB-208): the
 * people they invite will read all of it.
 */
export const ROOM_CONVERT_TEXT =
    'Everyone you invite to this room will read this chat’s whole history, including what you wrote before it became a room.';
/** How long an invite works unless an admin chose otherwise. */
export const ROOM_INVITE_TTL_MS = 7 * 24 * 60 * 60_000;

export const ROOM_MEMBER_ACTIONS = ['invite', 'accept', 'decline', 'expire', 'leave', 'remove'] as const;
export type RoomMemberAction = (typeof ROOM_MEMBER_ACTIONS)[number];

/**
 * The status a membership moves to, or null when the action is not allowed
 * from where it is (`undefined`: no row yet). Who may act, and an invite's
 * expiry, are checked apart (`roomAllows`, `inviteUsable`).
 */
export function memberTransition(
    current: RoomMemberStatus | undefined,
    action: RoomMemberAction,
): RoomMemberStatus | null {
    switch (action) {
        case 'invite':
            return current === 'invited' || current === 'active' ? null : 'invited';
        case 'accept':
            return current === 'invited' ? 'active' : null;
        case 'decline':
            return current === 'invited' ? 'declined' : null;
        case 'expire':
            return current === 'invited' ? 'expired' : null;
        case 'leave':
            return current === 'active' ? 'left' : null;
        case 'remove':
            return current === 'invited' || current === 'active' ? 'removed' : null;
    }
}

/** Whether an invite can still be accepted at `now`. */
export const inviteUsable = (member: Pick<RoomMember, 'status' | 'inviteExpiresAt'> | undefined, now: number) =>
    member?.status === 'invited' && (member.inviteExpiresAt === null || now < member.inviteExpiresAt);

/**
 * Whether a change leaves an active room without an admin: the last admin
 * must hand the role on, or archive the room, first.
 */
export function leavesNoAdmin(
    members: readonly Pick<RoomMember, 'userId' | 'role' | 'status'>[],
    change: { userId: string; status?: RoomMemberStatus; role?: RoomRole },
): boolean {
    const admins = members.filter((member) => {
        const changed = member.userId === change.userId;
        const status = changed ? (change.status ?? member.status) : member.status;
        const role = changed ? (change.role ?? member.role) : member.role;
        return status === 'active' && role === 'admin';
    });
    return admins.length === 0;
}

// ---- Socios ----------------------------------------------------------------

/**
 * A socio in a room. v1: company socios only (`ownerId` null); a personal
 * socio is refused. The lead is `thread_bindings.dotId` and must be an
 * active room socio.
 */
export const ROOM_SOCIO_STATUSES = ['requested', 'active', 'withdrawn', 'removed'] as const;
export type RoomSocioStatus = (typeof ROOM_SOCIO_STATUSES)[number];
export interface RoomSocio {
    roomId: string;
    dotId: string;
    status: RoomSocioStatus;
    requestedBy: string;
    /** Who authorized it: a workspace admin for a company socio. */
    authorizedBy: string | null;
    authorizedAt: number | null;
    endedAt: number | null;
}
/** Whether a socio may be in a room at all in v1. */
export const roomEligibleSocio = (dot: { ownerId?: string | null; archivedAt?: number | null }) =>
    !dot.ownerId && !dot.archivedAt;

// ---- Access -----------------------------------------------------------------

/**
 * What a person does to a conversation. `read` covers history, the live
 * stream (connect), the transcript, attachments and reactions; `send`
 * covers a message, a queued message and starting a turn; `manage` covers
 * rename, invite, remove, roles, the lead socio, socios, source bindings
 * and lowering limits.
 */
export const ROOM_ACTIONS = [
    'read',
    'send',
    'stop',
    'manage',
    'archive',
    'unarchive',
    'leave',
    'convert',
    'delete',
] as const;
export type RoomAction = (typeof ROOM_ACTIONS)[number];

/**
 * Why an action is refused. Routes answer `not_found` as a 404, as they do
 * for another person's chat today, so ids can't be probed.
 */
export type RoomDenial = 'not_found' | 'not_admin' | 'archived' | 'rooms_off' | 'read_only' | 'not_initiator';

/**
 * What a person is told when refused (CB-208). `not_found` reads as the
 * conversation missing, as for another person's chat.
 */
export const ROOM_DENIAL_MESSAGES: Record<RoomDenial, string> = {
    not_found: 'Conversation not found.',
    not_admin: 'Only a room admin can do that.',
    archived: 'This room is archived: unarchive it first.',
    rooms_off: 'Rooms are turned off in Settings, so this room is read-only.',
    read_only: 'This conversation is read-only here.',
    not_initiator: 'Only the person who sent the message, or a room admin, can stop it.',
};

export type RoomDecision =
    | { allowed: true; via: 'owner' | 'member' | 'legacy-topic' }
    | { allowed: false; reason: RoomDenial };

export interface RoomViewer {
    userId: string;
    /** Their `room_members` row in this conversation, if any. */
    member?: Pick<RoomMember, 'role' | 'status'>;
    /** A linked person observed in the topic's Telegram group (legacy reader). */
    topicReader?: boolean;
}

export interface RoomRuleOptions {
    /** Settings → Rooms: off by default. */
    roomsEnabled: boolean;
    /** For `stop`: who started the work cycle running now. */
    cycleInitiatorId?: string;
}

const allow = (via: 'owner' | 'member' | 'legacy-topic'): RoomDecision => ({
    allowed: true,
    via,
});
const deny = (reason: RoomDenial): RoomDecision => ({ allowed: false, reason });

/**
 * The one rule for who may do what in a conversation. A private chat keeps
 * today's rules exactly; a legacy topic stays read-only for its observed
 * readers until a member row ends that; a room needs an active membership,
 * and with Rooms switched off it is read-only.
 */
export function roomAllows(
    thread: Pick<ConversationRecord, 'kind' | 'ownerId' | 'archivedAt'>,
    viewer: RoomViewer,
    action: RoomAction,
    options: RoomRuleOptions,
): RoomDecision {
    const shape = conversationShape(thread);
    const archived = !!thread.archivedAt;
    if (shape === 'private') {
        if (thread.ownerId !== viewer.userId) {
            return deny('not_found');
        }
        if (action === 'leave') {
            return deny('not_found');
        }
        if (action === 'convert') {
            if (!options.roomsEnabled) {
                return deny('rooms_off');
            }
            return archived ? deny('archived') : allow('owner');
        }
        return allow('owner');
    }
    const status = viewer.member?.status;
    if (shape === 'legacy-topic') {
        // A topic a room admin has not converted: as today, read-only for the
        // linked people seen in its group; an ended member row ends that.
        const ended = status && status !== 'invited' && status !== 'active';
        if (!viewer.topicReader || ended) {
            return deny('not_found');
        }
        return action === 'read' ? allow('legacy-topic') : deny('read_only');
    }
    if (status !== 'active') {
        // Observed Telegram readers of a converted topic read on until they
        // accept, decline or are removed; never more than read.
        if (viewer.topicReader && status !== undefined && status !== 'invited') {
            return deny('not_found');
        }
        if (viewer.topicReader && action === 'read') {
            return allow('legacy-topic');
        }
        return deny('not_found');
    }
    const admin = viewer.member?.role === 'admin';
    switch (action) {
        case 'read':
        case 'leave':
            return allow('member');
        case 'convert':
        case 'delete':
            // Rooms are archived, never deleted, in v1; only a private chat converts.
            return deny('read_only');
        case 'unarchive':
            if (!options.roomsEnabled) {
                return deny('rooms_off');
            }
            if (!admin) {
                return deny('not_admin');
            }
            return archived ? allow('member') : deny('read_only');
        default:
            break;
    }
    if (!options.roomsEnabled) {
        return deny('rooms_off');
    }
    if (archived) {
        return deny('archived');
    }
    if (action === 'send') {
        return allow('member');
    }
    if (action === 'stop') {
        return admin || (options.cycleInitiatorId !== undefined && options.cycleInitiatorId === viewer.userId)
            ? allow('member')
            : deny('not_initiator');
    }
    return admin ? allow('member') : deny('not_admin');
}

// ---- Actors and private artifacts ----------------------------------------

/**
 * Who wrote a room message, by stable id; a display name is looked up when
 * shown and is never the identity (CB-210).
 */
export type RoomActorKind = 'person' | 'socio' | 'system';
export interface RoomActor {
    kind: RoomActorKind;
    id: string;
}
/** A stable key for an actor: identical names stay distinct. */
export const actorKey = (actor: RoomActor) => `${actor.kind}:${actor.id}`;
export const sameActor = (a: RoomActor, b: RoomActor) => a.kind === b.kind && a.id === b.id;

/**
 * Who may see a stored artifact of a room turn (a raw tool result, an
 * approval payload): the room, or only the person the turn acted for.
 * Room members and other people's later turns get the artifact's summary.
 */
export type ArtifactVisibility = 'room' | 'actor';
export const artifactVisibleTo = (
    artifact: { visibility: ArtifactVisibility; actingUserId: string },
    viewerUserId: string,
) => artifact.visibility === 'room' || artifact.actingUserId === viewerUserId;

// ---- Turn context -----------------------------------------------------------

/**
 * Who pays for a turn's model use: the acting person (their own
 * subscription) or the workspace (its shared model). Never another member.
 */
export type BillingPrincipal = { kind: 'person'; userId: string } | { kind: 'workspace' };

/**
 * Everything a turn step runs under: which conversation and work cycle, who
 * started the cycle, whose access it uses, which socio executes this step
 * and who pays. A handoff keeps all of it but the socio and `hop`.
 */
export interface TurnContext {
    conversationId: string;
    kind: ConversationKind;
    /** The work cycle (CB-211): one human request and all it leads to. */
    cycleId: string;
    /** Who started the cycle (CB-185's trigger): a person in a room. */
    initiator: RunActor;
    /** Whose grants, data, approvals and subscription the step uses. */
    actingUserId: string;
    /** The socio executing this step, and its owner (null: a company socio). */
    socio: { dotId: string; ownerId: string | null };
    billing: BillingPrincipal;
    /** 0 for the step a person's message started; one more per handoff. */
    hop: number;
}

export type TurnRefusal =
    | 'not_member'
    | 'archived'
    | 'rooms_off'
    | 'personal_socio'
    | 'socio_not_in_room'
    | 'billing_not_actor'
    | 'handoff_limit';

export type TurnStart = { ok: true; context: TurnContext } | { ok: false; reason: TurnRefusal };

/**
 * The context for a step a person's message starts. A room turn acts as
 * the sender, never as the room's creator or a socio's owner; when the
 * sender may not send it is refused, so the socio stops and asks.
 */
export function startTurn(input: {
    conversation: Pick<ConversationRecord, 'id' | 'kind' | 'ownerId' | 'archivedAt'>;
    senderId: string;
    member?: Pick<RoomMember, 'role' | 'status'>;
    socio: {
        dotId: string;
        ownerId: string | null;
        roomStatus?: RoomSocioStatus;
    };
    cycleId: string;
    billing: BillingPrincipal;
    roomsEnabled: boolean;
}): TurnStart {
    const { conversation, senderId, socio, billing } = input;
    const decision = roomAllows(conversation, { userId: senderId, member: input.member }, 'send', {
        roomsEnabled: input.roomsEnabled,
    });
    if (!decision.allowed) {
        return {
            ok: false,
            reason: decision.reason === 'archived' || decision.reason === 'rooms_off' ? decision.reason : 'not_member',
        };
    }
    if (conversation.kind === 'room') {
        if (socio.ownerId) {
            return { ok: false, reason: 'personal_socio' };
        }
        if (socio.roomStatus !== 'active') {
            return { ok: false, reason: 'socio_not_in_room' };
        }
    } else if (socio.ownerId && socio.ownerId !== senderId)
    // Today's rule: a person's own socio works only for them.
    {
        return { ok: false, reason: 'personal_socio' };
    }
    if (billing.kind === 'person' && billing.userId !== senderId) {
        return { ok: false, reason: 'billing_not_actor' };
    }
    return {
        ok: true,
        context: {
            conversationId: conversation.id,
            kind: conversation.kind,
            cycleId: input.cycleId,
            initiator: { kind: 'person', id: senderId },
            actingUserId: senderId,
            socio: { dotId: socio.dotId, ownerId: socio.ownerId },
            billing,
            hop: 0,
        },
    };
}

/**
 * The context for the next socio in the same cycle (CB-206): the same
 * initiator, acting person, billing and cycle, never a wider one.
 */
export function handOff(
    context: TurnContext,
    next: { dotId: string; ownerId: string | null; roomStatus?: RoomSocioStatus },
    handoffsPerCycle: number,
): TurnStart {
    if (context.hop + 1 > handoffsPerCycle) {
        return { ok: false, reason: 'handoff_limit' };
    }
    if (context.kind === 'room') {
        if (next.ownerId) {
            return { ok: false, reason: 'personal_socio' };
        }
        if (next.roomStatus !== 'active') {
            return { ok: false, reason: 'socio_not_in_room' };
        }
    }
    return {
        ok: true,
        context: {
            ...context,
            socio: { dotId: next.dotId, ownerId: next.ownerId },
            hop: context.hop + 1,
        },
    };
}

/**
 * What is wrong with a context, for an assertion where it is used: empty
 * when it keeps the rules. In a room the acting person is the person who
 * started the cycle, the socio is a company socio, and only the acting
 * person can be billed.
 */
export function turnContextProblems(context: TurnContext): string[] {
    const problems: string[] = [];
    if (!context.conversationId) {
        problems.push('no conversation');
    }
    if (!context.cycleId) {
        problems.push('no work cycle');
    }
    if (!context.actingUserId) {
        problems.push('no acting person');
    }
    if (!Number.isInteger(context.hop) || context.hop < 0) {
        problems.push('hop must be a whole number from 0');
    }
    if (context.billing.kind === 'person' && context.billing.userId !== context.actingUserId) {
        problems.push('billed to someone other than the acting person');
    }
    if (context.kind === 'room') {
        if (context.initiator.kind !== 'person' || context.initiator.id !== context.actingUserId) {
            problems.push('a room turn acts as the person who started it');
        }
        if (context.socio.ownerId) {
            problems.push('a personal socio in a room');
        }
    }
    return problems;
}

// ---- Work cycle limits -------------------------------------------------------

/**
 * A work cycle's bounds (CB-211). Time and queue reuse the existing turn
 * time limit and queued-message limit; spend applies only when the
 * provider reports cost and an admin set a cap.
 */
export interface RoomLimits {
    cycleTimeMs: number;
    cycleTokens: number;
    messagesPerMinute: number;
    maxQueued: number;
    handoffsPerCycle: number;
    /** Null: no spend cap (tokens and time still bound the cycle). */
    cycleSpendUsd: number | null;
}

/**
 * v1 defaults beside the existing limits; 2M tokens per cycle by the
 * owner's decision (CB-211).
 */
export const ROOM_LIMIT_DEFAULTS = {
    cycleTokens: 2_000_000,
    messagesPerMinute: 20,
    handoffsPerCycle: 4,
} as const;

const LIMIT_FIELDS = ['cycleTimeMs', 'cycleTokens', 'messagesPerMinute', 'maxQueued', 'handoffsPerCycle'] as const;

/**
 * The limits a room runs under: the workspace's, lowered by what a room
 * admin saved. A room value above the workspace's, or not a positive whole
 * number, is ignored: room admins can only lower.
 */
export function effectiveRoomLimits(workspace: RoomLimits, room: Partial<RoomLimits> = {}): RoomLimits {
    const out: RoomLimits = { ...workspace };
    for (const key of LIMIT_FIELDS) {
        const value = room[key];
        if (value !== undefined && Number.isInteger(value) && value > 0 && value < workspace[key]) {
            out[key] = value;
        }
    }
    const spend = room.cycleSpendUsd;
    if (typeof spend === 'number' && Number.isFinite(spend) && spend > 0) {
        out.cycleSpendUsd = workspace.cycleSpendUsd === null ? spend : Math.min(spend, workspace.cycleSpendUsd);
    }
    return out;
}

/** The fields of a room admin's change that would raise a limit (refused). */
export function raisedRoomLimits(workspace: RoomLimits, room: Partial<RoomLimits>): (keyof RoomLimits)[] {
    const raised: (keyof RoomLimits)[] = LIMIT_FIELDS.filter(
        (key) => room[key] !== undefined && !(room[key]! <= workspace[key]),
    );
    if (
        room.cycleSpendUsd !== undefined &&
        workspace.cycleSpendUsd !== null &&
        !(room.cycleSpendUsd !== null && room.cycleSpendUsd <= workspace.cycleSpendUsd)
    ) {
        raised.push('cycleSpendUsd');
    }
    return raised;
}

/** A cycle's use so far; `costUsd` null while any cost is unknown. */
export interface CycleUsage {
    startedAt: number;
    tokens: number;
    handoffs: number;
    costUsd: number | null;
}
export type CycleStop = 'deadline' | 'tokens' | 'handoffs' | 'spend';

/** Why a cycle must stop now, or undefined while it is within its limits. */
export function cycleExhausted(usage: CycleUsage, limits: RoomLimits, now: number): CycleStop | undefined {
    if (now - usage.startedAt >= limits.cycleTimeMs) {
        return 'deadline';
    }
    if (usage.tokens >= limits.cycleTokens) {
        return 'tokens';
    }
    if (usage.handoffs > limits.handoffsPerCycle) {
        return 'handoffs';
    }
    if (limits.cycleSpendUsd !== null && usage.costUsd !== null && usage.costUsd >= limits.cycleSpendUsd) {
        return 'spend';
    }
    return undefined;
}

/** Whether one more message fits the room's rate (the last 60 s). */
export function withinRoomRate(recentSubmissions: readonly number[], now: number, perMinute: number): boolean {
    const since = now - 60_000;
    return recentSubmissions.filter((at) => at > since).length < perMinute;
}

// ---- Audit ------------------------------------------------------------------

/**
 * A line of a room's own audit (`room_events`, CB-208/213): who did what to
 * whom, and whether it was refused. Never message text, prompts, tool
 * results or approval payloads.
 */
export const ROOM_EVENT_ACTIONS = [
    'create',
    'convert',
    'rename',
    'invite',
    'accept',
    'decline',
    'expire',
    'leave',
    'remove',
    'role',
    'archive',
    'unarchive',
    'socio_request',
    'socio_authorize',
    'socio_withdraw',
    'lead',
    'bind_source',
    'unbind_source',
    'limits',
    'denied',
    // A room admin canceled someone else's queued message (CB-215).
    'queue_cancel',
    // A pinned fact pinned, proposed, edited, approved, rejected, withdrawn
    // or unpinned (CB-217); the detail names which and its version.
    'pin',
] as const;
export type RoomEventAction = (typeof ROOM_EVENT_ACTIONS)[number];
export interface RoomEvent {
    roomId: string;
    /** A user id, `dot:<id>` or `system`. */
    actor: string;
    action: RoomEventAction;
    targetKind: 'room' | 'person' | 'socio' | 'source';
    targetId: string | null;
    outcome: 'ok' | 'denied';
    /** Names of what changed, a denial reason; never content. */
    detail: string;
    at: number;
}

// ---- API (CB-208) -------------------------------------------------------------

/**
 * Why the rooms API refuses, beside the rule's own reasons
 * (`RoomDenial`): a change that would leave the room without an admin,
 * an invite that ran out, a person or socio that can't be in a room, a
 * room limit above the workspace's, or a request that doesn't fit.
 */
export type RoomRefusal =
    | RoomDenial
    | 'last_admin'
    | 'expired'
    | 'not_eligible'
    | 'conflict'
    | 'disclosure'
    | 'raised'
    | 'invalid'
    | 'usage_hidden';

/** A person in a room, as members see them. Ended rows aren't listed. */
export interface RoomMemberView {
    userId: string;
    name: string;
    role: RoomRole;
    status: Extract<RoomMemberStatus, 'invited' | 'active'>;
    invitedBy: string | null;
    invitedAt: number;
    inviteExpiresAt: number | null;
    acceptedAt: number | null;
}

/** A socio in a room (or asked for), as members see it. */
export interface RoomSocioView {
    dotId: string;
    name: string;
    status: RoomSocioStatus;
    lead: boolean;
}

/** `GET /api/rooms/:id`: a room for one of its active members. */
export interface RoomView {
    id: string;
    title: string;
    /** The lead socio. */
    dotId: string;
    createdAt: number;
    createdBy: string | null;
    convertedAt: number | null;
    archivedAt: number | null;
    /** The reader's own role. */
    role: RoomRole;
    /** Settings → Rooms: off, the room is read-only for everyone. */
    roomsEnabled: boolean;
    /**
     * The reader may see the room's work-cycle use and limits (CB-218): a
     * room admin always, members when Settings → Rooms lets them. Absent
     * from an older server: not shown.
     */
    usageVisible?: boolean;
    members: RoomMemberView[];
    socios: RoomSocioView[];
}

/**
 * `GET /api/rooms/invites`: an invite waiting for its person. Only the
 * room's name, who asked and the disclosure: no history until accepted.
 */
export interface RoomInvite {
    roomId: string;
    title: string;
    role: RoomRole;
    invitedBy: string | null;
    invitedByName: string | null;
    invitedAt: number;
    inviteExpiresAt: number | null;
    memberCount: number;
    disclosure: { version: number; text: string };
}

/**
 * `GET /api/rooms/:id/invitable` (room admins, CB-212): a person a room
 * admin may invite, by id and name only. Not those already in the room or
 * invited, deactivated people or service accounts.
 */
export interface RoomPerson {
    userId: string;
    name: string;
}

/** `GET /api/rooms/:id/limits`: the workspace's, the room's own and the result. */
export interface RoomLimitsView {
    workspace: RoomLimits;
    room: Partial<RoomLimits>;
    effective: RoomLimits;
}

/**
 * `GET /api/rooms/:id/limits/handoffs`: how many times one message's work
 * may pass between the room's socios, for every active member whatever
 * Settings → Rooms shows them of its use. A rule of the room, as its
 * socios are, not budget data: no spend, tokens or time (those stay in
 * `RoomLimitsView`, behind `usage_hidden`).
 */
export interface RoomHandoffLimitView {
    /** The workspace's (Settings → General → Work per message). */
    workspace: number;
    /** The room's own, lower one, if its admins set it. */
    room: number | null;
    /** The one in force. */
    effective: number;
}

/**
 * A work cycle's use as a room's people see it (CB-218): its limits
 * beside what it used. Spend shows only when the provider reported it
 * and the workspace's models paid, or it is the reader's own cycle: a
 * cycle on another member's own subscription says `private`, never an
 * amount. No message, no tool, no other member's data.
 */
export interface RoomCycleUsage {
    status: 'running' | 'waiting' | 'ended';
    /** The reader started it. */
    mine: boolean;
    startedAt: number;
    /** Time its steps ran, waits left out, against its time limit. */
    elapsedMs: number;
    timeLimitMs: number;
    tokensUsed: number;
    tokenLimit: number;
    handoffs: number;
    handoffLimit: number;
    spend: 'known' | 'unknown' | 'private';
    /** With `spend` known; else null. */
    spendUsd: number | null;
    spendLimitUsd: number | null;
    /** The limit that stopped it, if one did. */
    stoppedBy: CycleStop | null;
}

/**
 * The fewest people whose cycles a room's day of use counts before its
 * people see it (CB-218): fewer, and it would show one person's use
 * (Operations' themes keep the same rule, `THEMES_MIN_PEOPLE`).
 */
export const ROOM_USAGE_MIN_PEOPLE = 3;

/**
 * `GET /api/rooms/:id/usage` (CB-218): the room's limits in force, its
 * running or last cycle, and its last day's cycles in total. Room
 * admins always; members when Settings → Rooms shows them
 * (`budgetVisible`); refused `usage_hidden` otherwise.
 */
export interface RoomUsageView {
    limits: RoomLimits;
    current: RoomCycleUsage | null;
    /**
     * The last 24 hours: cycles, tokens and those a limit stopped. Null
     * when fewer than `ROOM_USAGE_MIN_PEOPLE` people started them.
     */
    day: {
        since: number;
        cycles: number;
        tokens: number;
        stopped: Record<CycleStop, number>;
    } | null;
}

/** `GET /api/rooms/socio-requests` (workspace admins): socios rooms asked for. */
export interface RoomSocioRequest {
    roomId: string;
    roomTitle: string;
    dotId: string;
    dotName: string;
    requestedBy: string;
    requestedByName: string | null;
    requestedAt: number;
}

// ---- Settings ---------------------------------------------------------------

/**
 * Settings → Rooms: an admin's switch over `ROOMS_ENABLED`, off unless set.
 */
export interface RoomsSettings {
    enabled: boolean;
    /**
     * Room members see their room's work-cycle use and limits (CB-218);
     * room admins always do. Over `ROOMS_BUDGET_VISIBLE`, off unless set.
     */
    budgetVisible: boolean;
}
export const ROOMS_ENV = 'ROOMS_ENABLED';
export const ROOMS_BUDGET_ENV = 'ROOMS_BUDGET_VISIBLE';
/** `ROOMS_ENABLED`: on only for an explicit yes. */
export const roomsEnabledFromEnv = (value: string | undefined) =>
    ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());

/**
 * `GET /api/rooms/readiness` (CB-207, admins): the reconcile before Rooms
 * is turned on. Live conversations per kind: before the first room exists
 * every one is private, and private chats answer their readers exactly as
 * before.
 */
export interface RoomsReadiness {
    enabled: boolean;
    conversations: Record<ConversationKind, number>;
    /** No room exists yet. */
    allPrivate: boolean;
}

// ---- Live stream (CB-212) ------------------------------------------------------

/**
 * Why a member's live stream of a room ended: they were removed or left,
 * the room was archived, Rooms were turned off (the room is read-only now:
 * connect again to read it), or their access changed some other way (found
 * by the periodic re-check).
 */
export const ROOM_STREAM_CLOSE_REASONS = ['removed', 'left', 'archived', 'rooms_off', 'access'] as const;
export type RoomStreamCloseReason = (typeof ROOM_STREAM_CLOSE_REASONS)[number];

/**
 * `GET /api/conversations/:id/stream` (CB-212): a conversation's live
 * stream for its reader, as server-sent events that stay open across turns.
 * Plain `data:` frames are AG-UI events, as the reader may see them (other
 * people's private results withheld). Named frames are Socio's own:
 * `ROOM_STREAM_CURSOR` once each finished run is delivered (its sequence
 * number in `id:` and `data`, so `Last-Event-ID` or `?after=` resumes
 * after it), and `ROOM_STREAM_CLOSED` as the server ends the stream.
 */
export const ROOM_STREAM_CURSOR = 'cursor';
export const ROOM_STREAM_CLOSED = 'closed';
/** `data` of a `ROOM_STREAM_CURSOR` frame. */
export interface RoomStreamCursor {
    seq: number;
}
/** `data` of a `ROOM_STREAM_CLOSED` frame. */
export interface RoomStreamClosed {
    reason: RoomStreamCloseReason;
}

// ---- Read state (CB-215) -------------------------------------------------------

/**
 * The most unread turns a room counts: more shows as `99+`. Counting
 * stops there, so a long-unread room costs no more than a busy one.
 */
export const ROOM_UNREAD_CAP = 100;

/** A room's unread count as the sidebar shows it: `3`, or `99+`. */
export const unreadLabel = (unread: number) => (unread >= ROOM_UNREAD_CAP ? `${ROOM_UNREAD_CAP - 1}+` : String(unread));

/**
 * `POST /api/rooms/:id/read` (CB-215): the reader has seen the room up to
 * `seq` (a finished turn's, the stream's `ROOM_STREAM_CURSOR`), or up to
 * its last finished turn when no `seq` is given. Never moves back.
 */
export interface RoomReadRequest {
    seq?: number;
}
/** Its answer: where the reader's cursor is now, and what is still new. */
export interface RoomReadState {
    lastSeq: number;
    unread: number;
}
