import { afterEach, expect, it, vi } from 'vitest';

import { render } from '../src/server/notifications/channel.js';
import { type NotificationContentInput } from '../src/server/notifications/contract.js';
import { TelegramChannel } from '../src/server/telegram/telegram-channel.js';
import { CAPTION_LIMIT, captionOf, telegramNotificationChannel } from '../src/server/telegram/telegram-notify.js';

import { fakeTelegram, type BotUpload, type FakeTelegram } from './fixtures/fake-telegram.js';
import { PNG } from './fixtures/media.js';
import { ScriptAgent } from './fixtures/script-agent.js';
import { telegramServices } from './helpers/telegram-channel.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef012';
const ORIGIN = 'https://brain.test';
const ALICE_TG = 4242;
const CONFIG = {
    baseUrl: '', // no automatic titles (no model)
    apiKey: 'unused',
    model: 'test',
    voiceName: 'marin',
    runtimeUrl: '',
};
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
});

/** A platform with a Telegram channel on a fake Bot API, not started yet. */
async function fixture() {
    const bot = await fakeTelegram();
    const { store, workspace, platform, dispose } = await makeTestRuntime({ config: CONFIG });
    workspace.recordUser({ id: 'alice', name: 'Alice', role: 'member' });
    const channel = new TelegramChannel({
        settings: { token: TOKEN, allowedChatIds: [] },
        runner: platform.runner,
        store,
        workspace,
        ...telegramServices({ store, workspace, config: CONFIG, runner: platform.runner }),
        isUser: (id) => id === 'alice',
        apiRoot: bot.apiRoot,
        agentFor: () => new ScriptAgent('On it.'),
        presence: (userId, threadId) => platform.notifications.presence.telegramMessage(userId, threadId),
    });
    platform.useTelegram(channel);
    cleanup.push(
        () => bot.close(),
        dispose,
        () => channel.stop(),
    );
    const link = async (userId: string, telegramId: number, username?: string) =>
        workspace.telegram.redeem(
            (await workspace.telegram.createCode(userId)).code,
            String(telegramId),
            username ?? null,
        );
    return {
        bot,
        workspace,
        platform,
        channel,
        notify: telegramNotificationChannel(platform),
        link,
    };
}

const INPUT: NotificationContentInput = {
    from: 'Ada',
    title: 'Build done',
    message: 'All 12 checks passed on the release branch.',
    path: '/chats/thread-1',
};
const IMAGE = {
    bytes: PNG,
    mediaType: 'image/png',
    url: `${ORIGIN}/notification-images/token-1`,
};
const calls = (bot: FakeTelegram, method: string) => bot.calls.filter((call) => call.method === method);

it('reaches a linked person only while the bot is online, and says why not', async () => {
    const f = await fixture();
    expect(f.notify).toMatchObject({ id: 'telegram', label: 'Telegram' });
    // Not linked.
    expect(await f.notify.targets('alice')).toEqual([]);
    expect(await f.notify.note!('alice')).toBe('Link your Telegram account first (Settings → Telegram).');
    // Linked, but the bot isn't online yet.
    expect((await f.link('alice', ALICE_TG, 'alice_tg')).ok).toBe(true);
    expect(await f.notify.targets('alice')).toEqual([]);
    expect(await f.notify.note!('alice')).toBe('Telegram is not connected right now.');
    await f.channel.start();
    expect(f.channel.status).toBe('online');
    const linkedAt = (await f.workspace.telegram.linkFor('alice'))!.linkedAt;
    expect(await f.notify.targets('alice')).toEqual([
        { id: String(ALICE_TG), label: '@alice_tg', createdAt: linkedAt },
    ]);
    expect(await f.notify.note!('alice')).toBeUndefined();
    // No username: the channel's name.
    f.workspace.recordUser({ id: 'bob', name: 'Bob', role: 'member' });
    await f.link('bob', 5151);
    expect(await f.notify.targets('bob')).toMatchObject([{ id: '5151', label: 'Telegram' }]);
});

it('sends the title, body and link as a direct message, without logging it', async () => {
    const f = await fixture();
    await f.link('alice', ALICE_TG);
    await f.channel.start();
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')];
    const [target] = await f.notify.targets('alice');
    const result = await f.notify.send('alice', target!, render(INPUT, 'message', ORIGIN));
    expect(result).toEqual({ outcome: 'sent' });
    const [sent] = calls(f.bot, 'sendMessage');
    expect(sent!.body).toMatchObject({ chat_id: ALICE_TG });
    expect(sent!.body.text).toBe(`Ada: Build done\n${INPUT.message}\n\n${ORIGIN}/chats/thread-1`);
    // No link preview: Telegram would fetch the link.
    expect(sent!.body.link_preview_options).toEqual({ is_disabled: true });
    expect(calls(f.bot, 'sendPhoto')).toEqual([]);
    for (const log of logs) {
        expect(JSON.stringify(log.mock.calls)).not.toContain('checks passed');
    }
});

