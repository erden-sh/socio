// Must stay first: see packages/foundation/src/no-vendor-telemetry.ts.
import '@socio/foundation/no-vendor-telemetry';
import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';

import { filingCause, type GoalOfTask } from '@socio/foundation/issues/filing-cause';
import type { DotTurn } from '@socio/foundation/turns/turn';
import { issueWatchInput, issueWatchPage } from '@socio/shared/issues/board-inputs';

import { IssueError } from './contract.js';
import type { IssueSubscriptions } from './subscriptions.js';

export const ISSUE_WATCH_TOOL_NAMES = [
    'subscribe_to_issues',
    'list_issue_subscriptions',
    'cancel_issue_subscription',
] as const;
export function issueSubscriptionTools(service: IssueSubscriptions, turn: DotTurn, goalOf?: GoalOfTask) {
    if (!turn.dot.issuesAllowed || !['chat', 'scheduled', 'approval'].includes(turn.purpose)) {
        return [];
    }
    const check = () => {
        turn.check();
        if (turn.dot.ownerId && turn.dot.ownerId !== turn.userId) {
            throw new IssueError('This socio acts only for its owner.', 403);
        }
    };
    return [
        defineTool({
            name: 'subscribe_to_issues',
            description:
                'Only when the person explicitly asks, create their one-shot future status subscription for explicit issue keys. Notify once when ALL reach targetStatus. Already-matched issues cause no historical notice: the subscription waits for a later transition. No queries or recurring notifications. It uses their chosen notification channels; manage or cancel it with the subscription tools or Account → Notifications.',
            parameters: issueWatchInput,
            execute: async (input) => {
                check();
                const cause = await filingCause(turn, goalOf);
                check();
                return service.create(turn.userId, input, {
                    sourceKind: 'socio',
                    sourceId: turn.dot.id,
                    threadId: turn.threadId,
                    causeId: cause.causeId,
                });
            },
        }),
        defineTool({
            name: 'list_issue_subscriptions',
            description:
                'List only the current person’s one-shot issue status subscriptions. Follow next offsets until null. Recorded/triggered means the notice was recorded, not proof of device delivery.',
            parameters: issueWatchPage,
            execute: async (input) => {
                check();
                return service.list(turn.userId, input);
            },
        }),
        defineTool({
            name: 'cancel_issue_subscription',
            description:
                'Only when asked, cancel the current person’s pending one-shot issue subscription. A notice already recorded cannot be recalled.',
            parameters: z.object({ subscription: z.uuid() }).strict(),
            execute: async ({ subscription }) => {
                check();
                const cause = await filingCause(turn, goalOf);
                check();
                return service.cancel(turn.userId, subscription, {
                    sourceKind: 'socio',
                    sourceId: turn.dot.id,
                    threadId: turn.threadId,
                    causeId: cause.causeId,
                });
            },
        }),
    ];
}
