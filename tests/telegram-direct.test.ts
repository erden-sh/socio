import { AbstractAgent, type BaseEvent, type RunAgentInput } from '@ag-ui/client';
import { MemoryStore } from '@copilotkit/channels-core';
import { Observable } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import { helpText } from '@socio/foundation/skills/chat-skill';
import { approvalButtons, buttonData, parseButton } from '@socio/foundation/telegram/buttons';
import { RESERVED_SKILL_NAMES } from '@socio/shared/chat/chat-skills';
import type { LongRunView } from '@socio/shared/schedule-types';

import { ApprovalError } from '../src/server/approvals/contract.js';
import { approvalNotice } from '../src/server/approvals/notices.js';
import { sqliteApprovals } from '../src/server/approvals/services.js';
import { messageReactions } from '../src/server/context/reactions.js';
import { skillsRepository } from '../src/server/skills/repository.js';
import {
    TELEGRAM_INGRESS_PRIMED_AT_KEY,
    TelegramChannel,
    UNLINKED_REPLY,
} from '../src/server/telegram/telegram-channel.js';
import {
    ALREADY_NEW_REPLY,
    BUSY_SWITCH_REPLY,
    NOTHING_RUNNING_REPLY,
    NO_PROPOSALS_REPLY,
    STOPPING_REPLY,
    dmBindingKey,
    dmCommand,
    telegramMenu,
    type TelegramServices,
} from '../src/server/telegram/telegram-direct.js';
import { bootstrapTelegramIngress } from '../src/server/telegram/telegram-ingress.js';
import { PROGRESS_EDIT_MS, TelegramJobProgress, jobsReply, longRunLine } from '../src/server/telegram/telegram-jobs.js';

import { fakeTelegram, type FakeTelegram } from './fixtures/fake-telegram.js';
import { completion } from './fixtures/model-stream.js';
import { ScriptAgent } from './fixtures/script-agent.js';
import { LocalAgentRunner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { telegramServices } from './helpers/telegram-channel.js';
import { testDatabase } from './helpers/test-database.js';

const TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef012';
const DM = { id: 42, type: 'private' };
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
});

/**
 * A channel on the fake Bot API, Alice linkable as 42 and Bob as 43.
 * `agent` replaces the socio for each turn; `null` runs the real one
 * against the stubbed model.
 */
async function fixture(agent: (() => AbstractAgent) | null = () => new ScriptAgent('Hello there')) {
    const bot = await fakeTelegram();
    const stateStore = new MemoryStore();
    await bootstrapTelegramIngress(stateStore, String(bot.bot.id));
    await stateStore.kv.set(`${TELEGRAM_INGRESS_PRIMED_AT_KEY}:${bot.bot.id}`, Date.now() - 300_001);
    const store = new Store(testDatabase());
    const workspace = new WorkspaceStore(testDatabase());
    const runner = new LocalAgentRunner(testDatabase());
    workspace.recordUser({ id: 'alice', name: 'Alice', role: 'admin' });
    workspace.recordUser({ id: 'bob', name: 'Bob', role: 'member' });
    const turns: Array<{ dotId: string; userId: string }> = [];
    const channel = new TelegramChannel({
        settings: { token: TOKEN, allowedChatIds: [] },
        runner,
        store,
        workspace,
        ...telegramServices({
            store,
            workspace,
            config: {
                baseUrl: 'https://model.invalid/v1',
                apiKey: 'unused',
                model: 'test',
                voiceName: 'marin',
                runtimeUrl: '',
            },
            runner,
        }),
        isUser: (id) => ['alice', 'bob'].includes(id),
        stateStore,
        apiRoot: bot.apiRoot,
        agentFor: agent
            ? (dotId, userId) => {
                  turns.push({ dotId, userId });
                  return agent();
              }
            : undefined,
    });
    cleanup.push(
        () => bot.close(),
        () => {
            runner.close();
            store.close();
            workspace.close();
        },
        () => channel.stop(),
    );
    await channel.start();
    const link = async (userId: string, telegramId: number) =>
        workspace.telegram.redeem((await workspace.telegram.createCode(userId)).code, String(telegramId));
    /** A direct message from Telegram account `from` (Alice's 42 by default). */
    const say = (text: string, from = 42) =>
        bot.message({
            text,
            chat: { id: from, type: 'private' },
            from: { id: from },
        });
    /** Presses a button under the bot's message `message`. */
    const press = (data: string, message: { message_id: number; text: string }, from = 42) =>
        bot.push({
            callback_query: {
                id: `press-${Math.random()}`,
                from: { id: from, is_bot: false, first_name: 'User' },
                chat_instance: 'chat',
                data,
                message: {
                    ...message,
                    date: Math.floor(Date.now() / 1000),
                    chat: { id: from, type: 'private' },
                },
            },
        });
    const dmThread = (userId = 'alice', chatId = '42') => workspace.telegram.threadFor(dmBindingKey(chatId, userId));
    return {
        bot,
        store,
        workspace,
        runner,
        channel,
        turns,
        link,
        say,
        press,
        dmThread,
    };
}

