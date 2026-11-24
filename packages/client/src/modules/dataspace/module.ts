import { Database } from 'lucide-react';

import { MODULE_IDS } from '@socio/shared/modules';

import type { ClientModule } from '../types';

/**
 * Data: the user's data space. Datasets their Dots keep (scratch and
 * granted), files, grants per Dot, the audit trail, and quotas (admins
 * see everyone's usage, never their data).
 */
export const dataModule: ClientModule = {
    id: MODULE_IDS.data,
    title: 'Data',
    description: 'Datasets and files your socios keep for you, and who may use them.',
    icon: Database,
    tone: 'emerald',
    order: 45,
    opens: { path: '/data' },
    sidebar: 'workspace',
};
