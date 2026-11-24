import { randomUUID } from 'node:crypto';

import type { UnitOfWork } from '@socio/data/uow';
import { topicKey, topicOfKey } from '@socio/foundation/rooms/topic-keys';
import type { RoomTopicSender, RoomTopicView } from '@socio/shared/rooms/room-telegram';
import { isTeamOwnerId, roomEligibleSocio, type RoomPerson } from '@socio/shared/rooms/rooms';
import type { Conversation, Dot } from '@socio/shared/types';

import type {
    TelegramLink,
    TelegramRoomCode,
    TelegramRoomCodePurpose,
    TelegramThreadInfo,
    TelegramTopicSender,
} from '../integrations/contract.js';

import type { RoomAccess } from './access.js';
import {
    RoomError,
    type TopicRedeemRefusal,
    type TopicRedeemResult,
    type TopicRoute,
    type TopicSenderCheck,
    type TopicsShape,
} from './contract.js';
import type { RoomRepositories, RoomSourceBinding } from './domain/repositories.js';
import type { RoomMembership } from './membership.js';
import { RoomStorageError } from './service.js';

/**
 * Rooms' Telegram topics (CB-214). A forum
 * topic is bound to a room by someone who proves, in the topic itself,
 * that they hold both: a room admin asks the app for a one-time code and
 * posts it in the topic from their linked Telegram account, as an admin
 * of that Telegram group. A legacy team topic's reader converts it the
 * same way: a new room, with them as its admin, bound to the topic. The
 * legacy transcript stays as it was, read-only for the people who read it:
 * nobody is added to anything, and nobody reads more than before. One topic
 * maps to one room at a time (`room_source_bindings` keeps one row per
 * topic); archiving the room stops the binding.
 */

/**
 * What the topics read of the Telegram links (`WorkspaceStore.telegram`),
 * the members of telegram's `LinksShape` they call. Rooms declares it
 * rather than importing telegram's contract, which sits above it in the
 * folder order (scripts/feature-ranks.json); `TelegramLinks` answers it.
 */
export interface RoomTopicLinks {
    /** The person's link, if they linked a Telegram account. */
    linkFor(userId: string): Promise<TelegramLink | undefined>;
    /** The person linked to this Telegram account, if any. */
    userFor(telegramUserId: string): Promise<string | undefined>;
    /** Telegram facts for an app thread, if it came from Telegram. */
    threadInfo(threadId: string): Promise<TelegramThreadInfo | undefined>;
    /** The linked people seen in a group chat (CB-214). */
    chatMembers(chatId: string): Promise<string[]>;
    /** A fresh one-time code to bind a forum topic to a room, or convert a legacy topic (CB-214). */
    createRoomCode(
        userId: string,
        purpose: TelegramRoomCodePurpose,
        target: string,
        now?: number,
    ): Promise<{ code: string; expiresAt: number }>;
    /** A room code as stored, if `code` is one. */
    roomCode(code: string): Promise<TelegramRoomCode | undefined>;
    /** Uses a room code up; false when it was used already. */
    claimRoomCode(code: string, now?: number): Promise<boolean>;
    /** Counts a message the socio did not answer in a bound topic: true the first time. */
    unanswered(
        sender: Pick<TelegramTopicSender, 'sourceKey' | 'roomId' | 'telegramUserId' | 'reason' | 'username'>,
        now?: number,
    ): Promise<boolean>;
    /** A room's unanswered senders in its topics, the latest first. */
    unansweredIn(roomId: string, limit?: number): Promise<TelegramTopicSender[]>;
}

export interface RoomTopicsOptions {
    uow: UnitOfWork;
    repos: RoomRepositories;
    membership: Pick<RoomMembership, 'create' | 'unbindSources'>;
    workspace: {
        thread(id: string): Conversation | undefined;
        dot(id: string): Dot | undefined;
        roomAccess: RoomAccess;
        telegram: RoomTopicLinks;
    };
    people: {
        name(userId: string): string | undefined;
        /** May be in a room: active, signed in, no service account. */
        invitable(userId: string): boolean;
    };
    /** Settings → General → Rooms in force. */
    enabled: () => boolean;
    now?: () => number;
}

