import { BookOpen, Plus } from 'lucide-react';

import { MODULE_IDS } from '@socio/shared/modules';

import type { ClientModule } from '../types';

/** Memories: preferences the user shares with their Dots. */
export const memoriesModule: ClientModule = {
    id: MODULE_IDS.memories,
    title: 'Memories',
    description: 'Preferences you choose to share with your socios.',
    icon: BookOpen,
    tone: 'violet',
    order: 40,
    opens: { path: '/memories' },
    sidebar: 'workspace',
    badge: ({ state }) => state.memories.length,
    commands: () => [
        {
            id: 'memories:add',
            label: 'Add memory',
            group: 'Actions',
            keywords: ['new', 'memory', 'preference'],
            icon: Plus,
            run: ({ shell }) => shell.openDialog({ type: 'memory' }),
        },
    ],
};
