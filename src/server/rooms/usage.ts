import { isCycleStop } from '@socio/foundation/cycles/stops';
import {
    ROOM_USAGE_MIN_PEOPLE,
    type CycleStop,
    type RoomCycleUsage,
    type RoomLimits,
    type RoomUsageView,
} from '@socio/shared/rooms/rooms';

import type { WorkCycle } from '../cycles/contract.js';

const DAY = 86_400_000;

/**
 * One cycle as a room's people see it (CB-218): its use against the
 * limits it started with. Its spend only when known and either the
 * workspace's models paid or the reader started it: another member's own
 * subscription is theirs (`private`), never an amount.
 */
export function cycleUsage(cycle: WorkCycle, viewer: string): RoomCycleUsage {
    const mine = cycle.initiator.kind === 'person' && cycle.initiator.id === viewer;
    const theirs = cycle.billing?.kind === 'person' && cycle.billing.userId !== viewer;
    const known = cycle.costKnown && cycle.costUsd !== null;
    const spend = theirs && !mine ? 'private' : known ? 'known' : 'unknown';
    return {
        status: cycle.status,
        mine,
        startedAt: cycle.startedAt,
        elapsedMs: cycle.elapsedMs,
        timeLimitMs: cycle.limits.cycleTimeMs,
        tokensUsed: cycle.tokensUsed,
        tokenLimit: cycle.limits.cycleTokens,
        handoffs: cycle.handoffs,
        handoffLimit: cycle.limits.handoffsPerCycle,
        spend,
        spendUsd: spend === 'known' ? cycle.costUsd : null,
        spendLimitUsd: cycle.limits.cycleSpendUsd,
        stoppedBy: isCycleStop(cycle.endReason) ? cycle.endReason : null,
    };
}

/**
 * A room's use for its people (`GET /api/rooms/:id/usage`, CB-218): the
 * limits in force, the running or last cycle, and the last day's cycles
 * in total, which only show once at least `ROOM_USAGE_MIN_PEOPLE` people
 * started them, so they never show one person's use. No spend in the
 * day's total: some of it may be members' own subscriptions.
 */
export function roomUsage(input: {
    limits: RoomLimits;
    current: WorkCycle | undefined;
    recent: readonly WorkCycle[];
    viewer: string;
    now: number;
}): RoomUsageView {
    const since = input.now - DAY;
    const day = input.recent.filter((cycle) => cycle.startedAt >= since);
    const people = new Set(
        day.flatMap((cycle) => (cycle.initiator.kind === 'person' && cycle.initiator.id ? [cycle.initiator.id] : [])),
    );
    const stopped: Record<CycleStop, number> = {
        deadline: 0,
        tokens: 0,
        handoffs: 0,
        spend: 0,
    };
    for (const cycle of day) {
        if (isCycleStop(cycle.endReason)) {
            stopped[cycle.endReason]++;
        }
    }
    return {
        limits: input.limits,
        current: input.current ? cycleUsage(input.current, input.viewer) : null,
        day:
            people.size >= ROOM_USAGE_MIN_PEOPLE
                ? {
                      since,
                      cycles: day.length,
                      tokens: day.reduce((sum, cycle) => sum + cycle.tokensUsed, 0),
                      stopped,
                  }
                : null,
    };
}
