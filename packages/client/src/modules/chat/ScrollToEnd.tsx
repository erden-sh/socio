import { ArrowDown } from 'lucide-react';

import type { useStickToBottom } from '../../hooks/use-stick-to-bottom';

import { Button } from '@/components/ui/button';

/**
 * The round ↓ button centered above the composer while the reader is not
 * at the end of the transcript (T3 Code's "Scroll to end"): scrolls there
 * smoothly and follows again.
 */
export function ScrollToEnd({ scroll }: { scroll: Pick<ReturnType<typeof useStickToBottom>, 'atEnd' | 'toEnd'> }) {
    return (
        <div className="relative z-[2] h-0 shrink-0">
            {!scroll.atEnd && (
                <Button
                    type="button"
                    variant="outline"
                    data-slot="scroll-to-end"
                    aria-label="Scroll to end"
                    className="absolute bottom-3 left-1/2 grid size-8.5 -translate-x-1/2 pointer-coarse:after:absolute pointer-coarse:after:-inset-[5px] place-items-center rounded-full bg-background p-0 text-foreground shadow-[0_2px_8px_rgb(0_0_0/0.12)] hover:bg-accent dark:border-border dark:bg-background dark:hover:bg-accent"
                    onClick={() => scroll.toEnd(true)}
                >
                    <ArrowDown size={16} aria-hidden="true" />
                </Button>
            )}
        </div>
    );
}
