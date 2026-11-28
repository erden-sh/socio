'use client';

import type { ComponentProps, ReactElement, ReactNode } from 'react';

import { CommandDialog, CommandEmpty, CommandInput, CommandList } from './command.js';

export type QuickActionsProps = Pick<ComponentProps<typeof CommandDialog>, 'open' | 'onOpenChange' | 'commandProps'> & {
    trigger: ReactElement;
    title: string;
    description: string;
    searchLabel: string;
    placeholder?: string;
    emptyMessage: ReactNode;
    children: ReactNode;
};

/** A searchable dialog. The host supplies command groups, actions, and their labels. */
export function QuickActions({
    trigger,
    title,
    description,
    searchLabel,
    placeholder = searchLabel,
    emptyMessage,
    children,
    ...dialog
}: QuickActionsProps) {
    return (
        <CommandDialog trigger={trigger} title={title} description={description} {...dialog}>
            <CommandInput aria-label={searchLabel} placeholder={placeholder} className="pr-8" />
            <CommandList className="p-2">
                <CommandEmpty>{emptyMessage}</CommandEmpty>
                {children}
            </CommandList>
        </CommandDialog>
    );
}
