import { createHash, randomBytes } from 'node:crypto';

import type { UnitOfWork } from '@socio/data/uow';
import { ROOM_TOPIC_CODE_TTL_MS } from '@socio/shared/rooms/room-telegram';

import type {
    TelegramConversationKind,
    TelegramConversationRepository,
    TelegramLinkRepository,
    TelegramReply,
    TelegramReplyRepository,
    TelegramRoomCodePurpose,
    TelegramRoomCodeRepository,
    TelegramThreadInfo,
    TelegramTopicSender,
    TelegramTopicSenderRepository,
} from '../integrations/contract.js';

import type { LinksShape } from './contract.js';

export const LINK_CODE_TTL_MS = 10 * 60_000;
export type RedeemResult = { ok: true; userId: string } | { ok: false; reason: 'invalid' | 'expired' | 'used' };

// Codes are stored hashed: the database never holds a redeemable code.
const digest = (code: string) => createHash('sha256').update(code).digest('hex');

/**
 * What the links work over: the connection's unit of work and the
 * Integrations repositories of their tables, which the composition builds
 * (`composition/integration-stores.ts`, `telegramLinksOn`).
 */
export interface TelegramLinksDeps {
    readonly uow: UnitOfWork;
    readonly links: TelegramLinkRepository;
    readonly conversations: TelegramConversationRepository;
    readonly replies: TelegramReplyRepository;
    readonly roomCodes: TelegramRoomCodeRepository;
    readonly topicSenders: TelegramTopicSenderRepository;
}

/**
 * Links Telegram accounts to app users. The app issues a one-time code (single
 * use, ten-minute expiry); the bot redeems it from `/start <code>`, binding the
 * sender's numeric Telegram ID. One Telegram account per user and vice versa.
 * Over the Integrations repositories (CB-110).
 */
