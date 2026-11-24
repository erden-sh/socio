import type { StackEnvEntry } from './portainer.js';

export class PlanError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PlanError';
    }
}

/**
 * The stack env for `target`: every entry as it was, in the same order,
 * with only the tag keys' values set to `target` (CB-259). Refuses when a
 * tag key isn't in the env (the file's default would apply instead, which
 * the updater can't change), when a key is there twice, or when nothing
 * would change.
 */
export function planEnv(env: readonly StackEnvEntry[], tagKeys: readonly string[], target: string): StackEnvEntry[] {
    for (const key of tagKeys) {
        const count = env.filter((entry) => entry.name === key).length;
        if (!count) {
            throw new PlanError(
                `${key} is not in the stack's env: set it there first (the updater changes only the tag keys it finds).`,
            );
        }
        if (count > 1) {
            throw new PlanError(`${key} is in the stack's env ${count} times.`);
        }
    }
    const next = env.map((entry) =>
        tagKeys.includes(entry.name) ? { name: entry.name, value: target } : { name: entry.name, value: entry.value },
    );
    if (next.every((entry, index) => entry.value === env[index]!.value)) {
        throw new PlanError(`The stack already runs ${target}.`);
    }
    return next;
}

/** Only the tag keys differ, and every other key and value is the same. */
export function onlyTagsChanged(
    before: readonly StackEnvEntry[],
    after: readonly StackEnvEntry[],
    tagKeys: readonly string[],
) {
    return (
        before.length === after.length &&
        before.every(
            (entry, index) =>
                entry.name === after[index]!.name &&
                (tagKeys.includes(entry.name) || entry.value === after[index]!.value),
        )
    );
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The images the stack file names through a tag key, with the target
 * substituted: `image: company-brain:${IMAGE_TAG:-latest}` with IMAGE_TAG
 * and v0.22.0 is `company-brain:v0.22.0`. Images whose reference has
 * other variables are left out (they can't be checked).
 */
export function imagesFor(file: string, tagKeys: readonly string[], target: string): string[] {
    const images = new Set<string>();
    for (const line of file.split('\n')) {
        const match = line.match(/^\s*image:\s*(.+?)\s*$/);
        if (!match) {
            continue;
        }
        // Without a trailing comment and the quotes around it.
        let reference = match[1]!.replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2');
        let named = false;
        for (const key of tagKeys) {
            const variable = new RegExp(`\\$\\{${escape(key)}(?:[:]?[-?][^}]*)?\\}`, 'g');
            if (variable.test(reference)) {
                named = true;
                reference = reference.replace(variable, target);
            }
        }
        if (named && !reference.includes('$') && !/\s/.test(reference)) {
            images.add(reference);
        }
    }
    return [...images];
}
