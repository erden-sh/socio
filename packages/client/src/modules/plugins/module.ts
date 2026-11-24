import { Puzzle } from 'lucide-react';

import { MODULE_IDS } from '@socio/shared/modules';

import type { ClientModule } from '../types';

/**
 * Plugins: features an admin installs on this instance. Nothing is
 * installed until they do, and the catalog is empty unless this instance
 * lists one (docs/PLUGINS.md). Members never see the page.
 */
export const pluginsModule: ClientModule = {
    id: MODULE_IDS.plugins,
    title: 'Plugins',
    description: 'Features installed on this instance. Each one runs as its own service.',
    icon: Puzzle,
    tone: 'violet',
    order: 48,
    access: 'admin',
    opens: { path: '/plugins' },
    sidebar: 'workspace',
};
