import { CalendarClock } from 'lucide-react';

import { MODULE_IDS } from '@socio/shared/modules';

import type { ClientModule } from '../types';

import { DotPlans } from './DotPlans';

/**
 * Schedules & jobs: recurring work the user's Dots do for them
 * (schedules that run a Dot turn or a job) and the jobs' code, versions,
 * runs and logs. Each user sees their own; admins also see counts.
 */
export const schedulesModule: ClientModule = {
    id: MODULE_IDS.schedules,
    title: 'Schedules & jobs',
    navLabel: 'Schedules',
    description: 'Recurring work your socios do for you, and the jobs they run.',
    icon: CalendarClock,
    tone: 'violet',
    order: 47,
    opens: { path: '/schedules' },
    sidebar: 'workspace',
    slots: { 'dot.future': [DotPlans] },
};