const sent = (bot: FakeTelegram, text: string | RegExp) =>
    bot.waitFor(
        (c) =>
            ['sendMessage', 'editMessageText'].includes(c.method) &&
            (typeof text === 'string' ? String(c.body.text) === text : text.test(String(c.body.text))),
    );
const sentAfter = (bot: FakeTelegram, from: number, text: string | RegExp) =>
    bot.waitFor(
        (c) =>
            bot.calls.indexOf(c) >= from &&
            ['sendMessage', 'editMessageText', 'answerCallbackQuery'].includes(c.method) &&
            (typeof text === 'string' ? String(c.body.text) === text : text.test(String(c.body.text))),
    );
/** The `callback_data` of each button under a message. */
const buttonsOf = (call: { body: Record<string, unknown> }) =>
    (
        call.body.reply_markup as
            | {
                  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
              }
            | undefined
    )?.inline_keyboard.flat() ?? [];

it('parses the channel’s own commands and its buttons, and refuses anything else (CB-145)', () => {
    expect(dmCommand('/new', 'brain_bot')).toEqual({ name: 'new', rest: '' });
    expect(dmCommand('/Socio@Brain_Bot  Mingo ', 'brain_bot')).toEqual({
        name: 'socio',
        rest: 'Mingo',
    });
    // Another bot's, a chat skill and plain text are not the channel's.
    expect(dmCommand('/stop@other_bot', 'brain_bot')).toBeUndefined();
    expect(dmCommand('/compact', 'brain_bot')).toBeUndefined();
    expect(dmCommand('please /stop', 'brain_bot')).toBeUndefined();
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    for (const button of [
        { kind: 'approval', approve: true, id },
        { kind: 'approval', approve: false, id },
        { kind: 'memory', keep: true, id },
        { kind: 'memory', keep: false, id },
        { kind: 'socio', dotId: id },
    ] as const) {
        const data = buttonData(button);
        // Within Telegram's 64 bytes.
        expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
        expect(parseButton(data)).toEqual(button);
    }
    expect(parseButton('sb1:a+:../../x')).toBeUndefined();
    expect(parseButton('sb1:x+:abc')).toBeUndefined();
    expect(parseButton('other:a+:abc')).toBeUndefined();
    expect(parseButton(undefined)).toBeUndefined();
    // No skill can take a command's name.
    for (const name of ['new', 'socio', 'stop', 'memories', 'jobs']) {
        expect(RESERVED_SKILL_NAMES).toContain(name);
    }
});

it('lists the channel’s commands and every chat skill in Telegram’s menu, within its limits (CB-145)', () => {
    const skill = (name: string, description = `About ${name}`) => ({
        name,
        description,
        kind: 'prompt' as const,
        builtIn: false,
        lock: { source: 'workspace' as const, sha256: '' },
    });
    const menu = telegramMenu([
        skill('grill-me', 'Get\ninterviewed'),
        skill('start'),
        skill('new'),
        skill('x'.repeat(33)),
        skill('long', 'y'.repeat(300)),
        ...Array.from({ length: 120 }, (_, i) => skill(`s${i}`)),
    ]);
    expect(menu.slice(0, 7).map((c) => c.command)).toEqual([
        'new',
        'socio',
        'stop',
        'memories',
        'jobs',
        'grill_me',
        'long',
    ]);
    expect(menu[5].description).toBe('Get interviewed');
    expect(menu[6].description).toHaveLength(256);
    expect(menu).toHaveLength(100);
    expect(menu.filter((c) => c.command === 'new')).toHaveLength(1);
    expect(menu.some((c) => c.command === 'start')).toBe(false);
    // `/help` in Telegram names them too.
    const help = helpText([], true);
    expect(help).toContain('In a direct message with me:');
    // And where socios work in a group (CB-214).
    expect(help).toContain('- /bind <code>: Link this topic to a Socio room');
    expect(help).toContain('- /new: Start a new conversation');
    expect(helpText([], false)).not.toContain('/new');
});

