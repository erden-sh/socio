import { useCallback, useSyncExternalStore } from 'react';

import { BUILT_IN_SKILLS, invokedSkill, type ChatSkillView } from '@socio/shared/chat/chat-skills';

import { api } from '../../lib/api';

/**
 * The chat skills a person can invoke (CB-143), for the composer's `/`
 * menu and the transcript's chips: the built-in ones at once, then the
 * workspace's, read once a minute at most and only when needed (a `/`
 * typed, a message that starts with a name the built-ins don't have).
 */
let known: readonly ChatSkillView[] = BUILT_IN_SKILLS;
let loadedAt = 0;
let loading: Promise<void> | undefined;
const listeners = new Set<() => void>();
const FRESH_MS = 60_000;

/** Reads the workspace's skills, unless they were read in the last minute. */
export function loadChatSkills(force = false) {
    if (loading || (!force && Date.now() - loadedAt < FRESH_MS)) {
        return loading;
    }
    loading = api<{ skills: ChatSkillView[] }>('/chat-skills')
        .then(({ skills }) => {
            if (Array.isArray(skills)) {
                known = skills;
            }
            loadedAt = Date.now();
            for (const listener of listeners) {
                listener();
            }
        })
        .catch(() => {
            // The built-in ones still work; the next `/` asks again.
        })
        .finally(() => {
            loading = undefined;
        });
    return loading;
}

const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

/** The skills known now, and `load` to read the workspace's. */
export function useChatSkills() {
    const skills = useSyncExternalStore(
        subscribe,
        () => known,
        () => BUILT_IN_SKILLS,
    );
    const load = useCallback((force = false) => void loadChatSkills(force), []);
    return { skills, load };
}

/**
 * The name being typed for the `/` menu: the draft is a `/` and the start
 * of a name, nothing else yet. Hyphens or underscores, as on Telegram.
 */
export function skillQuery(draft: string): string | undefined {
    const match = /^\/([a-z0-9_-]*)$/i.exec(draft);
    return match ? match[1].toLowerCase().replace(/_/g, '-') : undefined;
}

/** The skills for a query: names that start with it, then names that have it. */
export function matchSkills(skills: readonly ChatSkillView[], query: string): ChatSkillView[] {
    return [
        ...skills.filter((skill) => skill.name.startsWith(query)),
        ...skills.filter((skill) => !skill.name.startsWith(query) && skill.name.includes(query)),
    ];
}

/**
 * The message as sent: a skill's name stays first, so the server and the
 * transcript find it, with `wrap` (the source the message comes from)
 * around the text after it. A `/word` that names no skill is text.
 */
export function skillFirst(text: string, skills: readonly ChatSkillView[], wrap: (text: string) => string) {
    const invoked = invokedSkill(text, skills);
    if (!invoked) {
        return wrap(text);
    }
    const name = `/${invoked.skill.name}`;
    return invoked.rest ? `${name} ${wrap(invoked.rest)}` : name;
}
