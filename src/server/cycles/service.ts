import { randomUUID } from 'node:crypto';

import type { TurnFailure } from '@socio/foundation/observability/failures';
import {
    conversationShape,
    cycleExhausted,
    effectiveRoomLimits,
    handOff,
    raisedRoomLimits,
    roomAllows,
    startTurn,
    withinRoomRate,
    type BillingPrincipal,
    type ConversationKind,
    type CycleStop,
    type RoomLimits,
    type RoomSocioStatus,
    type TurnContext,
    type TurnStart,
} from '@socio/shared/rooms/rooms';
import type { RunActor, RunTrace, TraceCycle } from '@socio/shared/runs/run-trace';
import type { AgentRunStatus } from '@socio/shared/types';

import {
    CYCLE_FAILURES,
    CycleLimitError,
    type CycleAdmission as AdmissionOf,
    type CycleConversation,
    type CycleEndReason,
    type CycleHold,
    type CycleLedger,
    type CycleRequest,
    type CycleRequestResult,
    type CycleRoomHooks,
    type CycleSocio,
    type CyclesShape,
    type CycleStepShape,
    type CycleUpkeepShape,
    type WorkCycle,
} from './contract.js';
import type { CycleRepositories, WorkCyclePatch } from './domain/repositories.js';

export interface WorkCyclesOptions {
    conversation: (id: string) => CycleConversation | undefined;
    socio: (id: string) => CycleSocio | undefined;
    /** The workspace's limits in force now (`cycleLimits`). */
    limits: () => RoomLimits;
    now?: () => number;
    log?: (line: string) => void;
}

/** Whether a step may run, and the step it runs as (`begin`). */
export type CycleAdmission = AdmissionOf<CycleStep>;

/** How long a cycle may wait for its next step before it ends (`expired`). */
export const CYCLE_WAIT_MS = 7 * 24 * 60 * 60_000;
/** How long submissions are kept for the rate limit's window (and margin). */
const SUBMISSION_KEEP_MS = 60 * 60_000;

/**
 * Work cycles (CB-211): every step of work in
 * a conversation runs in one, which `begin` opens, or carries on, as the
 * runner starts the step, and `end` settles as it ends. One cycle runs at
 * a time per conversation (its lease); a person's messages are limited per
 * minute; each cycle is bound by its time, tokens, handoffs and, where the
 * provider reports cost, spend, all from the limits in force when it
 * started. Everything is stored as it happens, so a restart neither loses
 * what a cycle used nor runs the same message again from nothing.
 */
export class WorkCycles implements CyclesShape, CycleUpkeepShape {
    /** Set by the rooms module once rooms exist. */
    rooms: CycleRoomHooks = {};
    /**
     * Whether a step left work its cycle carries on after (CB-209: approvals
     * waiting for their person, or decided and not yet carried on): set by
     * the platform. Such a step's cycle waits, so the decision carries on in
     * it, with what is left of its budget, rather than in a fresh one.
     */
    awaiting?: (conversationId: string, runId: string) => Promise<boolean>;
    private now: () => number;
    /** The start's reconciliation (`recover`): steps begin after it. */
    private recovering?: Promise<unknown>;
    constructor(
        /** One synchronous transaction, queued behind any unit of work. */
        private transact: <T>(label: string, work: () => T) => Promise<T>,
        private repos: CycleRepositories,
        private options: WorkCyclesOptions,
    ) {
        this.now = options.now ?? Date.now;
    }

    private kindOf(conversation: CycleConversation): ConversationKind {
        return conversation.kind ?? 'private';
    }

    /** What a room's rules need, read before a transaction (rooms are async). */
    private async roomFacts(conversation: CycleConversation, userId?: string, dotId?: string) {
        if (this.kindOf(conversation) !== 'room') {
            return {};
        }
        return {
            limits: await this.rooms.limits?.(conversation.id),
            member: userId ? await this.rooms.member?.(conversation.id, userId) : undefined,
            socio: dotId ? await this.rooms.socio?.(conversation.id, dotId) : undefined,
        };
    }

