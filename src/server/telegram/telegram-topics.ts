import type { Api } from 'grammy';
import type { Message as TelegramMessage } from 'grammy/types';

import type { ChatSkill } from '@socio/foundation/skills/chat-skill';
import { ROOM_TOPIC_COMMAND, ROOM_TOPIC_COMMAND_DESCRIPTION } from '@socio/shared/rooms/room-telegram';

import type { TopicRedeemResult } from '../rooms/contract.js';

import { telegramMenu } from './telegram-direct.js';

/**
 * Group chats and forum topics with Rooms (CB-214): what the channel says
 * and parses there. A forum topic bound to a room is where socios work in
 * a group (CB-145's "socios in groups"): a room member addresses the bot
 * (a mention, a reply to it, or a command naming it) and their message is
 * a room turn as them; anyone else is told once why not, and nothing of
 * theirs reaches the room. A topic nobody bound stays a legacy team topic,
 * exactly as before.
 */

/** Told once to someone not linked who addresses the bot in a bound topic. */
export const TOPIC_UNLINKED_REPLY =
    'This topic is a Socio room: only its members can talk to the socio here. Link your Socio account (in the app, choose Telegram in the sidebar), then ask a room admin to invite you.';
/** Told once to a linked person who is not in the topic's room. */
export const TOPIC_NOT_MEMBER_REPLY =
    'This topic is a Socio room: only its members can talk to the socio here. Ask a room admin to invite you. Until then the socio doesn’t read your messages.';
/** Told once while the topic's room takes no work (archived, unlinked, Rooms off). */
export const TOPIC_CLOSED_REPLY =
    'This topic’s Socio room isn’t taking messages now: it was archived or unlinked, or Rooms are turned off. The socio doesn’t read messages here until a room admin links the topic again.';

export const TOPIC_NOTICES = {
    unlinked: TOPIC_UNLINKED_REPLY,
    not_member: TOPIC_NOT_MEMBER_REPLY,
    closed: TOPIC_CLOSED_REPLY,
} as const;

/** What `/bind` with no code says. */
export const BIND_HOW_REPLY =
    'Send the code from the room: a room admin gets it in Socio, from the room’s ⋯ menu, Telegram topic.';
/** What `/bind` in a direct message says: the code goes in the topic. */
export const BIND_IN_TOPIC_REPLY =
    'Send the code in the forum topic you want to link, as an admin of that group, not here.';
export const BIND_NOT_LINKED_REPLY =
    'Link your Socio account first (in the app, choose Telegram in the sidebar), then send the code again.';

/** What the bot answers a code posted in a topic. */
export function bindReply(result: TopicRedeemResult): string {
    if (result.ok) {
        return result.converted
            ? `This topic is now the Socio room “${result.title}”, and you are its admin. Its earlier messages stay where they were, read-only in Socio for the people who could read them. Room members talk to the socio here by mentioning me or replying to me; I answer no one else. Invite people from the room in Socio.`
            : `Linked: this topic is the Socio room “${result.title}”. Room members talk to the socio here by mentioning me or replying to me; I answer no one else. Invite people from the room in Socio.`;
    }
    switch (result.reason) {
        case 'expired':
            return 'That code expired. Get a new one from the room in Socio.';
        case 'used':
            return 'That code was used already. Get a new one from the room in Socio.';
        case 'not_topic':
            return 'Rooms link to forum topics: turn on Topics for this group, then send the code in the topic.';
        case 'not_group_admin':
            return 'Only an admin of this Telegram group can link a topic to a room.';
        case 'wrong_topic':
            return 'That code is for another topic: send it in the topic you chose to make a room.';
        case 'conflict':
            return 'This topic is linked to a room already. That room’s admins can unlink it in Socio first.';
        case 'room_bound':
            return 'That room is linked to another topic already. Unlink it in Socio first.';
        case 'rooms_off':
            return 'Rooms are turned off in Socio, so a topic can’t be linked now.';
        case 'archived':
            return 'That room is archived. Unarchive it in Socio first.';
        case 'not_allowed':
            return 'You can’t link this topic to that room. Check in Socio that you are still allowed to.';
        case 'invalid':
        default:
            return 'That code is not valid. Get a new one from the room in Socio.';
    }
}

/**
 * The forum topic a group message is in: its thread id, `general` for a
 * forum's General topic (which carries none), none outside a forum. As
 * the adapter keys conversations (`deriveConversationKey`): in a group
 * that is no forum, a reply's thread id is no topic.
 */
export function forumTopicOf(
    message: Pick<TelegramMessage, 'chat' | 'message_thread_id'>,
    forum: boolean,
): string | null {
    if (message.chat.type === 'private' || !forum) {
        return null;
    }
    return message.message_thread_id !== undefined ? String(message.message_thread_id) : 'general';
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a group message addresses the bot, as the adapter answers one:
 * it mentions `@bot` (a command naming it, `/compact@bot`, does too) or
 * replies to one of the bot's messages.
 */
export function addressesBot(
    message: Pick<TelegramMessage, 'text' | 'caption' | 'reply_to_message'>,
    bot: { username?: string; id?: string },
) {
    const text = message.text ?? message.caption ?? '';
    if (bot.username && new RegExp(`@${escape(bot.username)}\\b`, 'i').test(text)) {
        return true;
    }
    return bot.id !== undefined && String(message.reply_to_message?.from?.id ?? '') === bot.id;
}

/**
 * `/bind <code>` in a group, when it is for this bot: it names the bot
 * (`/bind@bot`, as Telegram's menu writes it) or replies to it. A bare
 * `/bind` is someone else's (CB-145: a bare command in a group is not
 * the bot's). The code, or an empty one when none was given.
 */
export function bindCommandOf(
    message: Pick<TelegramMessage, 'text' | 'reply_to_message'>,
    bot: { username?: string; id?: string },
): { code: string } | undefined {
    const match = /^\/([A-Za-z_]+)(?:@(\w+))?(?:\s+(\S+))?\s*$/.exec(message.text?.trim() ?? '');
    if (!match || match[1].toLowerCase() !== ROOM_TOPIC_COMMAND) {
        return;
    }
    const named = match[2]?.toLowerCase();
    const repliedToBot = bot.id !== undefined && String(message.reply_to_message?.from?.id ?? '') === bot.id;
    if (named ? named !== bot.username?.toLowerCase() : !repliedToBot) {
        return;
    }
    return { code: match[3] ?? '' };
}

/** `/bind` in the command menu of a group's admins. */
const BIND = {
    name: ROOM_TOPIC_COMMAND,
    description: ROOM_TOPIC_COMMAND_DESCRIPTION,
};

/**
 * Telegram's command menus in groups: the chat skills for everyone (a
 * skill a member runs in a bound topic is a room turn, as in the app),
 * and `/bind` first for the group's admins, who alone can link a topic.
 * Direct messages keep their own menu (CB-145).
 */
export function telegramGroupMenus(skills: readonly ChatSkill[]) {
    return {
        all_group_chats: telegramMenu(skills, []),
        all_chat_administrators: telegramMenu(skills, [BIND]),
    };
}

/** Registers the group menus when they changed; the key registered. */
export async function refreshGroupMenus(
    api: Pick<Api, 'setMyCommands'>,
    skills: readonly ChatSkill[],
    last: string | undefined,
) {
    const menus = telegramGroupMenus(skills);
    const key = JSON.stringify(menus);
    if (key === last) {
        return key;
    }
    for (const [type, commands] of Object.entries(menus)) {
        await api.setMyCommands(commands, {
            scope: { type: type as keyof typeof menus },
        });
    }
    return key;
}