it('uploads an image as a photo with the text as its caption', async () => {
    const f = await fixture();
    await f.link('alice', ALICE_TG);
    await f.channel.start();
    const [target] = await f.notify.targets('alice');
    const result = await f.notify.send('alice', target!, render({ ...INPUT, image: IMAGE }, 'message', ORIGIN));
    expect(result).toEqual({ outcome: 'sent' });
    expect(calls(f.bot, 'sendMessage')).toEqual([]);
    const [photo] = calls(f.bot, 'sendPhoto');
    expect(photo!.body.chat_id).toBe(String(ALICE_TG));
    expect(photo!.body.caption).toBe(`Ada: Build done\n${INPUT.message}\n\n${ORIGIN}/chats/thread-1`);
    // The bytes themselves, never the image's address.
    const upload = photo!.body.photo as BotUpload;
    expect(upload).toMatchObject({ filename: 'image.png', size: PNG.length });
    expect(upload.bytes.equals(PNG)).toBe(true);

    // A long body is cut before the link is.
    const long = render({ ...INPUT, message: 'x'.repeat(1500), image: IMAGE }, 'message', ORIGIN);
    await f.notify.send('alice', target!, long);
    const caption = String(calls(f.bot, 'sendPhoto')[1]!.body.caption);
    expect(caption.length).toBeLessThanOrEqual(CAPTION_LIMIT);
    expect(caption.startsWith('Ada: Build done\nxxx')).toBe(true);
    expect(caption.endsWith(`…\n\n${ORIGIN}/chats/thread-1`)).toBe(true);
});

it('cuts a caption at Telegram’s limit, never inside a character', () => {
    const emoji = render({ ...INPUT, message: '🙂'.repeat(600), image: IMAGE }, 'message', ORIGIN);
    const caption = captionOf(emoji);
    expect(caption.length).toBeLessThanOrEqual(CAPTION_LIMIT);
    expect(caption).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(caption.endsWith(`…\n\n${ORIGIN}/chats/thread-1`)).toBe(true);
});

it('sends neither the message nor the image in private mode', async () => {
    const f = await fixture();
    await f.link('alice', ALICE_TG);
    await f.channel.start();
    const [target] = await f.notify.targets('alice');
    const result = await f.notify.send('alice', target!, render({ ...INPUT, image: IMAGE }, 'private', ORIGIN));
    expect(result).toEqual({ outcome: 'sent' });
    expect(calls(f.bot, 'sendPhoto')).toEqual([]);
    const sent = calls(f.bot, 'sendMessage');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.text).toBe(`Ada needs you\nOpen Socio to see why.\n\n${ORIGIN}/chats/thread-1`);
    const everything = JSON.stringify(f.bot.calls);
    expect(everything).not.toContain('checks passed');
    expect(everything).not.toContain('Build done');
});

it('reports a failed send, and a target that is no longer linked as gone', async () => {
    const f = await fixture();
    await f.link('alice', ALICE_TG);
    await f.channel.start();
    const [target] = await f.notify.targets('alice');
    const rendered = render(INPUT, 'message', ORIGIN);
    // Another Telegram account than the one linked now.
    expect(await f.notify.send('alice', { ...target!, id: '999' }, rendered)).toEqual({ outcome: 'gone' });
    await f.channel.stop();
    expect(await f.notify.send('alice', target!, rendered)).toEqual({
        outcome: 'failed',
        error: 'Telegram is not connected.',
    });
    expect(calls(f.bot, 'sendMessage')).toEqual([]);
});

it('counts a linked person writing in a conversation as present in its chat', async () => {
    const f = await fixture();
    await f.link('alice', ALICE_TG);
    await f.channel.start();
    const presence = f.platform.notifications.presence;
    f.bot.message({
        text: 'Status?',
        chat: { id: ALICE_TG, type: 'private' },
        from: { id: ALICE_TG },
    });
    await f.bot.waitFor(
        (call) => ['sendMessage', 'editMessageText'].includes(call.method) && String(call.body.text).includes('On it.'),
    );
    const threadId = await f.workspace.telegram.threadFor(`tg:${ALICE_TG}:dm#alice`);
    expect(threadId).toBeTruthy();
    expect(presence.judge('alice', threadId!)).toBe('present');
    expect(presence.judge('alice', 'another-thread')).toBe('away');
});

it('registers the channel with the platform, even without Telegram, until it stops', async () => {
    const { workspace, platform, dispose } = await makeTestRuntime({ config: CONFIG });
    cleanup.push(dispose);
    workspace.recordUser({ id: 'alice', name: 'Alice', role: 'member' });
    const telegramView = async () =>
        (await platform.notifications.views('alice')).find((view) => view.id === 'telegram');
    expect(await telegramView()).toBeUndefined();
    await platform.start();
    expect(await telegramView()).toMatchObject({
        label: 'Telegram',
        enabled: false,
        targets: [],
        note: 'Link your Telegram account first (Settings → Telegram).',
    });
    await platform.stop();
    expect(await telegramView()).toBeUndefined();
});
