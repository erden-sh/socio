/**
 * What other features may know of the Integrations context (CB-110): the
 * repositories of its tables (Telegram links and conversations, web
 * identity and the web-read audit, computer permissions and audit, the
 * custom domains' hosts and operations), as interfaces and as tags, and
 * the plain types they name. It imports only `effect` and `@socio/*`, and
 * holds no logic.
 *
 * The types here moved from `domain/repositories.ts`, which re-exports them, so
 * every importer (`telegram`, `web`, `computers`, `domains` and this folder's
 * infra) keeps compiling until that importer switches to the contract.
 *
 * Not here, on purpose:
 * - `sqliteIntegrationRepositories` (`infra/sqlite/index.ts`): what the
 *   four stores (`TelegramLinks`, `WebStore`, `ComputerStore`,
 *   `DomainsStore`) build their repositories with, construction only. The
 *   composition builds them once and provides the tags below.
 * - `telegramSchema`, `webSchema`, `computersSchema` and `domainsSchema`
 *   (`migrations.ts`): the migrations, which run in the one boot step
 *   before any layer is built. Only `migrations.ts` and `infra`
 *   may name these tables (`tests/integration/integration-boundary.test.ts`),
 *   so they stay in this folder rather than in a package.
 * - `integrationTables` (`infra/sqlite/schema.ts`): the Drizzle tables,
 *   which nothing outside `infra` may import.
 * - An `IntegrationsConfig` tag: the context reads no `PlatformConfig`.
 */
import { Context } from 'effect';

import type { ThreadFollower } from '@socio/shared/auth';
import type { ComputerAudit, ComputerPermissions } from '@socio/shared/computers/computer-types';
import type { DomainOp, DomainStep } from '@socio/shared/domains';
import type { WebAudit, WebIdentity } from '@socio/shared/web/web-types';

/**
 * The Integrations context's repositories (CB-110): Telegram
 * links and conversations, web identity and the web-read audit, computer
 * permissions and audit, and the custom domains' hosts and operations.
 * Async, taking and returning plain domain types. Only
 * `integrations/infra` implements them; nothing else touches their tables.
 * Every awaited write works inside or outside a unit of work: outside one
 * it opens its own. Audit rows (`append`, `finish`) are written soon
 * instead (`writeSoon`): at once when the connection is free, else queued
 * behind the open unit, without making the caller wait.
 */

// Telegram

export type TelegramConversationKind = 'dm' | 'topic' | 'group';

/** Where a Telegram conversation lives (`telegram_threads`). */
export interface TelegramThreadInfo {
    kind: TelegramConversationKind;
    chatId: string;
    topicId: string | null;
}

export interface TelegramLink {
    telegramUserId: string;
    username: string | null;
    linkedAt: number;
}

/** A stored link code, by its hash (the code itself is never stored). */
export interface TelegramLinkCode {
    userId: string;
    expiresAt: number;
    usedAt: number | null;
}

/** One-time link codes and the links they made: one per person and account. */
export interface TelegramLinkRepository {
    /** The person's new code; their earlier codes and expired ones go. */
    issueCode(hash: string, userId: string, expiresAt: number, expiredBefore: number): Promise<void>;
    code(hash: string): Promise<TelegramLinkCode | undefined>;
    /** Marks an unused code used; false when it was used already. */
    claimCode(hash: string, now: number): Promise<boolean>;
    /** Links the account to the person, replacing either's earlier link. */
    link(telegramUserId: string, userId: string, username: string | null, now: number): Promise<void>;
    userFor(telegramUserId: string): Promise<string | undefined>;
    linkFor(userId: string): Promise<TelegramLink | undefined>;
    linked(): Promise<Array<{ telegramUserId: string; userId: string }>>;
    /** False when the person had no link. */
    unlink(userId: string): Promise<boolean>;
}

/** Linked people seen in group chats, and the conversations' threads. */
export interface TelegramConversationRepository {
    threadFor(key: string): Promise<string | undefined>;
    bind(key: string, threadId: string, info: TelegramThreadInfo, now: number): Promise<void>;
    rebind(key: string, threadId: string): Promise<void>;
    /**
     * Frees `key` for a new thread (CB-145: `/new` in a DM): its thread
     * keeps its Telegram facts under `<key>~<threadId>`, which no
     * conversation looks up.
     */
    retire(key: string): Promise<void>;
    info(threadId: string): Promise<TelegramThreadInfo | undefined>;
    /** `info`, synchronously: who reads a chat, for Space access (CB-181). */
    infoNow(threadId: string): TelegramThreadInfo | undefined;
    /** Only the threads that came from Telegram are in the map. */
    infos(threadIds: string[]): Promise<Map<string, TelegramThreadInfo>>;
    recordMember(chatId: string, userId: string, now: number): Promise<void>;
    isMember(chatId: string, userId: string): Promise<boolean>;
    memberChats(userId: string): Promise<string[]>;
    /** The linked people seen in a group chat (CB-214: suggested invitees). */
    chatMembers(chatId: string): Promise<string[]>;
    /** Forum topic threads in the chats the person is a member of. */
    teamThreads(userId: string): Promise<string[]>;
    /** Synchronous access check for the legacy Data views. */
    teamThreadsNow(userId: string): string[];
}

