import { History } from 'lucide-react';

import { MODULE_IDS } from '@socio/shared/modules';

import type { ClientModule } from '../types';

/** Runs: recent agent turns and their traces; admins see the team's. */
export const runsModule: ClientModule = {
    id: MODULE_IDS.runs,
    title: 'Runs',
    description: 'Recent agent turns across the team, with their errors.',
    memberDescription: 'Your recent turns with socios: how each went, step by step.',
    icon: History,
    tone: 'slate',
    order: 70,
    opens: { path: '/runs' },
    sidebar: 'workspace',
};
