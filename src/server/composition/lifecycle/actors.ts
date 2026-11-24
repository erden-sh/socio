/**
 * Socio access's boot step. It stays a step the boot calls, not an acquisition
 * on actors' layer scope: the watch starts in phase 5, after the pages are
 * mounted, not when the graph is built, and what stops it is the leader work's
 * own order (`LeaderWork.drain()` hands the context leases over, `stop()` ends
 * the watch), which a finalizer on the runtime's scope would not keep.
 */
import { Context } from 'effect';

import type { AppEdge } from '../../main.js';
import { LegacyActors } from '../actors.js';

/**
 * Socio access (CB-232): every runtime polls revocations and re-checks
 * what it holds open, not only the leader.
 */
export function watchActors(edge: AppEdge) {
    Context.get(edge.services, LegacyActors).watch();
}

/** Actors' step, as lifecycle/index.ts runs it. */
export const actorsLifecycle = { watch: watchActors };
