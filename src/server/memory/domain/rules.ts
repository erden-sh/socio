import { PROFILE_FIELDS, type ProfileFields } from '@socio/shared/memory';

/** A memory's words folded, to notice the same one proposed again. */
export const memoryKey = (text: string) =>
    text
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/[.,;:!]+$/, '')
        .trim();

/** The fields with text, trimmed, in their order. */
export function filledFields(fields: ProfileFields): ProfileFields {
    const kept: ProfileFields = {};
    for (const field of PROFILE_FIELDS) {
        const value = fields[field]?.trim();
        if (value) {
            kept[field] = value;
        }
    }
    return kept;
}

/** The kinds the notes start a pinned fact with (`SUMMARY_PROMPT`). */
const FACT_LABEL = /^(Working on|Goal|Decision|Preference|Name|Result|Open):\s*/i;

/** An episode's longest text: a fact's, and a chat's summary's. */
export const EPISODE_FACT_CHARS = 1_000;
export const EPISODE_SUMMARY_CHARS = 2_000;

/**
 * How many of a person's newest episodes a search ranks (CB-180): bounds
 * the work a turn does; older ones are still listed on the Memories page.
 */
export const EPISODES_SEARCHED = 2_000;

const clipped = (text: string, chars: number) => (text.length > chars ? `${text.slice(0, chars - 1)}…` : text);

/**
 * A pinned fact as an episode (CB-180): its words as the notes kept them,
 * the kind it starts with as its label, and its folded key; undefined for
 * an empty one.
 */
export function factEpisode(fact: string) {
    const text = clipped(fact.replace(/\s+/g, ' ').trim(), EPISODE_FACT_CHARS);
    const key = memoryKey(text);
    if (!key) {
        return undefined;
    }
    const label = FACT_LABEL.exec(text)?.[1];
    return {
        text,
        key,
        label: label ? label[0].toUpperCase() + label.slice(1).toLowerCase() : null,
    };
}

/** A chat's summary as its one summary episode; its end is the newest. */
export function summaryEpisode(summary: string) {
    const text = summary.trim();
    if (!text) {
        return undefined;
    }
    return {
        text: text.length > EPISODE_SUMMARY_CHARS ? `…${text.slice(text.length - EPISODE_SUMMARY_CHARS + 1)}` : text,
        key: 'summary',
        label: null,
    };
}