    /** The limits a conversation's cycles start with now. */
    async limitsFor(conversationId: string): Promise<RoomLimits> {
        const conversation = this.options.conversation(conversationId);
        return this.limitsOf(conversation && (await this.roomFacts(conversation)).limits);
    }
    private limitsOf(room: Partial<RoomLimits> | undefined) {
        const workspace = this.options.limits();
        return room ? effectiveRoomLimits(workspace, room) : workspace;
    }

    /**
     * A room admin's change to their room's limits, checked: the fields it
     * would raise above the workspace's are refused (room admins can only
     * lower). Rooms store an accepted change (CB-208).
     */
    checkRoomLimits(change: Partial<RoomLimits>) {
        const raised = raisedRoomLimits(this.options.limits(), change);
        return raised.length ? { ok: false as const, raised } : { ok: true as const };
    }

    /**
     * At start: steps a stopped process left running are over. Each cycle
     * waits for its next step with what it used counted: its reserved
     * tokens as used, and the time its step ran until it was last stored.
     * The same message carries it on, from there; it never starts again.
     * A step whose run is still `alive` (another runtime's, during a
     * start-first deploy, CB-108) is left running: its own end settles it.
     */
    recover(alive?: (runId: string) => boolean): Promise<number> {
        const recovering = this.transact('recover work cycles', () => {
            const now = this.now();
            const open = this.repos.cycles.allRunning().filter((cycle) => !(cycle.runId && alive?.(cycle.runId)));
            for (const cycle of open) {
                this.park(cycle, now);
            }
            return open.length;
        });
        this.recovering = recovering.catch(() => undefined);
        return recovering.then((count) => {
            if (count) {
                this.options.log?.(
                    `Work cycles: ${count} left running by the last process now wait for their next step.`,
                );
            }
            return count;
        });
    }

    /** A cycle whose step is gone, as waiting, its reservations counted. */
    private park(cycle: WorkCycle, now: number) {
        const ran = cycle.stepStartedAt ? Math.max(0, cycle.updatedAt - cycle.stepStartedAt) : 0;
        this.repos.cycles.update(cycle.id, {
            status: 'waiting',
            runId: null,
            elapsedMs: cycle.elapsedMs + ran,
            tokensUsed: cycle.tokensUsed + cycle.tokensReserved,
            tokensReserved: 0,
            stepStartedAt: null,
            deadlineAt: null,
            updatedAt: now,
        });
    }

    /** Whether one more message fits now (the caller's transaction). */
    private fits(conversationId: string, limits: RoomLimits, now: number) {
        return withinRoomRate(
            this.repos.submissions.since(conversationId, now - 60_000),
            now,
            limits.messagesPerMinute,
        );
    }

    /** Whether the conversation takes another message this minute (no record). */
    async withinRate(conversationId: string) {
        const limits = await this.limitsFor(conversationId);
        return this.fits(conversationId, limits, this.now());
    }

    /**
     * Counts a message for the conversation's rate limit, if it fits: the
     * check and the record are one transaction, so concurrent messages
     * can't both take the last place. Whether it fit.
     */
    async submit(conversationId: string, actorId: string | null) {
        const limits = await this.limitsFor(conversationId);
        return this.transact('submit message', () => {
            const now = this.now();
            if (!this.fits(conversationId, limits, now)) {
                return false;
            }
            this.repos.submissions.add(conversationId, actorId, now);
            return true;
        });
    }

    /**
     * Opens or carries on the cycle a step runs in, holding the
     * conversation's lease; or says why the step may not run (shown as its
     * RUN_ERROR). A conversation that isn't bound has no cycle: its step
     * fails on its own.
     */
    async begin(request: CycleRequest): Promise<CycleAdmission> {
        await this.recovering;
        const conversation = this.options.conversation(request.conversationId);
        if (!conversation) {
            return { ok: true };
        }
        const trigger: RunActor = request.trigger ?? { kind: 'system' };
        const room = await this.roomFacts(
            conversation,
            trigger.kind === 'person' ? trigger.id : undefined,
            request.dotId,
        );
        return this.transact('begin work cycle', () => this.admit(request, conversation, trigger, room));
    }

