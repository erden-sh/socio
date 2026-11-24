/**
 * Live dictation at shutdown. It stays a step the shutdown calls, not a
 * finalizer on voice's layer scope: the shutdown closes live text at two points
 * of its own order (when the drain starts, and again as the server closes,
 * after the runtime is disposed). The relays are `Dictation`, built once by its
 * leaf step (`composition/app/dictation.ts`).
 */
import { Context } from 'effect';

import type { AppEdge } from '../../main.js';
import { Dictation } from '../../voice/contract.js';

/** Live dictation (CB-222): each composer sends its recording instead. */
export function closeDictation(edge: AppEdge) {
    Context.get(edge.services, Dictation).closeAll();
}

/** Voice's step, as lifecycle/index.ts runs it: live dictation's close. */
export const voiceLifecycle = { closeDictation };
