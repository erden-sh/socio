'use client';

import type { ComponentProps, ReactElement, ReactNode } from 'react';

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from './sheet.js';

type ReviewState =
    | { state: 'ready'; stateMessage?: never }
    | { state: 'loading' | 'partial' | 'error'; stateMessage: ReactNode };

export type AccessReviewProps = Pick<ComponentProps<typeof Sheet>, 'open' | 'onOpenChange'> &
    ReviewState & {
        trigger: ReactElement;
        title: string;
        description: string;
        children?: ReactNode;
    };

/** A review panel for content and permission-aware actions supplied by the host. */
export function AccessReview({
    trigger,
    title,
    description,
    state,
    stateMessage,
    children,
    ...sheet
}: AccessReviewProps) {
    return (
        <Sheet {...sheet}>
            <SheetTrigger asChild>{trigger}</SheetTrigger>
            <SheetContent>
                <SheetHeader>
                    <SheetTitle>{title}</SheetTitle>
                    <SheetDescription>{description}</SheetDescription>
                </SheetHeader>
                <div className="grid min-h-0 gap-2 overflow-y-auto px-4 pb-4" data-state={state}>
                    {state !== 'ready' && <div role={state === 'error' ? 'alert' : 'status'}>{stateMessage}</div>}
                    {children}
                </div>
            </SheetContent>
        </Sheet>
    );
}