    private admit(
        request: CycleRequest,
        conversation: CycleConversation,
        trigger: RunActor,
        room: Awaited<ReturnType<WorkCycles['roomFacts']>>,
    ): CycleAdmission {
        const now = this.now();
        const kind = this.kindOf(conversation);
        const socio = this.options.socio(request.dotId);
        // In a room the person who sent it, never the room's sentinel owner
        // (CB-208); else the chat's owner.
        const actingUserId =
            request.actingUserId ??
            (kind === 'room' && trigger.kind === 'person' && trigger.id ? trigger.id : conversation.ownerId);
        // The runner runs one step per conversation: a step still marked
        // running here is one a failure left (its end not stored). It waits,
        // counted, as after a restart.
        const stale = this.repos.cycles.running(conversation.id);
        if (stale) {
            this.park(stale, now);
        }
        // Read after the lease is cleared: a stale step's cycle now waits.
        const carried =
            request.cycleId !== undefined
                ? this.repos.cycles.byId(request.cycleId)
                : request.dispatchKey !== undefined
                  ? this.repos.cycles.byDispatch(conversation.id, request.dispatchKey)
                  : undefined;
        if (request.cycleId !== undefined || carried) {
            // The same message, or a step of a cycle (an approval decided): it
            // carries on what the cycle used, never from nothing; an ended cycle
            // takes no more work.
            if (
                !carried ||
                carried.conversationId !== conversation.id ||
                !(carried.status === 'waiting' || resumable(carried, request))
            ) {
                return { ok: false, failure: 'cycle_ended' };
            }
            // A room's cycle carries on only as the person who started it, while
            // they may still send there and its socio is still in the room
            // (CB-209): what changed while it waited is checked again now.
            if (
                kind === 'room' &&
                (trigger.kind !== 'person' ||
                    trigger.id !== carried.actingUserId ||
                    carried.initiator.kind !== 'person' ||
                    carried.initiator.id !== carried.actingUserId ||
                    !startTurn({
                        conversation: {
                            id: conversation.id,
                            kind,
                            ownerId: conversation.ownerId,
                            archivedAt: conversation.archivedAt ?? null,
                        },
                        senderId: carried.actingUserId,
                        member: room.member,
                        socio: {
                            dotId: request.dotId,
                            ownerId: socio?.ownerId ?? null,
                            roomStatus: room.socio,
                        },
                        cycleId: carried.id,
                        billing: { kind: 'workspace' },
                        roomsEnabled: this.rooms.enabled?.() ?? false,
                    }).ok)
            ) {
                return { ok: false, failure: 'room_access' };
            }
            const stop = cycleExhausted(
                {
                    startedAt: now - carried.elapsedMs,
                    tokens: carried.tokensUsed + carried.tokensReserved,
                    handoffs: carried.handoffs,
                    costUsd: carried.costKnown ? carried.costUsd : null,
                },
                carried.limits,
                now,
            );
            if (stop) {
                this.repos.cycles.update(carried.id, {
                    status: 'ended',
                    endReason: stop,
                    endedAt: now,
                    updatedAt: now,
                });
                return { ok: false, failure: failureOf(stop) };
            }
            const patch: WorkCyclePatch = {
                status: 'running',
                endedAt: null,
                endReason: null,
                runId: request.runId,
                dotId: request.dotId,
                dotOwnerId: socio?.ownerId ?? null,
                hop: request.hop ?? carried.hop,
                steps: carried.steps + 1,
                stepStartedAt: now,
                deadlineAt: now + carried.limits.cycleTimeMs - carried.elapsedMs,
                updatedAt: now,
            };
            this.repos.cycles.update(carried.id, patch);
            return {
                ok: true,
                step: new CycleStep(this, { ...carried, ...patch } as WorkCycle, this.now),
            };
        }
        // A room's step runs as the person who sent the message, never as
        // anyone else: refused when they may not send.
        if (kind === 'room') {
            if (trigger.kind !== 'person' || !trigger.id) {
                return { ok: false, failure: 'room_access' };
            }
            const start = startTurn({
                conversation: {
                    id: conversation.id,
                    kind,
                    ownerId: conversation.ownerId,
                    archivedAt: conversation.archivedAt ?? null,
                },
                senderId: trigger.id,
                member: room.member,
                socio: {
                    dotId: request.dotId,
                    ownerId: socio?.ownerId ?? null,
                    roomStatus: room.socio,
                },
                cycleId: 'pending',
                billing: { kind: 'workspace' },
                roomsEnabled: this.rooms.enabled?.() ?? false,
            });
            if (!start.ok || actingUserId !== trigger.id) {
                return { ok: false, failure: 'room_access' };
            }
        }
        const limits = this.limitsOf(room.limits);
        if (request.personMessage && !request.queued) {
            if (!this.fits(conversation.id, limits, now)) {
                return { ok: false, failure: 'cycle_rate' };
            }
            this.repos.submissions.add(conversation.id, trigger.kind === 'person' ? (trigger.id ?? null) : null, now);
        }
        const cycle: WorkCycle = {
            id: randomUUID(),
            conversationId: conversation.id,
            kind,
            dispatchKey: request.dispatchKey ?? null,
            initiator: trigger,
            actingUserId,
            dotId: request.dotId,
            dotOwnerId: socio?.ownerId ?? null,
            billing: null,
            status: 'running',
            runId: request.runId,
            hop: 0,
            steps: 1,
            limits,
            startedAt: now,
            elapsedMs: 0,
            stepStartedAt: now,
            deadlineAt: now + limits.cycleTimeMs,
            tokensReserved: 0,
            tokensUsed: 0,
            costUsd: 0,
            costKnown: true,
            handoffs: 0,
            unstopped: [],
            endedAt: null,
            endReason: null,
            updatedAt: now,
        };
        this.repos.cycles.insert(cycle);
        return { ok: true, step: new CycleStep(this, cycle, this.now) };
    }

