import type { Message } from '@ag-ui/client';

import { messageText } from '@socio/foundation/turns/media-parts';
import { compareText } from '@socio/shared/locale';
import { dotAvatarPath } from '@socio/shared/mascot';
import {
    DEFAULT_ROOM_NOTIFY_LEVEL,
    noticePreview,
    roomNoticeWanted,
    type RoomNoticeKind,
    type RoomNotifyLevel,
    type RoomPresenceView,
} from '@socio/shared/rooms/room-notices';
import { confirmedMentions, type PersonMention } from '@socio/shared/rooms/room-people-mentions';
import type { RoomAction } from '@socio/shared/rooms/rooms';
import { SENDER_METADATA, type AgentRunStatus, type Conversation, type Dot } from '@socio/shared/types';
import type { UserPreferences } from '@socio/shared/voice/dictation';

import type { NotifierShape, UserPresenceShape } from '../notifications/contract.js';
import type { FinishedRun } from '../turns/contract.js';

import type { NoticesShape, RoomAccessCheck, StoredRoomMention } from './contract.js';
import type { RoomNoticeRepository } from './domain/notices.js';
import type { RoomMemberRepository, RoomSocioRepository } from './domain/repositories.js';

/** Mentions whose message never reached the room go after this long. */
export const MENTION_PENDING_MS = 7 * 24 * 60 * 60_000;
/** A notice's claim is kept this long: no cause comes back after it. */
export const NOTICE_CLAIM_MS = 30 * 24 * 60 * 60_000;

export interface RoomNoticesOptions {
    notices: RoomNoticeRepository;
    members: Pick<RoomMemberRepository, 'list'>;
    socios: Pick<RoomSocioRepository, 'list'>;
    workspace: {
        thread(id: string): Conversation | undefined;
        dot(id: string): Dot | undefined;
        users(): readonly { id: string; name: string }[];
        isDeactivated(userId: string): boolean;
        preferences(userId: string): UserPreferences;
        allows(userId: string, id: string, action: RoomAction, check?: RoomAccessCheck): boolean;
    };
    runner: {
        messages(threadId: string): Promise<Message[]>;
    };
    notifications: Pick<NotifierShape, 'notifyPerson'> & { readonly presence: UserPresenceShape };
    /** The ids of the messages waiting in the room's queues. */
    queued(threadId: string): Promise<Set<string>>;
    log: (line: string) => void;
    now?: () => number;
}

/** The sender a stored message carries (CB-228), if any. */
const senderOf = (message: Message) => {
    const metadata = (message as { metadata?: Record<string, unknown> }).metadata;
    const sender = metadata?.[SENDER_METADATA];
    return typeof sender === 'string' ? sender : undefined;
};

/**
 * Each member's notices about their rooms (CB-216):
 *
 * - **Mentions.** The composer's picker records whom a message mentions
 *   (`record`, as it is queued); once a turn put the message in the
 *   room's history it is checked there (`confirmedMentions`: the `@Name`
 *   still in it, an active member, not the author) and each person
 *   mentioned is told, unless the author is no longer in the room.
 * - **Turns.** A turn someone started that finishes (or fails) tells them;
 *   one that brings news (a long run's report) tells the job's starter;
 *   members who chose `all` hear of every turn, once per work cycle, so
 *   socios handing work on to each other (CB-206) never add notices.
 * - **Invitations** tell the person invited.
 *
 * Each goes through `NotificationService.notifyPerson`: nothing while the
 * person looks at the room, a toast while they use Socio elsewhere, else
 * their channels by their choices. Every send re-checks that the person
 * is an active member who may read the room, not deactivated, and that
 * their level for the room wants it; each cause is claimed once per
 * person (`room_notices`), so a replay, a restart or a second runtime
 * never sends one twice. A preview is a person's own words or the
 * socio's reply, both the room's to read; never a tool result.
 */
export class RoomNotices implements NoticesShape {
    private now: () => number;
    constructor(private options: RoomNoticesOptions) {
        this.now = options.now ?? Date.now;
    }

