import type { ChatSkillLock, ChatSkillView } from '@socio/shared/chat/chat-skills';
import type { InferenceCapabilities } from '@socio/shared/inference';
import { ROOM_TOPIC_COMMAND, ROOM_TOPIC_COMMAND_DESCRIPTION } from '@socio/shared/rooms/room-telegram';
import { TELEGRAM_DM_COMMANDS } from '@socio/shared/telegram-commands';

import { contextBudget, textTokens } from '../context/budget.js';
import { TurnFailureError, TURN_FAILURE_MESSAGES } from '../observability/failures.js';

// Moved from `src/server/skills/registry.ts`, which re-exports it.

/**
 * The chat skills a person can invoke (CB-143): the built-in ones, then
 * the workspace's, by name, each with its lock record. A skill is invoked
 * by the person's newest message starting with its name; see
 * `packages/shared/src/chat/chat-skills.ts`.
 */
export interface ChatSkill extends ChatSkillView {
    /** A `prompt` skill's instructions for the turn. */
    instructions?: string;
    lock: ChatSkillLock;
}

/** A skill's name as typed: on Telegram, with underscores. */
export const commandName = (name: string, telegram = false) => `/${telegram ? name.replace(/-/g, '_') : name}`;

/**
 * What `/help` answers: each skill with what it does; on Telegram, then
 * the commands its channel answers in a direct message (CB-145).
 */
export function helpText(skills: readonly ChatSkill[], telegram = false) {
    return [
        'Skills you can use here: start a message with one.',
        '',
        ...skills.map((skill) => `- ${commandName(skill.name, telegram)}: ${skill.description}`),
        ...(telegram
            ? [
                  '',
                  'In a direct message with me:',
                  ...TELEGRAM_DM_COMMANDS.map((command) => `- /${command.name}: ${command.description}`),
                  // CB-214: where socios work in a group.
                  '',
                  'In a group, mention me or reply to me. In a topic linked to a Socio room I answer only its members.',
                  `- /${ROOM_TOPIC_COMMAND} <code>: ${ROOM_TOPIC_COMMAND_DESCRIPTION} For admins of the group.`,
              ]
            : []),
    ].join('\n');
}

const whose = (skill: ChatSkill) => (skill.builtIn ? 'of Socio' : 'an admin of this workspace added');

/**
 * A `prompt` skill's part of the turn's note (`withTurnNote`): with the
 * person's message, never in the system prompt. A `turn` skill's for the
 * message that invoked it; an `until-done` skill's on every turn while it
 * is on, with how it ends.
 */
export const skillNote = (skill: ChatSkill) =>
    skill.mode === 'until-done'
        ? `[The skill ${commandName(skill.name)}, ${whose(skill)}, is on in this conversation: the person started it, and it stays on, turn after turn, until it ends. Follow its instructions. When the person says they are done, wants to stop or moves on to something else, or its instructions say it is finished, call end_skill, then answer as usual. They can also send /done.]\n${skill.instructions ?? ''}`
        : `[The person started this message with ${commandName(skill.name)}, a skill ${whose(skill)}. Follow its instructions for this turn:]\n${skill.instructions ?? ''}`;

/** Skill instructions are protected turn notes: never silently truncate them.
 * Keep at least half the existing prompt budget for tools, role and conversation. */
export function assertSkillsFit(skills: readonly ChatSkill[], capabilities: InferenceCapabilities) {
    if (textTokens(skills.map(skillNote).join('\n\n')) > Math.floor(contextBudget(capabilities).target / 2)) {
        throw new TurnFailureError('skill_context', TURN_FAILURE_MESSAGES.skill_context);
    }
}