    /**
     * Settles a step as its run ends: its time and tokens added, and the
     * cycle waiting for its next step (the step waits for a person: an
     * approval, a review) or ended, with why. What it records for the
     * run's trace.
     */
    async end(step: CycleStep, outcome: { status: AgentRunStatus; trace: RunTrace }): Promise<TraceCycle> {
        const now = this.now();
        const cycle = step.cycle;
        // A limit that stopped it; a step that finished was not stopped (a
        // notes' summary it could not afford, say, is not the step's end).
        const stop =
            outcome.status === 'finished'
                ? undefined
                : (step.stop ?? (outcome.trace.end?.reason === 'time_limit' ? 'deadline' : undefined));
        const waits =
            outcome.status === 'finished' &&
            (outcome.trace.end?.reason === 'interrupted' ||
                (!!cycle.runId && !!(await this.awaiting?.(cycle.conversationId, cycle.runId).catch(() => false))));
        const endReason: CycleEndReason | null = waits
            ? null
            : outcome.status === 'finished'
              ? 'completed'
              : stop
                ? stop
                : outcome.status === 'stopped'
                  ? 'stopped'
                  : outcome.status === 'interrupted'
                    ? 'interrupted'
                    : 'failed';
        const unstopped = outcome.status === 'finished' ? [] : step.toolsRunning();
        const patch: WorkCyclePatch = {
            status: waits ? 'waiting' : 'ended',
            runId: cycle.runId,
            elapsedMs: cycle.elapsedMs + Math.max(0, now - (cycle.stepStartedAt ?? now)),
            // Requests still reserved never reported back: counted as reserved.
            tokensUsed: step.tokensUsed + step.tokensReserved,
            tokensReserved: 0,
            costUsd: step.costKnown ? step.costUsd : null,
            costKnown: step.costKnown,
            billing: step.billingPrincipal,
            stepStartedAt: null,
            deadlineAt: null,
            unstopped,
            ...(waits ? {} : { endedAt: now, endReason }),
            updatedAt: now,
        };
        step.closed = true;
        await this.transact('end work cycle step', () => this.repos.cycles.update(cycle.id, patch));
        return {
            id: cycle.id,
            kind: cycle.kind,
            hop: cycle.hop,
            actingUserId: cycle.actingUserId,
            dotId: cycle.dotId,
            ...(step.billingPrincipal ? { billing: step.billingPrincipal.kind } : {}),
            tokens: patch.tokensUsed,
            ...(step.costKnown && step.costUsd !== null ? { costUsd: step.costUsd } : {}),
            ...(stop ? { stop } : {}),
            ...(unstopped.length ? { unstopped } : {}),
        };
    }

