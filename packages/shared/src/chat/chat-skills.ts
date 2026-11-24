/**
 * Chat skills (CB-143): behaviors a person asks for by name at the start
 * of a message, `/compact` or `/grill-me`, in the app's chats and on
 * Telegram (`/grill_me`: Telegram's commands have no hyphens).
 *
 * - An `action` skill runs on the server and says what it did (`/compact`,
 *   `/help`, `/done`); text after its name goes on to the Dot as a turn.
 * - A `prompt` skill adds its instructions to the turn's note, with the
 *   person's message, never to the system prompt: for that one turn
 *   (`turn`), or on every turn until it ends (`until-done`, as `/grill-me`).
 *
 * The built-in ones ship with the app; admins add workspace skills, all
 * `prompt` skills, in Settings → Chat skills, where every edit is kept as a
 * revision with its lock record. A `/word` that names no skill is sent as
 * the text it is.
 */
import { TELEGRAM_DM_COMMAND_NAMES } from '../telegram-commands.js';

export type ChatSkillKind = 'action' | 'prompt';
/** A prompt skill's span: its message only, or until it ends. */
export type ChatSkillMode = 'turn' | 'until-done';
export const CHAT_SKILL_MODES: readonly ChatSkillMode[] = ['turn', 'until-done'];
export const CHAT_SKILL_MODE_LABELS: Record<ChatSkillMode, string> = {
    turn: 'That message only',
    'until-done': 'Until the person is done',
};

/**
 * Where a skill's content came from and what it is, lockfile-style: the
 * source (a built-in, an admin's edit, or later a git repository, CB-144),
 * the repository's URL, path, ref and commit when it has one, the SHA-256
 * of the content (`skillDigest`), and who changed it last and when.
 */
export interface ChatSkillLock {
    source: 'builtin' | 'workspace' | 'git';
    url?: string;
    path?: string;
    ref?: string;
    commit?: string;
    /** The license of content adapted from elsewhere. */
    license?: string;
    /** Digest of the exact imported SKILL.md bytes. */
    sourceSha256?: string;
    /** This revision contains local edits to the pinned source. */
    locallyModified?: boolean;
    sha256: string;
    /** A workspace skill's current revision. */
    revision?: number;
    updatedAt?: number;
    updatedBy?: string;
}

export interface ChatSkillView {
    name: string;
    description: string;
    kind: ChatSkillKind;
    /** A prompt skill's span. */
    mode?: ChatSkillMode;
    /** Ships with the app; otherwise an admin's workspace skill. */
    builtIn: boolean;
    /** A workspace skill's instructions, for admins only. */
    instructions?: string;
    /** For admins only. */
    lock?: ChatSkillLock;
    updatedAt?: number;
}

/** One kept revision of a workspace skill (Settings → Chat skills → History). */
export interface ChatSkillRevisionView {
    revision: number;
    description: string;
    instructions: string;
    mode: ChatSkillMode;
    sha256: string;
    /** The revision this one restored, on a rollback. */
    restoredFrom: number | null;
    createdAt: number;
    createdBy: string;
    /** The person's name, when known. */
    createdByName?: string;
}

/** The skill on in a chat until it ends (`until-done`). */
export interface ActiveChatSkill {
    name: string;
    description: string;
    startedAt: number;
}

/**
 * A skill's name: lowercase letters, digits and hyphens, up to 32, so it
 * is a Telegram command too once its hyphens are underscores.
 */
export const CHAT_SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const SKILL_DESCRIPTION_MAX = 200;
export const SKILL_INSTRUCTIONS_MAX = 4000;
export const IMPORTED_SKILL_DESCRIPTION_MAX = 2000;
export const IMPORTED_SKILL_INSTRUCTIONS_MAX = 64_000;

export interface SkillImportSource {
    url: string;
    ref: string;
    path: string;
}
export interface SkillImportPreview {
    id: string;
    expiresAt: number;
    name: string;
    description: string;
    instructions: string;
    mode: ChatSkillMode;
    source: SkillImportSource & {
        commit: string;
        sha256: string;
        license: string;
        licenseText: string;
    };
    previous: {
        revision: number;
        instructions: string;
        description: string;
    } | null;
    warnings: string[];
}

