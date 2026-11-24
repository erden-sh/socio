/**
 * What other features may know of chat names: the automatic title of a new
 * chat (`ThreadTitler`) and the content-based name suggestions (CB-292). Its
 * tags, as slices of the methods callers use, and the plain types they
 * name. It imports only `effect` and holds no logic.
 *
 * The types here moved from the files that defined them (`repository.ts`,
 * `routes.ts`, `triggers.ts`), which re-export them, so every importer keeps
 * compiling until that importer switches to the contract.
 *
 * Not here, on purpose:
 * - `sqliteChatNameSuggestionRepository`, `ThreadTitler` and
 *   `ChatNameSuggestions`: construction (`layer.ts`, which
 *   `composition/chat-name-suggestions.ts` wires).
 *   Other folders and the composition get the tags below.
 * - `chatNameRoutes`: route mounting (workspace's routes mount it today;
 *   route mounting belongs in `composition/http`). Only its deps' type is
 *   here.
 * - `chatNamesModule` and `chatNamesSchema`: the modules registry's.
 * - The trigger thresholds, `evaluateNameTrigger`, `keywordsOf`,
 *   `nameOverlap`, `suggestChatName` and `cleanTitle`: only this folder and
 *   its tests use them, so no package.
 * - A config tag: this folder reads no `PlatformConfig` field (the switch
 *   comes from Settings' `chatNameSuggestions`).
 */
import { Context } from 'effect';

// ── Suggestions (`repository.ts`, `triggers.ts`) ─────────────────────────

/** Why a name was suggested: the chat is still unnamed, or its topic drifted. */
export type NameTrigger = 'unnamed' | 'drift';

/** One chat's name suggestion state (CB-292). */
export interface ChatNameSuggestion {
    threadId: string;
    suggestedName: string;
    trigger: NameTrigger;
    status: 'pending' | 'accepted' | 'rejected' | 'customized';
    /** Message count when the suggestion was made. */
    suggestedAtMessageIndex: number;
    /** Message count at the last reject; -1 when none. */
    rejectedAtMessageIndex: number;
    createdAt: number;
    settledAt: number | null;
}

/** How a settled suggestion was resolved (for audit / the card). */
export type SuggestionResolution = 'accepted' | 'rejected' | 'customized';

export interface ChatNameSuggestionRepository {
    /** The chat's current suggestion row, if any (any status). */
    get(threadId: string): ChatNameSuggestion | undefined;
    /** The chat's pending suggestion, if any. */
    pending(threadId: string): ChatNameSuggestion | undefined;
    /** Records a new pending suggestion (replacing any prior row). */
    insert(suggestion: ChatNameSuggestion): void;
    /** Updates the suggestion to a settled status (and rejected index). */
    settle(threadId: string, resolution: SuggestionResolution, at: number, rejectedAtMessageIndex?: number): void;
    /** Removes the row (after the name is applied or the chat is gone). */
    clear(threadId: string): void;
}

/**
 * The suggestion store the name-suggestion card's routes read and settle
 * (`SuggestionsRepo` today).
 */
export class SuggestionsRepo extends Context.Service<SuggestionsRepo, ChatNameSuggestionRepository>()(
    'socio/chat-name-suggestions/SuggestionsRepo',
) {}

// ── Routes (`routes.ts`) ─────────────────────────────────────────────────

/** What `chatNameRoutes` is built with: the repo and the workspace's answers. */
export interface ChatNameRoutesDeps {
    repo: ChatNameSuggestionRepository;
    /** Apply the name to the chat (rename). Returns the new title. */
    applyName: (threadId: string, name: string, byUserId: string) => string | undefined;
    /**
     * Whether `userId` may review a suggestion for this chat: room admins for
     * shared rooms, the owner for single-user chats (CB-292).
     */
    mayReview: (threadId: string, userId: string) => boolean;
    /** The chat's current message count, to stamp a reject's cooldown. */
    messageCount: (threadId: string) => Promise<number>;
    now?: () => number;
}

// ── Running work (`thread-titles.ts`, `service.ts`) ──────────────────────

/**
 * What the shutdown (`LeaderWork.stop`) and tests call on the title writer: it is
 * attached to the runner when built, so callers only wait for or stop it.
 */
export interface ThreadTitlesShape {
    /** Resolves when titles requested so far have settled. */
    idle(): Promise<void>;
    /** Asks for no more titles, cancels those in flight and waits for them. */
    stop(): Promise<void>;
}

export class ThreadTitles extends Context.Service<ThreadTitles, ThreadTitlesShape>()(
    'socio/chat-name-suggestions/ThreadTitles',
) {}

/** What the shutdown (`LeaderWork.stop`) and tests call on the name-suggestion service. */
export interface ChatNamesShape {
    /** Resolves when suggestions requested so far have settled. */
    idle(): Promise<void>;
    /** Asks for no more suggestions and cancels one in flight. */
    stop(): Promise<void>;
    /** The chat's suggestion row, if any (any status). */
    suggestion(threadId: string): ChatNameSuggestion | undefined;
}

export class ChatNames extends Context.Service<ChatNames, ChatNamesShape>()('socio/chat-name-suggestions/ChatNames') {}