    /** Writes what a step used so far, behind the work ahead (no wait). */
    persist(step: CycleStep) {
        if (step.closed) {
            return;
        }
        try {
            this.repos.cycles.stamp(step.cycle.id, {
                tokensUsed: step.tokensUsed,
                tokensReserved: step.tokensReserved,
                costUsd: step.costKnown ? step.costUsd : null,
                costKnown: step.costKnown,
                billing: step.billingPrincipal,
                updatedAt: this.now(),
            });
        } catch {
            this.options.log?.('Work cycles: a step’s use could not be stored.');
        }
    }

    /** A stored cycle (a read: one statement, no transaction). */
    async cycle(id: string) {
        return this.repos.cycles.byId(id);
    }

    /**
     * A conversation's cycles for its use (CB-218): those started from
     * `since`, newest first (at most `limit`), and its current one: the
     * running cycle, else the newest, which may be older. Reads: one
     * statement each, no transaction.
     */
    async usage(conversationId: string, since: number, limit = 1000) {
        const recent = this.repos.cycles.recent(conversationId, since, limit);
        return {
            current:
                this.repos.cycles.running(conversationId) ??
                recent[0] ??
                this.repos.cycles.recent(conversationId, 0, 1)[0],
            recent,
        };
    }

    /** The conversation's running cycle, if a step runs. */
    async running(conversationId: string) {
        return this.repos.cycles.running(conversationId);
    }

    /**
     * The context for the next socio in the cycle (CB-206): the same
     * initiator, acting person and billing, one hop on; refused past the
     * cycle's handoffs. The count is stored before the context is given.
     */
    handOff(
        cycleId: string,
        next: {
            dotId: string;
            ownerId: string | null;
            roomStatus?: RoomSocioStatus;
        },
    ): Promise<TurnStart> {
        return this.transact('hand off work cycle', (): TurnStart => {
            const cycle = this.repos.cycles.byId(cycleId);
            if (!cycle || cycle.status === 'ended') {
                return { ok: false, reason: 'not_member' };
            }
            const result = handOff(contextOf(cycle), next, cycle.limits.handoffsPerCycle);
            if (!result.ok) {
                return result;
            }
            this.repos.cycles.update(cycle.id, {
                handoffs: cycle.handoffs + 1,
                hop: result.context.hop,
                updatedAt: this.now(),
            });
            return result;
        });
    }

    /**
     * Ends a cycle that waits for a next step that will not come (CB-206: a
     * handoff dropped or refused), with why; unless a request its last step
     * left still waits (`awaiting`), which carries it on. Whether it ended.
     */
    async close(cycleId: string, reason: CycleEndReason): Promise<boolean> {
        const cycle = this.repos.cycles.byId(cycleId);
        if (cycle?.status !== 'waiting') {
            return false;
        }
        if (cycle.runId && (await this.awaiting?.(cycle.conversationId, cycle.runId).catch(() => false))) {
            return false;
        }
        const now = this.now();
        return this.transact('close work cycle', () =>
            this.repos.cycles.byId(cycleId)?.status === 'waiting'
                ? this.repos.cycles.update(cycleId, {
                      status: 'ended',
                      endReason: reason,
                      endedAt: now,
                      updatedAt: now,
                  })
                : false,
        );
    }

    /** The turn context a stored cycle's step runs under. */
    context(cycle: WorkCycle): TurnContext {
        return contextOf(cycle);
    }

