/**
 * Telegram channel, without CopilotKit Intelligence.
 *
 * Decision (from a spike on @copilotkit/channels-core and channels-telegram
 * 0.11.0):
 * - The channel runs standalone: `createChannel({...})` and then
 *   `channel.ɵruntime.start()` / `stop()`. Only passing `channels` to
 *   CopilotRuntime is Intelligence-only; the lifecycle needs no key or URL.
 * - The adapter builds its own grammY `Bot(token)`. We replace `adapter.bot`
 *   before start, which lets tests point it at a fake Bot API (`apiRoot`) and
 *   lets our middleware run before the adapter's listener: it enforces the
 *   chat allowlist and redeems `/start <code>` (0.11.0 swallows `/start`
 *   before `onThreadStarted` / `onCommand`). Its file downloads ignore the
 *   bot's root, so `telegram-files.ts` sends them there (CB-8).
 * - The channel calls `agent.runAgent()` on a per-conversation clone with
 *   threadId `tg-thread-tg:<chatId>:<dm|topic:<id>|user:<id>>` and
 *   `forwardedProps.channelActor` (the Telegram sender). Its own history is
 *   in-memory, so `ChannelTurnAgent` maps each conversation to an app thread
 *   and runs the turn through `LocalAgentRunner.run`, with the stored history
 *   merged in. Turns are stored like browser turns (replay, titles, Learning).
 * - Identity: `identifyUser` resolves the sender's numeric Telegram ID through
 *   `TelegramLinks`; unlinked senders get instructions and nothing runs. Each
 *   turn runs as the linked sender (`DotAgent` actingUserId), including in a
 *   shared forum topic.
 * - Failed turns: the adapter's renderer answers a RUN_ERROR with
 *   "⚠️ Agent error: <message>" and stays silent when a turn throws, so the
 *   channel sees a failed turn as finished and `onMessage` posts the turn's
 *   user-facing failure message itself, once.
 * - Supported: private chats, groups and forum topics. Channel posts and
 *   channel direct-message chats are not handled by the adapter.
 */
// Must stay first: see packages/foundation/src/no-vendor-telemetry.ts.
import '@socio/foundation/no-vendor-telemetry';
import { randomUUID } from 'node:crypto';

import {
    AbstractAgent,
    EventType,
    type BaseEvent,
    type Message,
    type RunAgentInput,
    type RunErrorEvent,
} from '@ag-ui/client';
import { createChannel, MemoryStore, type Channel, type StateStore } from '@copilotkit/channels-core';
import {
    telegram,
    type TelegramAdapter,
    type ReplyTarget,
    conversationKeyOf,
    deriveConversationKey,
} from '@copilotkit/channels-telegram';
import { Bot, InputFile, type Context } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import { concatMap, defer, map, of, switchMap, tap, type Observable, type OperatorFunction } from 'rxjs';

import { TURN_FAILURE_MESSAGES, reportFailure, safeFailure } from '@socio/foundation/observability/failures';
import { topicKey } from '@socio/foundation/rooms/topic-keys';
import { isOwnButton } from '@socio/foundation/telegram/buttons';
import { teamOwner } from '@socio/foundation/telegram/team-owner';
import { senderOf as senderNamed, withSender } from '@socio/foundation/workspace/client-messages';
import { threadRunning } from '@socio/shared/chat/thread-running';

import type { TelegramConversationKind } from '../integrations/contract.js';
import { DRAINING_MESSAGE } from '../runtime/contract.js';
import type { RunnerShape } from '../turns/contract.js';

import { NO_TEXT_REPLY, type ChannelShape, type TelegramSettings } from './contract.js';
import type { TelegramStore, TelegramTurnServices, TelegramWorkspace } from './slices.js';
import { routeFileDownloads } from './telegram-files.js';
import {
    bootstrapTelegramIngress,
    signTelegramIngress,
    verifyTelegramIngress,
    TELEGRAM_INGRESS_TTL_MS,
    type TelegramIngress,
} from './telegram-ingress.js';

export { TELEGRAM_INGRESS_PRIMED_AT_KEY } from './telegram-ingress.js';
import { TelegramDirect, type TelegramServices } from './telegram-direct.js';

export type { TelegramServices } from './telegram-direct.js';
import { TELEGRAM_INGRESS_METADATA, type TelegramStatus } from '@socio/shared/types';

import type { TopicRoute } from '../rooms/contract.js';

import {
    BIND_HOW_REPLY,
    BIND_IN_TOPIC_REPLY,
    BIND_NOT_LINKED_REPLY,
    TOPIC_NOTICES,
    addressesBot,
    bindCommandOf,
    bindReply,
    forumTopicOf,
    refreshGroupMenus,
} from './telegram-topics.js';

export function telegramFromEnv(env: Record<string, string | undefined>): TelegramSettings | undefined {
    const token = env.TELEGRAM_BOT_TOKEN?.trim();
    if (!token) {
        return undefined;
    }
    // Only one process may long-poll a bot, and a shell can export the token
    // for other tools; so polling is an explicit opt-in per deployment.
    if (env.TELEGRAM_POLLING?.trim().toLowerCase() !== 'true') {
        console.log('Telegram: TELEGRAM_BOT_TOKEN is set but TELEGRAM_POLLING is not true; not polling.');
        return undefined;
    }
    if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) {
        throw new Error('TELEGRAM_BOT_TOKEN does not look like a Bot API token.');
    }
    const allowedChatIds = (env.TELEGRAM_ALLOWED_CHAT_IDS ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
    for (const id of allowedChatIds) {
        if (!/^-?\d+$/.test(id)) {
            throw new Error('TELEGRAM_ALLOWED_CHAT_IDS must be comma-separated chat IDs.');
        }
    }
    return {
        token,
        allowedChatIds,
        dotId: env.TELEGRAM_DOT_ID?.trim() || undefined,
    };
}

export const UNLINKED_REPLY =
    'Link your Socio account first: in the app, choose Telegram in the sidebar, then Link Telegram.';
export const PAUSED_REPLY = 'Socio is paused. An admin can resume it in the app.';
export const FAILED_REPLY = TURN_FAILURE_MESSAGES.failed;
export const DRAINING_REPLY = DRAINING_MESSAGE;
export const BUSY_REPLY = 'This conversation is already answering in the app. Try again when it finishes.';
/** The most arrival times kept for one conversation's waiting messages. */
const MAX_ARRIVALS = 200;
const INBOUND_DEDUP_TTL_MS = TELEGRAM_INGRESS_TTL_MS;
const MAX_INBOUND_DEDUP = 2000;
export const QUEUED_REPLY = 'Queued. I’ll reply after the current answer.';
/** How often the command menu is checked for changed skills (CB-145). */
const MENU_REFRESH_MS = 60_000;
type QueueReceipt = {
    id: string;
    actorId: string;
    target: ReplyTarget;
    processing: boolean;
    notified: boolean;
    eligible: boolean;
    receiptAbort?: AbortController;
};

/** Parsed `tg-thread-tg:<chatId>:<scope>` conversation identity. */
export function conversationOf(channelThreadId: string): {
    key: string;
    chatId: string;
    kind: TelegramConversationKind;
    topicId: string | null;
} {
    const match = channelThreadId.match(/^tg-thread-(tg:(-?\d+):(dm|topic:(\d+)|user:(\d+)))$/);
    if (!match) {
        throw new Error('Unrecognized Telegram conversation.');
    }
    const [, key, chatId, scope, topicId] = match;
    return {
        key,
        chatId,
        kind: scope === 'dm' ? 'dm' : scope.startsWith('topic:') ? 'topic' : 'group',
        topicId: topicId ?? null,
    };
}

