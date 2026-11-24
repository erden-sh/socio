import { LOCAL_NAMES, type LocalId } from '@socio/shared/mascot';

import flake from '../../assets/locals/flake.png';
import iggy from '../../assets/locals/iggy.png';
import lino from '../../assets/locals/lino.png';
import manny from '../../assets/locals/manny.png';
import mingo from '../../assets/locals/mingo.png';
import rosy from '../../assets/locals/rosy.png';
import rulo from '../../assets/locals/rulo.png';
import sebas from '../../assets/locals/sebas.png';

// A socio's picture (owner, 2026-11-10): its Local, the web's
// mascot (`characterOf` in @socio/shared/mascot picks it, the chosen one else
// its id's), as a still picture rendered from the web's art by
// scripts/locals.mts, at 1x, 2x and 3x for 64 pt, the largest an avatar is
// drawn. A Local with no picture here (one shared adds before this build has
// its art) shows its name's initial on a squircle, as every socio did before.

/** Each Local's picture, by id: Metro's asset id in the app. */
export const LOCAL_ART: Readonly<Partial<Record<LocalId, number>>> = {
    sebas,
    manny,
    mingo,
    rulo,
    lino,
    flake,
    iggy,
    rosy,
};

/** The largest size, in points, a Local's picture is drawn at: the pictures are 64 px at 1x. */
export const LOCAL_ART_MAX = 64;

/** What draws a socio: its Local's picture, or the Local's initial when it has none. */
export type SocioPicture<A = number> =
    | { readonly kind: 'art'; readonly local: LocalId; readonly source: A }
    | { readonly kind: 'initial'; readonly local: LocalId; readonly initial: string };

/** A socio's picture for its Local, from `art` (the app's pictures by default). */
export function socioPicture<A = number>(
    local: LocalId,
    art: Readonly<Partial<Record<LocalId, A>>> = LOCAL_ART as Readonly<Partial<Record<LocalId, A>>>,
): SocioPicture<A> {
    const source = art[local];
    if (source !== undefined) {
        return { kind: 'art', local, source };
    }
    const name = LOCAL_NAMES[local]?.name ?? local;
    return { kind: 'initial', local, initial: name.slice(0, 1).toUpperCase() || '?' };
}
