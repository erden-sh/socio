import type { Message } from '@ag-ui/core';

import { BUILT_IN_SKILLS, SKILL_ANSWER_PREFIX, skillCommand } from '@socio/shared/chat/chat-skills';

import { messageText } from '../turns/media-parts.js';

// Moved from `src/server/skills/registry.ts`, which re-exports
// `withoutSkillActions`.

/** The built-in skills the server runs itself. */
const ACTIONS = new Set(BUILT_IN_SKILLS.filter((skill) => skill.kind === 'action').map((skill) => skill.name));

/** The roles a model is sent; others (reasoning, activity) are not. */
const CHAT_ROLES = new Set(['user', 'assistant', 'tool']);

/** A message with text parts only (no attachments). */
export const textOnly = (message: Message) =>
    !Array.isArray(message.content) ||
    (message.content as Array<{ type?: string }>).every((part) => part?.type === 'text');

/**
 * The conversation as a model sees skills' turns (`/compact`, `/help`,
 * `/done` ran on the server; their answers' ids have
 * `SKILL_ANSWER_PREFIX`):
 * - one that was the skill's name alone is left out, with the server's
 *   answer, so the turns the model sees stay the same as before it;
 * - one with text or files after the name stays, with the server's answer;
 *   the last pass before the model (`alternating`, CB-147) puts that answer
 *   into the Dot's after it, so the roles still alternate.
 * A `/help` in a chat from before skills, which no server answer follows,
 * stays as it was.
 */
export function withoutSkillActions(messages: readonly Message[]) {
    // The first chat message from `from` on: reasoning and activity, which
    // no model is sent again, are passed over.
    const nextChat = (from: number) => {
        for (let at = from; at < messages.length; at++) {
            if (CHAT_ROLES.has(messages[at].role)) {
                return at;
            }
        }
        return -1;
    };
    const served = (message?: Message) => message?.role === 'assistant' && message.id.startsWith(SKILL_ANSWER_PREFIX);
    const dropped = new Set<number>();
    messages.forEach((message, at) => {
        if (message.role !== 'user') {
            return;
        }
        const answer = nextChat(at + 1);
        const command = skillCommand(messageText(message.content));
        if (
            answer >= 0 &&
            served(messages[answer]) &&
            command?.bare &&
            ACTIONS.has(command.name) &&
            textOnly(message)
        ) {
            for (let index = at; index <= answer; index++) {
                dropped.add(index);
            }
        }
    });
    if (!dropped.size) {
        return messages as Message[];
    }
    return messages.filter((_message, at) => !dropped.has(at));
}
