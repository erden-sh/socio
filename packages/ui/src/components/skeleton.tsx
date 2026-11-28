'use client';

import { cn } from '../utils.js';

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
    return (
        <div
            data-slot="skeleton"
            className={cn('motion-safe:animate-pulse rounded-md bg-accent', className)}
            {...props}
        />
    );
}

export { Skeleton };
