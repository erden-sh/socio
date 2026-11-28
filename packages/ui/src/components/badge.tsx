'use client';

import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import * as React from 'react';

import { cn } from '../utils.js';

const badgeVariants = cva(
    'inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-[background-color,border-color,color] duration-150 ease-out motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring aria-invalid:border-destructive [&>svg]:pointer-events-none [&>svg]:size-3',
    {
        variants: {
            variant: {
                default: 'bg-primary text-primary-foreground [a&]:hover:bg-primary-hover',
                secondary: 'bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90',
                destructive: 'bg-destructive text-white dark:bg-destructive/60 [a&]:hover:bg-destructive/90',
                outline: 'border-border text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
                ghost: '[a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
                link: 'text-primary underline-offset-4 [a&]:hover:underline',
                success: 'bg-(--status-success-bg) text-(--status-success-fg)',
                warning: 'bg-(--status-warning-bg) text-(--status-warning-fg)',
                info: 'bg-accent text-accent-foreground',
            },
        },
        compoundVariants: [
            {
                variant: ['success', 'warning', 'info'],
                class: 'rounded-[6px] px-1.5 py-0.5 text-[11px] font-semibold before:size-1.5 before:rounded-full before:bg-current forced-colors:border-current',
            },
        ],
        defaultVariants: {
            variant: 'default',
        },
    },
);

function Badge({
    className,
    variant = 'default',
    asChild = false,
    ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
    const Comp = asChild ? Slot.Root : 'span';

    return (
        <Comp
            data-slot="badge"
            data-variant={variant}
            className={cn(badgeVariants({ variant }), className)}
            {...props}
        />
    );
}

export { Badge, badgeVariants };
