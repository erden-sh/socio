import { ServerCog } from 'lucide-react';

import { MODULE_IDS } from '@socio/shared/modules';
import { isOperator } from '@socio/shared/roles';

import type { ClientModule } from '../types';

/**
 * Platform settings for operators: inference backends and the
 * subscriptions users may connect; in development, a force stop of running
 * work. Hidden for admins and members, whose `/api/inference` and
 * `/api/operator` calls get 403.
 */
export const operatorModule: ClientModule = {
    id: MODULE_IDS.operator,
    title: 'Platform',
    description: 'Inference backends, the subscriptions users may connect, and domains.',
    icon: ServerCog,
    tone: 'indigo',
    order: 95,
    access: ({ workspace }) => isOperator(workspace.user),
    opens: { path: '/settings/operator' },
    sidebar: 'platform',
    launcher: false,
};
