/**
 * What other features may know of Telegram (CB-145, CB-214): its
 * tags, the slices of the channel and the links store they call, and plain
 * types and constants. It imports only `effect`, `@socio/*` and other
 * contracts, and holds no logic.
 *
 * `TelegramSettings` and `NO_TEXT_REPLY` moved here from `telegram-channel.ts`;
 * that old path was later dropped and `NO_TEXT_REPLY` moved on into
 * `@socio/foundation/telegram/replies`, re-exported below. `TelegramChannel`
 * implements `ChannelShape` and `TelegramLinks` implements `LinksShape`. The
 * link and conversation records are the Integrations context's
 * (`integrations/contract.ts`, CB-110); the ones other folders name through
 * `telegram/` are re-exported below.
 *
 * Moved to packages: the inline buttons (`approvalButtons` and the rest of
 * `telegram-buttons.ts`) to `@socio/foundation/telegram/buttons`, and
 * `teamOwner` to `@socio/foundation/telegram/team-owner` (their old paths
 * are gone).
 *
 * Not here, on purpose:
 * - `TelegramChannel.start`, `stop`, `refreshMenu` and the photo and edit
 *   sends: the channel's own lifecycle (`telegram-module.ts`) and
 *   notification channel (`telegram-notify.ts`) call them.
 * - `TelegramChannel.useServices` and `TelegramServices`: wiring
 *   `LeaderWork.useTelegram` does once (`platform.ts`), typed by the
 *   approvals, schedules and rooms contracts' shapes. It goes when
 *   `platform.ts` stops calling it.
 * - `telegramFromEnv`: the boot step (`composition/lifecycle/telegram.ts`)
 *   reads the bot's settings from the environment it is given, where it
 *   logs and throws as before. `TelegramConfig` is built from the
 *   process's config (`composition/telegram.ts`): only `appOrigin` until
 *   the env parsing moves into composition.
 * - `channelsSchema` and `SqliteStateStore` (`channel-state.ts`): the
 *   channel's own state store, which the boot step migrates and the
 *   composition root opens.
 * - The link codes (`createCode`, `redeem`, `unlink`) and the conversation
 *   bindings and replies the channel records: only `telegram/` calls them.
 */
import { Context } from 'effect';

import type { CallbackKeyboard } from '@socio/foundation/telegram/buttons';
import type { TelegramStatus } from '@socio/shared/types';

import type {
    TelegramConversationKind,
    TelegramLink,
    TelegramRoomCode,
    TelegramRoomCodePurpose,
    TelegramThreadInfo,
    TelegramTopicSender,
} from '../integrations/contract.js';

export type { TelegramStatus } from '@socio/shared/types';
export type {
    TelegramConversationKind,
    TelegramLink,
    TelegramRoomCode,
    TelegramRoomCodePurpose,
    TelegramThreadInfo,
    TelegramTopicSender,
} from '../integrations/contract.js';

// ── Settings and replies ─────────────────────────────────────────────────

/** The bot the channel polls as (`telegramFromEnv`). */
export interface TelegramSettings {
    token: string;
    /** Group and supergroup chat IDs the bot answers in. DMs need only a link. */
    allowedChatIds: string[];
    dotId?: string;
}

/** Posted for a turn that ended without text (`@socio/foundation/telegram/replies`). */
export { NO_TEXT_REPLY } from '@socio/foundation/telegram/replies';

// ── Channel ──────────────────────────────────────────────────────────────

/** A conversation the channel may post in for a person (`reaches`). */
export interface ReachedConversation {
    kind: TelegramConversationKind;
    chatId: string;
}

/** Where a message to a conversation goes: its chat, and its forum topic if any. */
export interface PostedConversation {
    chatId: string;
    topicId: string | null;
}

/**
 * The Telegram channel (`Ports.telegram`), as other folders and the
 * composition call it: approvals, coding's reports and schedules' long-run
 * reports post a socio's reply where its turn came from, approvals and
 * issues send direct messages, rooms show the bot, and the platform
 * drains it and counts its turns. `TelegramChannel` implements it.
 */
export interface ChannelShape {
    /** `online` once polling; `not_configured` after `stop`. */
    readonly status: TelegramStatus;
    /** The bot's @username, known once connected. */
    readonly username?: string;
    /** Replies in progress, which a restart waits for (`LeaderWork.inProgress`). */
    readonly handling: number;
    /**
     * A direct message from the bot to a Telegram user, without a link
     * preview; the sent message's id. Throws when the channel isn't online.
     */
    readonly sendDirect: (
        telegramUserId: string,
        text: string,
        signal?: AbortSignal,
        extra?: { buttons?: CallbackKeyboard; silent?: boolean },
    ) => Promise<number>;
    /**
     * Whether a turn may still act for this user in a Telegram conversation
     * and post there: still a user, linked, and in that chat.
     */
    readonly reaches: (conversation: ReachedConversation, userId: string) => Promise<boolean>;
    /**
     * A message in a conversation from a turn the channel did not run (a
     * socio carrying on after an approval, CB-58), split at Telegram's
     * limit. Throws when the channel isn't online.
     */
    readonly sendToConversation: (conversation: PostedConversation, text: string) => Promise<void>;
    /** Draining for a restart: stops polling; turns in progress finish. */
    readonly drain: () => Promise<void>;
}

