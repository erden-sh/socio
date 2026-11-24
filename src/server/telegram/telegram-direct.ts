import { randomUUID } from 'node:crypto';

import type { Api, Context } from 'grammy';
import type { MessageReactionUpdated, ReactionType } from 'grammy/types';

import type { ChatSkill } from '@socio/foundation/skills/chat-skill';
import { memoryButtons, parseButton, socioButtons, type TelegramButton } from '@socio/foundation/telegram/buttons';
import type { ReactionKind } from '@socio/shared/chat/reactions';
import { compareText, lowerText } from '@socio/shared/locale';
import type { MemoryItem } from '@socio/shared/memory';
import { TELEGRAM_DM_COMMAND_NAMES, TELEGRAM_DM_COMMANDS, type TelegramCommand } from '@socio/shared/telegram-commands';

import { ApprovalError, type ApprovalsShape } from '../approvals/contract.js';
import type { TopicsShape } from '../rooms/contract.js';
import type { JobsShape, LongRunsShape } from '../schedules/contract.js';
import type { RunnerShape } from '../turns/contract.js';

import type { TelegramStore, TelegramTurnServices, TelegramWorkspace } from './slices.js';
import { jobsReply } from './telegram-jobs.js';

/**
 * A direct message with the bot as a full client of the workspace's
 * socio features (CB-145): the commands the channel answers itself (a new
 * conversation, choosing the socio, Stop, proposed memories, jobs), the
 * inline buttons under its own messages, reactions on the socio's replies
 * and the command menu Telegram shows. Every action is the linked
 * sender's own, checked as the web routes check the signed-in person.
 *
 * Group chats and forum topics are the channel's (CB-214): a forum topic
 * bound to a room is where socios work in a group (telegram-topics.ts).
 */

/** What the app's other services give the channel (`LeaderWork.useTelegram`). */
export interface TelegramServices {
    approvals?: Pick<ApprovalsShape, 'decide' | 'get'>;
    jobs?: Pick<JobsShape, 'list'>;
    longRuns?: Pick<LongRunsShape, 'latestFor'>;
    /** For links into the app (`APP_ORIGIN`). */
    appOrigin?: string;
    /** Forum topics bound to rooms (CB-214). */
    topics?: Pick<TopicsShape, 'route' | 'sender' | 'redeem' | 'unanswered'>;
}

export interface TelegramDirectDeps {
    workspace: TelegramWorkspace;
    runner: Pick<RunnerShape, 'activeRunId' | 'stop' | 'hasHistory'>;
    store: Pick<TelegramStore, 'memoryItems'>;
    /** Reactions on a socio's replies (`Reactions`) and the replies themselves (`DotReplies`). */
    reactions: TelegramTurnServices['reactions'];
    replies: TelegramTurnServices['replies'];
    services: () => TelegramServices;
    /** The linked, active app user of a Telegram account. */
    userFor: (telegramUserId: string) => Promise<string | undefined>;
    /** The socio a new conversation gets by default (`TELEGRAM_DOT_ID`). */
    dotId: () => string;
    /** The workspace's chat skills, for the command menu. */
    skills: () => Promise<readonly ChatSkill[]>;
    /** The bot's @username, once known. */
    botUsername: () => string | undefined;
    /** What an unlinked sender is told. */
    unlinked: string;
}

/** A DM conversation's binding key, as `ChannelTurnAgent.threadFor` makes it. */
export const dmBindingKey = (chatId: string, userId: string) => `tg:${chatId}:dm#${userId}`;

/** No link preview: Telegram would fetch the link. */
const QUIET = { link_preview_options: { is_disabled: true } } as const;

export const BUSY_SWITCH_REPLY = 'An answer is in progress. Send /stop first, or wait for it to finish.';
export const NOTHING_RUNNING_REPLY = 'Nothing is running here.';
export const STOPPING_REPLY = 'Stopping the answer in progress.';
export const ALREADY_NEW_REPLY = 'This conversation is new already: just write your message.';
export const NO_PROPOSALS_REPLY = 'No proposed memories wait for you.';

/** The proposals `/memories` shows at once; the rest are in the app. */
const PROPOSALS_SHOWN = 10;
/** The socios `/socio` offers as buttons. */
const SOCIOS_SHOWN = 20;