/** `MediaService.ingest`: inline files become attachment references. */
export type AttachmentIngest = (
    turn: { userId: string; threadId: string; dotId: string },
    messages: Message[],
) => Promise<Message[]>;

interface TurnDeps {
    runner: RunnerShape;
    workspace: TelegramWorkspace;
    /**
     * A channel-mode Dot agent for a turn (`DotAgents`): it resolves the
     * turn's model as the linked user and has the modules' tools and
     * computer hooks.
     */
    agents: TelegramTurnServices['agents'];
    /**
     * Stores the files of new messages as attachments and returns the
     * messages with references instead (`LegacyMedia`'s `ingest`, CB-54).
     */
    attachments?: AttachmentIngest;
    dotId: () => string;
    userFor: (telegramUserId: string) => Promise<string | undefined>;
    /** The agent for one turn; a channel-mode DotAgent unless tests replace it. */
    agentFor?: (dotId: string, userId: string) => AbstractAgent;
    /** Whether a group chat is a forum (has topics). */
    isForum?: (chatId: string) => boolean;
    /** A turn in this conversation ended with a RUN_ERROR carrying `message`. */
    onFailed?: (conversationKey: string, message: string) => void;
    /** The runner accepted a turn after its newly captured messages were consumed. */
    onRunning?: (conversationKey: string) => void;
    signIngress?: (threadId: string, messageId: string, ingress: TelegramIngress) => string | undefined;
    /** A turn finished without any visible text; `tools` it called, in order. */
    onSilent?: (conversationKey: string, tools: string[]) => void;
    /** A linked sender's message starts a turn in this app thread. */
    onTurn?: (userId: string, threadId: string) => void;
    /**
     * The conversation's turn runs in this app thread, as this user, and
     * shows this reply (the last of its assistant messages with text), once
     * it has shown one (CB-145).
     */
    onThread?: (conversationKey: string, turn: { threadId: string; userId: string; replyId?: string }) => void;
    /**
     * When the first of the `count` messages a turn takes from its
     * conversation reached the server, before they waited behind its other
     * turns (CB-185: queue time); undefined when it is not known.
     */
    receivedAt?: (conversationKey: string, count: number) => number | undefined;
    /**
     * Who sent the next message a turn takes from its conversation (CB-228):
     * their Telegram id, as the messages were received, oldest first.
     */
    nextSender?: (conversationKey: string) => { actorId: string; messageId: string; botId: string } | undefined;
    /**
     * The room a forum topic is bound to, if it ever was (CB-214): its turns
     * run in the room, never in a legacy team thread.
     */
    topicRoute?: (key: string) => Promise<TopicRoute | undefined>;
    /** Whether a linked person may send in a room now (`roomAllows`). */
    maySend?: (roomId: string, userId: string) => boolean;
}

/**
 * A bound topic's turn its sender may not run (CB-214): their room
 * membership ended, or the room closed, after the message was let in.
 */
export class TopicRefusedError extends Error {
    constructor(readonly reason: 'not_member' | 'closed') {
        super('This topic’s room does not take this message.');
        this.name = 'TopicRefusedError';
    }
}

/**
 * What a turn that showed no text says instead, naming the tools it called.
 */
export function silentReply(tools: string[]) {
    const names = [...new Set(tools)].slice(0, 5);
    return names.length ? `${NO_TEXT_REPLY} Tools used: ${names.join(', ')}.` : NO_TEXT_REPLY;
}

/**
 * Text messages as the Telegram adapter should see them (CB-35). The adapter
 * posts a "…" placeholder on a message's first content and edits it to the
 * final text; Telegram refuses an edit to blank text ("text must be
 * non-empty"), so whitespace before a tool call, or an empty answer, left
 * the placeholder behind. A message is held back until it has visible text
 * (its leading whitespace dropped) and dropped if it never does. `onSilent`
 * is told when a turn finishes without showing any text.
 */
export function visibleTextOnly(onSilent: (tools: string[]) => void): OperatorFunction<BaseEvent, BaseEvent> {
    return (source) =>
        defer(() => {
            const held = new Map<string, { start: BaseEvent; text: string }>();
            const tools: string[] = [];
            let shown = false;
            return source.pipe(
                concatMap((event): BaseEvent[] => {
                    const { messageId, delta } = event as {
                        messageId?: string;
                        delta?: string;
                    };
                    switch (event.type) {
                        case EventType.TEXT_MESSAGE_START:
                            held.set(messageId!, { start: event, text: '' });
                            return [];
                        case EventType.TEXT_MESSAGE_CONTENT: {
                            const pending = held.get(messageId!);
                            if (!pending) {
                                return [event];
                            }
                            pending.text += delta ?? '';
                            if (!pending.text.trim()) {
                                return [];
                            }
                            held.delete(messageId!);
                            shown = true;
                            return [pending.start, { ...event, delta: pending.text.trimStart() } as BaseEvent];
                        }
                        case EventType.TEXT_MESSAGE_END:
                            return held.delete(messageId!) ? [] : [event];
                        case EventType.TOOL_CALL_START:
                            tools.push((event as { toolCallName?: string }).toolCallName!);
                            return [event];
                        case EventType.RUN_FINISHED:
                            if (!shown) {
                                onSilent(tools.filter(Boolean));
                            }
                            return [event];
                        default:
                            return [event];
                    }
                }),
            );
        });
}

/**
 * The agent the channel sees. Each run maps the Telegram conversation to an
 * app thread and runs a channel-mode DotAgent as the linked sender through
 * the durable runner.
 */