it('registers the menu for direct messages at start and again once the skills change (CB-145)', async () => {
    const f = await fixture();
    const dms = (c: { method: string; body: Record<string, unknown> }) =>
        c.method === 'setMyCommands' && (c.body.scope as { type?: string } | undefined)?.type === 'all_private_chats';
    const first = await f.bot.waitFor(dms);
    expect(first.body.scope).toEqual({ type: 'all_private_chats' });
    const names = (first.body.commands as Array<{ command: string }>).map((c) => c.command);
    expect(names).toEqual(expect.arrayContaining(['new', 'socio', 'stop', 'grill_me', 'compact']));
    // Unchanged: not registered again.
    await f.channel.refreshMenu();
    expect(f.bot.calls.filter(dms)).toHaveLength(1);
    await skillsRepository(f.workspace.db).save(
        {
            name: 'stand-up',
            description: 'Write it as a standup.',
            instructions: 'Short.',
            mode: 'turn',
        },
        'alice',
    );
    await f.channel.refreshMenu();
    const again = f.bot.calls.filter(dms);
    expect(again).toHaveLength(2);
    expect(JSON.stringify(again[1].body.commands)).toContain('stand_up');
});

it('starts a new conversation with /new, keeping the earlier one Telegram’s, without carrying its messages over (CB-145)', async () => {
    const f = await fixture();
    await f.link('alice', 42);
    f.say('/new');
    // Nothing to start over from yet.
    await sent(f.bot, ALREADY_NEW_REPLY);
    f.say('first question');
    await sent(f.bot, 'Hello there');
    const first = (await f.dmThread())!;
    await vi.waitFor(() => expect(f.runner.activeRunId(first)).toBeUndefined());
    f.say('/new');
    await sent(f.bot, /^New conversation with .+\. Your earlier ones stay in Socio\.$/);
    const calls = f.bot.calls.length;
    f.say('second question');
    await sentAfter(f.bot, calls, 'Hello there');
    const second = (await f.dmThread())!;
    expect(second).not.toBe(first);
    // The new thread has only its own turn; the old one keeps its turn and
    // is still this DM's.
    await vi.waitFor(async () =>
        expect((await f.runner.messages(second)).map((m) => [m.role, m.content])).toEqual([
            ['user', 'second question'],
            ['assistant', 'Hello there'],
        ]),
    );
    expect((await f.runner.messages(first)).map((m) => m.content)).toEqual(['first question', 'Hello there']);
    expect(await f.workspace.telegram.threadInfo(first)).toEqual({
        kind: 'dm',
        chatId: '42',
        topicId: null,
    });
    // Both are Alice's, in the app.
    expect((await f.workspace.conversations('alice')).map((c) => c.id).sort()).toEqual([first, second].sort());
    // Commands never reached a socio.
    expect(f.turns).toHaveLength(2);
});

it('stops the answer in progress with /stop, and says when nothing runs (CB-145)', async () => {
    const agents: ScriptAgent[] = [];
    const f = await fixture(() => {
        const agent = new ScriptAgent('Working…', true);
        agents.push(agent);
        return agent;
    });
    await f.link('alice', 42);
    f.say('/stop');
    await sent(f.bot, NOTHING_RUNNING_REPLY);
    f.say('a long task');
    await vi.waitFor(() => expect(agents).toHaveLength(1));
    const thread = (await f.dmThread())!;
    await vi.waitFor(() => expect(f.runner.activeRunId(thread)).toBeDefined());
    // Busy: no switching away under it.
    f.say('/new');
    await sent(f.bot, BUSY_SWITCH_REPLY);
    f.say('/stop');
    await sent(f.bot, STOPPING_REPLY);
    expect(agents[0].aborted).toBe(true);
    await vi.waitFor(() => expect(f.runner.activeRunId(thread)).toBeUndefined());
    // The stop was a command, not a message queued for the socio.
    expect(agents).toHaveLength(1);
});

