import type { LocalId } from '@socio/shared/mascot';

import type { CharacterRig } from '../rig';

import { flake } from './flake';
import { iggy } from './iggy';
import { lino } from './lino';
import { manny } from './manny';
import { mingo } from './mingo';
import { rosy } from './rosy';
import { rulo } from './rulo';
import { sebas } from './sebas';

/** Every Local's rig. */
export const characters: Record<LocalId, CharacterRig> = {
    sebas,
    manny,
    mingo,
    rulo,
    lino,
    flake,
    iggy,
    rosy,
};