export class ChannelTurnAgent extends AbstractAgent {
    private current?: { threadId: string; runId: string };
    /**
     * The Telegram id of who sent each person's message not yet stored, by
     * message id (CB-228). A message refused (Socio paused, the server
     * draining, its sender not linked yet) waits for the conversation's next
     * turn, which may be another person's in a team topic.
     */
    private senders = new Map<string, string>();
    private ingress = new Map<
        string,
        {
            conversationKey: string;
            messageId: string;
            actorId: string;
            botId: string;
        }
    >();
    /**
     * The app thread this session's last run was in, and the messages of
     * the threads it left (CB-145). The session keeps its history in the
     * adapter's memory; after `/new` or `/socio` it goes on in a new app
     * thread, which must not get the earlier thread's messages again.
     */
    private lastThread?: string;
    private left = new Set<string>();
    constructor(public deps: TurnDeps) {
        super({});
    }
    clone() {
        const copy = super.clone() as ChannelTurnAgent;
        copy.deps = this.deps;
        copy.current = this.current;
        copy.senders = new Map();
        copy.ingress = new Map();
        copy.lastThread = undefined;
        copy.left = new Set();
        return copy;
    }
    /**
     * The adapter adds each received message here as its turn takes it, in
     * the order they came (`TelegramConversationStore`): each is from the
     * sender received next.
     */
    addMessage(message: Message) {
        const key = this.threadId?.replace(/^tg-thread-/, '');
        const from = message.role === 'user' && key ? this.deps.nextSender?.(key) : undefined;
        if (from && key) {
            this.senders.set(message.id, from.actorId);
            this.ingress.set(message.id, { conversationKey: key, ...from });
        }
        super.addMessage(message);
    }
    abortRun() {
        if (this.current) {
            void this.deps.runner.stop(this.current);
        }
    }
    /**
     * The app thread for this conversation and sender, created on first use:
     * looked up and bound in one unit of work (CB-110), so two messages at
     * once can't both bind it.
     */
    async threadFor(channelThreadId: string, userId: string) {
        const { workspace } = this.deps;
        let conversation = conversationOf(channelThreadId);
        // A forum's General topic carries no topic ID, so the adapter treats it as
        // a plain group; it is a topic like any other, shared by the team.
        if (conversation.kind === 'group' && this.deps.isForum?.(conversation.chatId)) {
            conversation = {
                key: `tg:${conversation.chatId}:topic:general`,
                chatId: conversation.chatId,
                kind: 'topic',
                topicId: 'general',
            };
        }
        // A topic bound to a room (CB-214) is that room, also before its first
        // turn; a topic whose room was unbound or archived runs nothing. The
        // legacy thread it may have had stays as it was.
        if (conversation.kind === 'topic') {
            const route = await this.deps.topicRoute?.(conversation.key);
            if (route) {
                if (route.status !== 'active') {
                    throw new TopicRefusedError('closed');
                }
                return route.roomId;
            }
        }
        // A DM or per-user group conversation belongs to the linked user; if the
        // Telegram account is relinked to someone else, they get a new thread.
        const key = conversation.kind === 'topic' ? conversation.key : `${conversation.key}#${userId}`;
        return workspace.data.uow.run(
            async () => {
                const existing = await workspace.telegram.threadFor(key);
                const bound = existing ? workspace.thread(existing) : undefined;
                // A thread whose Dot was archived is left as it is, readable; the
                // conversation goes on in a new thread with the channel's Dot.
                const archived = !!bound && !!workspace.dot(bound.dotId)?.archivedAt;
                if (existing && !archived) {
                    return existing;
                }
                const threadId = randomUUID();
                const owner = conversation.kind === 'topic' ? teamOwner(conversation.chatId) : userId;
                const title =
                    conversation.kind === 'dm'
                        ? 'Telegram direct message'
                        : conversation.kind === 'topic'
                          ? conversation.topicId === 'general'
                              ? 'Telegram General'
                              : `Telegram topic ${conversation.topicId}`
                          : 'Telegram group';
                workspace.bindThread(threadId, this.deps.dotId(), title, owner);
                if (existing) {
                    await workspace.telegram.rebindThread(key, threadId);
                    return threadId;
                }
                await workspace.telegram.bindThread(
                    key,
                    threadId,
                    conversation.kind,
                    conversation.chatId,
                    conversation.topicId,
                );
                return threadId;
            },
            { label: 'bind Telegram conversation' },
        );
    }
    run(input: RunAgentInput): Observable<BaseEvent> {
        return defer(async () => {
            const actor = (input.forwardedProps as { channelActor?: { id?: unknown } } | undefined)?.channelActor;
            const userId = actor?.id === undefined ? undefined : await this.deps.userFor(String(actor.id));
            if (!userId) {
                throw new Error('Telegram sender is not linked.');
            }
            const threadId = await this.threadFor(input.threadId, userId);
            // In a room (a bound topic, CB-214) only its members' messages are
            // turns: checked as the message came (the channel's gate), and here
            // again as its turn starts.
            const room = this.deps.workspace.thread(threadId)?.kind === 'room';
            const mayRoom = (person: string) => !room || (this.deps.maySend?.(threadId, person) ?? false);
            if (!mayRoom(userId)) {
                throw new TopicRefusedError('not_member');
            }
            // The sender is in this chat now: a notification for it waits (CB-114).
            this.deps.onTurn?.(userId, threadId);
            const history = await this.deps.runner.messages(threadId);
            const known = new Set(history.map((message) => message.id));
            if (this.lastThread && this.lastThread !== threadId) {
                for (const message of await this.deps.runner.messages(this.lastThread)) {
                    this.left.add(message.id);
                }
            }
            this.lastThread = threadId;
            for (const id of this.senders.keys()) {
                if (known.has(id)) {
                    this.senders.delete(id);
                    this.ingress.delete(id);
                }
            }
            const thread = this.deps.workspace.thread(threadId)!;
            const fresh = input.messages.filter((message) => !known.has(message.id) && !this.left.has(message.id));
            const { key } = conversationOf(input.threadId);
            // When its first new message reached the server, not when its turn
            // came: a turn can wait behind another of its conversation (CB-185).
            const receivedAt =
                this.deps.receivedAt?.(key, fresh.filter((message) => message.role === 'user').length) ?? Date.now();
            // Who said each, for the team transcript (CB-66): its own linked
            // sender (CB-228), else the one whose message starts the turn. One
            // whose sender is still not linked is left out: they were told to
            // link first, and no one else said it.
            const linked = new Map<string, Promise<string | undefined>>();
            const senderOf = (message: Message) => {
                const from = this.senders.get(message.id);
                if (message.role !== 'user' || !from || from === String(actor?.id)) {
                    return Promise.resolve(userId);
                }
                if (!linked.has(from)) {
                    linked.set(from, this.deps.userFor(from));
                }
                return linked.get(from)!;
            };
            const users = this.deps.workspace.users();
            const incoming: Message[] = [];
            for (const message of fresh) {
                const sender = await senderOf(message);
                // Nobody's message, or one from someone no longer in the room,
                // never reaches it (nor under another person's name).
                if (!sender || !mayRoom(sender)) {
                    continue;
                }
                // Photos and documents are stored as attachments of their sender
                // first: the stored run holds references, never their bytes (CB-54).
                const [stored] = this.deps.attachments
                    ? await this.deps.attachments({ userId: sender, threadId, dotId: thread.dotId }, [message])
                    : [message];
                // With their name now, for the model (CB-147).
                const attributed = stored.role === 'user' ? withSender(stored, senderNamed(users, sender)) : stored;
                const ingress = stored.role === 'user' ? this.ingress.get(stored.id) : undefined;
                incoming.push(
                    ingress
                        ? ({
                              ...attributed,
                              metadata: {
                                  ...(
                                      attributed as Message & {
                                          metadata?: Record<string, unknown>;
                                      }
                                  ).metadata,
                                  [TELEGRAM_INGRESS_METADATA]: {
                                      ...ingress,
                                      signature: this.deps.signIngress?.(threadId, stored.id, ingress),
                                  },
                              },
                          } as Message)
                        : attributed,
                );
            }
            // Nothing new from anyone: an earlier turn already took this one's
            // message, with the others that waited behind a running turn
            // (CB-303). The adapter still starts a turn for each message it
            // received; this one runs nothing and says nothing.
            if (!incoming.some((message) => message.role === 'user')) {
                const ids = { threadId: input.threadId, runId: input.runId };
                return of(
                    ...([
                        { type: EventType.RUN_STARTED, ...ids },
                        { type: EventType.RUN_FINISHED, ...ids },
                    ] as BaseEvent[]),
                );
            }
            const messages = [...history, ...incoming];
            const dot =
                this.deps.agentFor?.(thread.dotId, userId) ??
                this.deps.agents.agent({ dotId: thread.dotId, channel: true, actingUserId: userId });
            dot.threadId = threadId;
            dot.setMessages(messages);
            this.current = { threadId, runId: input.runId };
            const run = this.deps.runner.run({
                threadId,
                agent: dot,
                // The linked sender started the turn (CB-185).
                signals: { receivedAt, trigger: { kind: 'person', id: userId } },
                input: {
                    ...input,
                    threadId,
                    messages,
                    tools: [],
                    forwardedProps: {},
                },
            });
            this.deps.onRunning?.(key);
            this.deps.onThread?.(key, { threadId, userId });
            let replyId: string | undefined;
            return run.pipe(
                tap((event) => {
                    const { messageId, delta } = event as {
                        messageId?: string;
                        delta?: string;
                    };
                    if (
                        event.type === EventType.TEXT_MESSAGE_CONTENT &&
                        messageId &&
                        delta?.trim() &&
                        replyId !== messageId
                    ) {
                        replyId = messageId;
                        this.deps.onThread?.(key, { threadId, userId, replyId });
                    }
                }),
                // The stored run keeps its RUN_ERROR; the channel's renderer sees a
                // finished run (flushing any partial reply) and onMessage replies.
                map((event): BaseEvent => {
                    if (event.type !== EventType.RUN_ERROR) {
                        return event;
                    }
                    this.deps.onFailed?.(key, (event as RunErrorEvent).message);
                    return {
                        type: EventType.RUN_FINISHED,
                        threadId,
                        runId: input.runId,
                    } as BaseEvent;
                }),
                visibleTextOnly((tools) => this.deps.onSilent?.(key, tools)),
            );
        }).pipe(switchMap((events) => events));
    }
}