/**
 * The channel when Telegram is configured. `Ports.telegram` is optional
 * today, so the default is undefined and callers keep checking for it.
 */
export const Channel = Context.Reference<ChannelShape | undefined>('socio/telegram/Channel', {
    defaultValue: () => undefined,
});

// ── Links ────────────────────────────────────────────────────────────────

/**
 * Telegram accounts linked to people and the conversations they came from
 * (`WorkspaceStore.telegram`), as other folders read them: whether a chat
 * came from Telegram and where (Space access, memory, reports, approvals,
 * the live views), who a Telegram account is, and rooms' forum-topic codes
 * and unanswered senders (CB-214). `TelegramLinks` implements it.
 */
export interface LinksShape {
    /** The person's link, if they linked a Telegram account. */
    readonly linkFor: (userId: string) => Promise<TelegramLink | undefined>;
    /** The person linked to this Telegram account, if any. */
    readonly userFor: (telegramUserId: string) => Promise<string | undefined>;
    /** A fresh link code for this person; earlier unused codes stop working (the link routes). */
    readonly createCode: (userId: string, now?: number) => Promise<{ code: string; expiresAt: number }>;
    /** Removes the person's link; whether there was one (the link routes). */
    readonly unlink: (userId: string) => Promise<boolean>;
    /** Telegram facts for an app thread, if it came from Telegram. */
    readonly threadInfo: (threadId: string) => Promise<TelegramThreadInfo | undefined>;
    /** `threadInfo`, synchronously (Space access, CB-181). */
    readonly threadInfoNow: (threadId: string) => TelegramThreadInfo | undefined;
    /** `threadInfo` for many threads: only the ones that came from Telegram are in the map. */
    readonly threadInfos: (threadIds: string[]) => Promise<Map<string, TelegramThreadInfo>>;
    /** Whether the person's linked account still reaches the conversation (CB-58). */
    readonly reaches: (conversation: ReachedConversation, userId: string) => Promise<boolean>;
    /** The group chats the person has spoken in. */
    readonly memberChats: (userId: string) => Promise<string[]>;
    /** Team (forum topic) threads in the chats the person is a member of. */
    readonly teamThreadsFor: (userId: string) => Promise<string[]>;
    readonly teamThreadsForNow: (userId: string) => string[];
    /** The linked people seen in a group chat (CB-214). */
    readonly chatMembers: (chatId: string) => Promise<string[]>;
    /** A fresh one-time code to bind a forum topic to a room, or convert a legacy topic (CB-214). */
    readonly createRoomCode: (
        userId: string,
        purpose: TelegramRoomCodePurpose,
        target: string,
        now?: number,
    ) => Promise<{ code: string; expiresAt: number }>;
    /** A room code as stored, if `code` is one. */
    readonly roomCode: (code: string) => Promise<TelegramRoomCode | undefined>;
    /** Uses a room code up; false when it was used already. */
    readonly claimRoomCode: (code: string, now?: number) => Promise<boolean>;
    /** Counts a message the socio did not answer in a bound topic: true the first time. */
    readonly unanswered: (
        sender: Pick<TelegramTopicSender, 'sourceKey' | 'roomId' | 'telegramUserId' | 'reason' | 'username'>,
        now?: number,
    ) => Promise<boolean>;
    /** A room's unanswered senders in its topics, the latest first. */
    readonly unansweredIn: (roomId: string, limit?: number) => Promise<TelegramTopicSender[]>;
}

export class Links extends Context.Service<Links, LinksShape>()('socio/telegram/Links') {}

// ── Config ───────────────────────────────────────────────────────────────

/**
 * What `telegram/` reads of the deployment. The bot comes from the
 * environment (`telegramFromEnv`: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_POLLING`,
 * `TELEGRAM_ALLOWED_CHAT_IDS`, `TELEGRAM_DOT_ID`), not `PlatformConfig`; the
 * `PlatformConfig` the channel hands its turns is dots' (`DotsConfig`).
 */
export interface TelegramConfigShape {
    /** The bot, when a token is set and polling is on; none leaves Telegram off. */
    readonly settings?: TelegramSettings;
    /** `TELEGRAM_API_ROOT`: a local fake Bot API, for tests only. */
    readonly apiRoot?: string;
    /** `APP_ORIGIN`: links into the app from direct messages. */
    readonly appOrigin?: string;
}

export class TelegramConfig extends Context.Service<TelegramConfig, TelegramConfigShape>()(
    'socio/telegram/TelegramConfig',
) {}
