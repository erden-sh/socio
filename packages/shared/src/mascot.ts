/** The Locals: Sebas the stone crab, Manny the manatee, Mingo the flamingo,
 * Rulo the curly-tailed lizard, Lino the rooster, Flake the dolphin, Iggy the
 * iguana, Rosy the roseate spoonbill. The last four ship as static avatars
 * for now (CB-272); animation parity comes later. */
export const LOCALS = ['sebas', 'manny', 'mingo', 'rulo', 'lino', 'flake', 'iggy', 'rosy'] as const;
export type LocalId = (typeof LOCALS)[number];

/** Each Local's name and what it is, for pickers and their labels (CB-256). */
export const LOCAL_NAMES: Record<LocalId, { name: string; kind: string }> = {
    sebas: { name: 'Sebas', kind: 'stone crab' },
    manny: { name: 'Manny', kind: 'manatee' },
    mingo: { name: 'Mingo', kind: 'flamingo' },
    rulo: { name: 'Rulo', kind: 'curly-tailed lizard' },
    lino: { name: 'Lino', kind: 'rooster' },
    flake: { name: 'Flake', kind: 'dolphin' },
    iggy: { name: 'Iggy', kind: 'iguana' },
    rosy: { name: 'Rosy', kind: 'roseate spoonbill' },
};

export const isLocalId = (value: unknown): value is LocalId =>
    typeof value === 'string' && (LOCALS as readonly string[]).includes(value);

/**
 * The original cast (CB-256). Before CB-272 added the Locals,
 * `characterFor` hashed into these four. Keeping this roster frozen lets us
 * restore existing socios whose `character` column was NULL.
 */
export const LEGACY_LOCALS: readonly LocalId[] = ['sebas', 'manny', 'mingo', 'rulo'];

/**
 * A Dot's Local, stable for its id across views and reloads, and the same
 * in notifications (CB-114): `/locals/<local>.png`. A socio nobody chose a
 * character for keeps this one (CB-256).
 */
export function characterFor(identity?: string): LocalId {
    if (!identity) {
        return LOCALS[2];
    }
    let hash = 0;
    for (const character of identity) {
        hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    }
    return LOCALS[hash % LOCALS.length];
}

/**
 * The character assignment an existing socio had before the CB-272 roster
 * expansion (four Locals). Used only by migration 19 to backfill stable
 * values; new code should call `characterOf`/`characterFor`.
 */
export function legacyCharacterFor(identity?: string): LocalId {
    if (!identity) {
        return LEGACY_LOCALS[2];
    }
    let hash = 0;
    for (const character of identity) {
        hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    }
    const local = LEGACY_LOCALS[hash % LEGACY_LOCALS.length];
    return local ?? LEGACY_LOCALS[2];
}

/** A socio's Local: the one chosen for it (CB-256), else its id's. */
export const characterOf = (dot: { id: string; character?: string | null }): LocalId =>
    isLocalId(dot.character) ? dot.character : characterFor(dot.id);

export const dotAvatarPath = (dot: { id: string; character?: string | null }) => `/locals/${characterOf(dot)}.png`;
