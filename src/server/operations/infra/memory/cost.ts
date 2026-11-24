import { bucketStart, bucketStarts } from '@socio/shared/operations/operations';
import {
    CYCLE_LIMITS,
    OPS_COST_ROWS,
    type CycleLimit,
    type OpsCost,
    type OpsCostRow,
    type OpsCycleSummary,
    type OpsRoomCost,
} from '@socio/shared/operations/operations-cost';

import type { OpsScope } from '../../domain/reader.js';
import type { PoolHour } from '../../pricing/pools.js';

import type { CycleFact, TurnFact } from './facts.js';

const tokensOf = (turn: TurnFact) => (turn.inputTokens ?? 0) + (turn.outputTokens ?? 0);

/** Rows by key, the costliest first, as the store's `breakdown` sorts them. */
function breakdown(
    turns: readonly TurnFact[],
    keyOf: (turn: TurnFact) => string | null,
    nameOf: (turn: TurnFact) => string | null = () => null,
): OpsCostRow[] {
    const rows = new Map<string, OpsCostRow>();
    for (const turn of turns) {
        const key = keyOf(turn);
        if (key === null) {
            continue;
        }
        let row = rows.get(key);
        if (!row) {
            rows.set(
                key,
                (row = {
                    key,
                    name: nameOf(turn),
                    turns: 0,
                    tokens: 0,
                    costUsd: 0,
                    unpriced: 0,
                }),
            );
        }
        row.turns++;
        row.tokens += tokensOf(turn);
        row.costUsd += turn.costUsd ?? 0;
        if (turn.costBasis === 'none') {
            row.unpriced++;
        }
    }
    return [...rows.values()]
        .sort((a, b) => b.costUsd - a.costUsd || b.turns - a.turns || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .slice(0, OPS_COST_ROWS);
}

const LIMITS = new Set<string>(CYCLE_LIMITS);
const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Who paid for a turn (CB-218): a person, the workspace, or not recorded. */
const payerOf = (turn: TurnFact) =>
    turn.payerKind === 'workspace' ? 'workspace' : turn.payerKind === 'person' ? (turn.payerId ?? '') : '';

/** Rooms' turns and cycles (CB-218), as the store's `byRoom` answers. */
function roomRows(
    turns: readonly TurnFact[],
    cycles: ReadonlyMap<string, CycleFact>,
    titleOf: (id: string) => string | null,
): OpsRoomCost[] {
    const rooms = new Map<
        string,
        {
            row: OpsRoomCost;
            cycles: Set<string>;
            exhausted: Set<string>;
            people: Set<string>;
            socios: Set<string>;
        }
    >();
    for (const turn of turns) {
        if (turn.containerKind !== 'room') {
            continue;
        }
        let room = rooms.get(turn.threadId);
        if (!room) {
            rooms.set(
                turn.threadId,
                (room = {
                    row: {
                        key: turn.threadId,
                        name: titleOf(turn.threadId),
                        turns: 0,
                        tokens: 0,
                        costUsd: 0,
                        unpriced: 0,
                        cycles: 0,
                        handoffs: 0,
                        exhausted: 0,
                        people: 0,
                        socios: 0,
                    },
                    cycles: new Set(),
                    exhausted: new Set(),
                    people: new Set(),
                    socios: new Set(),
                }),
            );
        }
        const { row } = room;
        row.turns++;
        row.tokens += tokensOf(turn);
        row.costUsd += turn.costUsd ?? 0;
        if (turn.costBasis === 'none') {
            row.unpriced++;
        }
        if ((turn.hop ?? 0) > 0) {
            row.handoffs++;
        }
        if (turn.cycleId) {
            room.cycles.add(turn.cycleId);
            if (LIMITS.has(cycles.get(turn.cycleId)?.endReason ?? '')) {
                room.exhausted.add(turn.cycleId);
            }
        }
        if ((turn.triggerKind ?? 'person') === 'person' && turn.personId) {
            room.people.add(turn.personId);
        }
        if (turn.socioId) {
            room.socios.add(turn.socioId);
        }
    }
    return [...rooms.values()]
        .map(({ row, ...sets }) => ({
            ...row,
            cycles: sets.cycles.size,
            exhausted: sets.exhausted.size,
            people: sets.people.size,
            socios: sets.socios.size,
        }))
        .sort((a, b) => b.costUsd - a.costUsd || b.turns - a.turns || byKey(a.key, b.key))
        .slice(0, OPS_COST_ROWS);
}

/** The window's work cycles (CB-218): those with a step in it. */
function cycleSummary(turns: readonly TurnFact[], cycles: ReadonlyMap<string, CycleFact>): OpsCycleSummary {
    const steps = turns.filter((turn) => turn.cycleId);
    const found = [...new Set(steps.map((turn) => turn.cycleId!))].flatMap((id) => {
        const cycle = cycles.get(id);
        return cycle ? [cycle] : [];
    });
    const ended = found.filter((cycle) => cycle.endedAt !== undefined && cycle.endedAt !== null);
    return {
        cycles: found.length,
        inRooms: found.filter((cycle) => cycle.kind === 'room').length,
        steps: steps.length,
        handoffs: steps.filter((turn) => (turn.hop ?? 0) > 0).length,
        exhausted: Object.fromEntries(
            CYCLE_LIMITS.map((limit) => [limit, found.filter((cycle) => cycle.endReason === limit).length]),
        ) as Record<CycleLimit, number>,
        stopped: found.filter((cycle) => cycle.endReason === 'stopped').length,
        spendUnknown: found.filter((cycle) => cycle.costKnown === false).length,
        runningMs: ended.reduce((sum, cycle) => sum + (cycle.elapsedMs ?? 0), 0),
        wallMs: Math.max(
            0,
            ended.reduce((sum, cycle) => sum + (cycle.endedAt! - cycle.startedAt), 0),
        ),
    };
}

const backendOf = (turn: TurnFact) => turn.costBackend ?? turn.backendKey ?? 'unknown';

/**
 * Cost from facts in memory (CB-195, CB-196), as the store's SQL answers
 * it: `turns` are the window's (filtered), `previous` the period before's.
 */
export function memoryCost(input: {
    scope: OpsScope;
    turns: readonly TurnFact[];
    previous: readonly TurnFact[] | null;
    poolHours: readonly PoolHour[];
    /** The store's oldest fact, for an "All time" window. */
    earliest: number | null;
    /** Work cycles (CB-218), and names the store's dimensions hold. */
    cycles?: readonly CycleFact[];
    personName?: (id: string) => string | null;
    roomTitle?: (id: string) => string | null;
}): OpsCost {
    const { scope, turns } = input;
    const { window } = scope;
    const cycleMap = new Map((input.cycles ?? []).map((cycle) => [cycle.id, cycle]));
    const sum = (list: readonly TurnFact[]) => list.reduce((total, turn) => total + (turn.costUsd ?? 0), 0);
    const pools = new Map<string, OpsCost['pools'][number]>();
    for (const hour of input.poolHours) {
        if ((window.from !== null && hour.hourAt < window.from) || hour.hourAt >= window.to) {
            continue;
        }
        let pool = pools.get(hour.poolId);
        if (!pool) {
            pools.set(
                hour.poolId,
                (pool = {
                    poolId: hour.poolId,
                    costUsd: 0,
                    allocatedUsd: 0,
                    idleUsd: 0,
                    turns: 0,
                }),
            );
        }
        pool.costUsd += hour.costUsd;
        pool.allocatedUsd += hour.allocatedUsd;
        pool.turns += hour.turns;
    }
    for (const pool of pools.values()) {
        pool.idleUsd = Math.max(0, pool.costUsd - pool.allocatedUsd);
    }
    const poolRows = [...pools.values()].sort((a, b) => b.costUsd - a.costUsd || (a.poolId < b.poolId ? -1 : 1));

    const start = window.from ?? input.earliest;
    const starts = start === null ? [] : bucketStarts(start, window.to, window.bucket, window.timeZone);
    const points = new Map(starts.map((at) => [at, { at, priceUsd: 0, poolUsd: 0 }]));
    for (const turn of turns) {
        const point = points.get(bucketStart(turn.startedAt, window.bucket, window.timeZone));
        if (!point) {
            continue;
        }
        if (turn.costBasis === 'price') {
            point.priceUsd += turn.costUsd ?? 0;
        }
        if (turn.costBasis === 'pool') {
            point.poolUsd += turn.costUsd ?? 0;
        }
    }

    const backends = new Map<string, OpsCost['backends'][number]>();
    for (const turn of turns) {
        const key = backendOf(turn);
        let row = backends.get(key);
        if (!row) {
            backends.set(
                key,
                (row = {
                    backend: key,
                    turns: 0,
                    inputTokens: 0,
                    cachedTokens: 0,
                    outputTokens: 0,
                    costUsd: 0,
                    poolUsd: 0,
                    pooledTokens: 0,
                    referenceUsd: null,
                    unpriced: 0,
                }),
            );
        }
        row.turns++;
        row.inputTokens += turn.inputTokens ?? 0;
        row.cachedTokens += turn.cachedTokens ?? 0;
        row.outputTokens += turn.outputTokens ?? 0;
        row.costUsd += turn.costUsd ?? 0;
        if (turn.costBasis === 'pool') {
            row.poolUsd += turn.costUsd ?? 0;
            row.pooledTokens += tokensOf(turn);
        }
        if (turn.refCostUsd !== undefined && turn.refCostUsd !== null) {
            row.referenceUsd = (row.referenceUsd ?? 0) + turn.refCostUsd;
        }
        if (turn.costBasis === 'none') {
            row.unpriced++;
        }
    }

    const unpriced = new Map<string, OpsCost['unpricedModels'][number]>();
    for (const turn of turns) {
        if (turn.costBasis !== 'none' || !turn.model) {
            continue;
        }
        const key = `${turn.model}\u0000${backendOf(turn)}`;
        const row = unpriced.get(key) ?? {
            model: turn.model,
            backend: backendOf(turn),
            turns: 0,
        };
        row.turns++;
        unpriced.set(key, row);
    }
    const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

    return {
        totals: {
            costUsd: sum(turns),
            previousCostUsd: input.previous ? sum(input.previous) : null,
            turns: turns.length,
            priced: turns.filter((turn) => turn.costBasis === 'price').length,
            pooled: turns.filter((turn) => turn.costBasis === 'pool').length,
            unpriced: turns.filter((turn) => turn.costBasis !== 'price' && turn.costBasis !== 'pool').length,
            tokens: turns.reduce((total, turn) => total + tokensOf(turn), 0),
            idleUsd: poolRows.reduce((total, pool) => total + pool.idleUsd, 0),
        },
        series: [...points.values()],
        byModel: breakdown(turns, (turn) => turn.model ?? ''),
        bySocio: breakdown(
            turns,
            (turn) => turn.socioId ?? '',
            (turn) => turn.socioName ?? null,
        ),
        byPerson: breakdown(turns, (turn) => turn.personId ?? null),
        byPayer: breakdown(turns, payerOf, (turn) =>
            turn.payerKind === 'person' && turn.payerId ? (input.personName?.(turn.payerId) ?? null) : null,
        ),
        byRoom: roomRows(turns, cycleMap, input.roomTitle ?? (() => null)),
        cycles: cycleSummary(turns, cycleMap),
        backends: [...backends.values()]
            .sort((a, b) => b.costUsd - a.costUsd || b.turns - a.turns || byText(a.backend, b.backend))
            .slice(0, OPS_COST_ROWS),
        pools: poolRows,
        unpricedModels: [...unpriced.values()]
            .sort((a, b) => b.turns - a.turns || byText(a.model, b.model) || byText(a.backend, b.backend))
            .slice(0, 20),
    };
}