/**
 * The channel's own command a direct message is, with what follows its
 * name: `/socio Mingo` is `socio` and `Mingo`. A command naming another
 * bot isn't ours.
 */
export function dmCommand(
    text: string | undefined,
    botUsername: string | undefined,
): { name: string; rest: string } | undefined {
    const match = /^\/([A-Za-z_]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/.exec(text?.trim() ?? '');
    if (!match) {
        return undefined;
    }
    const name = match[1].toLowerCase();
    if (!TELEGRAM_DM_COMMAND_NAMES.includes(name)) {
        return undefined;
    }
    if (match[2] && match[2].toLowerCase() !== botUsername?.toLowerCase()) {
        return undefined;
    }
    return { name, rest: (match[3] ?? '').trim() };
}

/** The emoji reactions that are a socio reply's reactions (CB-133). */
const REACTION_OF: Record<string, ReactionKind> = { '👍': 'up', '👎': 'down' };
const kindsOf = (reactions: ReactionType[]) =>
    new Set(
        reactions.flatMap((reaction) =>
            reaction.type === 'emoji' && REACTION_OF[reaction.emoji] ? [REACTION_OF[reaction.emoji]] : [],
        ),
    );

/**
 * The command menu Telegram shows in direct messages: the channel's own
 * commands, then every chat skill with its hyphens as underscores
 * (`/grill_me`), within Telegram's limits (names of `[a-z0-9_]`, up to
 * 32; descriptions up to 256; 100 commands). A group's menus have their
 * own commands (`own`, CB-214).
 */
export function telegramMenu(skills: readonly ChatSkill[], own: readonly TelegramCommand[] = TELEGRAM_DM_COMMANDS) {
    const commands: Array<{ command: string; description: string }> = [];
    // The channel's own commands, wherever they are answered, are no skill.
    const seen = new Set<string>(['start', 'bind'].filter((name) => !own.some((command) => command.name === name)));
    for (const { name, description } of [
        ...own,
        ...skills.map((skill) => ({
            name: skill.name.replace(/-/g, '_'),
            description: skill.description,
        })),
    ]) {
        if (!/^[a-z0-9_]{1,32}$/.test(name) || seen.has(name)) {
            continue;
        }
        seen.add(name);
        const line = description.replace(/\s+/g, ' ').trim();
        commands.push({
            command: name,
            description: (line || name).slice(0, 256),
        });
        if (commands.length === 100) {
            break;
        }
    }
    return commands;
}

export class TelegramDirect {
    /** The menu last registered, to register it again only when it changed. */
    private menu?: string;
    /** Proposals already offered in Telegram, so none is offered twice. */
    private offered = new Set<string>();
    constructor(private deps: TelegramDirectDeps) {}

    /**
     * Registers the command menu for direct messages, when it changed since
     * the last time (a skill added, renamed or removed in Settings).
     */
    async refreshMenu(api: Api) {
        const commands = telegramMenu(await this.deps.skills());
        const key = JSON.stringify(commands);
        if (key === this.menu) {
            return;
        }
        // Taken first, so a check meanwhile doesn't send it twice.
        const before = this.menu;
        this.menu = key;
        try {
            await api.setMyCommands(commands, {
                scope: { type: 'all_private_chats' },
            });
        } catch (error) {
            if (this.menu === key) {
                this.menu = before;
            }
            throw error;
        }
    }

    /** The app thread of this person's DM conversation, if there is one. */
    thread(chatId: string, userId: string) {
        return this.deps.workspace.telegram.threadFor(dmBindingKey(chatId, userId));
    }

    /**
     * One of the channel's commands in a direct message: answered here, as
     * the linked sender; anything else goes on (`next`).
     */
    async command(ctx: Context, next: () => Promise<void>) {
        const command = dmCommand(ctx.message?.text, this.deps.botUsername());
        if (!command || ctx.chat?.type !== 'private') {
            return next();
        }
        const from = ctx.from;
        if (!from || from.is_bot) {
            return;
        }
        const userId = await this.deps.userFor(String(from.id));
        if (!userId) {
            await ctx.reply(this.deps.unlinked);
            return;
        }
        const chatId = String(ctx.chat.id);
        const reply = (text: string, extra: object = {}) => ctx.reply(text, { ...QUIET, ...extra });
        switch (command.name) {
            case 'new':
                await reply(await this.startNew(chatId, userId));
                return;
            case 'stop':
                await reply(await this.stop(chatId, userId));
                return;
            case 'socio':
                if (command.rest) {
                    await reply(await this.chooseByName(chatId, userId, command.rest));
                    return;
                }
                await this.offerSocios(chatId, userId, reply);
                return;
            case 'memories':
                await this.offerProposals(userId, reply);
                return;
            case 'jobs':
                await reply(await jobsReply(this.deps.services(), userId));
                return;
        }
    }

    /** `/new`: a new conversation with the socio of the current one. */
    private async startNew(chatId: string, userId: string) {
        const { workspace, runner } = this.deps;
        const threadId = await this.thread(chatId, userId);
        if (threadId && runner.activeRunId(threadId)) {
            return BUSY_SWITCH_REPLY;
        }
        const current = threadId ? workspace.thread(threadId) : undefined;
        const dotId = current && workspace.canUseDot(userId, current.dotId) ? current.dotId : this.deps.dotId();
        // Nothing said yet: the next message starts it anyway.
        if (!current || (current.dotId === dotId && !runner.hasHistory(current.id))) {
            return ALREADY_NEW_REPLY;
        }
        await this.startConversation(chatId, userId, dotId);
        return `New conversation with ${workspace.dot(dotId)!.name}. Your earlier ones stay in Socio.`;
    }

    /** `/stop`: stops the turn running in this conversation, as Stop does. */
    private async stop(chatId: string, userId: string) {
        const threadId = await this.thread(chatId, userId);
        const runId = threadId && this.deps.runner.activeRunId(threadId);
        if (!threadId || !runId) {
            return NOTHING_RUNNING_REPLY;
        }
        return (await this.deps.runner.stop({ threadId, runId })) ? STOPPING_REPLY : 'It is stopping already.';
    }

    /** The socio of this person's DM conversation, if it is still usable. */
    private async currentDot(chatId: string, userId: string) {
        const threadId = await this.thread(chatId, userId);
        const dotId = threadId ? this.deps.workspace.thread(threadId)?.dotId : undefined;
        return dotId && this.deps.workspace.canUseDot(userId, dotId) ? dotId : this.deps.dotId();
    }

    private async offerSocios(
        chatId: string,
        userId: string,
        reply: (text: string, extra?: object) => Promise<unknown>,
    ) {
        const dots = this.deps.workspace.dotsFor(userId).slice(0, SOCIOS_SHOWN);
        const current = await this.currentDot(chatId, userId);
        const name = this.deps.workspace.dot(current)?.name ?? 'a socio';
        if (dots.length < 2) {
            await reply(`You are talking to ${name}, the only socio you can use.`);
            return;
        }
        await reply(`You are talking to ${name}. Choose a socio:`, {
            reply_markup: socioButtons(
                dots.map((dot) => ({ ...dot, personal: !!dot.ownerId })),
                current,
            ),
        });
    }

    /** `/socio <name>`: that socio, by its name or the start of it. */
    private async chooseByName(chatId: string, userId: string, name: string) {
        const wanted = lowerText(name);
        const dots = this.deps.workspace.dotsFor(userId);
        const exact = dots.filter((dot) => lowerText(dot.name) === wanted);
        const started = dots.filter((dot) => lowerText(dot.name).startsWith(wanted));
        const found = exact.length === 1 ? exact : started;
        if (found.length !== 1) {
            return found.length
                ? `More than one socio’s name starts with “${name}”: ${found
                      .map((dot) => dot.name)
                      .sort(compareText)
                      .join(', ')}. Send /socio to choose one.`
                : `No socio you can use is called “${name}”. Send /socio to choose one.`;
        }
        return this.switchTo(chatId, userId, found[0].id);
    }

    /** A new conversation with another socio; the earlier one stays. */
    private async switchTo(chatId: string, userId: string, dotId: string) {
        const { workspace, runner } = this.deps;
        const dot = workspace.dot(dotId);
        if (!dot || !workspace.canUseDot(userId, dotId)) {
            return 'That socio is not available to you.';
        }
        const threadId = await this.thread(chatId, userId);
        if (threadId && runner.activeRunId(threadId)) {
            return BUSY_SWITCH_REPLY;
        }
        if ((await this.currentDot(chatId, userId)) === dotId) {
            return `You are talking to ${dot.name} already.`;
        }
        await this.startConversation(chatId, userId, dotId);
        return `Now talking to ${dot.name}, in a new conversation. Your earlier ones stay in Socio.`;
    }

    /**
     * Binds this DM to a new app thread with `dotId`, as one unit of work.
     * The earlier thread keeps its Telegram facts under a retired key, so it
     * is still this DM's (Operations, carrying on after an approval there).
     */
    async startConversation(chatId: string, userId: string, dotId: string) {
        const { workspace } = this.deps;
        const key = dmBindingKey(chatId, userId);
        return workspace.data.uow.run(
            async () => {
                const threadId = randomUUID();
                workspace.bindThread(threadId, dotId, 'Telegram direct message', userId);
                await workspace.telegram.retireConversation(key);
                await workspace.telegram.bindThread(key, threadId, 'dm', chatId, null);
                return threadId;
            },
            { label: 'start Telegram conversation' },
        );
    }

    /** `/memories`: each proposal waiting for the person, with its buttons. */
    private async offerProposals(userId: string, reply: (text: string, extra?: object) => Promise<unknown>) {
        const proposals = (await this.deps.store.memoryItems.list(userId)).filter(
            (memory) => memory.status === 'proposed',
        );
        if (!proposals.length) {
            await reply(NO_PROPOSALS_REPLY);
            return;
        }
        await reply(
            proposals.length === 1
                ? 'A proposed memory waits for you:'
                : `${proposals.length} proposed memories wait for you:`,
        );
        for (const memory of proposals.slice(0, PROPOSALS_SHOWN)) {
            await reply(proposalText(memory), {
                reply_markup: memoryButtons(memory.id),
            });
        }
        if (proposals.length > PROPOSALS_SHOWN) {
            await reply(`And ${proposals.length - PROPOSALS_SHOWN} more in ${this.memoriesLink()}.`);
        }
    }

    private memoriesLink() {
        const origin = this.deps.services().appOrigin;
        return origin ? `${origin.replace(/\/$/, '')}/memories` : 'Memories in Socio';
    }

    /**
     * After a turn in a direct message: the memories its socio proposed in
     * it, each with Keep and Turn down, as the web chat offers them.
     */
    async offerTurnProposals(api: Api, chatId: string, userId: string, threadId: string, since: number) {
        const proposals = (await this.deps.store.memoryItems.list(userId)).filter(
            (memory) =>
                memory.status === 'proposed' &&
                memory.threadId === threadId &&
                memory.createdAt >= since &&
                !this.offered.has(memory.id),
        );
        for (const memory of proposals.slice(0, PROPOSALS_SHOWN)) {
            this.offered.add(memory.id);
            if (this.offered.size > 2000) {
                this.offered.delete(this.offered.values().next().value!);
            }
            await api.sendMessage(Number(chatId), proposalText(memory), {
                ...QUIET,
                reply_markup: memoryButtons(memory.id),
            });
        }
    }

    /**
     * A press of one of our buttons, as the linked person who pressed it.
     * The answer shows as a short notice; the message loses its buttons and
     * says what was decided, unless nothing was.
     */
    async button(ctx: Context) {
        const query = ctx.callbackQuery;
        if (!query) {
            return;
        }
        const action = parseButton(query.data);
        const userId = query.from.is_bot || !action ? undefined : await this.deps.userFor(String(query.from.id));
        if (!action || !userId) {
            await ctx
                .answerCallbackQuery({
                    text: action ? this.deps.unlinked : 'This button no longer works.',
                    show_alert: !!action,
                })
                .catch(() => {});
            return;
        }
        // A socio is chosen for the presser's own DM only, never a group's.
        const chat = query.message?.chat;
        const chatId =
            chat?.type === 'private' && String(chat.id) === String(query.from.id) ? String(chat.id) : undefined;
        const { notice, outcome } = await this.act(action, userId, chatId);
        await ctx.answerCallbackQuery({ text: notice }).catch(() => {});
        const text = query.message && 'text' in query.message ? query.message.text : undefined;
        if (outcome !== undefined && text) {
            await ctx.editMessageText(`${text}\n\n${outcome}`, QUIET).catch(() => {});
        }
    }

    private async act(
        action: TelegramButton,
        userId: string,
        chatId: string | undefined,
    ): Promise<{ notice: string; outcome?: string }> {
        switch (action.kind) {
            case 'approval': {
                const approvals = this.deps.services().approvals;
                if (!approvals) {
                    return { notice: 'Approvals are not available here.' };
                }
                try {
                    // From a message: a carded request is refused.
                    await approvals.decide(action.id, userId, action.approve, 'message');
                    const done = action.approve ? 'Approved.' : 'Denied.';
                    return { notice: done, outcome: done };
                } catch (error) {
                    if (!(error instanceof ApprovalError)) {
                        throw error;
                    }
                    // Decided elsewhere, or expired: the buttons go, with its state.
                    const view =
                        error.status === 404
                            ? undefined
                            : await approvals.get(action.id, userId).catch(() => undefined);
                    return {
                        notice: error.message,
                        ...(view && view.status !== 'pending' ? { outcome: `Already ${view.status}.` } : {}),
                    };
                }
            }
            case 'memory': {
                const memories = this.deps.store.memoryItems;
                const memory = await memories.get(action.id, userId);
                if (!memory) {
                    return { notice: 'That memory is gone.', outcome: 'Gone.' };
                }
                if (memory.status !== 'proposed') {
                    return {
                        notice: 'You already kept it.',
                        outcome: 'Kept: it is in use.',
                    };
                }
                if (action.keep) {
                    await memories.approve(action.id, userId);
                    return {
                        notice: 'Kept.',
                        outcome: 'Kept: it is in use from now on.',
                    };
                }
                await memories.forget(action.id, userId);
                // As the Memories page's turn-down is (CB-64).
                this.deps.workspace.audit({
                    actor: userId,
                    action: 'delete',
                    targetKind: 'memory',
                    targetId: action.id,
                });
                return { notice: 'Turned down.', outcome: 'Turned down.' };
            }
            case 'socio': {
                if (!chatId) {
                    return { notice: 'Choose a socio in a direct message.' };
                }
                const text = await this.switchTo(chatId, userId, action.dotId);
                // Busy: the buttons stay, for once the answer is done.
                return text === BUSY_SWITCH_REPLY ? { notice: text } : { notice: text.slice(0, 200), outcome: text };
            }
        }
    }

    /**
     * A reaction in a direct message: 👍 and 👎 on a message that shows a
     * socio's reply are that reply's reactions (CB-133), added and removed
     * as on the web. Others are Telegram's own.
     */
    async reaction(update: MessageReactionUpdated) {
        const sender = update.user;
        if (!sender || sender.is_bot || update.chat.type !== 'private') {
            return;
        }
        const userId = await this.deps.userFor(String(sender.id));
        if (!userId) {
            return;
        }
        const { workspace, reactions, replies } = this.deps;
        const shown = await workspace.telegram.replyFor(String(update.chat.id), String(update.message_id));
        if (!shown || !(await workspace.readableThread(userId, shown.threadId))) {
            return;
        }
        const before = kindsOf(update.old_reaction);
        const after = kindsOf(update.new_reaction);
        for (const kind of before) {
            if (!after.has(kind)) {
                reactions.remove(shown.threadId, shown.replyId, userId, kind);
            }
        }
        const added = [...after].filter((kind) => !before.has(kind));
        if (!added.length) {
            return;
        }
        const message = await replies.find(shown.threadId, shown.replyId);
        if (!message) {
            return;
        }
        for (const kind of added) {
            reactions.add(shown.threadId, shown.replyId, userId, kind, message);
        }
    }
}

/** A proposed memory, as the person decides on it. */
const proposalText = (memory: Pick<MemoryItem, 'text'>) => `Remember this about you?\n“${memory.text}”`;