it('answers an unlinked sender’s command with how to link, and nothing else (CB-145)', async () => {
    const f = await fixture();
    f.say('/socio', 50);
    await f.bot.waitFor(
        (c) => c.method === 'sendMessage' && c.body.text === UNLINKED_REPLY && Number(c.body.chat_id) === 50,
    );
    expect(f.turns).toEqual([]);
});

it('switches the socio of a direct message with /socio, as a new conversation, only to a socio the person may use (CB-145)', async () => {
    const f = await fixture();
    await f.link('alice', 42);
    await f.link('bob', 43);
    const sebas = f.workspace.companyDots()[0];
    const space = sebas.spaceId;
    const mingo = f.workspace.createDot(space, 'Mingo', 'Help.', true, true);
    const mine = f.workspace.createDot(
        space,
        'Rulo',
        'Help Alice.',
        true,
        true,
        [space],
        null,
        false,
        null,
        false,
        'alice',
    );
    f.say('hello');
    await sent(f.bot, 'Hello there');
    const first = (await f.dmThread())!;
    expect(f.workspace.thread(first)?.dotId).toBe(sebas.id);
    await vi.waitFor(() => expect(f.runner.activeRunId(first)).toBeUndefined());

    f.say('/socio');
    const menu = await sent(f.bot, /^You are talking to .+\. Choose a socio:$/);
    const buttons = buttonsOf(menu);
    expect(buttons.map((b) => b.text)).toEqual([`✓ ${sebas.name}`, 'Mingo', 'Rulo (yours)']);
    const calls = f.bot.calls.length;
    f.press(buttons[1].callback_data, {
        message_id: 900,
        text: String(menu.body.text),
    });
    const edited = await f.bot.waitFor(
        (c) =>
            f.bot.calls.indexOf(c) >= calls &&
            c.method === 'editMessageText' &&
            /Now talking to Mingo/.test(String(c.body.text)),
    );
    // The menu's buttons are gone.
    expect(edited.body.reply_markup).toBeUndefined();
    f.say('next');
    await vi.waitFor(() => expect(f.turns.at(-1)).toEqual({ dotId: mingo.id, userId: 'alice' }));
    const second = (await f.dmThread())!;
    expect(second).not.toBe(first);
    expect(f.workspace.thread(second)?.dotId).toBe(mingo.id);

    // By name, and the person's own socio.
    await vi.waitFor(() => expect(f.runner.activeRunId(second)).toBeUndefined());
    f.say('/socio ru');
    await sent(f.bot, /Now talking to Rulo/);
    f.say('/socio Rulo');
    await sent(f.bot, 'You are talking to Rulo already.');
    f.say('/socio nobody');
    await sent(f.bot, /No socio you can use is called “nobody”/);

    // Bob can't take Alice's own socio, even with her button's data.
    const before = f.bot.calls.length;
    f.press(
        buttonData({ kind: 'socio', dotId: mine.id }),
        {
            message_id: 901,
            text: 'You are talking to Sebas. Choose a socio:',
        },
        43,
    );
    await sentAfter(f.bot, before, /not available to you/);
    expect(await f.dmThread('bob', '43')).toBeUndefined();
    // A press under a group's message chooses nothing.
    const group = f.bot.calls.length;
    f.bot.push({
        callback_query: {
            id: 'press-group',
            from: { id: 43, is_bot: false, first_name: 'User' },
            chat_instance: 'group',
            data: buttonData({ kind: 'socio', dotId: mingo.id }),
            message: {
                message_id: 902,
                date: Math.floor(Date.now() / 1000),
                chat: { id: -100, type: 'supergroup', title: 'Team' },
                text: 'Choose a socio:',
            },
        },
    });
    await sentAfter(f.bot, group, 'Choose a socio in a direct message.');
    expect(await f.dmThread('bob', '-100')).toBeUndefined();
});

