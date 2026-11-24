import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { transaction, writeSoon } from '@socio/data/open';
import type { CodingLimits } from '@socio/shared/coding/coding-gateway';

import type { GatewayLedgerShape, SessionTokens } from '../coding/contract.js';
import type { RuntimeOwnershipShape } from '../runtime/contract.js';

import { LedgerRows, type ReservationRecord, type UsageEntry } from './infra/sqlite/rows.js';
import { STALE_RESERVATION_MS, WINDOW_MS } from './limits.js';

export type { ReservationRecord } from './infra/sqlite/rows.js';

/** Who a request is for, as the ledger counts it. */
export interface LedgerParty {
    sessionId: string;
    personId: string;
    socioId: string;
    grantId: string;
}

export interface ReserveInput extends LedgerParty {
    modelId: string;
    backendId: string;
    /** The prompt's estimate (4 characters a token). */
    promptTokens: number;
    /** What the request asked for, if anything. */
    requestedCompletion?: number;
    /** The model's own output limit. */
    maxOutputTokens: number;
    limits: CodingLimits;
}

/** Why a reservation was refused; each is a 429 at the gateway. */
export type ReserveRefusal =
    | 'session_busy'
    | 'person_busy'
    | 'instance_busy'
    | 'session_budget'
    | 'person_budget'
    | 'socio_budget';

export type ReserveResult =
    | { ok: true; reservation: ReservationRecord; maxCompletionTokens: number }
    | { ok: false; refusal: ReserveRefusal };

/** How a request ended, for its `gateway_usage` row. */
export interface Settlement {
    promptTokens: number;
    completionTokens: number;
    cachedTokens?: number;
    /** The backend sent no usage: counts are estimates. */
    estimated: boolean;
    latencyMs: number;
    /** `ok`, `client_closed`, `revoked`, `upstream_502`, `output_cap`, … */
    status: string;
}

/**
 * Budgets and in-flight counts of the model gateway (CB-239). A request
 * reserves its prompt estimate plus its clamped completion limit against
 * the session's budget and the person's and the socio's rolling 24 hours,
 * all at once, in one transaction that also counts the open reservations
 * against the in-flight caps; so concurrent requests, on either runtime of
 * a deploy, can't each pass a check only one of them fits. It settles to
 * the real usage when the response ends, or to the estimate when it broke.
 *
 * A reservation names the runtime serving it. One whose runtime is no
 * longer alive (released or past its lease) is settled at its estimate
 * before anything is counted, and by the gateway's own sweep, so a crash
 * or a deploy can't keep slots or budget locked. Rows only: nothing here
 * lives in process memory (docs/DATA-LAYER.md).
 */
export class GatewayLedger implements GatewayLedgerShape {
    private rows: LedgerRows;
    private now: () => number;
    constructor(
        private db: DatabaseSync,
        private options: { ownership: RuntimeOwnershipShape; now?: () => number },
    ) {
        this.rows = new LedgerRows(db);
        this.now = options.now ?? Date.now;
    }

    /**
     * Inside a transaction: dead runtimes' reservations, and any past the
     * upstream time limit on a live one (its settle failed),
     * settled at their estimate.
     */
    private settleOrphansWithin(now: number) {
        let settled = 0;
        for (const [runtimeId, reservations] of this.rows.reservationsByRuntime()) {
            const dead = !this.options.ownership.instanceAlive(runtimeId, now);
            for (const reservation of reservations) {
                if (!dead && now - reservation.createdAt <= STALE_RESERVATION_MS) {
                    continue;
                }
                if (this.rows.deleteReservation(reservation.id)) {
                    this.rows.insertUsage({
                        ...this.usageOf(reservation, now),
                        promptTokens: reservation.promptTokens,
                        completionTokens: reservation.completionTokens,
                        cachedTokens: 0,
                        estimated: true,
                        latencyMs: now - reservation.createdAt,
                        status: dead ? 'orphaned' : 'stale',
                    });
                    settled++;
                }
            }
        }
        return settled;
    }

    private usageOf(
        reservation: ReservationRecord,
        at: number,
    ): Omit<UsageEntry, 'promptTokens' | 'completionTokens' | 'cachedTokens' | 'estimated' | 'latencyMs' | 'status'> {
        return {
            at,
            sessionId: reservation.sessionId,
            personId: reservation.personId,
            socioId: reservation.socioId,
            grantId: reservation.grantId,
            modelId: reservation.modelId,
            backendId: reservation.backendId,
        };
    }

    /** Settles reservations whose runtime is gone, or stuck (every runtime's sweep). */
    settleOrphans() {
        if (!this.db.isOpen) {
            return Promise.resolve(0);
        }
        return transaction(this.db, 'settle orphaned gateway reservations', () => this.settleOrphansWithin(this.now()));
    }

