/**
 * What other features may know of the classification seam (CB-198): its
 * tags, the slices of the classifier and its label store they call, and the
 * plain types around them. It imports only `effect` and `@socio/*`, and
 * holds no logic.
 *
 * The types here moved from `seam.ts` and `infra/sqlite/store.ts`. A use, a
 * call, a label and the `SeamShape` and `LabelsShape` slices moved on to
 * `@socio/foundation/classify/seam`, re-exported here, so Learning, below
 * this folder in the order, names them without it. `Classifier` implements
 * `SeamShape` and `ClassifyStore` implements `LabelsShape`. `layer.ts`
 * provides `Seam` and `Labels`; the composition root builds `ClassifyConfig`
 * from the startup configuration.
 *
 * Not here, on purpose:
 * - `clip` is a pure helper Learning calls: it moved to
 *   `@socio/foundation/classify/clip`.
 * - `scrubState` (Learning calls it too) joined `clip` in
 *   `@socio/foundation/classify/scrub-state`.
 * - No tag for `ClassifyService`: only the classify module and
 *   `composition/learning.ts` use it, and Learning reaches the seam through
 *   `classifier` and `store`, which `Seam` and `Labels` cover. `layer.ts`
 *   implements the tags.
 */
import { Context } from 'effect';

import type { LabelsShape, SeamShape } from '@socio/foundation/classify/seam';
import type { ClassifySettings } from '@socio/shared/classify';
import type { OperationsSettings } from '@socio/shared/operations/operations';

export type {
    Answer,
    CallOptions,
    ClassifyUsage,
    CurrentProvider,
    DecideResult,
    ExtractField,
    ExtractResult,
    LabelsShape,
    NewLabel,
    Question,
    SeamShape,
    StoredLabel,
    Unanswered,
    UseDefinition,
} from '@socio/foundation/classify/seam';

// ── Providers ────────────────────────────────────────────────────────────

/** What a provider is sent: a fixed brief, and the state as untrusted data. */
export interface ProviderRequest {
    use: string;
    system: string;
    user: string;
    maxTokens: number;
    signal: AbortSignal;
}
export interface ProviderReply {
    /** The model's text. */
    text: unknown;
    inputTokens: number | null;
    outputTokens: number | null;
    /** In US dollars, when the provider reports it; null: unknown. */
    costUsd: number | null;
}

/**
 * A model the seam can ask. `version` names what answers (its model, and
 * whatever else changes them): labels and evaluations are kept by it.
 * Undefined while it isn't set up; the seam then goes on to the next.
 */
export interface ClassifyProvider {
    id: string;
    version(): Promise<string | undefined>;
    complete(request: ProviderRequest): Promise<ProviderReply>;
}

// ── Tags ─────────────────────────────────────────────────────────────────

/**
 * The seam's classifier (`Classifier`): the slice Learning's triage and
 * checks call (`SeamShape`, in `@socio/foundation/classify/seam`).
 */
export class Seam extends Context.Service<Seam, SeamShape>()('socio/classify/Seam') {}

/**
 * The seam's labels and call log (`ClassifyStore`): the slice Learning
 * reads and writes (`LabelsShape`, in `@socio/foundation/classify/seam`).
 */
export class Labels extends Context.Service<Labels, LabelsShape>()('socio/classify/Labels') {}

/**
 * What the seam reads from `PlatformConfig`: the environment's per-use
 * settings (`CLASSIFY_*`) and the environment's Operations settings, for
 * the session gap.
 */
export interface ClassifyConfigShape {
    readonly classify?: ClassifySettings;
    readonly operations?: OperationsSettings;
}

export class ClassifyConfig extends Context.Service<ClassifyConfig, ClassifyConfigShape>()(
    'socio/classify/ClassifyConfig',
) {}