    /**
     * Whether `viewerId` may stop the conversation's running cycle: the
     * person who started it, or a room admin; in a private
     * chat its owner.
     */
    async mayStop(conversationId: string, viewerId: string) {
        const conversation = this.options.conversation(conversationId);
        if (!conversation) {
            return false;
        }
        const running = await this.running(conversationId);
        const kind = this.kindOf(conversation);
        if (conversationShape({ kind, ownerId: conversation.ownerId }) === 'legacy-topic')
        // A topic's turn is stopped by the person it runs for (as today).
        {
            return running?.initiator.kind === 'person' && running.initiator.id === viewerId;
        }
        const { member } = await this.roomFacts(conversation, viewerId);
        return roomAllows(
            {
                kind,
                ownerId: conversation.ownerId,
                archivedAt: conversation.archivedAt ?? null,
            },
            { userId: viewerId, member },
            'stop',
            {
                roomsEnabled: this.rooms.enabled?.() ?? false,
                ...(running?.initiator.kind === 'person' && running.initiator.id
                    ? { cycleInitiatorId: running.initiator.id }
                    : {}),
            },
        ).allowed;
    }

    /**
     * Whether a person's queued messages may start work now (re-checked as
     * they are claimed): their own private chat, or a room they may send
     * in. A Telegram topic has no queue.
     */
    async mayDispatch(conversationId: string, userId: string) {
        const conversation = this.options.conversation(conversationId);
        if (!conversation) {
            return false;
        }
        const kind = this.kindOf(conversation);
        if (conversationShape({ kind, ownerId: conversation.ownerId }) === 'legacy-topic') {
            return false;
        }
        const { member } = await this.roomFacts(conversation, userId);
        return roomAllows(
            {
                kind,
                ownerId: conversation.ownerId,
                archivedAt: conversation.archivedAt ?? null,
            },
            { userId, member },
            'send',
            { roomsEnabled: this.rooms.enabled?.() ?? false },
        ).allowed;
    }

    /**
     * Ends the conversation's waiting cycles that have nothing left to wait
     * for (`awaiting` false): every request their step left expired or was
     * ended (CB-209, CB-212) and none was decided, so no step carries them
     * on. Called as requests settle, so such a cycle ends at once, as
     * `expired`, rather than at the tidy-up a week on. How many.
     */
    async settleWaiting(conversationId: string): Promise<number> {
        const cycles = await this.transact('read waiting work cycles', () => this.repos.cycles.waiting(conversationId));
        let ended = 0;
        for (const cycle of cycles) {
            if (!cycle.runId || !this.awaiting) {
                continue;
            }
            const waits = await this.awaiting(conversationId, cycle.runId).catch(() => true);
            if (waits) {
                continue;
            }
            const now = this.now();
            // Read again: a decision may have carried it on meanwhile.
            const done = await this.transact('end settled work cycle', () => {
                if (this.repos.cycles.byId(cycle.id)?.status !== 'waiting') {
                    return false;
                }
                return this.repos.cycles.update(cycle.id, {
                    status: 'ended',
                    endReason: 'expired',
                    endedAt: now,
                    updatedAt: now,
                });
            });
            if (done) {
                ended += 1;
            }
        }
        return ended;
    }

    /** The rooms with a step running now, on any runtime (Rooms turned off). */
    async runningRooms(): Promise<string[]> {
        return this.transact('read running room cycles', () =>
            this.repos.cycles
                .allRunning()
                .filter((cycle) => cycle.kind === 'room')
                .map((cycle) => cycle.conversationId),
        );
    }

    /** Periodic: forget old submissions, end cycles that waited too long. */
    tick() {
        return this.transact('tidy work cycles', () => {
            const now = this.now();
            this.repos.submissions.prune(now - SUBMISSION_KEEP_MS);
            this.repos.cycles.expireWaiting(now - CYCLE_WAIT_MS, now);
        });
    }
}

const failureOf = (stop: CycleStop): TurnFailure => CYCLE_FAILURES[stop];

/**
 * Whether an ended cycle's message may carry it on: a step that failed or
 * was interrupted before its message was stored (no model for the person,
 * a restart) goes again, from what the cycle used; one that completed,
 * was stopped or reached a limit never runs again.
 */
const resumable = (cycle: WorkCycle, request: CycleRequest) =>
    request.cycleId === undefined &&
    cycle.status === 'ended' &&
    (cycle.endReason === 'failed' || cycle.endReason === 'interrupted');