export class TelegramLinks implements LinksShape {
    private uow: UnitOfWork;
    private links: TelegramLinkRepository;
    private conversations: TelegramConversationRepository;
    private replies: TelegramReplyRepository;
    private roomCodes: TelegramRoomCodeRepository;
    private topicSenders: TelegramTopicSenderRepository;
    constructor(deps: TelegramLinksDeps) {
        this.uow = deps.uow;
        this.links = deps.links;
        this.conversations = deps.conversations;
        this.replies = deps.replies;
        this.roomCodes = deps.roomCodes;
        this.topicSenders = deps.topicSenders;
    }
    /** A fresh code for this user; earlier unused codes stop working. */
    async createCode(userId: string, now = Date.now()) {
        // Telegram start parameters allow [A-Za-z0-9_-], up to 64 characters.
        const code = randomBytes(18).toString('base64url');
        await this.links.issueCode(digest(code), userId, now + LINK_CODE_TTL_MS, now - LINK_CODE_TTL_MS);
        return { code, expiresAt: now + LINK_CODE_TTL_MS };
    }
    async redeem(
        code: string,
        telegramUserId: string,
        username: string | null = null,
        now = Date.now(),
    ): Promise<RedeemResult> {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(code)) {
            return { ok: false, reason: 'invalid' };
        }
        const hash = digest(code);
        return this.uow.run(
            async (): Promise<RedeemResult> => {
                const row = await this.links.code(hash);
                if (!row) {
                    return { ok: false, reason: 'invalid' };
                }
                if (row.usedAt !== null) {
                    return { ok: false, reason: 'used' };
                }
                if (row.expiresAt <= now) {
                    return { ok: false, reason: 'expired' };
                }
                // Nothing changed: the commit is a no-op.
                if (!(await this.links.claimCode(hash, now))) {
                    return { ok: false, reason: 'used' };
                }
                await this.links.link(telegramUserId, row.userId, username, now);
                return { ok: true, userId: row.userId };
            },
            { label: 'redeem Telegram link code' },
        );
    }
    /** The app user linked to this Telegram account, if any. */
    userFor(telegramUserId: string) {
        return this.links.userFor(telegramUserId);
    }
    linkFor(userId: string) {
        return this.links.linkFor(userId);
    }
    /** Telegram IDs of every linked user. */
    linkedUsers() {
        return this.links.linked();
    }
    /** The app thread for a Telegram conversation key, if one exists. */
    threadFor(key: string) {
        return this.conversations.threadFor(key);
    }
    /** Points a conversation at a new thread (its Dot was archived). */
    rebindThread(key: string, threadId: string) {
        return this.conversations.rebind(key, threadId);
    }
    /**
     * Frees a conversation's key for a new thread (`/new` in a DM); the
     * thread it had stays Telegram's (CB-145).
     */
    retireConversation(key: string) {
        return this.conversations.retire(key);
    }
    bindThread(key: string, threadId: string, kind: TelegramConversationKind, chatId: string, topicId: string | null) {
        return this.conversations.bind(key, threadId, { kind, chatId, topicId }, Date.now());
    }
    /** Telegram facts for an app thread, if it came from Telegram. */
    threadInfo(threadId: string) {
        return this.conversations.info(threadId);
    }
    /** `threadInfo`, synchronously (Space access, CB-181). */
    threadInfoNow(threadId: string) {
        return this.conversations.infoNow(threadId);
    }
    /**
     * `threadInfo` for many threads in one query (a conversation list):
     * only the threads that came from Telegram are in the map.
     */
    threadInfos(threadIds: string[]): Promise<Map<string, TelegramThreadInfo>> {
        return this.conversations.infos(threadIds);
    }
    /** Records that a linked user spoke in a group chat (membership for team conversations). */
    recordMember(chatId: string, userId: string, now = Date.now()) {
        return this.conversations.recordMember(chatId, userId, now);
    }
    /**
     * Whether this user's Telegram account still reaches a conversation, for
     * a message the server sends there on their behalf (CB-58): linked, and
     * that account's own DM, or a group chat they have spoken in.
     */
    async reaches(conversation: { kind: TelegramConversationKind; chatId: string }, userId: string): Promise<boolean> {
        const link = await this.linkFor(userId);
        if (!link) {
            return false;
        }
        if (conversation.kind === 'dm') {
            return link.telegramUserId === conversation.chatId;
        }
        return this.conversations.isMember(conversation.chatId, userId);
    }
    /** The group chats this user has spoken in (their team topics' chats). */
    memberChats(userId: string) {
        return this.conversations.memberChats(userId);
    }
    /** Team (forum topic) threads in chats this user is a member of. */
    teamThreadsForNow(userId: string) {
        return this.conversations.teamThreadsNow(userId);
    }
    teamThreadsFor(userId: string) {
        return this.conversations.teamThreads(userId);
    }
    unlink(userId: string) {
        return this.links.unlink(userId);
    }
    /** The bot's messages in `chatId` that show a socio reply (CB-145). */
    recordReplies(chatId: string, messageIds: string[], reply: TelegramReply, now = Date.now()) {
        return this.replies.record(chatId, messageIds, reply, now);
    }
    /** The linked people seen in a group chat (CB-214). */
    chatMembers(chatId: string) {
        return this.conversations.chatMembers(chatId);
    }
    /**
     * A fresh one-time code (CB-214) for `userId` to post in a forum topic:
     * binding it to room `target` (`bind`), or making legacy topic `target`
     * a room (`convert`). Their earlier code for it stops working. Stored
     * hashed, like link codes.
     */
    async createRoomCode(userId: string, purpose: TelegramRoomCodePurpose, target: string, now = Date.now()) {
        const code = randomBytes(12).toString('base64url');
        const expiresAt = now + ROOM_TOPIC_CODE_TTL_MS;
        await this.roomCodes.issue(
            digest(code),
            { userId, purpose, target, expiresAt, createdAt: now },
            now - ROOM_TOPIC_CODE_TTL_MS,
        );
        return { code, expiresAt };
    }
    /** A room code as stored, if `code` is one. */
    async roomCode(code: string) {
        if (!/^[A-Za-z0-9_-]{8,64}$/.test(code)) {
            return undefined;
        }
        return this.roomCodes.get(digest(code));
    }
    /** Uses a room code up; false when it was used already. */
    claimRoomCode(code: string, now = Date.now()) {
        return this.roomCodes.claim(digest(code), now);
    }
    /**
     * Counts a message the socio did not answer in a bound topic (CB-214):
     * true the first time for that topic, room, sender and reason.
     */
    unanswered(
        sender: Pick<TelegramTopicSender, 'sourceKey' | 'roomId' | 'telegramUserId' | 'reason' | 'username'>,
        now = Date.now(),
    ) {
        return this.topicSenders.record(sender, now);
    }
    /** A room's unanswered senders in its topics, the latest first. */
    unansweredIn(roomId: string, limit = 50) {
        return this.topicSenders.forRoom(roomId, limit);
    }
    /** The socio reply a bot message shows, if it shows one. */
    replyFor(chatId: string, messageId: string) {
        return this.replies.reply(chatId, messageId);
    }
}
