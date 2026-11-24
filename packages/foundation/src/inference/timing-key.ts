/**
 * The key response-time samples are kept under (the server's
 * `inference/timings.ts`). Moved from there.
 */

/** The fields of a resolved model (`InferenceModel`) the key is made of. */
export interface TimedModel {
    source: { type: 'shared'; backendId: string } | { type: 'byo'; kind: string };
    model: string | null;
}

/** The model a sample belongs to: the backend or kind, and the model id. */
export const timingKey = (model: TimedModel) =>
    model.source.type === 'shared'
        ? `shared:${model.source.backendId}:${model.model ?? ''}`
        : `byo:${model.source.kind}:${model.model ?? ''}`;