/**
 * A message that starts with a command other than `/start` goes on as
 * text (CB-143). The adapter sends a command to the channel's `onCommand`,
 * which has no handlers, and drops it; as text it is a turn like any
 * other, so the turn runs the skill it names (`/compact`, `/grill_me`)
 * and an unknown command reaches the Dot as written. In a group it is
 * answered as any message is: with the bot's name (`/compact@brain_bot`,
 * as Telegram's command menu writes it) or as a reply to the bot. A
 * command for another bot (`/compact@other_bot`) stays a command, which
 * the adapter ignores; so does one with a bot's name while this bot's is
 * not known yet.
 */
export function commandAsText(ctx: Pick<Context, 'message'>, botUsername: string | undefined) {
    const message = ctx.message;
    if (!message?.text || !message.entities?.length) {
        return;
    }
    const command = /^\/([\w-]+)(?:@(\w+))?/.exec(message.text);
    if (!command || command[1].toLowerCase() === 'start') {
        return;
    }
    if (command[2] && command[2].toLowerCase() !== botUsername?.toLowerCase()) {
        return;
    }
    message.entities = message.entities.filter((entity) => !(entity.type === 'bot_command' && entity.offset === 0));
}

/** The chat ID of a direct message's conversation key; none for a group's. */
function directChat(key: string) {
    try {
        const conversation = conversationOf(`tg-thread-${key}`);
        return conversation.kind === 'dm' ? conversation.chatId : undefined;
    } catch {
        return undefined;
    }
}

export interface TelegramChannelOptions extends TelegramTurnServices {
    settings: TelegramSettings;
    runner: RunnerShape;
    store: TelegramStore;
    workspace: TelegramWorkspace;
    /** Stores incoming files as attachments (`LegacyMedia`'s `ingest`). */
    attachments?: AttachmentIngest;
    isUser: (userId: string) => boolean;
    stateStore?: StateStore;
    /** Bot API base URL; tests point this at a local fake. */
    apiRoot?: string;
    agentFor?: TurnDeps['agentFor'];
    /**
     * A linked person wrote in this app thread's conversation and a turn
     * starts: they count as present there (`platform.notifications.presence`).
     */
    presence?: (userId: string, threadId: string) => void;
}

export class TelegramChannel implements ChannelShape {
    status: TelegramStatus = 'connecting';
    /** The bot's @username, known once connected. */
    username?: string;
    private channel?: Channel;
    private adapter?: TelegramAdapter;
    private monitor?: ReturnType<typeof setInterval>;
    /** Ends sending inbound file downloads to `apiRoot`. */
    private unrouteFiles?: () => void;
    private ignored = new Set<number>();
    /** Group chats seen with topics enabled. */
    private forums = new Set<string>();
    /** Failure message of the turn in progress, by conversation key. */
    private failed = new Map<string, string>();
    /** What to say for a turn in progress that showed no text, by key. */
    private silent = new Map<string, string>();
    private draining = false;
    /** Exact Telegram deliveries are suppressed before the adapter inserts them. */
    private inboundSeen = new Map<string, number>();
    private waitingReceipts = new Map<string, Map<string, QueueReceipt>>();
    private activeReplies = new Set<string>();
    private ingressState?: StateStore;
    private scopeReadyAt = Infinity;
    private botId?: string;
    private ingressSecret?: string;
    /** What the app's other services give the channel (`useServices`). */
    private services: TelegramServices = {};
    /** Direct messages as a full client (CB-145): commands, buttons, reactions. */
    private direct?: TelegramDirect;
    /** Keeps the command menu current. */
    private menuTimer?: ReturnType<typeof setInterval>;
    /** The app thread, sender and reply of each conversation's turn in progress. */
    private turnThreads = new Map<string, { threadId: string; userId: string; replyId?: string }>();
    /**
     * The bot's messages in each direct message while its turn is shown
     * there, by chat ID: they show its reply, for reactions (CB-145).
     */
    private shown = new Map<string, number[]>();

    /**
     * Approvals, jobs and the app's address (`LeaderWork.useTelegram`): what
     * the commands and buttons of direct messages act on.
     */
    useServices(services: TelegramServices) {
        this.services = services;
    }

    private async acceptInbound(ctx: Context, next: () => Promise<void>) {
        const message = ctx.message;
        if (!message) {
            return next();
        }
        const now = Date.now();
        for (const [id, at] of this.inboundSeen) {
            if (now - at >= INBOUND_DEDUP_TTL_MS) {
                this.inboundSeen.delete(id);
            }
        }
        const id = `${message.chat.id}:${message.message_id}`;
        if (this.inboundSeen.has(id)) {
            return;
        }
        this.inboundSeen.set(id, now);
        if (this.inboundSeen.size > MAX_INBOUND_DEDUP) {
            this.inboundSeen.delete(this.inboundSeen.keys().next().value!);
        }
        const actorId = ctx.from && !ctx.from.is_bot ? String(ctx.from.id) : undefined;
        if (actorId) {
            const key = conversationKeyOf(deriveConversationKey(message, Number(actorId)));
            const userId = await this.userFor(actorId);
            if (userId) {
                const conversation = conversationOf(`tg-thread-${key}`);
                const bindingKey =
                    conversation.kind === 'group' && this.forums.has(conversation.chatId)
                        ? `tg:${conversation.chatId}:topic:general`
                        : conversation.kind === 'topic'
                          ? conversation.key
                          : `${key}#${userId}`;
                // A topic bound to a room is the room (CB-214).
                const route = bindingKey.includes(':topic:')
                    ? await this.services.topics?.route(bindingKey)
                    : undefined;
                const threadId =
                    route?.status === 'active'
                        ? route.roomId
                        : await this.options.workspace.telegram.threadFor(bindingKey);
                if (
                    threadId &&
                    this.options.runner.hasTelegramIngress(
                        threadId,
                        key,
                        String(message.message_id),
                        actorId,
                        this.botId!,
                        now - INBOUND_DEDUP_TTL_MS,
                        (storedMessageId, signature) =>
                            this.ingressSecret !== undefined &&
                            verifyTelegramIngress(
                                this.ingressSecret,
                                threadId,
                                storedMessageId,
                                {
                                    conversationKey: key,
                                    messageId: String(message.message_id),
                                    actorId,
                                    botId: this.botId!,
                                },
                                signature,
                            ),
                    )
                ) {
                    return;
                }
            }
            // Priming preserves the old global guard only until every pre-upgrade key expires.
            if (now < this.scopeReadyAt) {
                // A first turn may be waiting in core before its legacy key is written.
                const reserved = [...this.inboundSeen.keys()].some(
                    (other) => other !== id && other.endsWith(`:${message.message_id}`),
                );
                if (
                    reserved ||
                    (await this.ingressState?.kv.get(
                        `dedup:message:telegram:created:${message.message_id}:${message.message_id}`,
                    ))
                ) {
                    // An unscoped refusal is not proof this chat's message was processed.
                    this.inboundSeen.delete(id);
                    return;
                }
            }
        }
        return next();
    }

