import { lazy, Suspense, type ComponentProps } from 'react';

import type { LocalId } from '@socio/shared/mascot';

import { importOrReload } from '../shell/chunk-reload';

import type { CharacterRig } from './rig';
import { RigAvatar } from './RigAvatar';

type Props = Omit<ComponentProps<typeof RigAvatar>, 'definition'>;
const view = (load: () => Promise<CharacterRig>) =>
    lazy(async () => {
        const definition = await importOrReload(load);
        return {
            default: (props: Props) => <RigAvatar {...props} definition={definition} />,
        };
    });
// Only the chosen character's art loads, rather than all eight SVGs on every
// page. Suspense also streams the art from SSR with the page's nonce.
const avatars: Record<LocalId, ReturnType<typeof view>> = {
    sebas: view(() => import('./characters/sebas').then((m) => m.sebas)),
    manny: view(() => import('./characters/manny').then((m) => m.manny)),
    mingo: view(() => import('./characters/mingo').then((m) => m.mingo)),
    rulo: view(() => import('./characters/rulo').then((m) => m.rulo)),
    lino: view(() => import('./characters/lino').then((m) => m.lino)),
    flake: view(() => import('./characters/flake').then((m) => m.flake)),
    iggy: view(() => import('./characters/iggy').then((m) => m.iggy)),
    rosy: view(() => import('./characters/rosy').then((m) => m.rosy)),
};
export function LocalAvatar(props: Props) {
    const Avatar = avatars[props.character];
    return (
        <Suspense
            fallback={
                <span
                    className={props.className}
                    data-local={props.character}
                    data-state={props.state}
                    role={props.label ? 'img' : undefined}
                    aria-label={props.label}
                    aria-hidden={props.label ? undefined : true}
                />
            }
        >
            <Avatar {...props} />
        </Suspense>
    );
}
