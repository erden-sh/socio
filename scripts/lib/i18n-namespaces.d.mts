// Types for i18n-namespaces.mjs.
export const NAMESPACE_LIMITS: { label: number; where: number };
export function namespaceTextProblem(
    field: 'label' | 'where',
    text: unknown,
    options?: { required?: boolean },
): string | null;
export function namespaceEntryProblems(entries: unknown, options?: { required?: boolean }): string[];
