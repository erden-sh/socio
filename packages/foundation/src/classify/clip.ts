/**
 * A text cut to `max` characters, its last one an ellipsis when it was
 * longer: how the classification seam (CB-198) and Learning's triage
 * (CB-200) bound what they send a model. Moved from `classify/seam.ts`,
 * which re-exports it.
 */
export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
