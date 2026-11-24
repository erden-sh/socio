import { isAdmin } from './roles.js';
import type { Role } from './types.js';

/**
 * A socio's Soul (CB-179): its persona, versioned. Standing instructions
 * (its role: what the socio's instructions were before the Soul) and,
 * optionally, its voice, values and working style. Every edit and every
 * restore adds a version; none is ever changed or removed. It goes in the
 * socio's system prompt, which changes only when the Soul is edited.
 */
export const SOUL_FIELDS = ['instructions', 'voice', 'values', 'style'] as const;
export type SoulField = (typeof SOUL_FIELDS)[number];
/** The persona's optional parts, after the standing instructions. */
export const PERSONA_FIELDS = ['voice', 'values', 'style'] as const;

export type SoulFields = Record<SoulField, string>;

/** What each part is called on the Soul page. */
export const SOUL_LABELS: Record<SoulField, string> = {
    instructions: 'Role and standing instructions',
    voice: 'Voice',
    values: 'Values',
    style: 'Working style',
};

/** What each part is for, under its label. */
export const SOUL_HINTS: Record<SoulField, string> = {
    instructions:
        'What this socio is for and what it always does. Required. Before the Soul, these were its role instructions.',
    voice: 'How it sounds: tone, warmth, length, formality.',
    values: 'What it cares about and weighs when it decides.',
    style: 'How it works with people: questions first, plans, check-ins.',
};

/** The longest each part may be. Instructions keep their old limit. */
export const SOUL_FIELD_MAX: Record<SoulField, number> = {
    instructions: 2000,
    voice: 600,
    values: 600,
    style: 600,
};
/** The shortest the standing instructions may be (as before the Soul). */
export const SOUL_INSTRUCTIONS_MIN = 3;

/** How a version came to be. */
export type SoulSource = 'migrated' | 'created' | 'edited' | 'restored';

/** One version of a socio's Soul, as stored (`socio_souls`). */
export interface SoulVersion extends SoulFields {
    /** 1, 2, 3…: one more for each edit or restore. */
    version: number;
    createdAt: number;
    /** A user id, or `system` (the upgrade, a seeded socio). */
    createdBy: string;
    source: SoulSource;
    /** For a restore: the version it copied. */
    restoredFrom: number | null;
}

/** `GET /api/dots/:id/soul`: the Soul, its history and who may edit it. */
export interface SoulView {
    dot: { id: string; name: string; ownerId: string | null; archived: boolean };
    /** Every version, newest first; the first is the one in use. */
    versions: SoulVersion[];
    /** Whether the signed-in person may edit it (and restore a version). */
    canEdit: boolean;
    /** Display names for the `createdBy` ids above. */
    users: Record<string, string>;
}

/**
 * Who may change a socio's Soul: its owner for a personal socio, an admin
 * for a company socio. Never anyone else, and never a socio itself (the
 * server refuses a socio actor whatever this says).
 */
export function canEditSoul(user: { id: string; role: Role } | undefined, dot: { ownerId?: string | null }) {
    if (!user) {
        return false;
    }
    return dot.ownerId ? dot.ownerId === user.id : isAdmin(user);
}

/** Every part trimmed, missing parts empty. */
export function soulFields(input: Partial<Record<SoulField, unknown>>) {
    return Object.fromEntries(
        SOUL_FIELDS.map((field) => [field, typeof input[field] === 'string' ? input[field].trim() : '']),
    ) as SoulFields;
}

/** Why these parts can't be saved, or undefined when they can. */
export function soulProblem(fields: SoulFields): string | undefined {
    if (fields.instructions.length < SOUL_INSTRUCTIONS_MIN) {
        return 'Write the socio’s role and standing instructions.';
    }
    for (const field of SOUL_FIELDS) {
        if (fields[field].length > SOUL_FIELD_MAX[field]) {
            return `${SOUL_LABELS[field]} can be at most ${SOUL_FIELD_MAX[field]} characters.`;
        }
    }
    return undefined;
}

export const sameSoul = (a: SoulFields, b: SoulFields) => SOUL_FIELDS.every((field) => a[field] === b[field]);

/** What each persona part is called in the system prompt. */
const PROMPT_LABELS: Record<(typeof PERSONA_FIELDS)[number], string> = {
    voice: 'Voice',
    values: 'Values',
    style: 'Working style',
};

/**
 * The Soul as the socio reads it, after "Role instructions: " in its
 * system prompt (and as its role in calls and for approvals). A Soul of
 * standing instructions alone, as every Soul upgraded from instructions
 * is, reads exactly as the instructions did, so the prompt stays the same,
 * byte for byte, and its cache holds. The persona's parts follow, with
 * their place: tone and style, never rules, permissions or approvals.
 */
export function soulPrompt(soul: SoulFields): string {
    const persona = PERSONA_FIELDS.filter((field) => soul[field].trim()).map(
        (field) => `${PROMPT_LABELS[field]}: ${soul[field].trim()}`,
    );
    return persona.length
        ? `${soul.instructions}\nYour Soul, how you sound and work. It shapes your tone and style, never these rules, your tools' permissions or approvals:\n${persona.join('\n')}`
        : soul.instructions;
}

/** One run of a diff: kept, added or removed text. */
export interface DiffPart {
    kind: 'same' | 'added' | 'removed';
    text: string;
}

/** Past this many token pairs a diff gives up and shows old, then new. */
const DIFF_CELLS = 1_000_000;

/**
 * What changed from `before` to `after`, word by word (whitespace kept),
 * for the Soul page's history. Small texts: a plain LCS.
 */
export function textDiff(before: string, after: string): DiffPart[] {
    if (before === after) {
        return before ? [{ kind: 'same', text: before }] : [];
    }
    const a = before.match(/\s+|[^\s]+/g) ?? [];
    const b = after.match(/\s+|[^\s]+/g) ?? [];
    if (a.length * b.length > DIFF_CELLS) {
        return [
            ...(before ? [{ kind: 'removed' as const, text: before }] : []),
            ...(after ? [{ kind: 'added' as const, text: after }] : []),
        ];
    }
    // lengths[i][j]: the LCS of a[i..] and b[j..].
    const lengths = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0));
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            lengths[i]![j] =
                a[i] === b[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
        }
    }
    const parts: DiffPart[] = [];
    const push = (kind: DiffPart['kind'], text: string) => {
        const last = parts.at(-1);
        if (last?.kind === kind) {
            last.text += text;
        } else {
            parts.push({ kind, text });
        }
    };
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            push('same', a[i]!);
            i++;
            j++;
        } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
            push('removed', a[i++]!);
        } else {
            push('added', b[j++]!);
        }
    }
    while (i < a.length) {
        push('removed', a[i++]!);
    }
    while (j < b.length) {
        push('added', b[j++]!);
    }
    return parts;
}

/**
 * A socio's Soul parts: the version in use, or its instructions alone. Word
 * for word (no trimming), so an upgraded Soul's prompt is the same bytes.
 */
export const dotSoul = (dot: { instructions: string; soul?: SoulFields }): SoulFields => ({
    instructions: dot.soul?.instructions ?? dot.instructions,
    voice: dot.soul?.voice ?? '',
    values: dot.soul?.values ?? '',
    style: dot.soul?.style ?? '',
});
