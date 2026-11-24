/** Inference's boot step: the bring-your-own kinds, where the process entry registered them. */
import { Context } from 'effect';

import { registerInferenceKinds as registerKinds } from '../../inference/kinds.js';
import type { AppEdge } from '../../main.js';
import { LegacyInference } from '../inference.js';

export function registerInferenceKinds(edge: AppEdge, env: Record<string, string | undefined>) {
    registerKinds(Context.get(edge.services, LegacyInference), env);
}

/** Inference's step, as lifecycle/index.ts runs it: its kinds' registration. */
export const inferenceLifecycle = { registerKinds: registerInferenceKinds };