    // ---- levels -----------------------------------------------------------------

    async level(roomId: string, userId: string): Promise<RoomNotifyLevel> {
        return (await this.options.notices.level(roomId, userId)) ?? DEFAULT_ROOM_NOTIFY_LEVEL;
    }
    setLevel(roomId: string, userId: string, level: RoomNotifyLevel) {
        return this.options.notices.setLevel(roomId, userId, level, this.now());
    }
    /** The chat list with each room's level where the person chose one. */
    async withLevels(userId: string, conversations: Conversation[]): Promise<Conversation[]> {
        if (!conversations.some((chat) => chat.kind === 'room')) {
            return conversations;
        }
        const levels = await this.options.notices.levels(userId);
        return conversations.map((chat) => {
            const level = chat.kind === 'room' ? levels.get(chat.id) : undefined;
            return level && level !== DEFAULT_ROOM_NOTIFY_LEVEL ? { ...chat, roomNotify: level } : chat;
        });
    }

    // ---- people -----------------------------------------------------------------

    /** The room's active members now, not deactivated, by id with their names. */
    private async members(roomId: string) {
        const names = new Map(this.options.workspace.users().map((user) => [user.id, user.name]));
        const active = new Map<string, string>();
        for (const member of await this.options.members.list(roomId)) {
            if (member.status === 'active' && !this.options.workspace.isDeactivated(member.userId)) {
                active.set(member.userId, names.get(member.userId) ?? 'Team member');
            }
        }
        return active;
    }
    private async socioNames(roomId: string) {
        return (await this.options.socios.list(roomId))
            .filter((socio) => socio.status === 'active')
            .map((socio) => this.options.workspace.dot(socio.dotId)?.name)
            .filter((name): name is string => !!name);
    }

    /**
     * Who else is looking at the room now (presence): active members with a
     * tab in use on it, but never the reader, nor anyone who hides their
     * presence (`UserPreferences.roomPresence`). By name.
     */
    async presence(roomId: string, readerId: string): Promise<RoomPresenceView> {
        const members = await this.members(roomId);
        const people = this.options.notifications.presence
            .viewing(roomId, this.now())
            .filter(
                (userId) =>
                    userId !== readerId &&
                    members.has(userId) &&
                    this.options.workspace.preferences(userId).roomPresence !== 'hidden',
            )
            .map((userId) => ({ userId, name: members.get(userId)! }))
            .sort((a, b) => compareText(a.name, b.name) || compareText(a.userId, b.userId));
        return { people };
    }

    // ---- mentions ---------------------------------------------------------------

    /**
     * The people a queued message mentions, as its author's picker chose
     * them (`picked`), checked now against its text and the room's members
     * and kept until the message is in the room (replacing any it had).
     * What is kept: never anyone outside the room.
     */
    async record(
        roomId: string,
        authorId: string,
        messageId: string,
        text: string,
        picked: readonly PersonMention[],
    ): Promise<PersonMention[]> {
        const kept = picked.length
            ? confirmedMentions(text, picked, {
                  names: await this.members(roomId),
                  authorId,
                  socioNames: await this.socioNames(roomId),
              })
            : [];
        const now = this.now();
        await this.options.notices.replaceMentions(
            roomId,
            messageId,
            kept.map((mention): StoredRoomMention => ({
                roomId,
                messageId,
                userId: mention.userId,
                authorId,
                label: mention.label,
                status: 'pending',
                createdAt: now,
            })),
        );
        return kept;
    }
    /** A queued message canceled: its mentions go with it. */
    forget(roomId: string, messageId: string) {
        return this.options.notices.forgetMentions(roomId, messageId);
    }
    /** The room's mentions, by message, for its transcript. */
    mentions(roomId: string) {
        return this.options.notices.confirmed(roomId);
    }

