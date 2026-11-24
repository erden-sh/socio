import { ShieldCheck } from 'lucide-react';

import { MODULE_IDS } from '@socio/shared/modules';

import type { ClientModule } from '../types';

import { DotApprovals } from './DotApprovals';

/**
 * Approvals: what your Dots asked to do and is waiting for you, your
 * decisions, and the approval policy (manual or bypass) per Dot and
 * capability. Telegram notices link to `/approvals/<id>`.
 */
export const approvalsModule: ClientModule = {
    id: MODULE_IDS.approvals,
    title: 'Approvals',
    description: 'What your socios ask to do, and which actions need you.',
    icon: ShieldCheck,
    tone: 'amber',
    order: 46,
    opens: { path: '/approvals' },
    sidebar: 'workspace',
    slots: { 'dot.present': [DotApprovals] },
};
