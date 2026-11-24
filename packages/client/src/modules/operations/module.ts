import { Gauge } from 'lucide-react';

import { MODULE_IDS } from '@socio/shared/modules';

import type { ClientModule } from '../types';

import { OPS_HOME } from './sections';

/**
 * Operations (CB-164): how the workspace is used, what fails and what it
 * costs, for admins. The server refuses its API to
 * members on its own (`/api/operations/*`); this hides it from them.
 */
export const operationsModule: ClientModule = {
    id: MODULE_IDS.operations,
    title: 'Operations',
    description: 'How the workspace is used, what fails and what it costs, over time.',
    icon: Gauge,
    tone: 'sky',
    order: 92,
    access: 'admin',
    opens: { path: OPS_HOME },
    sidebar: 'platform',
};
