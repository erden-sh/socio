import { compareText, lowerText } from '../locale.js';

/**
 * People's @mentions in a room message (CB-216): a mention is structured,
 * never read from the text alone. The composer's picker records whom the
 * person chose, by id, and the name it put in the text (`@Ana Lima`);
 * the server keeps such a mention only while that `@Name` is still in the
 * message, the name is the person's own and they are an active member.
 * So two people who share a name stay two people, and text that merely
 * looks like a mention (typed, pasted or quoted) mentions nobody.
 *
 * Socios' mentions (CB-206) are another module's: a name a socio and a
 * person share is the socio's, so a person's mention never doubles as one.
 * Pure: the composer and the server use the same rules.
 */

/** One person a message mentions, as the picker chose them. */
export interface PersonMention {
    userId: string;
    /** The name the picker put after `@`: the person's name then. */
    label: string;
}

/** A person the picker may offer: an active member of the room. */
export interface MentionablePerson {
    userId: string;
    name: string;
}

/** At most this many people per message. */
export const PERSON_MENTIONS_MAX = 20;
/** A label's longest. */
export const MENTION_LABEL_MAX = 120;
/** The longest `@query` the picker follows while typing. */
const QUERY_MAX = 40;

/** A letter, digit or underscore: a mention can't start or end inside a word. */
const WORD = /[\p{L}\p{N}_]/u;

/** A name with its spaces folded, as it goes in the text. */
const spaced = (name: string) => name.trim().replace(/\s+/g, ' ');
/** A name as mentions compare it: spaces folded, any case. */
export const foldedName = (name: string) => lowerText(spaced(name));

/** The text the picker puts in the message for a person. */
export const personToken = (name: string) => `@${spaced(name)}`;

/**
 * How many times each label stands in `text` as a whole mention: `@`
 * after the start or a character that isn't part of a word (an email
 * address is no mention), then the label, not followed by more of a word.
 * At each `@` the longest label that fits counts (`@Ana Lima` is Ana
 * Lima's, not Ana's).
 */
export function tokenCounts(text: string, labels: readonly string[]) {
    const names = [...new Set(labels.map(foldedName))].filter(Boolean).sort((a, b) => b.length - a.length);
    const counts = new Map(names.map((name) => [name, 0]));
    const lower = lowerText(text).replace(/\s+/g, ' ');
    for (let at = lower.indexOf('@'); at >= 0; at = lower.indexOf('@', at + 1)) {
        if (at > 0 && WORD.test(lower[at - 1]!)) {
            continue;
        }
        const rest = lower.slice(at + 1);
        const name = names.find(
            (candidate) =>
                rest.startsWith(candidate) && !(rest.length > candidate.length && WORD.test(rest[candidate.length]!)),
        );
        if (name) {
            counts.set(name, counts.get(name)! + 1);
        }
    }
    return counts;
}

/**
 * The people `text` really mentions, of those the picker recorded: each
 * once, in the order picked. Left out: anyone not in `names` (the room's
 * active members now, by id), the author, a label that isn't the person's
 * own name, a name one of the room's socios has (`socioNames`, CB-206's to
 * route), and a pick whose `@Name` is no longer in the text. A name that
 * several picked people share needs as many `@Name`s in the text.
 */
export function confirmedMentions(
    text: string,
    picked: readonly PersonMention[],
    options: {
        names: ReadonlyMap<string, string>;
        authorId?: string;
        socioNames?: readonly string[];
    },
): PersonMention[] {
    const socios = new Set((options.socioNames ?? []).map(foldedName));
    const byLabel = new Map<string, PersonMention[]>();
    const seen = new Set<string>();
    for (const mention of picked.slice(0, PERSON_MENTIONS_MAX)) {
        if (seen.has(mention.userId) || mention.userId === options.authorId) {
            continue;
        }
        const name = options.names.get(mention.userId);
        const label = foldedName(mention.label);
        if (!name || !label || foldedName(name) !== label || socios.has(label)) {
            continue;
        }
        seen.add(mention.userId);
        byLabel.set(label, [...(byLabel.get(label) ?? []), { userId: mention.userId, label: spaced(name) }]);
    }
    // Every name the room has competes, so `@Ana Lima` is never Ana's.
    const counts = tokenCounts(text, [...options.names.values(), ...(options.socioNames ?? [])]);
    const kept = new Set<string>();
    for (const [label, people] of byLabel) {
        if ((counts.get(label) ?? 0) >= people.length) {
            for (const person of people) {
                kept.add(person.userId);
            }
        }
    }
    const out: PersonMention[] = [];
    for (const people of byLabel.values()) {
        for (const person of people) {
            if (kept.has(person.userId)) {
                out.push(person);
            }
        }
    }
    const order = new Map(picked.map((mention, index) => [mention.userId, index]));
    return out.sort((a, b) => order.get(a.userId)! - order.get(b.userId)!);
}

/**
 * The `@query` being typed just before `caret`, if any: where its `@` is
 * and what follows it. Spaces count (names have them), line breaks don't.
 */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | undefined {
    const before = text.slice(0, caret);
    const start = before.lastIndexOf('@');
    if (start < 0) {
        return undefined;
    }
    if (start > 0 && WORD.test(before[start - 1]!)) {
        return undefined;
    }
    const query = before.slice(start + 1);
    if (query.length > QUERY_MAX || /[\n\r@]/.test(query)) {
        return undefined;
    }
    if (/^\s/.test(query)) {
        return undefined;
    }
    return { start, query };
}

/**
 * The people whose name fits what is typed after `@`: its whole start, or
 * the start of a later word of it ("@lim" finds Ana Lima). By name.
 */
export function matchingPeople<T extends MentionablePerson>(people: readonly T[], query: string, limit = 8): T[] {
    const wanted = foldedName(query);
    return people
        .filter((person) => {
            const name = foldedName(person.name);
            if (!name) {
                return false;
            }
            if (!wanted) {
                return true;
            }
            return name.startsWith(wanted) || name.split(' ').some((word) => word.startsWith(wanted));
        })
        .sort((a, b) => compareText(a.name, b.name) || compareText(a.userId, b.userId))
        .slice(0, limit);
}

/** `text` with `@query` (from `start` to `caret`) replaced by the person's token and a space. */
export function insertMention(text: string, start: number, caret: number, name: string) {
    const token = `${personToken(name)} `;
    const after = text.slice(caret).replace(/^ /, '');
    return {
        text: `${text.slice(0, start)}${token}${after}`,
        caret: start + token.length,
    };
}