/**
 * Names a workspace skill can't take: the built-ins', Telegram's `/start`
 * and the commands its channel answers itself (`/new`, `/socio`, `/stop`,
 * `/memories`, `/jobs`, CB-145), and `threads` (`/api/chat-skills/threads/…`).
 */
export const RESERVED_SKILL_NAMES = [
    'compact',
    'done',
    'grill-me',
    'help',
    'report',
    'start',
    'threads',
    ...TELEGRAM_DM_COMMAND_NAMES,
];

/** The built-in skills, as everyone sees them. */
export const BUILT_IN_SKILLS: readonly ChatSkillView[] = [
    {
        name: 'compact',
        description:
            'Fold this chat’s earlier turns into its notes now, before it grows long enough to do it on its own.',
        kind: 'action',
        builtIn: true,
    },
    {
        name: 'done',
        description: 'End the skill that is on in this chat, such as /grill-me.',
        kind: 'action',
        builtIn: true,
    },
    {
        name: 'grill-me',
        description:
            'Get interviewed about your plan or idea, round by round, until you both understand it the same way.',
        kind: 'prompt',
        mode: 'until-done',
        builtIn: true,
    },
    {
        name: 'help',
        description: 'List the skills you can use in this chat.',
        kind: 'action',
        builtIn: true,
    },
    {
        name: 'report',
        description:
            'Report a problem or ask for an improvement: answer a few questions and the issue is filed for you, after you confirm it.',
        kind: 'prompt',
        mode: 'until-done',
        builtIn: true,
    },
    {
        name: 'unfurl',
        description:
            'Save a link’s full source (an X post, a video, an article) to a page, with a card and its media, not a summary.',
        kind: 'prompt',
        mode: 'turn',
        builtIn: true,
    },
];

/**
 * What the app puts before a message: a source link (`From https://…:`).
 * A skill's name may follow it. A page chat's page is never in the text
 * (CB-158).
 */
const CONTEXT_PREFIX = /^(?:From https?:\/\/\S+:\n\n)+/;
const COMMAND = /^\/([A-Za-z0-9][A-Za-z0-9_-]{0,31})(?:@[A-Za-z0-9_]+)?(?=\s|$)/;

/**
 * The `/word` a message starts with (after the source the app puts
 * first), as a skill's name, and the text after it, with that source:
 * `/Grill_Me@brain_bot my plan` is `grill-me` and `my plan`.
 * `bare` when nothing but the name was written. None when the message
 * doesn't start with one.
 */
export function skillCommand(text: string): { name: string; rest: string; bare: boolean } | undefined {
    const start = text.trimStart();
    const prefix = CONTEXT_PREFIX.exec(start)?.[0] ?? '';
    const body = start.slice(prefix.length);
    const match = COMMAND.exec(body);
    if (!match) {
        return undefined;
    }
    const after = body.slice(match[0].length).trim();
    return {
        name: match[1].toLowerCase().replace(/_/g, '-'),
        rest: `${prefix}${after}`.trim(),
        bare: !after,
    };
}

/** The skill a message starts with, among `skills`, and the text after it. */
export function invokedSkill<T extends { name: string }>(
    text: string,
    skills: readonly T[],
): { skill: T; rest: string; bare: boolean } | undefined {
    const command = skillCommand(text);
    const skill = command && skills.find((item) => item.name === command.name);
    return skill && { skill, rest: command.rest, bare: command.bare };
}

/**
 * A skill's content as one text, `SKILL.md`-like, whose SHA-256 is its
 * lock record's `sha256`: the same content always gives the same digest.
 */
export const skillDocument = (skill: {
    name: string;
    description: string;
    mode?: ChatSkillMode;
    instructions?: string;
}) =>
    `---\nname: ${skill.name}\ndescription: ${skill.description.replace(/\n/g, ' ')}\n${skill.mode ? `mode: ${skill.mode}\n` : ''}---\n${skill.instructions ?? ''}\n`;

/**
 * The id prefix of an action skill's answer (CB-143): its turn is left out
 * of what the model sees only when its answer has it, so a message like
 * `/help` in a chat from before skills stays as it was.
 */
export const SKILL_ANSWER_PREFIX = 'skill-answer-';