/** Answers, then (once) proposes a memory in the turn's own thread. */
class ProposingAgent extends ScriptAgent {
    constructor(
        private propose: (threadId: string) => Promise<unknown>,
        reply: string,
    ) {
        super(reply);
    }
    run(input: RunAgentInput): Observable<BaseEvent> {
        return new Observable<BaseEvent>((subscriber) => {
            void this.propose(input.threadId).then(() => super.run(input).subscribe(subscriber));
        });
    }
}

it('offers a memory the socio proposed in a direct message with Keep and Turn down, and lists the waiting ones with /memories (CB-145, CB-106)', async () => {
    let proposals = 0;
    const holder: { store?: Store } = {};
    const f = await fixture(
        () =>
            new ProposingAgent(async (threadId) => {
                proposals++;
                await holder.store!.memoryItems.add({
                    userId: 'alice',
                    text: `Prefers metric units ${proposals}`,
                    source: 'socio',
                    threadId,
                });
            }, 'Noted.'),
    );
    holder.store = f.store;
    await f.link('alice', 42);
    await f.link('bob', 43);
    f.say('I use metric');
    const offer = await sent(f.bot, /^Remember this about you\?\n“Prefers metric units 1”$/);
    const [keep, down] = buttonsOf(offer);
    expect([keep.text, down.text]).toEqual(['Keep', 'Turn down']);
    const [proposal] = await f.store.memoryItems.list('alice');
    // Bob can't decide Alice's.
    let calls = f.bot.calls.length;
    f.press(keep.callback_data, { message_id: 700, text: String(offer.body.text) }, 43);
    await sentAfter(f.bot, calls, 'That memory is gone.');
    expect((await f.store.memoryItems.get(proposal.id, 'alice'))?.status).toBe('proposed');
    calls = f.bot.calls.length;
    f.press(keep.callback_data, {
        message_id: 700,
        text: String(offer.body.text),
    });
    await sentAfter(f.bot, calls, /Kept: it is in use from now on\.$/);
    expect((await f.store.memoryItems.get(proposal.id, 'alice'))?.status).toBe('active');
    // Pressed again: nothing turns a kept memory down.
    calls = f.bot.calls.length;
    f.press(down.callback_data, {
        message_id: 700,
        text: String(offer.body.text),
    });
    await sentAfter(f.bot, calls, 'You already kept it.');
    expect((await f.store.memoryItems.get(proposal.id, 'alice'))?.status).toBe('active');

    // Another turn proposes another; /memories offers the waiting one.
    f.say('and kilometres');
    await sent(f.bot, /“Prefers metric units 2”/);
    f.say('/memories');
    await sent(f.bot, 'A proposed memory waits for you:');
    const listed = (await f.store.memoryItems.list('alice')).find((memory) => memory.status === 'proposed')!;
    calls = f.bot.calls.length;
    f.press(buttonData({ kind: 'memory', keep: false, id: listed.id }), {
        message_id: 701,
        text: 'Remember this about you?',
    });
    await sentAfter(f.bot, calls, /Turned down\.$/);
    expect(await f.store.memoryItems.get(listed.id, 'alice')).toBeUndefined();
    expect(f.workspace.auditOf('memory', listed.id)).toHaveLength(1);
    f.say('/memories');
    await sent(f.bot, NO_PROPOSALS_REPLY);
});