/** A refusal while binding: the unit of work rolls back, the code stays. */
class Refused extends Error {
    constructor(readonly reason: TopicRedeemRefusal) {
        super(reason);
    }
}

export class RoomTopics implements TopicsShape {
    private now: () => number;
    constructor(private options: RoomTopicsOptions) {
        this.now = options.now ?? Date.now;
    }

    private get repos() {
        return this.options.repos;
    }
    private get telegram() {
        return this.options.workspace.telegram;
    }

    /** The room, if `userId` may do `action` there; else the rule's refusal. */
    private require(roomId: string, userId: string, action: 'read' | 'manage') {
        const thread = this.options.workspace.thread(roomId);
        if (!thread || thread.kind !== 'room') {
            throw new RoomError('not_found');
        }
        const decision = this.options.workspace.roomAccess.decide(thread, userId, action);
        if (!decision.allowed) {
            throw new RoomError(decision.reason);
        }
        return thread;
    }

    private async linked(userId: string) {
        if (!(await this.telegram.linkFor(userId))) {
            throw new RoomError('invalid', 'Link your Telegram account first: choose Telegram in the sidebar.');
        }
    }

    /** The topic's live binding, if any. */
    private async active(key: string) {
        const binding = await this.repos.sources.bySource('telegram', key);
        return binding?.status === 'active' ? binding : undefined;
    }

    // ---- in the app ---------------------------------------------------------------

    /**
     * A room admin's code to bind a topic to their live room, once they
     * confirmed who reads the topic (`ROOM_TOPIC_AUDIENCE`). Their Telegram
     * account must be linked: the code works only from it.
     */
    async bindCode(roomId: string, by: string, confirmedAudience: boolean) {
        this.require(roomId, by, 'manage');
        if (!confirmedAudience) {
            throw new RoomError('disclosure', 'Confirm who reads the Telegram topic before you link it.');
        }
        await this.linked(by);
        if ((await this.repos.sources.forRoom(roomId)).some((binding) => binding.status === 'active')) {
            throw new RoomError('conflict', 'This room is linked to a Telegram topic already. Unlink it first.');
        }
        return this.telegram.createRoomCode(by, 'bind', roomId, this.now());
    }

    /**
     * A legacy topic's reader's code to make it a room (Rooms on): a new
     * room they are the admin of, with the topic's company socio as lead,
     * bound to the topic once they post the code there as an admin of its
     * group. The legacy transcript stays as it is.
     */
    async convertCode(threadId: string, by: string, confirmedAudience: boolean) {
        const thread = this.options.workspace.thread(threadId);
        const decision = thread ? this.options.workspace.roomAccess.decide(thread, by, 'read') : undefined;
        // Only a legacy topic this person reads; anything else is unknown.
        if (
            !thread ||
            !isTeamOwnerId(thread.ownerId) ||
            thread.kind === 'room' ||
            !decision?.allowed ||
            decision.via !== 'legacy-topic'
        ) {
            throw new RoomError('not_found');
        }
        const info = await this.telegram.threadInfo(threadId);
        if (info?.kind !== 'topic' || !info.topicId) {
            throw new RoomError('not_found');
        }
        if (!this.options.enabled()) {
            throw new RoomError('rooms_off');
        }
        if (thread.archivedAt) {
            throw new RoomError('archived');
        }
        if (!confirmedAudience) {
            throw new RoomError('disclosure', 'Confirm who reads the Telegram topic before you make it a room.');
        }
        const dot = this.options.workspace.dot(thread.dotId);
        if (!dot || !roomEligibleSocio(dot)) {
            throw new RoomError('not_eligible', 'Only a topic with an active company socio can become a room.');
        }
        await this.linked(by);
        if (await this.active(topicKey(info.chatId, info.topicId))) {
            throw new RoomError('conflict', 'This topic is linked to a room already. Ask its admins to invite you.');
        }
        return this.telegram.createRoomCode(by, 'convert', threadId, this.now());
    }

