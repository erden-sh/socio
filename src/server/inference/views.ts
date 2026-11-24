import type { OperatorInferenceState } from '@socio/shared/inference';

import type { InferenceShape } from './contract.js';

/**
 * Inference's views: moved from the now-deleted live/views/inference.ts (the
 * pages read them through the `InferenceViews` tag).
 */

/**
 * `GET /api/inference` (operators): the backends (keys are write-only and
 * never in it), the default, and the subscriptions users may connect.
 */
export function operatorInferenceView(inference: InferenceShape): Promise<OperatorInferenceState> {
    return inference.operatorState();
}
