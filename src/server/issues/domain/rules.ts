import type { IssuePriority } from '@socio/shared/issues/issue-types';

/** The board's order: critical first (lists sort by it, then by update). */
export const PRIORITY_RANKS: Record<IssuePriority, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
};