    /**
     * A room admin unlinks its topic, whatever the switch or archive: the
     * topic answers no one from then on. False when it had none.
     */
    async unbind(roomId: string, by: string) {
        const thread = this.options.workspace.thread(roomId);
        if (!thread || thread.kind !== 'room') {
            throw new RoomError('not_found');
        }
        const viewer = this.options.workspace.roomAccess.viewer(thread, by);
        if (viewer.member?.status !== 'active') {
            throw new RoomError('not_found');
        }
        if (viewer.member.role !== 'admin') {
            throw new RoomError('not_admin');
        }
        return this.options.uow.run(
            async () => {
                const live = (await this.repos.sources.forRoom(roomId)).some((binding) => binding.status === 'active');
                if (live) {
                    await this.options.membership.unbindSources(roomId, by, 'unlinked', this.now());
                }
                return live;
            },
            { label: 'unbind room topic' },
        );
    }

    /** The room's topic for one of its members; more for its admins. */
    async view(
        roomId: string,
        by: string,
        bot: { available: boolean; username: string | null },
    ): Promise<RoomTopicView> {
        const thread = this.require(roomId, by, 'read');
        const bindings = await this.repos.sources.forRoom(roomId);
        const binding = bindings.find((row) => row.status === 'active') ?? bindings.at(-1);
        const topic = binding && topicOfKey(binding.sourceKey);
        const view: RoomTopicView = {
            available: bot.available,
            bot: bot.username,
            linked: !!(await this.telegram.linkFor(by)),
            topic:
                binding && topic
                    ? {
                          status: binding.status,
                          topicId: topic.topicId,
                          boundAt: binding.boundAt,
                          boundByName: this.options.people.name(binding.boundBy) ?? null,
                          endedAt: binding.endedAt,
                      }
                    : null,
        };
        const member = this.options.workspace.roomAccess.viewer(thread, by).member;
        if (member?.role !== 'admin') {
            return view;
        }
        const members = new Map((await this.repos.members.list(roomId)).map((row) => [row.userId, row]));
        const inRoom = (userId: string) => {
            const status = members.get(userId)?.status;
            return status === 'active' || status === 'invited';
        };
        const person = (userId: string): RoomPerson => ({
            userId,
            name: this.options.people.name(userId) ?? 'Someone',
        });
        const unanswered: RoomTopicSender[] = [];
        for (const row of await this.telegram.unansweredIn(roomId)) {
            if (row.reason === 'closed') {
                continue;
            }
            // Who the account is linked to now, never who it was: a relinked
            // account is someone else, and an unlinked one is no one in Socio.
            const linkedTo = await this.telegram.userFor(row.telegramUserId);
            if (row.reason === 'not_member') {
                if (!linkedTo || inRoom(linkedTo)) {
                    continue;
                }
                if (!this.options.people.invitable(linkedTo)) {
                    continue;
                }
                unanswered.push({
                    reason: 'not_member',
                    person: person(linkedTo),
                    lastSeenAt: row.lastSeenAt,
                    seen: row.seen,
                });
            } else if (!linkedTo) {
                unanswered.push({
                    reason: 'unlinked',
                    ...(row.username ? { username: row.username } : {}),
                    lastSeenAt: row.lastSeenAt,
                    seen: row.seen,
                });
            }
        }
        // One line per person.
        const people = new Set<string>();
        view.unanswered = unanswered.filter(
            (row) => !row.person || (!people.has(row.person.userId) && !!people.add(row.person.userId)),
        );
        view.suggested =
            binding?.status === 'active' && topic
                ? (await this.telegram.chatMembers(topic.chatId))
                      .filter((userId) => !inRoom(userId) && this.options.people.invitable(userId))
                      .map(person)
                : [];
        return view;
    }

