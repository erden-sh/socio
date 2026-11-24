import { PlugZap } from 'lucide-react';

import { MODULE_IDS } from '@socio/shared/modules';

import type { ClientModule } from '../types';

/** Connected agents (CB-90): everyone's external agents and their grants, for admins. */
export const connectedAgentsModule: ClientModule = {
    id: MODULE_IDS.connectedAgents,
    title: 'Connected agents',
    description: 'External agents, such as Claude Code, that people connected to act for them.',
    icon: PlugZap,
    tone: 'slate',
    order: 73,
    access: 'admin',
    opens: { path: '/admin/agents' },
    sidebar: 'workspace',
};
