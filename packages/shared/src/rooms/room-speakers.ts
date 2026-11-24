import { foldedName } from './room-people-mentions.js';
import type { RoomMemberView } from './rooms.js';

/**
 * How a room tells its people apart (CB-212), shared by the web and the
 * app: initials for an avatar, a tone by name as an index into the
 * client's own palette (the web's Tailwind classes, the app's theme), and
 * same-named members numbered in words. Never by color alone: the name is
 * always beside the avatar.
 */

/** "Ana Lima" → "AL"; one name → its first letter. */
export const initials = (name: string) =>
    name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => [...part][0]?.toUpperCase() ?? '')
        .join('') || '?';

/** A name's tone among `count`: the same for the same name, in every client. */
export function toneIndex(name: string, count: number) {
    let hash = 0;
    for (const char of name) {
        hash = (hash * 31 + char.codePointAt(0)!) | 0;
    }
    return Math.abs(hash) % count;
}

/**
 * Each person's avatar tone in a room among `count`, by id: their name's,
 * but two people with one name get different ones (the next tones along,
 * in the order of their ids), so their avatars differ as well as their ids.
 */
export function personTones(people: Iterable<{ id?: string; name: string }>, count: number): Map<string, number> {
    const byName = new Map<string, Set<string>>();
    for (const { id, name } of people) {
        if (id) {
            byName.set(name, (byName.get(name) ?? new Set()).add(id));
        }
    }
    const tones = new Map<string, number>();
    for (const [name, ids] of byName) {
        [...ids].sort().forEach((id, at) => {
            tones.set(id, (toneIndex(name, count) + at) % count);
        });
    }
    return tones;
}

/**
 * Each active member's name as the room shows it, by id: their name, but
 * two or more active members with one name (`foldedName`: case and
 * spacing aside) each get their place in the order they joined, "Ana
 * Lima · 1", "Ana Lima · 2", so they differ in words, not by avatar
 * color alone. Nothing new about anyone: only the room's join order
 * (`acceptedAt`, else the invite's time, then the id). Someone who
 * leaves takes their number with them: the others' may change.
 */
export function personLabels(
    members: readonly Pick<RoomMemberView, 'userId' | 'name' | 'status' | 'acceptedAt' | 'invitedAt'>[],
): Map<string, string> {
    const byName = new Map<string, typeof members>();
    for (const member of members) {
        if (member.status === 'active') {
            const key = foldedName(member.name);
            byName.set(key, [...(byName.get(key) ?? []), member]);
        }
    }
    const labels = new Map<string, string>();
    for (const same of byName.values()) {
        if (same.length < 2) {
            continue;
        }
        [...same]
            .sort(
                (a, b) =>
                    (a.acceptedAt ?? a.invitedAt) - (b.acceptedAt ?? b.invitedAt) ||
                    (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
            )
            .forEach((member, at) => labels.set(member.userId, `${member.name} · ${at + 1}`));
    }
    return labels;
}