    /** Best-effort status only: never insert into the queue or model history. */
    private acknowledgeQueued(key: string) {
        if (!this.activeReplies.has(key)) {
            return;
        }
        for (const entry of this.waitingReceipts.get(key)?.values() ?? []) {
            if (entry.processing || entry.notified || !entry.eligible) {
                continue;
            }
            entry.notified = true;
            void (async () => {
                if (!(await this.userFor(entry.actorId))) {
                    return;
                }
                if (
                    this.draining ||
                    this.options.store.settings().paused ||
                    !this.activeReplies.has(key) ||
                    entry.processing ||
                    this.waitingReceipts.get(key)?.get(entry.id) !== entry
                ) {
                    return;
                }
                const api = this.adapter?.bot.api;
                if (!api) {
                    return;
                }
                entry.receiptAbort = new AbortController();
                await api.sendMessage(
                    entry.target.chatId,
                    QUEUED_REPLY,
                    {
                        ...(entry.target.messageThreadId === undefined
                            ? {}
                            : { message_thread_id: entry.target.messageThreadId }),
                        reply_parameters: { message_id: Number(entry.id) },
                        disable_notification: true,
                    },
                    AbortSignal.any([entry.receiptAbort.signal, AbortSignal.timeout(3000)]) as unknown as Parameters<
                        typeof api.sendMessage
                    >[3],
                );
            })().catch(() => {
                if (!entry.receiptAbort?.signal.aborted) {
                    console.warn('Telegram: could not send queued receipt.');
                }
            });
        }
    }

    private trackReceipt(key: string, id: string, actorId: string, rawTarget: unknown) {
        if (!rawTarget || typeof rawTarget !== 'object') {
            return;
        }
        const target = rawTarget as Partial<ReplyTarget>;
        let conversation: ReturnType<typeof conversationOf>;
        try {
            conversation = conversationOf(`tg-thread-${key}`);
        } catch {
            return;
        }
        if (
            String(target.chatId) !== conversation.chatId ||
            !/^\d+$/.test(id) ||
            !/^\d+$/.test(actorId) ||
            (conversation.kind === 'dm' && conversation.chatId !== actorId) ||
            (conversation.kind === 'group' && !key.endsWith(`:user:${actorId}`)) ||
            (conversation.kind !== 'dm' && !this.options.settings.allowedChatIds.includes(conversation.chatId)) ||
            (conversation.topicId ?? null) !==
                (target.messageThreadId === undefined ? null : String(target.messageThreadId))
        ) {
            return;
        }
        const entries = this.waitingReceipts.get(key) ?? new Map<string, QueueReceipt>();
        if (entries.size >= MAX_ARRIVALS) {
            return;
        }
        entries.set(id, {
            id,
            actorId,
            target: target as ReplyTarget,
            processing: false,
            notified: false,
            eligible: !this.draining && !this.options.store.settings().paused,
        });
        this.waitingReceipts.set(key, entries);
        this.acknowledgeQueued(key);
    }

    /** Messages received and not yet answered; the shutdown drain waits for them. */
    handling = 0;
    constructor(private options: TelegramChannelOptions) {}

    /**
     * When each message not yet taken by a turn reached the server, oldest
     * first, by conversation key (CB-185). A turn takes the messages queued
     * for its conversation in the same order (`TelegramConversationStore`).
     * A refused message (draining, unlinked, paused) stays queued for the
     * next turn, but its time is not that turn's queue time.
     */
    private arrivals = new Map<string, { id: string; at: number; refused?: boolean }[]>();
    private arrived(key: string, id: string) {
        const times = this.arrivals.get(key) ?? [];
        // A bound against a turn that never takes its messages.
        if (times.length >= MAX_ARRIVALS) {
            times.shift();
        }
        times.push({ id, at: Date.now() });
        this.arrivals.set(key, times);
    }
    private refused(key: string, id: string | undefined) {
        const entry = this.arrivals.get(key)?.find((time) => time.id === id);
        if (entry) {
            entry.refused = true;
        }
    }
    /**
     * When the first message accepted among the next `count` of `key` came;
     * takes them. A turn refused as busy after taking its messages leaves
     * them queued, so the next turn's count can exceed the times left: its
     * queue time is then low, never high, and the lists come back in step.
     */
    private received(key: string, count: number) {
        const times = this.arrivals.get(key);
        if (!times || count < 1) {
            return undefined;
        }
        const taken = times.splice(0, count);
        for (const { id } of taken) {
            const entry = this.waitingReceipts.get(key)?.get(id);
            if (entry) {
                entry.processing = true;
                entry.receiptAbort?.abort();
            }
        }
        if (!times.length) {
            this.arrivals.delete(key);
        }
        return taken.find((time) => !time.refused)?.at;
    }

    /**
     * Who sent each message not yet taken by a turn, by conversation key, in
     * the order they came (CB-228): their Telegram ids. The adapter queues a
     * message for a conversation's next turn and tells `onTurn` at once, and
     * a turn takes them in order (`ChannelTurnAgent.addMessage`).
     */
    private senders = new Map<string, { actorId: string; messageId: string; botId: string }[]>();
    private queueSender(key: string, telegramId: string, messageId: string) {
        const ids = this.senders.get(key) ?? [];
        ids.push({ actorId: telegramId, messageId, botId: this.botId! });
        this.senders.set(key, ids);
    }
    private nextSender(key: string) {
        const ids = this.senders.get(key);
        const next = ids?.shift();
        if (ids && !ids.length) {
            this.senders.delete(key);
        }
        return next;
    }

