import type { InferencePurpose } from '@socio/foundation/turns/inference-purpose';

export const PERSONAL_PURPOSES: ReadonlySet<InferencePurpose> = new Set(['chat', 'scheduled', 'approval']);

/** A failure a kind's `connect` reports to the user as is (HTTP `status`). */
export class ByoError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 404 | 409 | 429 | 502 = 400,
    ) {
        super(message);
    }
}