    /**
     * The room's waiting mentions whose message is in its history now:
     * checked against it and sent. Who was told (by message).
     */
    private async deliverMentions(thread: Conversation, messages?: Message[]) {
        const told = new Set<string>();
        const pending = await this.options.notices.pending(thread.id);
        if (!pending.length) {
            return told;
        }
        const stored = new Map(
            (messages ?? (await this.options.runner.messages(thread.id))).map((message) => [message.id, message]),
        );
        const byMessage = new Map<string, StoredRoomMention[]>();
        for (const row of pending) {
            if (stored.has(row.messageId)) {
                byMessage.set(row.messageId, [...(byMessage.get(row.messageId) ?? []), row]);
            }
        }
        if (!byMessage.size) {
            return told;
        }
        const members = await this.members(thread.id);
        const socioNames = await this.socioNames(thread.id);
        for (const [messageId, rows] of byMessage) {
            const message = stored.get(messageId)!;
            const authorId = rows[0]!.authorId;
            const text = messageText(message.content);
            // Only the author's own message carries their mentions.
            const kept =
                message.role === 'user' && senderOf(message) === authorId
                    ? confirmedMentions(text, rows, {
                          names: members,
                          authorId,
                          socioNames,
                      })
                    : [];
            await this.options.notices.settle(
                thread.id,
                messageId,
                kept.map((mention) => mention.userId),
            );
            // Checked again as it is sent: an author no longer in the room
            // tells nobody.
            if (!members.has(authorId)) {
                continue;
            }
            for (const mention of kept) {
                if (
                    await this.send(mention.userId, 'mention', `mention:${messageId}`, thread, {
                        trigger: 'room_mention',
                        causeId: messageId,
                        title: `${members.get(authorId)} mentioned you`,
                        message: noticePreview(text) || 'Open the room to read it.',
                    })
                ) {
                    told.add(mention.userId);
                }
            }
        }
        return told;
    }

    // ---- turns ------------------------------------------------------------------

    /** A turn in a room ended (`LocalAgentRunner.onRunFinished`). Never throws. */
    async runFinished(threadId: string, status: AgentRunStatus, run: FinishedRun) {
        try {
            const thread = this.options.workspace.thread(threadId);
            if (thread?.kind !== 'room') {
                return;
            }
            const messages = await this.options.runner.messages(threadId);
            const mentioned = await this.deliverMentions(thread, messages);
            await this.turnNotices(thread, status, run, messages, mentioned);
        } catch (error) {
            this.options.log(
                `Rooms: notices for run=${run.runId} failed (${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}).`,
            );
        }
    }

    private async turnNotices(
        thread: Conversation,
        status: AgentRunStatus,
        run: FinishedRun,
        messages: Message[],
        mentioned: Set<string>,
    ) {
        const { trace } = run;
        const starter = trace.trigger?.kind === 'person' ? trace.trigger.id : undefined;
        if (!starter || (status !== 'finished' && status !== 'failed')) {
            return;
        }
        const members = await this.members(thread.id);
        const socio =
            this.options.workspace.dot(trace.cycle?.dotId ?? thread.dotId) ?? this.options.workspace.dot(thread.dotId);
        const socioName = socio?.name ?? 'The socio';
        const icon = socio ? dotAvatarPath(socio) : undefined;
        // The reply: the last answer the turn added, the room's to read.
        const added = new Set(
            (trace.messages ?? []).filter((message) => message.author.kind !== 'person').map((message) => message.id),
        );
        const reply = [...messages].reverse().find((message) => message.role === 'assistant' && added.has(message.id));
        const preview = reply ? noticePreview(messageText(reply.content)) : '';
        const failed = status === 'failed';
        const common = {
            dotId: socio?.id,
            causeId: run.runId,
            icon,
        };
        if (trace.news) {
            if (failed) {
                return;
            }
            const cause = `report:${run.runId}`;
            for (const userId of members.keys()) {
                await this.send(userId, userId === starter ? 'own_report' : 'report', cause, thread, {
                    ...common,
                    trigger: 'room_report',
                    title: `${socioName} reported on a job`,
                    message: preview || 'Open the room to read the report.',
                });
            }
            return;
        }
        // Once per work cycle: its later steps (a socio handing on) add none.
        const cycle = trace.cycle?.id ?? run.runId;
        await this.send(starter, 'own_turn', `turn:${cycle}`, thread, {
            ...common,
            trigger: 'room_turn',
            title: failed ? `${socioName} couldn’t finish` : `${socioName} answered you`,
            message: failed
                ? 'Your message didn’t get its answer. Open the room to try again.'
                : preview || 'Open the room to read the answer.',
        });
        if (failed) {
            return;
        }
        const starterName = members.get(starter) ?? 'Someone';
        for (const userId of members.keys()) {
            if (userId === starter || mentioned.has(userId)) {
                continue;
            }
            await this.send(userId, 'activity', `activity:${cycle}`, thread, {
                ...common,
                trigger: 'room_activity',
                title: `${socioName} answered ${starterName}`,
                message: preview || 'Open the room to read it.',
            });
        }
    }

