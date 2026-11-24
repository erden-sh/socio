import type { ModelChoice } from '@socio/shared/inference';

/** A stored `ModelChoice` (JSON), or null. */
export function choiceOf(value: unknown): ModelChoice | null {
    if (typeof value !== 'string' || !value) {
        return null;
    }
    try {
        return JSON.parse(value) as ModelChoice;
    } catch {
        return null;
    }
}
export const choiceText = (choice: ModelChoice | null | undefined) => (choice ? JSON.stringify(choice) : null);
