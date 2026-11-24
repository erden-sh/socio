import { Clock3 } from 'lucide-react';

import { MODULE_IDS } from '@socio/shared/modules';

import type { ClientModule } from '../types';

/** Activity: scheduled tasks and their runs. */
export const activityModule: ClientModule = {
    id: MODULE_IDS.activity,
    title: 'Activity',
    navLabel: 'Scheduled & activity',
    description: 'Scheduled tasks and what they did.',
    icon: Clock3,
    tone: 'amber',
    order: 30,
    opens: { path: '/activity' },
    sidebar: 'workspace',
    badge: ({ state }) => state.tasks.length,
};
