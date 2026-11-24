import { BookOpen, Compass } from 'lucide-react';

import { MODULE_IDS } from '@socio/shared/modules';

import { openGuides } from '../onboarding/events';
import type { ClientModule, SlotProps } from '../types';

import { DropdownMenuItem } from '@/components/ui/dropdown-menu';

function GuidesItem({ close }: SlotProps['account.items']) {
    return (
        <DropdownMenuItem
            onSelect={() => {
                close();
                openGuides();
            }}
        >
            <Compass />
            Getting started &amp; guides
        </DropdownMenuItem>
    );
}
export const helpModule: ClientModule = {
    id: MODULE_IDS.help,
    title: 'Help',
    description: 'Written help and optional product guides.',
    icon: BookOpen,
    tone: 'sky',
    order: 99,
    opens: { path: '/docs' },
    sidebar: 'help',
    launcher: false,
    slots: { 'account.items': [GuidesItem] },
    commands: () => [
        {
            id: 'help:guides',
            label: 'Getting started & guides',
            group: 'Help',
            icon: Compass,
            keywords: ['onboarding', 'tutorial', 'tour', 'restart'],
            run: () => openGuides(),
        },
        {
            id: 'help:getting-started',
            label: 'Guide: Getting started',
            group: 'Help',
            icon: Compass,
            keywords: ['onboarding', 'tour'],
            run: () => openGuides('getting-started'),
        },
    ],
};
