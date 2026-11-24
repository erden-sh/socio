/**
 * Mentions in a room message (CB-206): `@Name` tokens, matched against the
 * names the room has. A socio's mention sends the message to that socio.
 * People's are parsed apart, only so a
 * name is never taken for both: they route nothing and must not drive
 * notifications, which CB-216's mentions picked by id do. A name that is
 * an active socio's is never a person's mention. Socio and people
 * mentions are two lists, so neither can be taken for the other. Pure:
 * the client shows who a message goes to before it is sent, and the
 * server routes it, with the same rule.
 */

/** A name a mention may match: a room's socio or person. */
export interface MentionCandidate {
    id: string;
    name: string;
}

/** Who a message mentions, by id, each once, in the order first mentioned. */
export interface RoomMentions {
    socios: string[];
    people: string[];
}

/** A letter, digit or underscore: a mention can't start or end inside a word. */
const WORD = /[\p{L}\p{N}_]/u;

/** A name as mentions compare it: trimmed, spaces folded, any case. */
const folded = (name: string) => name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');

/** The token the socio picker puts in the message for a socio. */
export const mentionToken = (name: string) => `@${name.trim().replace(/\s+/g, ' ')}`;

/**
 * The socios and people `text` mentions. A mention is `@` at the start of
 * the text or after a character that is not part of a word (an email
 * address is no mention), then a candidate's whole name, in any case,
 * not followed by more of a word. The longest name that fits wins (`@Ana
 * Lima` over `@Ana`). A name two socios share, or two people share, is
 * ambiguous and mentions nobody; a name a socio and a person share is the
 * socio's, since socio mentions route the message.
 */
export function parseRoomMentions(
    text: string,
    candidates: {
        socios?: readonly MentionCandidate[];
        people?: readonly MentionCandidate[];
    },
): RoomMentions {
    const names = new Map<string, { kind: 'socio' | 'person'; ids: Set<string> }>();
    const add = (kind: 'socio' | 'person', list: readonly MentionCandidate[]) => {
        for (const { id, name } of list) {
            const key = folded(name);
            if (!key) {
                continue;
            }
            const known = names.get(key);
            if (!known) {
                names.set(key, { kind, ids: new Set([id]) });
            } else if (known.kind === kind) {
                known.ids.add(id);
            }
            // A socio's name is never also a person's mention.
        }
    };
    add('socio', candidates.socios ?? []);
    add('person', candidates.people ?? []);
    // Longest first, so the longest name that fits is tried first.
    const keys = [...names.keys()].sort((a, b) => b.length - a.length);
    const found: RoomMentions = { socios: [], people: [] };
    const lower = text.toLocaleLowerCase('en');
    for (let at = text.indexOf('@'); at >= 0; at = text.indexOf('@', at + 1)) {
        if (at > 0 && WORD.test(text[at - 1]!)) {
            continue;
        }
        const rest = lower.slice(at + 1).replace(/\s+/g, ' ');
        const key = keys.find(
            (name) => rest.startsWith(name) && !(rest.length > name.length && WORD.test(rest[name.length]!)),
        );
        if (!key) {
            continue;
        }
        const { kind, ids } = names.get(key)!;
        if (ids.size !== 1) {
            continue;
        }
        const [id] = ids;
        const list = kind === 'socio' ? found.socios : found.people;
        if (!list.includes(id!)) {
            list.push(id!);
        }
    }
    return found;
}
