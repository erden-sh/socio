import { BUILT_IN_SKILLS, invokedSkill } from '@socio/shared/chat/chat-skills';

import type { AuthedFetch } from '../net/authed-fetch';
import { readJson } from '../net/read-body';
import { httpError } from '../sync/errors';

// The chat skills a person's message may start with (CB-143, CB-415): the
// built-in ones at once, then the workspace's from `GET /api/chat-skills`,
// read at most once a minute and only when a message starts with a name the
// known ones don't have, as the web's chat-skills.ts reads them. A message
// that invoked one shows the skill as a chip above the rest of its words
// (`messageSkill`, the web's useSkillSplit and SkillChip). No React Native
// here: tests/chat runs it under Node.

export const CHAT_SKILLS_PATH = '/api/chat-skills';
/** How long the workspace's skills stay fresh (the web's FRESH_MS). */
export const SKILLS_FRESH_MS = 60_000;

/** A skill as the transcript needs it: its name. */
export interface KnownSkill {
    readonly name: string;
}

/** A message that invoked a skill: the chip's name, and what the person wrote after it. */
export interface MessageSkill {
    readonly name: string;
    readonly rest: string;
}

/** The skill `text` starts with among `skills`, or null: a `/word` that names none is text. */
export function messageSkill(text: string, skills: readonly KnownSkill[]): MessageSkill | null {
    const invoked = invokedSkill(text, skills);
    return invoked === undefined ? null : { name: invoked.skill.name, rest: invoked.rest };
}

/** Whether `text` starts like a skill (`/name`) the known ones don't have: the workspace's are worth reading. */
export const namesUnknownSkill = (text: string, skills: readonly KnownSkill[]) =>
    messageSkill(text, skills) === null && /^\s*\/[a-z0-9]/i.test(text);

export interface ChatSkills {
    /** The skills known now: the built-in ones until the workspace's are read. */
    known(): readonly KnownSkill[];
    subscribe(listener: () => void): () => void;
    /** Reads the workspace's skills, unless they were read (or failed) in the last minute or a read is on its way. */
    load(): void;
}

export function createChatSkills(options: {
    readonly fetch: AuthedFetch;
    readonly signal?: AbortSignal;
    readonly now?: () => number;
    readonly onError?: (error: unknown) => void;
}): ChatSkills {
    const { fetch, signal, now = Date.now, onError = () => {} } = options;
    let known: readonly KnownSkill[] = BUILT_IN_SKILLS;
    let loadedAt = -Infinity;
    let loading = false;
    const listeners = new Set<() => void>();
    const read = async () => {
        const response = await fetch(CHAT_SKILLS_PATH, signal ? { signal } : undefined);
        if (!response.ok) {
            throw await httpError(response, signal);
        }
        const body = (await readJson(response, signal)) as { skills?: unknown } | null;
        const skills = body !== null && typeof body === 'object' ? body.skills : undefined;
        if (Array.isArray(skills)) {
            known = skills.filter(
                (skill): skill is KnownSkill =>
                    skill !== null && typeof skill === 'object' && typeof (skill as KnownSkill).name === 'string',
            );
        }
        loadedAt = now();
        for (const listener of listeners) {
            listener();
        }
    };
    return {
        known: () => known,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        load() {
            if (loading || now() - loadedAt < SKILLS_FRESH_MS) {
                return;
            }
            loading = true;
            read()
                // The built-in ones still show; a message that names one asks again after a minute.
                .catch((error: unknown) => {
                    loadedAt = now();
                    onError(error);
                })
                .finally(() => {
                    loading = false;
                });
        },
    };
}