    private dotId() {
        const { workspace, settings } = this.options;
        // A company Dot: the channel speaks for several people.
        const set = settings.dotId ? workspace.dot(settings.dotId) : undefined;
        const dot = (set && !set.ownerId && !set.archivedAt ? set : undefined) ?? workspace.companyDots()[0];
        if (!dot) {
            throw new Error('Socio not found.');
        }
        return dot.id;
    }
    private userFor = async (telegramUserId: string) => {
        const userId = await this.options.workspace.telegram.userFor(telegramUserId);
        return userId && this.options.isUser(userId) ? userId : undefined;
    };
    /** Allowlist and account linking, ahead of the adapter's own listener. */
    private gate = async (ctx: Context, next: () => Promise<void>) => {
        const chat = ctx.chat;
        if (!chat) {
            return;
        }
        // Our own buttons (CB-145), in any chat: who pressed one is checked.
        if (isOwnButton(ctx.callbackQuery?.data)) {
            return this.direct?.button(ctx);
        }
        // A reaction in a direct message, on a socio's reply (CB-133).
        if (ctx.messageReaction && chat.type === 'private') {
            await this.direct?.reaction(ctx.messageReaction);
            return;
        }
        commandAsText(ctx, this.adapter?.botUsername);
        if (chat.type !== 'private') {
            if (!this.options.settings.allowedChatIds.includes(String(chat.id))) {
                // Setup aid: the ID (never the title or content) of an ignored chat.
                if (!this.ignored.has(chat.id)) {
                    this.ignored.add(chat.id);
                    console.log(
                        `Telegram: ignoring ${chat.type} ${chat.id}; add it to TELEGRAM_ALLOWED_CHAT_IDS to enable.`,
                    );
                }
                return;
            }
            if ('is_forum' in chat && chat.is_forum) {
                this.forums.add(String(chat.id));
            }
            const from = ctx.from;
            const userId = from && !from.is_bot && (await this.userFor(String(from.id)));
            // The forum topic it is in, and the room it is linked to (CB-214).
            const topic = await this.topicOf(ctx);
            // A linked user speaking here can read this chat's legacy team
            // topics; speaking in a topic linked to a room is the room's, and
            // makes no one a reader of the group's legacy topics (CB-214).
            if (userId && !topic.route) {
                await this.options.workspace.telegram.recordMember(String(chat.id), userId);
            }
            // Rooms (CB-214): `/bind <code>`, and who may talk in a bound topic.
            if (await this.topicGate(ctx, userId || undefined, topic)) {
                return;
            }
            return this.acceptInbound(ctx, next);
        }
        const text = ctx.message?.text ?? '';
        // A topic's code belongs in the topic (CB-214), never in a socio's
        // conversation.
        if (/^\/bind(?:@\w+)?(?:\s|$)/i.test(text.trim())) {
            await ctx.reply(BIND_IN_TOPIC_REPLY);
            return;
        }
        const start = text.match(/^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/);
        // The channel's own commands (`/new`, `/stop`…) never start a turn.
        if (!start) {
            return this.acceptInbound(ctx, () => (this.direct ? this.direct.command(ctx, next) : next()));
        }
        const code = start[1];
        if (!code) {
            await ctx.reply(UNLINKED_REPLY);
            return;
        }
        const from = ctx.from;
        if (!from || from.is_bot) {
            return;
        }
        const result = await this.options.workspace.telegram.redeem(code, String(from.id), from.username ?? null);
        await ctx.reply(
            result.ok
                ? 'Linked. You can message me here, or mention me in your team’s group.'
                : result.reason === 'expired'
                  ? 'That link expired. Create a new one in Socio.'
                  : 'That link is not valid. Create a new one in Socio.',
        );
    };

    /**
     * A group message and forum topics bound to rooms (CB-214): handled here
     * (true) when it is `/bind <code>`, or when it comes to a bound topic
     * from someone who may not talk there. Then it never reaches the
     * adapter: no turn, nothing queued for another person's turn, nothing
     * stored. Who addressed the bot is told why, once. A topic nobody
     * bound goes on as a legacy team topic (false), as before.
     */
    private async topicGate(
        ctx: Context,
        userId: string | undefined,
        { topicId, key, route }: Awaited<ReturnType<TelegramChannel['topicOf']>>,
    ) {
        const message = ctx.message;
        const from = ctx.from;
        const chat = ctx.chat;
        if (!message || !from || from.is_bot || !chat) {
            return false;
        }
        const bot = { username: this.adapter?.botUsername, id: this.botId };
        const command = bindCommandOf(message, bot);
        if (command) {
            await this.bindTopic(ctx, command.code, userId, topicId);
            return true;
        }
        const topics = this.services.topics;
        if (!topics || !key || !route) {
            return false;
        }
        let reason: 'unlinked' | 'not_member' | 'closed' | undefined;
        if (route.status !== 'active') {
            reason = 'closed';
        } else if (!userId) {
            reason = 'unlinked';
        } else {
            const check = topics.sender(route.roomId, userId);
            if (!check.ok) {
                reason = check.reason;
            }
        }
        if (!reason) {
            return false;
        }
        // Only someone who addressed the socio is counted and told, once.
        if (
            addressesBot(message, bot) &&
            (await topics.unanswered({
                key,
                roomId: route.roomId,
                telegramUserId: String(from.id),
                reason,
                username: from.username ?? null,
            }))
        ) {
            await ctx
                .reply(TOPIC_NOTICES[reason], {
                    reply_parameters: { message_id: message.message_id },
                    link_preview_options: { is_disabled: true },
                })
                .catch(() => console.warn('Telegram: could not send a topic notice.'));
        }
        return true;
    }

    /**
     * The forum topic a group message is in (none outside a forum), its
     * conversation key and the room it is linked to, if it ever was
     * (CB-214): a topic with a binding row, active or not, is no legacy
     * topic.
     */
    private async topicOf(ctx: Context): Promise<{
        topicId: string | null;
        key?: string;
        route?: TopicRoute;
    }> {
        const message = ctx.message;
        const chat = ctx.chat;
        if (!message || !chat) {
            return { topicId: null };
        }
        const forum = ('is_forum' in chat && !!chat.is_forum) || this.forums.has(String(chat.id));
        const topicId = forumTopicOf(message, forum);
        if (!topicId) {
            return { topicId };
        }
        const key = topicKey(String(chat.id), topicId);
        return { topicId, key, route: await this.services.topics?.route(key) };
    }

    /**
     * `/bind@bot <code>` in a forum topic (CB-214): the code's person, from
     * their linked account, as an admin of this group (asked of Telegram
     * now), binds the topic to their room or makes its legacy topic a
     * room. The answer goes in the topic.
     */
    private async bindTopic(ctx: Context, code: string, userId: string | undefined, topicId: string | null) {
        const reply = (text: string) =>
            ctx
                .reply(text, {
                    reply_parameters: { message_id: ctx.message!.message_id },
                    link_preview_options: { is_disabled: true },
                })
                .catch(() => console.warn('Telegram: could not answer /bind.'));
        const topics = this.services.topics;
        if (!topics) {
            await reply(bindReply({ ok: false, reason: 'rooms_off' }));
            return;
        }
        if (!code) {
            await reply(BIND_HOW_REPLY);
            return;
        }
        if (!userId) {
            await reply(BIND_NOT_LINKED_REPLY);
            return;
        }
        const chatId = String(ctx.chat!.id);
        let groupAdmin = false;
        try {
            const member = await ctx.api.getChatMember(Number(chatId), ctx.from!.id);
            groupAdmin = member.status === 'creator' || member.status === 'administrator';
        } catch {
            // Not known to be an admin: refused below, the code kept.
        }
        const result = await topics.redeem({
            code,
            userId,
            chatId,
            topicId,
            groupAdmin,
        });
        await reply(bindReply(result));
    }