/** A socio reply a bot message in a Telegram chat shows (CB-145). */
export interface TelegramReply {
    threadId: string;
    /** The stored assistant message's id. */
    replyId: string;
}

/**
 * Which socio reply each of the bot's messages shows (CB-145): a reply
 * may take several Telegram messages (its text before and after a tool,
 * or one too long for one message), and a person reacts to one of them.
 */
export interface TelegramReplyRepository {
    /** Records `messageIds` (the bot's, in `chatId`) as showing `reply`. */
    record(chatId: string, messageIds: string[], reply: TelegramReply, now: number): Promise<void>;
    reply(chatId: string, messageId: string): Promise<TelegramReply | undefined>;
}

/** What a code that binds a forum topic to a room does (CB-214). */
export type TelegramRoomCodePurpose = 'bind' | 'convert';

/**
 * A stored room code, by its hash: who asked for it, to bind which room
 * (`bind`, `target` a room id) or to convert which legacy topic
 * (`convert`, `target` its thread id).
 */
export interface TelegramRoomCode {
    userId: string;
    purpose: TelegramRoomCodePurpose;
    target: string;
    expiresAt: number;
    usedAt: number | null;
}

/** One-time codes that bind a forum topic to a room (CB-214). */
export interface TelegramRoomCodeRepository {
    /**
     * The person's new code for `purpose` and `target`: their earlier codes
     * for it, and every expired one, go.
     */
    issue(
        hash: string,
        code: Omit<TelegramRoomCode, 'usedAt'> & { createdAt: number },
        expiredBefore: number,
    ): Promise<void>;
    get(hash: string): Promise<TelegramRoomCode | undefined>;
    /** Marks an unused code used; false when it was used already. */
    claim(hash: string, now: number): Promise<boolean>;
}

/**
 * Why the socio did not answer someone who addressed it in a bound topic:
 * their Telegram account is not linked to anyone in Socio, the person it
 * is linked to is not in the room, or the room is closed to work (Rooms
 * off, archived, unbound).
 */
export type TelegramTopicSenderReason = 'unlinked' | 'not_member' | 'closed';

/** A sender the socio did not answer in a bound topic, per room and reason. */
export interface TelegramTopicSender {
    sourceKey: string;
    roomId: string;
    telegramUserId: string;
    reason: TelegramTopicSenderReason;
    /** Their public @username when Telegram gave one; never their name. */
    username: string | null;
    firstSeenAt: number;
    lastSeenAt: number;
    /** How many times they addressed it. */
    seen: number;
    /** When they were told why (once). */
    noticedAt: number | null;
}

export interface TelegramTopicSenderRepository {
    /**
     * Counts an unanswered message: true the first time for this topic,
     * room, sender and reason (they are told why, once), false after.
     */
    record(
        sender: Pick<TelegramTopicSender, 'sourceKey' | 'roomId' | 'telegramUserId' | 'reason' | 'username'>,
        now: number,
    ): Promise<boolean>;
    /** A room's unanswered senders, the latest first. */
    forRoom(roomId: string, limit: number): Promise<TelegramTopicSender[]>;
}

// Web

export interface WebIdentityRepository {
    get(dotId: string): Promise<WebIdentity | undefined>;
    /** Sets the socio's identity, or with null clears it. */
    set(dotId: string, identity: WebIdentity | null, now: number): Promise<void>;
}

/** What a socio's activity shows of a web-audit line (the admins' socios page). */
export interface WebActivity {
    userId: string | null;
    method: string;
    host: string;
    path: string;
    status: number | null;
    outcome: string;
    createdAt: number;
}

/** The web-read audit: append-only, every line kept. */
export interface WebAuditRepository {
    /** Written soon (see above). */
    append(entry: WebAudit & { dotId: string }): void;
    /** The socio's latest lines, newest first. */
    latest(dotId: string, limit: number): Promise<WebAudit[]>;
    activity(dotId: string, before: number, limit: number): Promise<WebActivity[]>;
}

// Computers

export interface ComputerPermissionRepository {
    get(dotId: string): Promise<ComputerPermissions | undefined>;
    save(dotId: string, value: ComputerPermissions): Promise<void>;
}

export interface ComputerAuditEntry {
    id: string;
    dotId: string;
    action: string;
    actor: 'owner' | 'agent' | 'platform';
    userId: string | null;
    createdAt: number;
}

/** What a socio's activity shows of a computer-audit line. */
export interface ComputerActivity {
    action: string;
    actor: string;
    outcome: string;
    userId: string | null;
    createdAt: number;
}

/** The computer audit: every entry kept. */
export interface ComputerAuditRepository {
    /** Whether this person previously used this computer (shared data access). */
    usedBy(userId: string, dotId: string): boolean;
    /** A pending entry, written soon (see above). */
    begin(entry: ComputerAuditEntry): void;
    /** Its outcome, written soon, after the entry. */
    finish(id: string, outcome: 'succeeded' | 'failed'): void;
    latest(dotId: string, limit: number): Promise<ComputerAudit[]>;
    activity(dotId: string, before: number, limit: number): Promise<ComputerActivity[]>;
}

