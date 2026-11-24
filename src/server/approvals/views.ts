import type { ApprovalsState, ApprovalView } from '@socio/shared/approvals';
import { SOCIO_ACCESS_CAPABILITIES } from '@socio/shared/socio-access';

import type { FlagsShape } from '../flags/contract.js';

import { ApprovalError, type ApprovalsShape, type ApprovalsViewsShape } from './contract.js';

/**
 * The approvals' views, moved from `live/views/approvals.ts` (since
 * deleted: the pages read them through `ApprovalsViews`).
 * Each reads its sources when it is called.
 */

/** What the views read: the approvals and, for the delegated capabilities, the flags. */
export interface ApprovalsViewSources {
    readonly approvals: Pick<ApprovalsShape, 'list' | 'capabilities' | 'policies' | 'auditFor' | 'guidance' | 'get'>;
    readonly flags: Pick<FlagsShape, 'enabled'>;
}

/**
 * `GET /api/approvals`: this user's own approvals only (nobody, admins
 * included, sees another's). `auto`: recent decisions only from requests
 * an auto review saw (`?review=auto`).
 */
export async function approvalsView(
    sources: ApprovalsViewSources,
    userId: string,
    { auto = false }: { auto?: boolean } = {},
): Promise<ApprovalsState> {
    const { approvals } = sources;
    const all = await approvals.list(userId, { limit: 100 });
    const recent = auto ? await approvals.list(userId, { limit: 100, auto: true }) : all;
    // Delegated app access stays out of sight while its flag is off for
    // this person (CB-232).
    const delegated = sources.flags.enabled('socio-actor-access', userId);
    return {
        capabilities: approvals
            .capabilities()
            .filter((item) => delegated || !(Object.values(SOCIO_ACCESS_CAPABILITIES) as string[]).includes(item.id)),
        pending: all.filter((item) => item.status === 'pending'),
        recent: recent.filter((item) => item.status !== 'pending').slice(0, 50),
        policies: await approvals.policies(userId),
        audit: await approvals.auditFor(userId, 100),
        guidance: await approvals.guidance(userId),
    };
}

/** `GET /api/approvals/:id`: one of this user's requests; null otherwise. */
export async function approvalView(
    sources: Pick<ApprovalsViewSources, 'approvals'>,
    id: string,
    userId: string,
): Promise<ApprovalView | null> {
    try {
        return await sources.approvals.get(id, userId);
    } catch (error) {
        if (error instanceof ApprovalError && error.status === 404) {
            return null;
        }
        throw error;
    }
}

/** Both views over the same sources, as the `ApprovalsViews` tag offers them. */
export function approvalsViews(sources: ApprovalsViewSources): ApprovalsViewsShape {
    return {
        approvals: (userId, options) => approvalsView(sources, userId, options),
        approval: (id, userId) => approvalView(sources, id, userId),
    };
}
