/**
 * What approvals' services read of other features, each by its contract's
 * slice: the sources `layer.ts` builds them over from the tags. Values that
 * are set after the graph is built (the Telegram channel, the drain) or
 * that are the composition's (a socio's turn, the log) are functions, read
 * at the moment of use.
 */
import type { CallbackKeyboard } from '@socio/foundation/telegram/buttons';
import type { TelegramStatus } from '@socio/shared/types';

import type { CyclesShape } from '../cycles/contract.js';
import type { FlagsShape } from '../flags/contract.js';
import type { InferenceResolver } from '../inference/contract.js';
import type { WorkspaceSettingsShape } from '../settings/contract.js';
import type { PlatformTurnOptions, RunnerShape, TurnOutcome } from '../turns/contract.js';

import type {
    ApprovalConversations,
    ApprovalsConfigShape,
    ApprovalSocios,
    ApprovalsShape,
    ApprovalsWorkspaceShape,
} from './contract.js';
import type { ApprovalService } from './service.js';

// ── What approvals read of the features above them ──────────────────────
//
// The workspace's socios and conversations and Telegram's links and
// channel sit above approvals in the folder order
// (scripts/feature-ranks.json), so approvals declare the members they call
// here rather than importing those contracts. `WorkspaceStore`,
// `TelegramLinks` and `TelegramChannel` answer them; the composition root
// provides them (`composition/approvals.ts`).

/** Where a Telegram conversation is (`TelegramConversationKind`): the notice says where the socio carries on. */
export type NoticeConversationKind = 'dm' | 'topic' | 'group';

/** A Telegram conversation an app thread came from (`TelegramThreadInfo`). */
export interface ApprovalTelegramConversation {
    kind: NoticeConversationKind;
    chatId: string;
    topicId: string | null;
}

/** The socios and the conversations, as approvals read them: moved to the contract. */
export type { ApprovalConversations, ApprovalSocios };

/** The Telegram links (`LinksShape`, telegram's contract). */
export interface ApprovalLinks {
    /** Telegram facts for an app thread, if it came from Telegram. */
    threadInfo(threadId: string): Promise<ApprovalTelegramConversation | undefined>;
    /** The person's link, if they linked a Telegram account. */
    linkFor(userId: string): Promise<{ telegramUserId: string } | undefined>;
    /** Whether the person's linked account still reaches the conversation (CB-58). */
    reaches(conversation: Pick<ApprovalTelegramConversation, 'kind' | 'chatId'>, userId: string): Promise<boolean>;
}

/** The Telegram channel (`ChannelShape`, telegram's contract), when configured. */
export interface ApprovalChannel {
    /** `online` once polling. */
    readonly status: TelegramStatus;
    /** A direct message from the bot to a Telegram user; the sent message's id. */
    sendDirect(
        telegramUserId: string,
        text: string,
        signal?: AbortSignal,
        extra?: { buttons?: CallbackKeyboard; silent?: boolean },
    ): Promise<number>;
    /** Whether a turn may still act for this user in the conversation and post there. */
    reaches(conversation: Pick<ApprovalTelegramConversation, 'kind' | 'chatId'>, userId: string): Promise<boolean>;
    /** A message in a conversation from a turn the channel did not run, split at Telegram's limit. */
    sendToConversation(
        conversation: Pick<ApprovalTelegramConversation, 'chatId' | 'topicId'>,
        text: string,
    ): Promise<void>;
}

/** What the workspace's approval service reads of other features, by their contracts' slices. */
export interface ApprovalSources {
    readonly socios: Pick<ApprovalSocios, 'dot'>;
    readonly conversations: Pick<ApprovalConversations, 'thread' | 'allows'>;
    readonly people: ApprovalsWorkspaceShape['people'];
    readonly runner: Pick<RunnerShape, 'activeRunId'>;
    readonly cycles: Pick<CyclesShape, 'running' | 'settleWaiting'>;
    readonly inference: InferenceResolver;
}

/**
 * What the notices read: the approvals they listen to, the Telegram links,
 * the config, and the channel, which is set after they are built (a
 * late-bound port), so it is read when a request waits.
 */
export interface ApprovalNoticeSources {
    readonly approvals: Pick<ApprovalsShape, 'onPending'>;
    readonly links: Pick<ApprovalLinks, 'threadInfo' | 'linkFor'>;
    readonly config: ApprovalsConfigShape;
    readonly telegram: () => ApprovalChannel | undefined;
}

/**
 * What the continuations read, each by its contract's slice. The channel,
 * the drain, the turn and the log are read when a continuation runs: the
 * first two are set after the continuations are built (late-bound ports),
 * and the turn is `AppTurns`'s.
 */
export interface ContinuationSources {
    readonly approvals: Pick<
        ApprovalService,
        | 'onSettled'
        | 'endRunningContinuations'
        | 'waitingThreads'
        | 'readyToContinue'
        | 'markContinuation'
        | 'recordNote'
    >;
    readonly runner: Pick<RunnerShape, 'onRunFinished' | 'activeRunId'>;
    readonly cycles: Pick<CyclesShape, 'cycle' | 'context'>;
    readonly socios: Pick<ApprovalSocios, 'dot'>;
    readonly conversations: ApprovalConversations;
    readonly links: Pick<ApprovalLinks, 'threadInfo' | 'reaches'>;
    readonly settings: Pick<WorkspaceSettingsShape, 'settings'>;
    readonly telegram: () => ApprovalChannel | undefined;
    readonly draining: () => boolean;
    readonly turnOutcome: (
        threadId: string,
        prompt: string,
        signal: AbortSignal,
        options?: PlatformTurnOptions,
    ) => Promise<TurnOutcome>;
    readonly log: (line: string) => void;
}

/**
 * What the routes read of the platform the module is given, when they are
 * called: approvals' own service, and the socios and the flags by their
 * slices.
 */
export interface ApprovalRoutesPlatform {
    readonly approvals: ApprovalsShape;
    readonly workspace: Pick<ApprovalSocios, 'canUseDot'>;
    readonly flags: Pick<FlagsShape, 'enabled'>;
}