/** A stored cycle's turn context. */
function contextOf(cycle: WorkCycle): TurnContext {
    return {
        conversationId: cycle.conversationId,
        kind: cycle.kind,
        cycleId: cycle.id,
        initiator: cycle.initiator,
        actingUserId: cycle.actingUserId,
        socio: { dotId: cycle.dotId, ownerId: cycle.dotOwnerId },
        billing: cycle.billing ?? { kind: 'workspace' },
        hop: cycle.hop,
    };
}

/**
 * One step of a cycle while it runs: its budget for the step's model
 * requests (`CycleLedger`) and its deadline. Kept in memory, and stored
 * after each request (`WorkCycles.persist`).
 */
export class CycleStep implements CycleStepShape, CycleLedger {
    tokensUsed: number;
    tokensReserved = 0;
    costUsd: number | null;
    costKnown: boolean;
    billingPrincipal: BillingPrincipal | null;
    /** The limit that stopped the cycle in this step, once one did. */
    stop?: CycleStop;
    closed = false;
    private tools = new Map<number, string>();
    private toolIds = 0;
    constructor(
        private cycles: WorkCycles,
        readonly cycle: WorkCycle,
        private now: () => number = Date.now,
    ) {
        this.tokensUsed = cycle.tokensUsed + cycle.tokensReserved;
        this.costUsd = cycle.costUsd;
        this.costKnown = cycle.costKnown;
        this.billingPrincipal = cycle.billing;
    }
    get id() {
        return this.cycle.id;
    }
    get limits() {
        return this.cycle.limits;
    }
    /** The step's context. */
    get context(): TurnContext {
        return {
            ...contextOf(this.cycle),
            billing: this.billingPrincipal ?? { kind: 'workspace' },
        };
    }
    /** How long the step may run: what is left of the cycle's time. */
    remainingMs() {
        return Math.max(0, (this.cycle.deadlineAt ?? this.now()) - this.now());
    }
    private exhausted(): CycleStop | undefined {
        const now = this.now();
        return cycleExhausted(
            {
                // The cycle's clock: the time its earlier steps ran, then this one.
                startedAt: (this.cycle.stepStartedAt ?? now) - this.cycle.elapsedMs,
                tokens: this.tokensUsed + this.tokensReserved,
                handoffs: this.cycle.handoffs,
                costUsd: this.costKnown ? this.costUsd : null,
            },
            this.limits,
            now,
        );
    }
    reserve(estimate: number): CycleHold {
        const amount = Math.max(0, Math.ceil(estimate));
        const stop =
            this.exhausted() ??
            (this.tokensUsed + this.tokensReserved + amount > this.limits.cycleTokens ? 'tokens' : undefined);
        if (stop) {
            this.stop ??= stop;
            throw new CycleLimitError(stop);
        }
        this.tokensReserved += amount;
        this.cycles.persist(this);
        let settled = false;
        return {
            settle: (result: CycleRequestResult) => {
                if (settled) {
                    return;
                }
                settled = true;
                this.tokensReserved -= amount;
                const used = result.tokens !== undefined ? result.tokens : result.output ? amount : 0;
                this.tokensUsed += used;
                if (result.costUsd !== undefined && this.costKnown) {
                    this.costUsd = (this.costUsd ?? 0) + result.costUsd;
                } else if (result.costUsd === undefined && used > 0) {
                    // One request without a cost: the cycle's spend is unknown.
                    this.costKnown = false;
                    this.costUsd = null;
                }
                this.cycles.persist(this);
            },
        };
    }
    billing(source: string) {
        this.billingPrincipal = source.startsWith('byo')
            ? { kind: 'person', userId: this.cycle.actingUserId }
            : { kind: 'workspace' };
    }
    fallback() {
        this.billingPrincipal = { kind: 'workspace' };
    }
    tool(name: string) {
        const id = (this.toolIds += 1);
        this.tools.set(id, name);
        return () => void this.tools.delete(id);
    }
    /** The tools still running, by name. */
    toolsRunning() {
        return [...new Set(this.tools.values())];
    }
}