    // ---- in Telegram --------------------------------------------------------------

    /** Where a topic's messages go, if it was ever bound. */
    async route(key: string): Promise<TopicRoute | undefined> {
        const binding = await this.repos.sources.bySource('telegram', key);
        return binding
            ? {
                  bindingId: binding.id,
                  roomId: binding.roomId,
                  status: binding.status,
              }
            : undefined;
    }

    /**
     * Whether `userId` (a linked, active person) may talk to the room's
     * socio from its topic: an active member while the room is live and
     * Rooms are on (`roomAllows` `send`). A refusal is audited in the room.
     */
    sender(roomId: string, userId: string): TopicSenderCheck {
        const thread = this.options.workspace.thread(roomId);
        if (!thread || thread.kind !== 'room' || thread.archivedAt) {
            return { ok: false, reason: 'closed' };
        }
        const decision = this.options.workspace.roomAccess.decide(thread, userId, 'send');
        if (decision.allowed) {
            return { ok: true };
        }
        return {
            ok: false,
            reason: decision.reason === 'rooms_off' || decision.reason === 'archived' ? 'closed' : 'not_member',
        };
    }

    /**
     * A code posted in a topic (`/bind@bot <code>`) by `userId`'s linked
     * account, an admin of the group (`groupAdmin`, asked of Telegram just
     * before): binds the topic to the code's room, or makes the code's
     * legacy topic a room and binds it. The code is used up only when it
     * binds; a refusal leaves it for its person to try again.
     */
    async redeem(input: {
        code: string;
        userId: string;
        chatId: string;
        topicId: string | null;
        groupAdmin: boolean;
    }): Promise<TopicRedeemResult> {
        const now = this.now();
        const stored = await this.telegram.roomCode(input.code);
        // Someone else's code reads as no code at all.
        if (!stored || stored.userId !== input.userId) {
            return { ok: false, reason: 'invalid' };
        }
        if (stored.usedAt !== null) {
            return { ok: false, reason: 'used' };
        }
        if (stored.expiresAt <= now) {
            return { ok: false, reason: 'expired' };
        }
        if (!input.topicId) {
            return { ok: false, reason: 'not_topic' };
        }
        if (!input.groupAdmin) {
            return { ok: false, reason: 'not_group_admin' };
        }
        if (!this.options.enabled()) {
            return { ok: false, reason: 'rooms_off' };
        }
        const key = topicKey(input.chatId, input.topicId);
        try {
            return await this.options.uow.run(
                async (): Promise<TopicRedeemResult> => {
                    const result =
                        stored.purpose === 'bind'
                            ? await this.bindRoom(stored.target, input.userId, key, now)
                            : await this.convertTopic(stored.target, input.userId, key, input, now);
                    if (!(await this.telegram.claimRoomCode(input.code, now))) {
                        throw new Refused('used');
                    }
                    return result;
                },
                { label: 'bind room topic' },
            );
        } catch (error) {
            if (error instanceof Refused) {
                return { ok: false, reason: error.reason };
            }
            if (error instanceof RoomError || error instanceof RoomStorageError) {
                return {
                    ok: false,
                    reason:
                        error.reason === 'rooms_off'
                            ? 'rooms_off'
                            : error.reason === 'archived'
                              ? 'archived'
                              : 'not_allowed',
                };
            }
            throw error;
        }
    }