it('counts 👍 and 👎 on a socio’s reply in a direct message as its reactions (CB-145, CB-133)', async () => {
    const f = await fixture();
    await f.link('alice', 42);
    f.say('how are you?');
    const shown = await f.bot.waitFor((c) => c.method === 'editMessageText' && c.body.text === 'Hello there');
    const thread = (await f.dmThread())!;
    const [, reply] = await f.runner.messages(thread);
    const reactions = messageReactions(f.workspace.db);
    // The reply's messages are known once the turn is done.
    await vi.waitFor(async () =>
        expect(await f.workspace.telegram.replyFor('42', String(shown.body.message_id))).toEqual({
            threadId: thread,
            replyId: reply.id,
        }),
    );
    const react = (old: string[], now: string[], from = 42, messageId = Number(shown.body.message_id)) =>
        f.bot.push({
            message_reaction: {
                chat: DM,
                message_id: messageId,
                user: { id: from, is_bot: false, first_name: 'User' },
                date: Math.floor(Date.now() / 1000),
                old_reaction: old.map((emoji) => ({ type: 'emoji', emoji })),
                new_reaction: now.map((emoji) => ({ type: 'emoji', emoji })),
            },
        });
    react([], ['👍']);
    await vi.waitFor(() =>
        expect(reactions.view(thread, 'alice')[reply.id]).toEqual({
            counts: { up: 1 },
            mine: ['up'],
        }),
    );
    // Changed to 👎: up goes, down comes; another emoji is Telegram's own.
    react(['👍'], ['👎', '🔥']);
    await vi.waitFor(() =>
        expect(reactions.view(thread, 'alice')[reply.id]).toEqual({
            counts: { down: 1 },
            mine: ['down'],
        }),
    );
    react(['👎', '🔥'], []);
    await vi.waitFor(() => expect(reactions.view(thread, 'alice')[reply.id]).toBeUndefined());
    // An unlinked account's, or one on a message that shows no reply: nothing.
    react([], ['👍'], 50);
    react([], ['👍'], 42, 1);
    f.say('again');
    await vi.waitFor(() => expect(f.turns).toHaveLength(2));
    expect(reactions.view(thread, 'alice')).toEqual({});
});

it('keeps a socio’s until-done skill on across Telegram turns until /done (CB-145, CB-143)', async () => {
    const passthrough = globalThis.fetch.bind(globalThis);
    const bodies: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
        if (!String(url).startsWith('https://model.invalid/')) {
            return passthrough(url, init);
        }
        if (String(init?.body).includes('Write a short title')) {
            return Promise.resolve(Response.json({ choices: [{ message: { content: 'Title' } }] }));
        }
        bodies.push(String(init?.body));
        return Promise.resolve(completion({ role: 'assistant', content: `Reply ${bodies.length}.` }));
    });
    const f = await fixture(null);
    await f.link('alice', 42);
    const newest = (at: number) =>
        JSON.stringify((JSON.parse(bodies[at]) as { messages: Array<{ content: unknown }> }).messages.at(-1)!.content);
    f.say('/grill_me my launch plan');
    await sent(f.bot, 'Reply 1.');
    expect(newest(0)).toContain('The skill /grill-me, of Socio, is on');
    f.say('It is for small teams.');
    await sent(f.bot, 'Reply 2.');
    expect(newest(1)).toContain('The skill /grill-me, of Socio, is on');
    f.say('/done');
    await sent(f.bot, 'Ended /grill-me.');
    f.say('Thanks.');
    await sent(f.bot, 'Reply 3.');
    expect(newest(2)).not.toContain('The skill /grill-me');
});

/** Approvals as the channel's buttons reach them, recorded. */
function fakeApprovals() {
    const decided: Array<[string, string, boolean]> = [];
    const approvals: NonNullable<TelegramServices['approvals']> = {
        decide: async (id, userId, approve) => {
            if (userId !== 'alice') {
                throw new ApprovalError('Approval request not found.', 404);
            }
            if (decided.some(([done]) => done === id)) {
                throw new ApprovalError('This request was already decided.', 409);
            }
            decided.push([id, userId, approve]);
            return {} as never;
        },
        get: async () => ({ status: 'approved' }) as never,
    };
    return { decided, approvals };
}

