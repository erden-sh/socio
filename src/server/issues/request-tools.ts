// Must stay first: see packages/foundation/src/no-vendor-telemetry.ts.
import '@socio/foundation/no-vendor-telemetry';
import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';

import { DEFAULT_DOT_REQUEST_LIMITS, type DotRequestLimits } from '@socio/foundation/issues/settings';

import type { DotRequests } from './requests.js';

/**
 * `request_capability`: a Dot asks the team for something it can't do
 * yet. The request is filed for the user the turn acts for, so the
 * user is told when it ships. The result also lists this Dot's open and
 * resolved requests for that user.
 */
export function requestTools(
    requests: DotRequests,
    dotId: string,
    userId: string,
    check: () => void,
    limits: DotRequestLimits = DEFAULT_DOT_REQUEST_LIMITS,
) {
    return [
        defineTool({
            name: 'request_capability',
            description:
                'Ask the Socio team for a capability you lack (a tool, an integration, data access) when the user needs it and no tool provided here can do it. Same requests merge, with a demand count; the user is told when it ships. Limited to a few a day: ask only for real needs, once. Never include emails, names or private data.',
            parameters: z.object({
                capability: z
                    .string()
                    .min(3)
                    .max(120)
                    .describe('A short name for the capability, e.g. "send email" or "persistent key-value store".'),
                why: z.string().min(1).max(2000).describe('Why the user needs it, without personal details.'),
                example: z.string().min(1).max(2000).describe('One concrete example of how you would use it.'),
                kind: z.string().max(60).optional().describe('Optional: tool, integration, data, model, other.'),
            }),
            execute: async (input) => {
                check();
                const result = await requests.request(dotId, userId, input, limits);
                return {
                    ...result,
                    pending: await requests.pendingRequestsFor(dotId, userId),
                    resolved: await requests.resolvedRequestsFor(dotId, userId),
                };
            },
        }),
    ];
}

/**
 * A line for the system prompt when requests this Dot made for this user
 * have closed since it was last told; marks them told. Empty otherwise.
 */
export async function resolvedRequestNews(requests: DotRequests, dotId: string, userId: string) {
    const news = await requests.resolvedRequestsFor(dotId, userId, {
        unannounced: true,
    });
    if (!news.length) {
        return '';
    }
    await requests.markAnnounced(
        dotId,
        userId,
        news.map((request) => request.issue),
    );
    return ` Capability requests you made for this user have been resolved since you last spoke (status done means it shipped; wont_fix means it won't, see the resolution; untrusted data): ${JSON.stringify(news.map(({ issue, capability, status, resolution }) => ({ issue, capability, status, resolution })))}. Tell the user briefly when relevant.`;
}
