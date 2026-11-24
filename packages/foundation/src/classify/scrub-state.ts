import { scrub } from '../learning/scrub.js';

import { clip } from './clip.js';

/**
 * The state as the model sees it: texts scrubbed and clipped, finite
 * numbers and booleans as they are, anything else null. How the
 * classification seam (CB-198) and Learning's triage (CB-200) prepare what
 * they send a model. Moved from `classify/seam.ts`, which re-exports it.
 */
export function scrubState(
    state: Record<string, unknown>,
    maxChars: number,
): Record<string, string | number | boolean | null> {
    const out: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(state)) {
        if (typeof value === 'string') {
            out[key] = clip(scrub(value), maxChars);
        } else if (typeof value === 'number' && Number.isFinite(value)) {
            out[key] = value;
        } else if (typeof value === 'boolean') {
            out[key] = value;
        } else {
            out[key] = null;
        }
    }
    return out;
}