it('decides an approval from its notice’s buttons, as the person it is for, once (CB-145)', async () => {
    const f = await fixture();
    await f.link('alice', 42);
    await f.link('bob', 43);
    const { decided, approvals } = fakeApprovals();
    f.channel.useServices({ approvals });
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const text = approvalNotice(
        {
            id,
            dotName: 'Sebas',
            summary: 'Sebas wants to set a goal “Ship it”',
            details: ['Goal: Ship it', 'Check: daily'],
            auto: null,
        },
        'https://brain.example',
    );
    // The goal's details are in the notice (CB-131).
    expect(text).toBe(
        `Approval needed: Sebas wants to set a goal “Ship it”.\nGoal: Ship it\nCheck: daily\nApprove or deny it below, or in Socio: https://brain.example/approvals/${id}\nThe socio carries on here once you decide.`,
    );
    const messageId = await f.channel.sendDirect('42', text, undefined, {
        buttons: approvalButtons(id),
    });
    const notice = await f.bot.waitFor((c) => c.method === 'sendMessage' && c.body.text === text);
    const [approve, deny] = buttonsOf(notice);
    expect([approve.text, deny.text]).toEqual(['Approve', 'Deny']);
    let calls = f.bot.calls.length;
    f.press(deny.callback_data, { message_id: messageId, text }, 43);
    await sentAfter(f.bot, calls, 'Approval request not found.');
    calls = f.bot.calls.length;
    f.press(approve.callback_data, { message_id: messageId, text });
    const edited = await sentAfter(f.bot, calls, `${text}\n\nApproved.`);
    expect(edited.method).toBe('editMessageText');
    expect(decided).toEqual([[id, 'alice', true]]);
    // Pressed again: it says so, and shows how it was decided.
    calls = f.bot.calls.length;
    f.press(deny.callback_data, { message_id: messageId, text });
    await sentAfter(f.bot, calls, 'This request was already decided.');
    await sentAfter(f.bot, calls, `${text}\n\nAlready approved.`);
    expect(decided).toHaveLength(1);
    // A long request's details are cut, with where the rest is.
    expect(
        approvalNotice({
            id,
            dotName: 'Sebas',
            summary: 'Sebas wants to set a goal',
            details: ['x'.repeat(5000)],
            auto: null,
        }).length,
    ).toBeLessThan(2000);
});

it('refuses a forged button press for a request decided on its card: it stays pending', async () => {
    const f = await fixture();
    await f.link('alice', 42);
    const db = testDatabase();
    cleanup.push(() => db.close());
    const approvals = sqliteApprovals(db);
    const execute = vi.fn(async () => 'Granted.');
    approvals.register({
        capability: 'test.carded',
        label: 'Let a socio change an app’s data for you',
        description: 'Decided on its card.',
        manualOnly: true,
        execute,
        card: () => null,
    });
    f.channel.useServices({ approvals });
    const pending = await approvals.request({
        userId: 'alice',
        dotId: 'dot',
        capability: 'test.carded',
        summary: 'Read and change CRM Dashboard for 1 hour',
        payload: {},
    });
    const id = pending.id;
    // Its notice has no buttons; the person's own client sends one anyway.
    const text = 'Approval needed: Read and change CRM Dashboard for 1 hour.';
    const messageId = await f.channel.sendDirect('42', text);
    for (const approve of [true, false]) {
        const calls = f.bot.calls.length;
        f.press(buttonData({ kind: 'approval', approve, id }), {
            message_id: messageId,
            text,
        });
        await sentAfter(f.bot, calls, 'Decide on its card in Socio.');
    }
    expect((await approvals.get(id, 'alice')).status).toBe('pending');
    expect(execute).not.toHaveBeenCalled();
    // No message edit claims it was decided.
    expect(f.bot.calls.filter((call) => call.method === 'editMessageText')).toEqual([]);
    // On its card (the app) it is decided as usual.
    await approvals.decide(id, 'alice', true);
    expect(execute).toHaveBeenCalledTimes(1);
});

const run = (patch: Partial<LongRunView> = {}): LongRunView =>
    ({
        id: 'run-1',
        jobId: 'job-1',
        status: 'running',
        items: { total: 120, done: 40, remaining: 78, inProgress: 3, failed: 2 },
        outcome: null,
        updatedAt: 1,
        ...patch,
    }) as LongRunView;

