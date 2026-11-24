import type { ComponentProps, ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/*
 * The Spaces library's and the page view's shared pieces, on the tokens.
 * No data-slot on the frames that hold a page's text (the Space's <main>,
 * the writing layout, the page's column): the legacy resets that give the
 * page's prose its browser defaults stop at data-slot elements.
 */

/**
 * The library's main action (New page, Back to all pages): the ink
 * button, near-black in light and near-white in dark.
 */
export function PagePrimaryButton({ className, ...props }: ComponentProps<typeof Button>) {
    return (
        <Button
            className={cn(
                'h-auto min-h-10.5 gap-2 rounded-[9px] bg-foreground px-4 py-2.5 text-[13px] font-medium text-background hover:bg-foreground/90',
                className,
            )}
            {...props}
        />
    );
}

/**
 * A quiet 40 px icon button of the page chrome (the outline's, the page
 * header's), 44 px tall on phones.
 */
export function PageIconButton({ className, ...props }: ComponentProps<typeof Button>) {
    return (
        <Button
            variant="ghost"
            className={cn(
                'size-10 rounded-lg p-0 text-muted-foreground hover:text-foreground max-[700px]:min-h-11',
                className,
            )}
            {...props}
        />
    );
}

/**
 * A centered notice in place of the library or a page: no pages yet, no
 * match, a page loading, deleted or not found.
 */
export function LibraryEmpty({
    icon,
    title,
    children,
    action,
    ...props
}: Omit<ComponentProps<'div'>, 'title'> & {
    icon?: ReactNode;
    title: string;
    action?: ReactNode;
}) {
    return (
        <div
            data-slot="library-empty"
            className="mx-auto my-[65px] max-w-125 p-7 text-center text-muted-foreground [&>svg]:mx-auto [&>svg]:mb-3.5"
            {...props}
        >
            {icon}
            <h2 className="mt-0 mb-[0.83em] text-xl font-bold tracking-[-0.3px] text-foreground">{title}</h2>
            {children && <p className="mt-0 mb-[1em] text-sm/[1.7]">{children}</p>}
            {action}
        </div>
    );
}