    async start() {
        const { settings, runner, store, workspace, apiRoot } = this.options;
        this.status = 'connecting';
        this.ingressState = this.options.stateStore ?? new MemoryStore();
        const adapter = telegram({ token: settings.token, showToolStatus: true });
        adapter.bot = new Bot(settings.token, apiRoot ? { client: { apiRoot } } : undefined);
        // The adapter downloads files from api.telegram.org whatever the bot's
        // root (CB-8).
        this.unrouteFiles?.();
        this.unrouteFiles = routeFileDownloads(settings.token, apiRoot);
        adapter.bot.use(this.gate);
        this.direct = new TelegramDirect({
            workspace,
            runner,
            store,
            reactions: this.options.reactions,
            replies: this.options.replies,
            services: () => this.services,
            userFor: this.userFor,
            dotId: () => this.dotId(),
            skills: () => this.options.skills.list(),
            botUsername: () => this.adapter?.botUsername,
            unlinked: UNLINKED_REPLY,
        });
        // The messages that show a turn's reply in a direct message: what the
        // adapter's renderer sends there while the turn runs. The channel's
        // own messages (receipts, notices, buttons) carry a reply, a link
        // preview setting or buttons, which the renderer's never do.
        adapter.bot.api.config.use(async (prev, method, payload, signal) => {
            const result = await prev(method, payload, signal);
            const sent = payload as Record<string, unknown>;
            const ids = this.shown.get(String(sent.chat_id));
            if (
                ids &&
                result.ok &&
                (method === 'sendMessage' || method === 'sendPhoto') &&
                !sent.reply_parameters &&
                !sent.link_preview_options &&
                !sent.reply_markup
            ) {
                ids.push((result.result as { message_id: number }).message_id);
            }
            return result;
        });
        // Count each received message until it is answered, including while it
        // waits behind another turn of its conversation, for the shutdown drain;
        // and note when it came, for its turn's queue time (CB-185).
        const startAdapter = adapter.start.bind(adapter);
        adapter.start = async (sink) => {
            const me = await adapter.bot.api.getMe();
            if (!Number.isSafeInteger(me.id) || me.id <= 0) {
                throw new Error('Telegram bot identity is invalid.');
            }
            this.botId = String(me.id);
            const { primedAt, secret } = await bootstrapTelegramIngress(this.ingressState!, this.botId);
            this.scopeReadyAt = primedAt + INBOUND_DEDUP_TTL_MS + 1;
            this.ingressSecret = secret;
            return startAdapter(
                Object.assign(Object.create(sink) as typeof sink, {
                    onTurn: async (turn: Parameters<typeof sink.onTurn>[0]) => {
                        this.arrived(turn.conversationKey, turn.operation.logicalMessageId);
                        // Called as its message is queued for the conversation's next
                        // turn, before anything else: its sender is next in line.
                        this.queueSender(turn.conversationKey, turn.actor.id, turn.operation.logicalMessageId);
                        this.handling++;
                        const key = turn.conversationKey;
                        const id = turn.operation.logicalMessageId;
                        this.trackReceipt(key, id, turn.actor.id, turn.replyTarget);
                        try {
                            // Core's dedup key is global, but Telegram message IDs are chat-scoped.
                            // Keep wire/reply IDs intact; namespace only the operation revision.
                            await sink.onTurn({
                                ...turn,
                                operation: {
                                    ...turn.operation,
                                    revisionId:
                                        Date.now() < this.scopeReadyAt
                                            ? turn.operation.revisionId
                                            : JSON.stringify([this.botId, key, turn.operation.revisionId]),
                                },
                            });
                        } finally {
                            this.handling--;
                            const entries = this.waitingReceipts.get(key);
                            entries?.get(id)?.receiptAbort?.abort();
                            entries?.delete(id);
                            if (!entries?.size) {
                                this.waitingReceipts.delete(key);
                            }
                        }
                    },
                }),
            );
        };
        this.adapter = adapter;
        const channel = createChannel({
            name: 'socio-telegram',
            identifyUser: async (ctx) => {
                const userId = await this.userFor(ctx.actor.id);
                if (!userId) {
                    return null;
                }
                const user = workspace.users().find((entry) => entry.id === userId);
                return { id: userId, name: user?.name ?? userId };
            },
            adapters: [adapter],
            agent: new ChannelTurnAgent({
                runner,
                workspace,
                agents: this.options.agents,
                attachments: this.options.attachments,
                dotId: () => this.dotId(),
                userFor: this.userFor,
                isForum: (chatId) => this.forums.has(chatId),
                agentFor: this.options.agentFor,
                onFailed: (key, message) => this.failed.set(key, message),
                onSilent: (key, tools) => this.silent.set(key, silentReply(tools)),
                onTurn: this.options.presence,
                onThread: (key, turn) => this.turnThreads.set(key, turn),
                receivedAt: (key, count) => this.received(key, count),
                nextSender: (key) => this.nextSender(key),
                topicRoute: async (key) => this.services.topics?.route(key),
                maySend: (roomId, userId) => this.services.topics?.sender(roomId, userId).ok ?? false,
                signIngress: (threadId, messageId, ingress) =>
                    signTelegramIngress(this.ingressSecret!, threadId, messageId, ingress),
                onRunning: (key) => {
                    this.activeReplies.add(key);
                    this.acknowledgeQueued(key);
                },
            }),
            store: {
                adapter: this.ingressState,
                concurrency: 'serial',
                dedupTtl: INBOUND_DEDUP_TTL_MS,
            },
        });
        channel.onMessage(async ({ thread, message }) => {
            const key = thread.conversationKey;
            const entry = this.waitingReceipts.get(key)?.get(message.operation?.logicalMessageId ?? '');
            if (entry) {
                entry.processing = true;
                entry.receiptAbort?.abort();
            }
            // Refused, the message stays queued for the conversation's next turn.
            const refuse = (reply: string) => {
                this.refused(thread.conversationKey, message.operation?.logicalMessageId);
                return thread.post(reply);
            };
            if (this.draining) {
                await refuse(DRAINING_REPLY);
                return;
            }
            if (!message.user) {
                await refuse(UNLINKED_REPLY);
                return;
            }
            if (store.settings().paused) {
                await refuse(PAUSED_REPLY);
                return;
            }
            // Turns of one conversation run one at a time ('serial').
            this.failed.delete(key);
            this.silent.delete(key);
            this.turnThreads.delete(key);
            const dm = directChat(key);
            const startedAt = Date.now();
            if (dm) {
                this.shown.set(dm, []);
            }
            let reply: string | undefined;
            try {
                await thread.runAgent();
                // A failure replaces whatever the turn showed; silence gets a note.
                reply = this.failed.get(key) ?? this.silent.get(key);
            } catch (error) {
                const busy = threadRunning(error);
                // A bound topic's room no longer takes this sender's message
                // (CB-214): said plainly, not as a failure.
                const topic = error instanceof TopicRefusedError ? error.reason : undefined;
                if (!busy && !topic) {
                    reportFailure('Telegram turn failed', [safeFailure(error)]);
                }
                reply = topic ? TOPIC_NOTICES[topic] : busy ? BUSY_REPLY : (this.failed.get(key) ?? FAILED_REPLY);
            } finally {
                this.activeReplies.delete(key);
                this.failed.delete(key);
                this.silent.delete(key);
            }
            if (dm) {
                await this.afterDirectTurn(key, dm, startedAt).catch(() =>
                    console.warn('Telegram: could not finish a direct message turn.'),
                );
            }
            if (reply) {
                await thread.post(reply).catch(() => {});
            }
        });
        this.channel = channel;
        try {
            await channel.ɵruntime.start();
        } catch (error) {
            this.status = 'failed';
            reportFailure('Telegram channel failed to start', [safeFailure(error)]);
            return;
        }
        // Replace the adapter's handler, which logs raw errors.
        adapter.bot.catch((error) => reportFailure('Telegram update failed', [safeFailure(error.error)]));
        this.username = adapter.botUsername;
        const check = () => {
            this.status = adapter.bot.isRunning() ? 'online' : 'failed';
        };
        check();
        this.monitor = setInterval(check, 5_000);
        this.monitor.unref();
        // The command menu, kept current as skills change (CB-145).
        const menu = () =>
            void this.refreshMenu().catch(() => console.warn('Telegram: could not set the command menu.'));
        menu();
        this.menuTimer = setInterval(menu, MENU_REFRESH_MS);
        this.menuTimer.unref();
    }