it('lists the person’s jobs that run until done with /jobs, open ones first (CB-145, CB-122)', async () => {
    expect(longRunLine('Import', run())).toBe('Import: running · 40 of 120 done · 2 failed');
    expect(longRunLine('Import', run({ status: 'waiting', items: { total: 0 } as never }))).toBe(
        'Import: waiting for its next batch · no items yet',
    );
    const services = {
        appOrigin: 'https://brain.example/',
        jobs: {
            list: async (userId: string) =>
                userId === 'alice'
                    ? ([
                          { id: 'job-1', name: 'Digest', untilDone: true },
                          { id: 'job-2', name: 'Import', untilDone: true },
                          { id: 'job-3', name: 'Once', untilDone: false },
                      ] as never)
                    : [],
        },
        longRuns: {
            latestFor: async (ids: string[]) => {
                const runs = new Map<string, LongRunView>();
                if (ids.includes('job-1')) {
                    runs.set(
                        'job-1',
                        run({
                            jobId: 'job-1',
                            status: 'done',
                            items: { total: 3, done: 3, failed: 0 } as never,
                            outcome: 'All 3 done.',
                            updatedAt: 5,
                        }),
                    );
                }
                if (ids.includes('job-2')) {
                    runs.set('job-2', run({ jobId: 'job-2' }));
                }
                return runs;
            },
        },
    };
    expect(await jobsReply(services, 'alice')).toBe(
        [
            'Your jobs:',
            '- Import: running · 40 of 120 done · 2 failed',
            '- Digest: done · 3 of 3 done\n  All 3 done.',
            '',
            'Details: https://brain.example/schedules?tab=jobs',
        ].join('\n'),
    );
    expect(await jobsReply(services, 'bob')).toMatch(/^None of your jobs/);
    expect(await jobsReply({}, 'alice')).toBe('Jobs are not available here.');

    const f = await fixture();
    await f.link('alice', 42);
    f.channel.useServices(services);
    f.say('/jobs');
    await sent(f.bot, /^Your jobs:\n- Import: running/);
});

it('keeps one progress message for a job started from a direct message, edited as it goes and when it ends (CB-145, CB-122)', async () => {
    let now = 1_000_000;
    const progress: Array<(row: never, view: LongRunView) => void> = [];
    const finished: Array<(row: never, view: LongRunView) => void> = [];
    const sentTexts: Array<[string, string]> = [];
    const edits: Array<[string, number, string]> = [];
    const threads: Record<string, { kind: string; chatId: string }> = {
        'dm-thread': { kind: 'dm', chatId: '42' },
        'topic-thread': { kind: 'topic', chatId: '-100' },
    };
    let reaches = true;
    const platform = {
        telegram: {
            status: 'online',
            reaches: async () => reaches,
            sendDirect: async (chatId: string, text: string) => {
                sentTexts.push([chatId, text]);
                return 77;
            },
            editDirect: async (chatId: string, id: number, text: string) => {
                edits.push([chatId, id, text]);
            },
        },
        workspace: {
            telegram: { threadInfo: async (id: string) => threads[id] },
        },
        jobs: { job: async () => ({ name: 'Import' }) },
        longRuns: {
            onProgress: (listener: (row: never, view: LongRunView) => void) => {
                progress.push(listener);
                return () => {};
            },
            onFinished: (listener: (row: never, view: LongRunView) => void) => {
                finished.push(listener);
                return () => {};
            },
        },
    };
    const watcher = new TelegramJobProgress(platform as never, () => now);
    watcher.start();
    expect(progress).toHaveLength(1);
    const row = (threadId: string | null, id = 'run-1') => ({ id, jobId: 'job-1', userId: 'alice', threadId }) as never;
    await watcher.show(row('dm-thread'), run(), false);
    expect(sentTexts).toEqual([['42', 'Job in progress: “Import”: running · 40 of 120 done · 2 failed']]);
    // Too soon: no edit; later, one.
    now += 1000;
    await watcher.show(row('dm-thread'), run({ items: { total: 120, done: 50, failed: 2 } as never }), false);
    expect(edits).toEqual([]);
    now += PROGRESS_EDIT_MS;
    await watcher.show(row('dm-thread'), run({ items: { total: 120, done: 60, failed: 2 } as never }), false);
    expect(edits).toEqual([['42', 77, 'Job in progress: “Import”: running · 60 of 120 done · 2 failed']]);
    // Its end edits it at once, then it is forgotten.
    now += 1;
    await watcher.show(
        row('dm-thread'),
        run({
            status: 'done',
            items: { total: 120, done: 120, failed: 0 } as never,
        }),
        true,
    );
    expect(edits.at(-1)).toEqual(['42', 77, 'Job ended: “Import”: done · 120 of 120 done']);
    // A job from a topic, from no conversation, or that no longer reaches the
    // person, gets none; an end without a message sends none.
    await watcher.show(row('topic-thread', 'run-2'), run(), false);
    await watcher.show(row(null, 'run-3'), run(), false);
    reaches = false;
    await watcher.show(row('dm-thread', 'run-4'), run(), false);
    reaches = true;
    await watcher.show(row('dm-thread', 'run-5'), run({ status: 'done' }), true);
    expect(sentTexts).toHaveLength(1);
});