// Domains

/** A hostname the domains module manages, with what it made for it. */
export interface DomainHost {
    hostname: string;
    kind: 'base' | 'custom';
    dnsRecordId: string | null;
    dnsContent: string | null;
    dnsCreated: number;
    certificateId: number | null;
    certificateCreated: number;
    proxyHostId: number | null;
    proxyHostCreated: number;
    createdBy: string;
    createdAt: number;
    updatedAt: number;
}

export interface DomainHostRepository {
    all(kind?: DomainHost['kind']): Promise<DomainHost[]>;
    byName(hostname: string): Promise<DomainHost | undefined>;
    /** Inserts or replaces the whole row. */
    save(host: DomainHost): Promise<void>;
    remove(hostname: string): Promise<void>;
}

/** Every domain operation, kept. */
export interface DomainOpRepository {
    /** A new running operation. */
    start(op: DomainOp): Promise<void>;
    saveSteps(id: string, steps: DomainStep[]): Promise<void>;
    /** Ended: ok, or failed with its (redacted) error. */
    finish(id: string, steps: DomainStep[], error: string | undefined, now: number): Promise<DomainOp | undefined>;
    byId(id: string): Promise<DomainOp | undefined>;
    /** The newest first. */
    latest(limit: number): Promise<DomainOp[]>;
    /** The hostname's last finished operation. */
    lastFinished(hostname: string): Promise<DomainOp | undefined>;
    /** Marks every running one failed (a restart); how many. */
    interruptRunning(now: number): Promise<number>;
}

export interface IntegrationRepositories {
    telegramLinks: TelegramLinkRepository;
    telegramConversations: TelegramConversationRepository;
    telegramReplies: TelegramReplyRepository;
    telegramRoomCodes: TelegramRoomCodeRepository;
    telegramTopicSenders: TelegramTopicSenderRepository;
    webIdentities: WebIdentityRepository;
    webAudit: WebAuditRepository;
    computerPermissions: ComputerPermissionRepository;
    computerAudit: ComputerAuditRepository;
    domainHosts: DomainHostRepository;
    domainOps: DomainOpRepository;
}

/*
 * The repositories as tags, one each, as the stores pick them today from
 * `sqliteIntegrationRepositories(...)`. `infra/sqlite`'s classes implement
 * them. The `Repo` suffix keeps them apart from the services that use them
 * (`TelegramLinks` in `telegram`) and from the shared types of the same
 * name (`WebAudit`, `ComputerAudit`, `ComputerPermissions`).
 */

export class TelegramLinksRepo extends Context.Service<TelegramLinksRepo, TelegramLinkRepository>()(
    'socio/integrations/TelegramLinksRepo',
) {}

export class TelegramConversationsRepo extends Context.Service<
    TelegramConversationsRepo,
    TelegramConversationRepository
>()('socio/integrations/TelegramConversationsRepo') {}

export class TelegramRepliesRepo extends Context.Service<TelegramRepliesRepo, TelegramReplyRepository>()(
    'socio/integrations/TelegramRepliesRepo',
) {}

export class TelegramRoomCodesRepo extends Context.Service<TelegramRoomCodesRepo, TelegramRoomCodeRepository>()(
    'socio/integrations/TelegramRoomCodesRepo',
) {}

export class TelegramTopicSendersRepo extends Context.Service<
    TelegramTopicSendersRepo,
    TelegramTopicSenderRepository
>()('socio/integrations/TelegramTopicSendersRepo') {}

export class WebIdentitiesRepo extends Context.Service<WebIdentitiesRepo, WebIdentityRepository>()(
    'socio/integrations/WebIdentitiesRepo',
) {}

export class WebAuditRepo extends Context.Service<WebAuditRepo, WebAuditRepository>()(
    'socio/integrations/WebAuditRepo',
) {}

export class ComputerPermissionsRepo extends Context.Service<ComputerPermissionsRepo, ComputerPermissionRepository>()(
    'socio/integrations/ComputerPermissionsRepo',
) {}

export class ComputerAuditRepo extends Context.Service<ComputerAuditRepo, ComputerAuditRepository>()(
    'socio/integrations/ComputerAuditRepo',
) {}

export class DomainHostsRepo extends Context.Service<DomainHostsRepo, DomainHostRepository>()(
    'socio/integrations/DomainHostsRepo',
) {}

export class DomainOpsRepo extends Context.Service<DomainOpsRepo, DomainOpRepository>()(
    'socio/integrations/DomainOpsRepo',
) {}

/**
 * A moved conversation's Telegram chat (CB-360's transfer): the chat is the
 * old owner's, so it lets go of the conversation, and their next message
 * there starts a new one. `infra/sqlite/ownership.ts` implements it.
 */
export type TelegramThreadOwnershipShape = ThreadFollower;
