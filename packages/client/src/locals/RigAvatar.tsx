import { useEffect, useId, useMemo, useRef } from 'react';

import { type LocalId } from '@socio/shared/mascot';

import { Rig, run, scopeIds, type CharacterRig, type RigState } from './rig';

import { cn } from '@/lib/utils';

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * A Local, rigged and alive (rig.ts). The server renders the art at rest;
 * once hydrated the rig takes over, unless the person asked for reduced
 * motion, when it holds the state's still pose.
 */
export function RigAvatar({
    character,
    definition,
    state,
    label,
    className = '',
}: {
    character: LocalId;
    definition: CharacterRig;
    state: RigState;
    /** Read out for the image; none when it's decorative. */
    label?: string;
    className?: string;
}) {
    const id = useId().replace(/[^a-zA-Z0-9]/g, '');
    const html = useMemo(() => scopeIds(definition.svg, `l${id}-`), [definition, id]);
    const ref = useRef<HTMLSpanElement>(null);
    const rig = useRef<Rig | null>(null);
    const stateRef = useRef(state);
    stateRef.current = state;

    useEffect(() => {
        const svg = ref.current?.querySelector('svg');
        if (!svg) {
            return;
        }
        let seed = 0;
        for (const c of id) {
            seed = (seed * 31 + c.charCodeAt(0)) % 997;
        }
        const instance = new Rig(definition, svg, seed);
        instance.setState(stateRef.current);
        rig.current = instance;
        // No animation frames (a test's DOM) or reduced motion: hold still.
        if (definition.static || reducedMotion() || typeof requestAnimationFrame !== 'function') {
            instance.still();
            return () => {
                rig.current = null;
            };
        }
        const observer =
            typeof IntersectionObserver === 'function'
                ? new IntersectionObserver(([entry]) => {
                      instance.visible = entry.isIntersecting;
                  })
                : undefined;
        observer?.observe(svg);
        const stop = run(instance);
        return () => {
            stop();
            observer?.disconnect();
            rig.current = null;
        };
    }, [definition, html, id]);

    useEffect(() => {
        rig.current?.setState(state);
        if (reducedMotion()) {
            rig.current?.still();
        }
    }, [state]);

    return (
        <span
            ref={ref}
            // The art fills the box. Its paper tile is for the brand's pages; in
            // the app the Local stands on the surface it's shown on.
            className={cn(
                'inline-flex [&>svg]:block [&>svg]:h-full [&>svg]:w-full [&_[data-rig=tile]]:hidden',
                className,
            )}
            data-local={character}
            data-state={state}
            role={label ? 'img' : undefined}
            aria-label={label}
            aria-hidden={label ? undefined : true}
            dangerouslySetInnerHTML={{ __html: html }}
        />
    );
}