    // ---- invitations --------------------------------------------------------------

    /** A person was invited (`RoomMembership.invite`). Never throws. */
    async invited(roomId: string, by: string, userId: string, at: number) {
        try {
            const thread = this.options.workspace.thread(roomId);
            if (thread?.kind !== 'room' || this.options.workspace.isDeactivated(userId)) {
                return;
            }
            if (!(await this.options.notices.claim(userId, `invite:${roomId}:${at}`, roomId, this.now()))) {
                return;
            }
            const inviter = this.options.workspace.users().find((user) => user.id === by)?.name ?? 'Someone';
            await this.options.notifications.notifyPerson({
                userId,
                trigger: 'room_invite',
                causeId: roomId,
                from: thread.title,
                title: `${inviter} invited you`,
                message: `Join the room “${thread.title}” to read and write in it.`,
                // Home lists the invitations; the room opens once accepted.
                path: '/',
            });
        } catch (error) {
            this.options.log(
                `Rooms: the invitation notice failed (${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}).`,
            );
        }
    }

    // ---- sending ----------------------------------------------------------------

    /**
     * One notice of `kind` to one person, if they still may read the room,
     * their level there wants it and nobody sent it before (`cause`).
     */
    private async send(
        userId: string,
        kind: RoomNoticeKind,
        cause: string,
        thread: Conversation,
        content: {
            trigger: string;
            causeId: string;
            title: string;
            message: string;
            dotId?: string;
            icon?: string;
        },
    ) {
        const { workspace, notices, notifications } = this.options;
        if (workspace.isDeactivated(userId)) {
            return false;
        }
        if (!workspace.allows(userId, thread.id, 'read', { audit: false })) {
            return false;
        }
        if (!roomNoticeWanted(await this.level(thread.id, userId), kind)) {
            return false;
        }
        if (!(await notices.claim(userId, cause, thread.id, this.now()))) {
            return false;
        }
        await notifications.notifyPerson({
            userId,
            threadId: thread.id,
            from: thread.title,
            path: `/chats/${encodeURIComponent(thread.id)}`,
            ...content,
        });
        return true;
    }

    // ---- upkeep -------------------------------------------------------------------

    /**
     * The module's tick: mentions whose message reached the room while no
     * turn's end saw it (a restart) are sent; those whose message never
     * will (canceled, gone) are dropped after `MENTION_PENDING_MS`; old
     * claims are forgotten.
     */
    async sweep() {
        const now = this.now();
        for (const { roomId, oldest } of await this.options.notices.pendingRooms()) {
            const thread = this.options.workspace.thread(roomId);
            if (thread?.kind !== 'room') {
                continue;
            }
            await this.deliverMentions(thread);
            if (now - oldest < MENTION_PENDING_MS) {
                continue;
            }
            const queued = await this.options.queued(roomId);
            for (const row of await this.options.notices.pending(roomId)) {
                if (now - row.createdAt >= MENTION_PENDING_MS && !queued.has(row.messageId)) {
                    await this.options.notices.forgetMentions(roomId, row.messageId);
                }
            }
        }
        await this.options.notices.pruneClaims(now - NOTICE_CLAIM_MS);
    }
}