    /**
     * Registers Telegram's command menu for direct messages, when it changed
     * (a chat skill added, renamed or removed); checked every minute.
     */
    async refreshMenu() {
        const api = this.adapter?.bot.api;
        if (api && this.direct) {
            await this.direct.refreshMenu(api);
        }
        // Groups' menus (CB-214): skills, and `/bind` for their admins.
        if (api) {
            this.groupMenu = await refreshGroupMenus(api, await this.options.skills.list(), this.groupMenu);
        }
    }
    /** The group menus last registered. */
    private groupMenu?: string;

    /**
     * After a turn in a direct message (CB-145): the bot's messages that
     * showed its reply are recorded as that reply's, for reactions, and the
     * memories its socio proposed are offered with Keep and Turn down.
     */
    private async afterDirectTurn(key: string, chatId: string, since: number) {
        const shown = this.shown.get(chatId) ?? [];
        this.shown.delete(chatId);
        const turn = this.turnThreads.get(key);
        this.turnThreads.delete(key);
        const api = this.adapter?.bot.api;
        if (!turn || !api) {
            return;
        }
        if (turn.replyId && shown.length) {
            await this.options.workspace.telegram.recordReplies(chatId, shown.map(String), {
                threadId: turn.threadId,
                replyId: turn.replyId,
            });
        }
        await this.direct?.offerTurnProposals(api, chatId, turn.userId, turn.threadId, since);
    }

    /**
     * A direct message from the bot to a Telegram user (a private chat's ID is
     * the user's ID). No link preview: Telegram would fetch the link.
     */
    async sendDirect(
        telegramUserId: string,
        text: string,
        signal?: AbortSignal,
        /** Buttons under it (CB-145); `silent`: without a sound. */
        extra: { buttons?: InlineKeyboardMarkup; silent?: boolean } = {},
    ) {
        if (!this.adapter || this.status !== 'online') {
            throw new Error('Telegram is not connected.');
        }
        const sent = await this.adapter.bot.api.sendMessage(
            Number(telegramUserId),
            text,
            {
                link_preview_options: { is_disabled: true },
                ...(extra.buttons ? { reply_markup: extra.buttons } : {}),
                ...(extra.silent ? { disable_notification: true } : {}),
            },
            // Grammy types its node-fetch polyfill signal; Node's native signal is compatible at runtime.
            signal as Parameters<typeof this.adapter.bot.api.sendMessage>[3],
        );
        return sent.message_id;
    }

    /** Replaces the text of a message the bot sent in a chat (CB-145). */
    async editDirect(chatId: string, messageId: number, text: string) {
        if (!this.adapter || this.status !== 'online') {
            throw new Error('Telegram is not connected.');
        }
        await this.adapter.bot.api
            .editMessageText(Number(chatId), messageId, text, {
                link_preview_options: { is_disabled: true },
            })
            .catch((error: unknown) => {
                // The same text again is no change.
                if (!/message is not modified/i.test(String(error))) {
                    throw error;
                }
            });
    }

    /**
     * A photo from the bot to a Telegram user, with a caption (the caller
     * keeps it within Telegram's 1024 characters). The bot uploads the bytes,
     * so Telegram never fetches the image from anywhere (CB-114).
     */
    async sendPhotoDirect(
        telegramUserId: string,
        bytes: Buffer,
        mediaType: string,
        caption: string,
        signal?: AbortSignal,
    ) {
        if (!this.adapter || this.status !== 'online') {
            throw new Error('Telegram is not connected.');
        }
        const subtype = mediaType.split('/')[1]?.replace(/[^a-z0-9]/gi, '');
        const ext = subtype === 'jpeg' || !subtype ? 'jpg' : subtype;
        await this.adapter.bot.api.sendPhoto(
            Number(telegramUserId),
            new InputFile(bytes, `image.${ext}`),
            { caption },
            signal as Parameters<typeof this.adapter.bot.api.sendPhoto>[3],
        );
    }

    /**
     * Whether a turn may still act for this user in a Telegram conversation
     * and post there: still a user, linked, and in that chat (as a sender of
     * a channel turn must be).
     */
    async reaches(conversation: { kind: TelegramConversationKind; chatId: string }, userId: string) {
        return this.options.isUser(userId) && (await this.options.workspace.telegram.reaches(conversation, userId));
    }

    /**
     * A message in a Telegram conversation from a turn the channel did not
     * run (the Dot carrying on after an approval, CB-58): to its chat, in its
     * topic for a forum topic (General has no topic ID). Long text is split
     * at Telegram's limit; no link preview.
     */
    async sendToConversation(conversation: { chatId: string; topicId: string | null }, text: string) {
        if (!this.adapter || this.status !== 'online') {
            throw new Error('Telegram is not connected.');
        }
        const topic =
            conversation.topicId && conversation.topicId !== 'general' ? Number(conversation.topicId) : undefined;
        for (let start = 0; start < text.length; start += 4096) {
            await this.adapter.bot.api.sendMessage(Number(conversation.chatId), text.slice(start, start + 4096), {
                ...(topic ? { message_thread_id: topic } : {}),
                link_preview_options: { is_disabled: true },
            });
        }
    }

    /**
     * Draining for a restart: stops polling, so Telegram keeps new messages
     * for the next process. Turns in progress finish; messages already
     * received but not yet answered get DRAINING_REPLY.
     */
    async drain() {
        this.draining = true;
        for (const entries of this.waitingReceipts.values()) {
            for (const entry of entries.values()) {
                entry.receiptAbort?.abort();
            }
        }
        clearInterval(this.monitor);
        await this.adapter?.bot.stop().catch(() => {
            console.warn(
                'Telegram: update offset confirmation failed; durable ingress retry protection is still required.',
            );
        });
    }

    async stop() {
        clearInterval(this.monitor);
        clearInterval(this.menuTimer);
        await this.channel?.ɵruntime.stop().catch(() => {});
        this.channel = undefined;
        this.unrouteFiles?.();
        this.unrouteFiles = undefined;
        // Stopped: setup reports the channel as not running.
        this.status = 'not_configured';
        (this.options.stateStore as { close?: () => void } | undefined)?.close?.();
    }
}
