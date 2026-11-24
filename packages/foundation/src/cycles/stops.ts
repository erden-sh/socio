import type { CycleStop } from '@socio/shared/rooms/rooms';

/**
 * Whether a work cycle's end reason is a limit that stopped it (CB-211):
 * its time, tokens, handoffs or spend. Moved from
 * `cycles/domain/repositories.ts`, which re-exports it.
 */
export const isCycleStop = (reason: unknown): reason is CycleStop =>
    reason === 'deadline' || reason === 'tokens' || reason === 'handoffs' || reason === 'spend';
