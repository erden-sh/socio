import { MODULE_IDS } from '@socio/shared/modules';

import type { ServerModule } from '../modules/contract.js';
import { WorkspaceSettings } from '../settings/contract.js';
import { Audit, People } from '../workspace/contract.js';

import { classifySchema } from './migrations.js';
import { classifyRoutes } from './routes.js';
import { classifyParts } from './service.js';

/**
 * The classification and extraction seam (CB-198): a platform service
 * with its own tables, shared by Operations' failure labels, sessions'
 * intent and themes (CB-199) and Learning's triage (CB-200, which runs on
 * Learning's own tick). Admin-only; it has no
 * page of its own: its settings are cards in Operations → Settings, and
 * its labels are set in Reliability and in Themes' review. Labeling
 * runs on a one-minute tick while an admin has a use on.
 *
 * The seam is the one the app's services hold (`ClassifyHost`): the layer
 * graph's (`layer.ts`), or, on a platform built on its own, its own
 * services' (`classifyParts`).
 */
export const classifyModule: ServerModule = {
    ...classifySchema,
    id: MODULE_IDS.classify,
    access: 'admin',
    // The settings, people and audit are the workspace's
    // (`WorkspaceSettings`, `People`, `Audit`), from the app's services.
    routes: (context) => {
        const { service, audit } = classifyParts(context);
        const { services } = context;
        const people = services.get(People);
        const workspaceAudit = services.get(Audit);
        return classifyRoutes(
            {
                store: services.get(WorkspaceSettings),
                workspace: {
                    users: () => people.users(),
                    audit: (entry) => workspaceAudit.audit(entry),
                },
            },
            service,
            audit,
        );
    },
    // Evaluations a dead process left running end as failed (CB-108: on
    // the leader once no other runtime is alive, never a live one's).
    succeed: (context) => classifyParts(context).service.start(),
    tick: { everyMs: 60_000, run: (context) => classifyParts(context).service.tick() },
    stop: (context) => classifyParts(context).service.stop(),
};
