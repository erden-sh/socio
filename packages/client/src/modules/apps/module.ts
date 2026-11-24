import { AppWindow } from 'lucide-react';

import { MODULE_IDS } from '@socio/shared/modules';

import type { ClientModule } from '../types';

/**
 * Apps: the mini apps Dots run in their computers, each on its own
 * origin behind platform sign-in. Ephemeral: they live as long as the
 * computer runs them. `/apps/<id>/open` is where an app's origin sends
 * someone to sign in (the launch hand-off).
 */
export const appsModule: ClientModule = {
    id: MODULE_IDS.apps,
    title: 'Apps',
    description: 'Mini apps your socios run for you, on their own addresses.',
    icon: AppWindow,
    tone: 'violet',
    order: 47,
    opens: { path: '/apps' },
    sidebar: 'workspace',
};
