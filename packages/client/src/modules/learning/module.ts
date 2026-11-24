import { GraduationCap } from 'lucide-react';

import { MODULE_IDS } from '@socio/shared/modules';

import type { ClientModule } from '../types';

import { ProposalsWidget } from './ProposalsWidget';

/** Learning for admins (review), Skills for members (published skills). */
export const learningModule: ClientModule = {
    id: MODULE_IDS.learning,
    title: 'Learning',
    memberTitle: 'Skills',
    description: 'Review what your socios learn from finished conversations.',
    memberDescription: 'Procedures your socios have learned, reviewed by an admin.',
    icon: GraduationCap,
    tone: 'emerald',
    order: 50,
    opens: { path: '/learning' },
    sidebar: 'workspace',
    slots: { 'home.widgets': [ProposalsWidget] },
};
