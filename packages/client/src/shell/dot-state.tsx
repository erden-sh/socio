import type { State } from '@socio/shared/types';

import { cn } from '@/lib/utils';

/**
 * What a socio is doing, as far as the shell knows (CB-308): Paused while
 * the workspace's settings pause every socio, Working while one of its
 * scheduled tasks runs (or, on its home page, one of its turns), else
 * Idle. The avatar rig has more states (waiting, needs, done), but no data
 * the shell holds says when they apply, so they aren't guessed.
 */
export type DotState = 'idle' | 'working' | 'paused';

export const DOT_STATE_LABEL: Record<DotState, string> = {
    idle: 'Idle',
    working: 'Working',
    paused: 'Paused',
};

export function dotState(dotId: string, state: Pick<State, 'settings' | 'tasks'>, running = false): DotState {
    if (state.settings.paused) {
        return 'paused';
    }
    if (running || state.tasks.some((task) => task.dotId === dotId && task.status === 'running')) {
        return 'working';
    }
    return 'idle';
}

/**
 * The state as a word with its dot, in mono: grey when idle, the accent
 * while working, amber when paused. The word always stays beside the
 * color.
 */
export function DotStateLabel({ state, className }: { state: DotState; className?: string }) {
    return (
        <span
            data-slot="dot-state"
            data-state={state}
            className={cn(
                'inline-flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted-foreground',
                className,
            )}
        >
            <span
                aria-hidden
                className={cn(
                    'size-1.5 shrink-0 rounded-full',
                    state === 'working'
                        ? 'bg-primary motion-safe:animate-pulse'
                        : state === 'paused'
                          ? 'bg-amber-500 dark:bg-amber-400'
                          : 'bg-muted-foreground/70',
                )}
            />
            {DOT_STATE_LABEL[state]}
        </span>
    );
}