    /**
     * Reserves a request against every cap and budget at once, or says
     * which one it doesn't fit. The completion limit is clamped to the
     * model's limit, the request's own, and what every budget has left.
     */
    reserve(input: ReserveInput): Promise<ReserveResult> {
        return transaction(this.db, 'reserve gateway request', () => {
            const now = this.now();
            this.settleOrphansWithin(now);
            const { limits } = input;
            if (this.rows.inFlight({ sessionId: input.sessionId }) >= limits.inFlightPerSession) {
                return { ok: false, refusal: 'session_busy' } as const;
            }
            if (this.rows.inFlight({ personId: input.personId }) >= limits.inFlightPerPerson) {
                return { ok: false, refusal: 'person_busy' } as const;
            }
            if (this.rows.inFlight() >= limits.inFlightPerInstance) {
                return { ok: false, refusal: 'instance_busy' } as const;
            }
            const since = now - WINDOW_MS;
            const left = (scope: Parameters<LedgerRows['tokens']>[0], budget: number) => {
                const { settled, reserved } = this.rows.tokens(scope);
                return budget - settled - reserved;
            };
            const budgets: [ReserveRefusal, number][] = [
                ['session_budget', left({ sessionId: input.sessionId }, limits.sessionTokens)],
                ['person_budget', left({ personId: input.personId, since }, limits.personDailyTokens)],
                ['socio_budget', left({ socioId: input.socioId, since }, limits.socioDailyTokens)],
            ];
            const [tightest, room] = budgets.reduce((a, b) => (b[1] < a[1] ? b : a));
            const completion = Math.min(
                input.maxOutputTokens,
                input.requestedCompletion ?? input.maxOutputTokens,
                room - input.promptTokens,
            );
            // Not even one token of answer fits: the tightest budget is spent.
            if (completion < 1) {
                return { ok: false, refusal: tightest } as const;
            }
            const reservation: ReservationRecord = {
                id: randomUUID(),
                sessionId: input.sessionId,
                personId: input.personId,
                socioId: input.socioId,
                grantId: input.grantId,
                modelId: input.modelId,
                backendId: input.backendId,
                runtimeId: this.options.ownership.session.id,
                promptTokens: input.promptTokens,
                completionTokens: completion,
                createdAt: now,
            };
            this.rows.insertReservation(reservation);
            return {
                ok: true,
                reservation,
                maxCompletionTokens: completion,
            } as const;
        });
    }

    /**
     * The request ended: its reservation becomes a usage row. Idempotent: a
     * reservation already settled (by an orphan sweep, or twice) is left.
     */
    settle(reservation: ReservationRecord, outcome: Settlement) {
        if (!this.db.isOpen) {
            return Promise.resolve(false);
        }
        return transaction(this.db, 'settle gateway request', () => {
            if (!this.rows.deleteReservation(reservation.id)) {
                return false;
            }
            this.rows.insertUsage({
                ...this.usageOf(reservation, this.now()),
                promptTokens: Math.max(0, Math.round(outcome.promptTokens)),
                completionTokens: Math.max(0, Math.round(outcome.completionTokens)),
                cachedTokens: Math.max(0, Math.round(outcome.cachedTokens ?? 0)),
                estimated: outcome.estimated,
                latencyMs: Math.max(0, Math.round(outcome.latencyMs)),
                status: outcome.status.slice(0, 32),
            });
            return true;
        });
    }

    /** A session's tokens used and held now (`coding_status`). */
    session(sessionId: string, limits: CodingLimits): SessionTokens {
        const { settled, reserved } = this.rows.tokens({ sessionId });
        return {
            used: settled,
            inFlight: this.rows.inFlight({ sessionId }),
            reserved,
            left: Math.max(0, limits.sessionTokens - settled - reserved),
            dropped: this.rows.droppedFields(sessionId),
        };
    }

    /** The last 24 hours by person, socio and model (Settings → Coding). */
    summary() {
        const since = this.now() - WINDOW_MS;
        return {
            persons: this.rows.summary('personId', since),
            socios: this.rows.summary('socioId', since),
            models: this.rows.summary('modelId', since),
        };
    }

    /**
     * Field names the gateway dropped from a session's request: names only,
     * never values, at most 50 distinct per session.
     */
    noteDropped(sessionId: string, fields: readonly string[]) {
        if (!fields.length || !this.db.isOpen) {
            return;
        }
        const at = this.now();
        writeSoon(this.db, 'note dropped gateway fields', () => {
            const room = 50 - this.rows.distinctDropped(sessionId);
            const known = new Set(this.rows.droppedFields(sessionId).map((entry) => entry.field));
            const fresh = fields.filter((field) => !known.has(field));
            this.rows.noteDropped(
                sessionId,
                [...fields.filter((field) => known.has(field)), ...fresh.slice(0, Math.max(0, room))],
                at,
            );
        });
    }
}
