import { useLayoutEffect, useRef } from 'react';

import { phaseElapsed, phaseHint, phaseLabel, type RunPhase } from '@socio/shared/runs/run-phase';

import { shimmer } from '../../lib/shimmer';

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * The running turn's one status line, at the end of the transcript (T3
 * Code's working row): "Waiting for ChatGPT · 4 s", "Ada is thinking · 6 s".
 * The label shimmers (CSS only, still with reduced motion). The clock is
 * written into the DOM once a second through a ref, so the chat does not
 * re-render as it ticks; a new phase re-renders. Screen readers hear the
 * label when the phase changes, never the clock. The usual wait and the
 * prompt's size are in the tooltip.
 */
export function RunStatus({ phase, dotName }: { phase: RunPhase; dotName: string }) {
    const clock = useRef<HTMLSpanElement>(null);
    // Before paint, so a new phase never shows the last one's clock.
    useLayoutEffect(() => {
        const tick = () => {
            if (clock.current) {
                clock.current.textContent = phaseElapsed(phase, Math.max(Date.now(), phase.since));
            }
        };
        tick();
        const timer = window.setInterval(tick, 1000);
        return () => window.clearInterval(timer);
    }, [phase]);
    const hint = phaseHint(phase);
    // The same elements with or without a hint, so a phase change keeps them.
    return (
        <TooltipProvider delayDuration={300}>
            <Tooltip open={hint ? undefined : false}>
                <TooltipTrigger asChild>
                    <div
                        className="max-w-full self-start truncate rounded-[4px] text-[13px] leading-[1.5] text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        data-slot="run-phase"
                        data-phase={phase.kind}
                        tabIndex={hint ? 0 : undefined}
                    >
                        <span className={shimmer} role="status">
                            {phaseLabel(phase, dotName)}
                        </span>
                        <span ref={clock} aria-hidden="true" className="tabular-nums" data-slot="run-clock" />
                    </div>
                </TooltipTrigger>
                {hint && (
                    <TooltipContent side="top" align="start">
                        {hint}
                    </TooltipContent>
                )}
            </Tooltip>
        </TooltipProvider>
    );
}