    /** Binds `key` to room `roomId` for its admin `by` (in the unit of work). */
    private async bindRoom(roomId: string, by: string, key: string, now: number) {
        const thread = this.options.workspace.thread(roomId);
        if (!thread || thread.kind !== 'room') {
            throw new Refused('not_allowed');
        }
        if (thread.archivedAt) {
            throw new Refused('archived');
        }
        const decision = this.options.workspace.roomAccess.decide(thread, by, 'manage');
        if (!decision.allowed) {
            throw new Refused(decision.reason === 'rooms_off' ? 'rooms_off' : 'not_allowed');
        }
        const existing = await this.repos.sources.bySource('telegram', key);
        // Posting the same room's code again in its own topic changes nothing.
        if (existing?.status === 'active' && existing.roomId === roomId) {
            return {
                ok: true as const,
                roomId,
                title: thread.title,
                converted: false,
            };
        }
        if (existing?.status === 'active') {
            throw new Refused('conflict');
        }
        if ((await this.repos.sources.forRoom(roomId)).some((binding) => binding.status === 'active')) {
            throw new Refused('room_bound');
        }
        await this.bind(existing, roomId, by, key, now, 'telegram topic');
        return { ok: true as const, roomId, title: thread.title, converted: false };
    }

    /**
     * Makes legacy topic `threadId` a new room of `by`'s and binds `key`,
     * which must be that topic (in the unit of work). The legacy thread is
     * not touched: its readers keep reading it, and only it.
     */
    private async convertTopic(
        threadId: string,
        by: string,
        key: string,
        at: { chatId: string; topicId: string | null },
        now: number,
    ) {
        const legacy = this.options.workspace.thread(threadId);
        const info = await this.telegram.threadInfo(threadId);
        if (!legacy || !isTeamOwnerId(legacy.ownerId) || info?.kind !== 'topic' || !info.topicId) {
            throw new Refused('not_allowed');
        }
        if (info.chatId !== at.chatId || info.topicId !== at.topicId) {
            throw new Refused('wrong_topic');
        }
        const decision = this.options.workspace.roomAccess.decide(legacy, by, 'read');
        if (!decision.allowed || decision.via !== 'legacy-topic') {
            throw new Refused('not_allowed');
        }
        const existing = await this.repos.sources.bySource('telegram', key);
        if (existing?.status === 'active') {
            throw new Refused('conflict');
        }
        const room = await this.options.membership.create(by, {
            dotId: legacy.dotId,
            title: legacy.title,
        });
        await this.bind(existing, room.id, by, key, now, 'telegram topic, from a legacy team topic');
        return {
            ok: true as const,
            roomId: room.id,
            title: room.title,
            converted: true,
        };
    }

    private async bind(
        existing: RoomSourceBinding | undefined,
        roomId: string,
        by: string,
        key: string,
        now: number,
        detail: string,
    ) {
        let id = existing?.id;
        if (existing) {
            if (
                !(await this.repos.sources.rebind(existing.id, {
                    roomId,
                    boundBy: by,
                    boundAt: now,
                }))
            ) {
                throw new Refused('conflict');
            }
        } else {
            id = randomUUID();
            await this.repos.sources.insert({
                id,
                roomId,
                source: 'telegram',
                sourceKey: key,
                status: 'active',
                bridge: false,
                boundBy: by,
                boundAt: now,
                endedAt: null,
            });
        }
        await this.repos.events.append({
            roomId,
            actor: by,
            action: 'bind_source',
            targetKind: 'source',
            targetId: id!,
            outcome: 'ok',
            detail,
            at: now,
        });
    }

    /**
     * Counts a message the socio did not answer in a bound topic; true when
     * its sender should be told why (the first time).
     */
    unanswered(input: {
        key: string;
        roomId: string;
        telegramUserId: string;
        reason: 'unlinked' | 'not_member' | 'closed';
        username: string | null;
    }) {
        return this.telegram.unanswered(
            {
                sourceKey: input.key,
                roomId: input.roomId,
                telegramUserId: input.telegramUserId,
                reason: input.reason,
                username: input.username,
            },
            this.now(),
        );
    }
}
