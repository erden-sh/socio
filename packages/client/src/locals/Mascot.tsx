import { characterFor, isLocalId } from '@socio/shared/mascot';

import { LocalAvatar } from './LocalAvatar';
import { RIG_STATES, type RigState } from './rig';

import { cn } from '@/lib/utils';

const rigState = (state: string): RigState =>
    (RIG_STATES as readonly string[]).includes(state) ? (state as RigState) : 'idle';

/** A Dot's Local (locals/), alive in the state the Dot is in. */
export function Mascot({
    state = 'idle',
    small = false,
    identity,
    character,
    name = 'Socio',
    decorative = false,
    className = '',
}: {
    state?: string;
    small?: boolean;
    identity?: string;
    /** The socio's chosen Local (`Dot.character`, CB-256); else its id's. */
    character?: string | null;
    name?: string;
    decorative?: boolean;
    /** Extra classes, e.g. a Tailwind size where a surface sets it. */
    className?: string;
}) {
    // 180 px, or 54 px small, unless `className` sizes it; a paused Dot is
    // washed out.
    return (
        <LocalAvatar
            character={isLocalId(character) ? character : characterFor(identity)}
            state={rigState(state)}
            label={decorative ? undefined : `${name} is ${state}`}
            className={cn(
                'shrink-0 items-center justify-center overflow-visible',
                small ? 'h-13.5 w-13.5' : 'h-45 w-45',
                state === 'paused' && '[filter:saturate(0.5)]',
                className,
            )}
        />
    );
}
