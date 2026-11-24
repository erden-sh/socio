import {
    decidePageReview as decide,
    restorePageReview as restore,
    type PageReviewRequest,
} from '@socio/shared/pages/page-review';

import { api } from '../../lib/api';

/**
 * The web's page-review calls, over its `api`. The decision itself is in
 * shared (pages/page-review), the same for the app.
 */
const request: PageReviewRequest = api;

export function restorePageReview(threadId: string, toolCallId: string) {
    return restore(request, threadId, toolCallId);
}

export function decidePageReview(threadId: string, toolCallId: string, args: unknown, approved: boolean) {
    return decide(request, threadId, toolCallId, args, approved);
}

// In shared now; re-exported here until nothing imports it from this path.
export { matchesReviewedDraft } from '@socio/shared/pages/page-review';
