// Must stay first: see packages/foundation/src/no-vendor-telemetry.ts.
import '@socio/foundation/no-vendor-telemetry';
import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';

import type { DotTurn } from '@socio/foundation/turns/turn';

import type { ApprovalsShape } from '../approvals/contract.js';

import { CAPABILITIES_TOOL, type CapabilitiesShape } from './contract.js';

/**
 * `capabilities`: what this Dot can do for this user right now. Every
 * module's registered capabilities with their tools, limits and usage, the
 * user's approval policies for this Dot, its pending approvals and the
 * sections other modules add (`identity` and `requests`).
 */
export function capabilitiesTool(
    registry: Pick<CapabilitiesShape, 'describe'>,
    approvals: ApprovalsShape,
    turn: DotTurn,
    toolNames: () => readonly string[],
) {
    return defineTool({
        name: CAPABILITIES_TOOL,
        description:
            'Find out what you can do for this user right now: your enabled capabilities and their tools, limits and current usage, the approval policy for each action that needs approval, approvals waiting on the user (and recent decisions), and your web identity. Call it when unsure whether you can do something, before telling the user you can’t.',
        parameters: z.object({}),
        execute: async () => {
            turn.check();
            const recent = (await approvals.list(turn.userId, { dotId: turn.dot.id, limit: 20 })).map(
                ({ id, summary, status, decidedVia, outcome, createdAt }) => ({
                    id,
                    summary,
                    status,
                    ...(decidedVia ? { decidedBy: decidedVia } : {}),
                    ...(outcome ? { outcome } : {}),
                    createdAt: new Date(createdAt).toISOString(),
                }),
            );
            // This socio's policies; a capability without one is manual.
            const policies = new Map(
                (await approvals.policies(turn.userId, turn.dot.id)).map((item) => [item.capability, item.policy]),
            );
            return {
                dot: { id: turn.dot.id, name: turn.dot.name },
                actingFor: 'the user of this conversation; everything below is theirs and for them',
                ...(await registry.describe(turn, (capability) => policies.get(capability) ?? 'manual', toolNames())),
                approvalPolicies: {
                    manual: 'the user approves or denies each request',
                    auto: 'an automatic review decides in the user’s place: it may approve, deny, or pass the request to the user',
                    bypass: 'the action runs at once',
                },
                pendingApprovals: recent.filter((item) => item.status === 'pending'),
                recentApprovals: recent.filter((item) => item.status !== 'pending').slice(0, 5),
            };
        },
    });
}
