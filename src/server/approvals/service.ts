import { randomUUID } from 'node:crypto';

import { nextTurn } from '@socio/data/events';
import type { UnitOfWork } from '@socio/data/uow';
import {
    APPROVAL_POLICIES,
    AUTO_GUIDANCE_MAX,
    autoReasonLine,
    type ApprovalAuditEntry,
    type ApprovalAutoView,
    type ApprovalCapabilityView,
    type ApprovalContinuationView,
    type ApprovalPolicy,
    type ApprovalPolicyView,
    type ApprovalStatus,
    type ApprovalView,
    type AutoCause,
    type AutoRisk,
    type PendingApprovalResult,
} from '@socio/shared/approvals';

import {
    AUTO_APPROVALS_PER_HOUR,
    AUTO_SYSTEM_PROMPT,
    AUTO_TIMEOUT_MS,
    ESCALATION_REASON,
    autoPrompt,
    parseAutoAnswer,
    riskRank,
    scrub,
    type AutoDecider,
} from './auto.js';
import {
    ApprovalError,
    type ApprovalDecisionEvent,
    type ApprovalHandler,
    type ApprovalInput,
    type ApprovalOutcome,
    type ApprovalRecord,
    type ApprovalsShape,
    type BoundApproval,
    type DecidedRequest,
    type PendingListener,
    type SettledListener,
} from './contract.js';
import type { ApprovalRepositories, ApprovalRequest } from './domain/repositories.js';

interface Review {
    verdict: ApprovalAutoView['verdict'];
    cause: AutoCause;
    reason: string;
    risk?: AutoRisk;
    modelDecision?: string;
    model?: string | null;
    backend?: string | null;
    latencyMs?: number;
    inputHash?: string;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const line = (error: unknown) => (error instanceof Error ? error.message : 'The action failed.').slice(0, 300);

/** What the approval service is given besides its storage. */
export interface ApprovalOptions {
    dotName?: (dotId: string) => string | undefined;
    ttlMs?: number;
    log?: (line: string) => void;
    /** The run in progress in a conversation: the turn a request came from. */
    activeRun?: (threadId: string) => string | undefined;
    /** The work cycle running in a conversation (CB-209). */
    activeCycle?: (threadId: string) => Promise<string | undefined> | string | undefined;
    /**
     * Whether the request's person may still decide it and its action run
     * (CB-209: in a room, while they may send there): undefined if so, else
     * why not, in a line for them.
     */
    standing?: (request: { userId: string; threadId: string | null }) => string | undefined;
    /**
     * The room a conversation is, by title (CB-209): a request from one
     * says where it was asked and who reads what comes of it.
     */
    room?: (threadId: string) => { title: string } | undefined;
    /** The line a request from a room carries (`roomApprovalLine`). */
    roomLine?: (title: string) => string;
    /** The `auto` policy; without a decider every auto request goes to its user. */
    auto?: {
        decider?: AutoDecider;
        /** The Dot's role instructions, summarized for the decision model. */
        dotRole?: (dotId: string) => string | undefined;
        /** AUTO_APPROVALS_PER_HOUR by default. */
        perHour?: number;
        /** AUTO_TIMEOUT_MS by default. */
        timeoutMs?: number;
    };
}

/**
 * Approvals (`LegacyApprovals`). A module registers a handler per
 * capability; a Dot's tool calls `request`, which either runs the action at
 * once (bypass, audited as such) or stores it as pending and returns a
 * marker the tool passes back to the model. The user approves or denies in
 * the chat's card or on `/approvals/<id>`; approving runs the handler then,
 * and the Dot carries on in the request's conversation once every request
 * of that turn is settled (`onSettled`, CB-58). Pending requests expire
 * after `ttlMs` (7 days). Tool calls never wait.
 *
 * Storage is the context's repositories (CB-110); writes that belong
 * together run as one unit of work, and a handler's action runs between
 * units, never inside one.
 */
export class ApprovalService implements ApprovalsShape {
    private handlers = new Map<string, ApprovalHandler>();
    private pendingListeners: Array<PendingListener> = [];
    private settledListeners: Array<SettledListener> = [];
    constructor(
        private uow: UnitOfWork,
        private repos: ApprovalRepositories,
        private options: ApprovalOptions = {},
    ) {}
    register<P>(handler: ApprovalHandler<P>) {
        if (this.handlers.has(handler.capability)) {
            throw new Error(`Approval capability "${handler.capability}" is registered twice.`);
        }
        if (!handler.consumable === !handler.execute) {
            throw new Error(`Approval capability "${handler.capability}" needs execute, or is consumable without one.`);
        }
        this.handlers.set(handler.capability, handler as ApprovalHandler);
        return this;
    }
    /** Capabilities with a handler, for the policies UI. */
    capabilities(): ApprovalCapabilityView[] {
        return [...this.handlers.values()].map(({ capability, label, description, auto, undo, manualOnly }) => ({
            id: capability,
            label,
            description,
            ...(manualOnly ? { manualOnly: true } : {}),
            auto: {
                allowed: !manualOnly && auto?.allowed !== false,
                maxRisk: auto?.maxRiskForAuto ?? 'low',
                rules: (auto?.rules ?? []).map((rule) => rule.description),
                undo: !!undo,
            },
        }));
    }
    /** Called for each new pending request (the Telegram notice). */
    onPending(listener: PendingListener) {
        this.pendingListeners.push(listener);
    }
    /**
     * Called when a conversation's request is decided by its user or expires
     * (the Dot carrying on, CB-58). A user's decision waits for the listener,
     * so its answer says whether the Dot is carrying on already.
     */
    onSettled(listener: SettledListener) {
        this.settledListeners.push(listener);
    }
    private async settled(threadIds: Iterable<string | null>) {
        for (const threadId of new Set(threadIds)) {
            if (threadId) {
                for (const listener of this.settledListeners) {
                    try {
                        await listener(threadId);
                    } catch {
                        // Carrying on is best effort; the decision stands.
                    }
                }
            }
        }
    }
    /**
     * `settled` for work nobody awaits (an expiry, a deleted socio): on the
     * next turn of the event loop, after the writes that settled them have
     * landed, so its units never open in its caller's turn (CB-110).
     */
    private settleLater(threadIds: Array<string | null>) {
        if (!threadIds.some(Boolean)) {
            return;
        }
        void nextTurn().then(() => this.settled(threadIds));
    }
    async policy(userId: string, dotId: string, capability: string): Promise<ApprovalPolicy> {
        if (this.handlers.get(capability)?.manualOnly) {
            return 'manual';
        }
        return (await this.repos.policies.get(userId, dotId, capability)) ?? 'manual';
    }
    async policies(userId: string, dotId?: string): Promise<ApprovalPolicyView[]> {
        return (await this.repos.policies.list(userId, dotId)).map((row) =>
            this.handlers.get(row.capability)?.manualOnly ? { ...row, policy: 'manual' } : row,
        );
    }
    async setPolicy(
        userId: string,
        dotId: string,
        capability: string,
        policy: ApprovalPolicy,
    ): Promise<ApprovalPolicyView> {
        const handler = this.handlers.get(capability);
        if (!handler) {
            throw new ApprovalError('Unknown approval capability.', 404);
        }
        if (!APPROVAL_POLICIES.includes(policy)) {
            throw new ApprovalError('Choose manual, auto or bypass.');
        }
        if (handler.manualOnly && policy !== 'manual') {
            throw new ApprovalError('This capability requires your approval for every call.');
        }
        if (policy === 'auto' && handler.auto?.allowed === false) {
            throw new ApprovalError('This capability is never decided automatically.');
        }
        const now = Date.now();
        await this.uow.run(
            async () => {
                const before = await this.policy(userId, dotId, capability);
                await this.repos.policies.set({
                    userId,
                    dotId,
                    capability,
                    policy,
                    updatedAt: now,
                });
                if (before !== policy) {
                    await this.audit(
                        userId,
                        dotId,
                        capability,
                        null,
                        'policy_changed',
                        userId,
                        `${before} → ${policy}`,
                    );
                }
            },
            { label: 'set approval policy' },
        );
        return { dotId, capability, policy, updatedAt: now };
    }
    /** The user's standing guidance for their auto reviews; '' when none. */
    async guidance(userId: string): Promise<string> {
        return (await this.repos.guidance.get(userId)) ?? '';
    }
    async setGuidance(userId: string, text: string): Promise<string> {
        const guidance = text.trim();
        if (guidance.length > AUTO_GUIDANCE_MAX) {
            throw new ApprovalError(`Keep the guidance under ${AUTO_GUIDANCE_MAX} characters.`);
        }
        await this.uow.run(
            async () => {
                if (guidance === (await this.guidance(userId))) {
                    return;
                }
                if (guidance) {
                    await this.repos.guidance.set(userId, guidance, Date.now());
                } else {
                    await this.repos.guidance.clear(userId);
                }
                // The text itself stays out of the audit.
                await this.audit(userId, '', '', null, 'guidance_changed', userId, null);
            },
            { label: 'set approval guidance' },
        );
        return guidance;
    }
    async request<P>(input: ApprovalInput<P>): Promise<ApprovalOutcome> {
        return (await this.file(input, false)) as ApprovalOutcome;
    }
    /**
     * `request` for a consumable capability, except that a request bound to
     * the same binding and digest that waits, or is approved and unused, is
     * answered instead of filing a second one. It is looked up inside the
     * inserting unit of work, so identical requests at once make one card
     * (CB-232).
     */
    async requestBound<P>(
        input: ApprovalInput<P> & {
            binding: { digest: string; bindingId: string };
        },
    ): Promise<ApprovalOutcome | BoundApproval> {
        return this.file(input, true);
    }
    private async file<P>(input: ApprovalInput<P>, reuseBound: boolean): Promise<ApprovalOutcome | BoundApproval> {
        const handler = this.handlers.get(input.capability);
        if (!handler) {
            throw new Error(`No approval handler for "${input.capability}".`);
        }
        if (!handler.consumable !== !input.binding) {
            throw new Error(`A "${input.capability}" request ${handler.consumable ? 'needs' : 'takes no'} binding.`);
        }
        const id = randomUUID();
        const now = Date.now();
        const expiresAt = now + (handler.ttlMs ?? this.options.ttlMs ?? 7 * DAY);
        const runId = input.runId ?? ((input.threadId && this.options.activeRun?.(input.threadId)) || null);
        const cycleId =
            input.cycleId ?? ((input.threadId && (await this.options.activeCycle?.(input.threadId))) || null);
        // From a room (CB-209): where it was asked and who reads the reply,
        // for the one person who decides it.
        const room = input.threadId ? this.options.room?.(input.threadId) : undefined;
        const roomLine = room && this.options.roomLine?.(room.title);
        // One unit of work, queued behind one open on the connection (CB-110):
        // the request, its audit and a bypass's approval.
        const filed = await this.uow.run(
            async () => {
                if (reuseBound && input.binding) {
                    const found = await this.repos.requests.bound(input.binding.bindingId, input.binding.digest, now);
                    if (found) {
                        return { found };
                    }
                }
                const { limit } = input;
                if (
                    limit &&
                    (await this.repos.requests.countPending({
                        capabilities: limit.capabilities,
                        now,
                        ...(limit.by === 'dot'
                            ? { dotId: input.dotId }
                            : { bindingId: input.binding?.bindingId ?? '' }),
                    })) >= limit.max
                ) {
                    throw new ApprovalError(limit.message, 409);
                }
                await this.repos.requests.insert({
                    id,
                    ...(input.binding ? input.binding : {}),
                    userId: input.userId,
                    dotId: input.dotId,
                    capability: input.capability,
                    summary: input.summary.slice(0, 300),
                    details: [
                        ...(input.details ?? [])
                            // Leave room for a complete 4,000-character schedule prompt and
                            // its context, while keeping the stored/displayed details bounded.
                            .map((d) => d.slice(0, 8192))
                            .slice(0, roomLine ? 11 : 12),
                        ...(roomLine ? [roomLine] : []),
                    ],
                    payload: input.payload,
                    threadId: input.threadId ?? null,
                    runId,
                    cycleId,
                    createdAt: now,
                    expiresAt,
                });
                await this.audit(
                    input.userId,
                    input.dotId,
                    input.capability,
                    id,
                    'requested',
                    `dot:${input.dotId}`,
                    input.summary.slice(0, 300),
                );
                const policy = input.alwaysAsk
                    ? 'manual'
                    : await this.policy(input.userId, input.dotId, input.capability);
                if (policy === 'bypass') {
                    await this.repos.requests.decide(id, {
                        status: 'approved',
                        via: 'bypass',
                        at: now,
                    });
                    await this.audit(input.userId, input.dotId, input.capability, id, 'bypassed', 'policy', null);
                    await this.decided(id, { status: 'approved', by: 'policy', at: now });
                }
                return { policy };
            },
            { label: 'request approval' },
        );
        if ('found' in filed && filed.found) {
            return {
                status: 'bound',
                id: filed.found.id,
                approved: filed.found.status === 'approved',
                expiresAt: filed.found.expiresAt,
            };
        }
        const { policy } = filed as Extract<typeof filed, { policy: unknown }>;
        if (policy === 'bypass') {
            const outcome = await this.execute((await this.row(id))!);
            return { status: 'approved', id, via: 'bypass', outcome };
        }
        if (policy === 'auto') {
            const review = await this.review((await this.row(id))!, handler);
            if (review.verdict !== 'escalated') {
                const approve = review.verdict === 'approved';
                // The user may have decided meanwhile (it was listed as pending).
                const claimed = await this.uow.run(
                    async () => {
                        const at = Date.now();
                        const changed = await this.repos.requests.decide(id, {
                            status: approve ? 'approved' : 'denied',
                            via: 'auto',
                            at,
                        });
                        if (changed) {
                            await this.decided(id, {
                                status: approve ? 'approved' : 'denied',
                                by: 'auto',
                                at,
                            });
                        }
                        return changed;
                    },
                    { label: 'auto decide approval' },
                );
                if (claimed && approve) {
                    const outcome = await this.execute((await this.row(id))!);
                    return {
                        status: 'approved',
                        id,
                        via: 'auto',
                        outcome,
                        reason: review.reason,
                    };
                }
                if (claimed) {
                    const outcome = `Denied by auto review: ${review.reason}`;
                    await this.repos.requests.recordOutcome(id, outcome.slice(0, 300));
                    return {
                        status: 'denied',
                        id,
                        via: 'auto',
                        outcome,
                        message: `The user's automatic approval review denied this: ${review.reason} Do not retry the same request; tell the user, who can review it under Approvals (/approvals/${id}) or change the policy.`,
                    };
                }
            }
        }
        const view = await this.view((await this.row(id))!);
        for (const listener of this.pendingListeners) {
            try {
                listener(view, {
                    userId: input.userId,
                    threadId: input.threadId ?? null,
                });
            } catch {
                // A notice that can't be sent never blocks the request.
            }
        }
        return this.pendingResult(view);
    }
    /**
     * The result a tool returns for a request waiting for its person: the
     * marker the chat shows as an approval card.
     */
    private pendingResult(view: ApprovalView): PendingApprovalResult & { id: string; expiresAt: number } {
        const { id } = view;
        return {
            status: 'pending_approval',
            id,
            expiresAt: view.expiresAt,
            approval: { id, summary: view.summary, url: `/approvals/${id}` },
            message: `Waiting for the user's approval (request ${id}). ${view.auto ? `An automatic review passed it to them: ${autoReasonLine(view.auto)} ` : ''}The person already sees an approval card for it in this chat (and under Approvals in the app, ${`/approvals/${id}`}), where they approve or deny it: say in a line what is waiting there, without asking them to approve in your reply or to type their approval, which grants nothing. Do not retry or wait for it: once they decide, the action runs (if approved) and a note with the decision and its result comes to you in this conversation, so you can carry on then. Until then it is in \`capabilities\` under pendingApprovals.`,
        };
    }
    /**
     * The request of the same kind already waiting for this person, if
     * `same` finds one among its payloads: asking again returns it, not a
     * second one (CB-131).
     */
    async findPending<P>(
        userId: string,
        dotId: string,
        capability: string,
        same: (payload: P) => boolean,
    ): Promise<(PendingApprovalResult & { id: string; expiresAt: number }) | undefined> {
        await this.expire();
        const rows = await this.repos.requests.pending(userId, dotId, capability);
        const row = rows.find((item) => same(item.payload as P));
        return row ? this.pendingResult(await this.view(row)) : undefined;
    }
    /** The payloads of this person's pending requests of one kind, oldest first. */
    async pendingPayloads<P>(
        userId: string,
        dotId: string,
        capability: string,
    ): Promise<Array<{ id: string; payload: P }>> {
        await this.expire();
        return (await this.repos.requests.pending(userId, dotId, capability)).map((row) => ({
            id: row.id,
            payload: row.payload as P,
        }));
    }
    /**
     * The stored payload of this person's request of one kind once it was
     * approved: `approved`, or `failed` as its action ran (only an approved
     * request runs). Undefined for any other request (CB-336: a job's code
     * is stored again from what was approved, never from anything newer).
     */
    async approvedPayload<P>(
        id: string,
        userId: string,
        capability: string,
    ): Promise<{ dotId: string; payload: P } | undefined> {
        const row = await this.row(id);
        if (
            !row ||
            row.userId !== userId ||
            row.capability !== capability ||
            (row.status !== 'approved' && row.status !== 'failed') ||
            !row.decidedVia ||
            row.decidedVia === 'expiry'
        ) {
            return undefined;
        }
        return { dotId: row.dotId, payload: row.payload as P };
    }
    /** This person's approved requests of one kind whose action failed, newest first, with why. */
    async failedPayloads<P>(
        userId: string,
        dotId: string,
        capability: string,
    ): Promise<Array<{ id: string; payload: P; outcome: string | null; decidedAt: number | null }>> {
        return (await this.repos.requests.failed(userId, dotId, capability))
            .filter((row) => !!row.decidedVia && row.decidedVia !== 'expiry')
            .map((row) => ({
                id: row.id,
                payload: row.payload as P,
                outcome: row.outcome,
                decidedAt: row.decidedAt,
            }));
    }
    /**
     * The auto review of a request, recorded and audited. Guards first
     * (the capability allows auto, its hard rules, the hourly limit per Dot),
     * then one call to the decision model with a timeout; its answer must be
     * strict JSON, and an approval above the capability's risk threshold goes
     * to the user. Anything that fails or is unclear escalates.
     */
    private async review(row: ApprovalRequest, handler: ApprovalHandler) {
        const settings = handler.auto ?? {};
        const record = this.record(row);
        const done = (review: Review) => this.recordReview(row, review);
        if (settings.allowed === false) {
            return done({
                verdict: 'escalated',
                cause: 'not_allowed',
                reason: ESCALATION_REASON.not_allowed,
            });
        }
        for (const rule of settings.rules ?? []) {
            let why: string | false | null | undefined;
            try {
                why = rule.check(record);
            } catch {
                why = `This request could not be checked against “${rule.description}”.`;
            }
            if (why) {
                return done({ verdict: 'escalated', cause: 'rule', reason: why });
            }
        }
        const perHour = this.options.auto?.perHour ?? AUTO_APPROVALS_PER_HOUR;
        const approvedLastHour = await this.repos.reviews.approvedSince(row.dotId, Date.now() - HOUR);
        if (approvedLastHour >= perHour) {
            return done({
                verdict: 'escalated',
                cause: 'rate_limit',
                reason: ESCALATION_REASON.rate_limit,
            });
        }
        const decider = this.options.auto?.decider;
        if (!decider) {
            return done({
                verdict: 'escalated',
                cause: 'no_inference',
                reason: ESCALATION_REASON.no_inference,
            });
        }
        const maxRisk = settings.maxRiskForAuto ?? 'low';
        let payload: unknown = record.payload;
        try {
            if (settings.describe) {
                payload = settings.describe(record.payload);
            }
        } catch {
            payload = '(not shown)';
        }
        const { prompt, hash } = autoPrompt({
            capability: {
                id: handler.capability,
                label: handler.label,
                description: handler.description,
                riskNotes: [
                    settings.riskNotes,
                    ...(settings.rules ?? []).map((rule) => `Checked already: ${rule.description}`),
                ]
                    .filter(Boolean)
                    .join(' '),
                maxRiskForAuto: maxRisk,
            },
            request: {
                summary: row.summary,
                details: row.details,
                payload,
            },
            dotRole: this.options.auto?.dotRole?.(row.dotId),
            guidance: await this.guidance(row.userId),
            recent: await this.recentFor(row),
        });
        const started = Date.now();
        const timeoutMs = this.options.auto?.timeoutMs ?? AUTO_TIMEOUT_MS;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                controller.abort();
                reject(new Error('timeout'));
            }, timeoutMs);
        });
        const measured = { latencyMs: 0, inputHash: hash };
        let result: Awaited<ReturnType<AutoDecider['decide']>>;
        try {
            result = await Promise.race([
                decider.decide({
                    userId: row.userId,
                    system: AUTO_SYSTEM_PROMPT,
                    prompt,
                    signal: controller.signal,
                }),
                timedOut,
            ]);
        } catch {
            const timeout = controller.signal.aborted;
            return done({
                verdict: 'escalated',
                cause: timeout ? 'timeout' : 'error',
                reason: ESCALATION_REASON[timeout ? 'timeout' : 'error'],
                ...measured,
                latencyMs: Date.now() - started,
            });
        } finally {
            clearTimeout(timer);
        }
        measured.latencyMs = Date.now() - started;
        if (!result.ok) {
            return done({
                verdict: 'escalated',
                cause: 'no_inference',
                reason: ESCALATION_REASON.no_inference,
                ...measured,
            });
        }
        const source = { model: result.model, backend: result.backend };
        const answer = parseAutoAnswer(result.text);
        if (!answer) {
            return done({
                verdict: 'escalated',
                cause: 'malformed',
                reason: ESCALATION_REASON.malformed,
                ...measured,
                ...source,
            });
        }
        const verdict = {
            modelDecision: answer.decision,
            risk: answer.risk,
            reason: answer.reason,
            ...measured,
            ...source,
        };
        if (answer.decision === 'escalate') {
            return done({ verdict: 'escalated', cause: 'model', ...verdict });
        }
        if (answer.decision === 'deny') {
            return done({ verdict: 'denied', cause: 'model', ...verdict });
        }
        if (riskRank(answer.risk) > riskRank(maxRisk)) {
            return done({ verdict: 'escalated', cause: 'risk', ...verdict });
        }
        return done({ verdict: 'approved', cause: 'model', ...verdict });
    }
    /** The review and its audit, as one unit of work (CB-110). */
    private async recordReview(row: ApprovalRequest, review: Review): Promise<Review> {
        const reason = scrub(review.reason, 400);
        await this.uow.run(
            async () => {
                await this.repos.reviews.insert({
                    id: randomUUID(),
                    requestId: row.id,
                    userId: row.userId,
                    dotId: row.dotId,
                    capability: row.capability,
                    verdict: review.verdict,
                    cause: review.cause,
                    modelDecision: review.modelDecision ?? null,
                    risk: review.risk ?? null,
                    reason,
                    model: review.model ?? null,
                    backend: review.backend ?? null,
                    latencyMs: review.latencyMs ?? null,
                    inputHash: review.inputHash ?? null,
                    createdAt: Date.now(),
                });
                await this.audit(
                    row.userId,
                    row.dotId,
                    row.capability,
                    row.id,
                    review.verdict === 'approved'
                        ? 'auto_approved'
                        : review.verdict === 'denied'
                          ? 'auto_denied'
                          : 'auto_escalated',
                    review.model ? `auto:${review.model}` : 'auto',
                    `${review.risk ? `Risk ${review.risk}. ` : ''}${reason}`.slice(0, 300),
                );
            },
            { label: 'record auto review' },
        );
        return { ...review, reason };
    }
    /** Recent decisions on the same capability for this user, for the model. */
    private async recentFor(row: ApprovalRequest) {
        return (await this.repos.requests.recentDecided(row.userId, row.capability, row.id, 5)).map((item) => ({
            summary: item.summary,
            status: item.status,
            decidedBy: item.decidedVia ?? 'unknown',
        }));
    }
    private record(row: ApprovalRequest): ApprovalRecord {
        return {
            id: row.id,
            userId: row.userId,
            dotId: row.dotId,
            capability: row.capability,
            summary: row.summary,
            payload: row.payload,
            threadId: row.threadId,
            binding: row.digest && row.bindingId ? { digest: row.digest, bindingId: row.bindingId } : null,
        };
    }
    /**
     * The handler's `onDecision`, inside the open unit of work: its record
     * commits with the change (CB-232).
     */
    private async decided(id: string, event: ApprovalDecisionEvent) {
        const row = await this.row(id);
        const handler = row && this.handlers.get(row.capability);
        if (row && handler?.onDecision) {
            handler.onDecision(this.record(row), event);
        }
    }
    private async execute(row: ApprovalRequest): Promise<string> {
        const handler = this.handlers.get(row.capability);
        if (handler?.consumable) {
            // Nothing runs here: the holder of its binding uses it once.
            const outcome = 'Approved: it can be used once.';
            await this.repos.requests.recordOutcome(row.id, outcome);
            return outcome;
        }
        try {
            if (!handler?.execute) {
                throw new Error('This capability is no longer available.');
            }
            // Checked again as it runs (CB-209): a person who left the room
            // since, or a room archived, runs nothing there.
            const gone = this.options.standing?.(row);
            if (gone) {
                throw new ApprovalError(gone, 409);
            }
            const result = await handler.execute(this.record(row));
            const outcome = typeof result === 'string' ? result : result.outcome;
            await this.uow.run(
                async () => {
                    await this.repos.requests.recordExecution(
                        row.id,
                        outcome.slice(0, 300),
                        typeof result === 'string' ? undefined : result.undoData,
                    );
                    await this.audit(
                        row.userId,
                        row.dotId,
                        row.capability,
                        row.id,
                        'executed',
                        'platform',
                        outcome.slice(0, 300),
                    );
                },
                { label: 'record approval outcome' },
            );
            return outcome;
        } catch (error) {
            await this.uow.run(
                async () => {
                    await this.repos.requests.recordFailure(row.id, line(error));
                    await this.audit(row.userId, row.dotId, row.capability, row.id, 'failed', 'platform', line(error));
                },
                { label: 'record approval failure' },
            );
            throw error;
        }
    }
    /**
     * The user's decision on their own pending request; approving runs it.
     * `from` is where they decided: `message` is outside the app (a
     * Telegram notice's buttons), which can't show a card.
     */
    async decide(id: string, userId: string, approve: boolean, from: 'app' | 'message' = 'app'): Promise<ApprovalView> {
        const row = await this.row(id);
        // Only its person decides it: never a room admin or another member,
        // who get a missing request, not a refusal.
        if (!row || row.userId !== userId) {
            throw new ApprovalError('Approval request not found.', 404);
        }
        const handler = this.handlers.get(row.capability);
        // A capability with a card (CB-232) is decided on that card only.
        // Its notice has no buttons, but button data is unsigned: a forged
        // press is refused here, either way.
        if (from === 'message' && handler?.card) {
            throw new ApprovalError('Decide on its card in Socio.', 409);
        }
        if (row.status === 'pending' && row.expiresAt <= Date.now()) {
            await this.expire();
            throw new ApprovalError('This request expired.', 409);
        }
        // In a room only while they may still work there (CB-209).
        const gone = row.status === 'pending' && this.options.standing?.(row);
        if (gone) {
            throw new ApprovalError(gone, 409);
        }
        // Long details must be opened first, on every surface.
        if (approve && row.status === 'pending' && !row.openedAt && this.mustOpen(handler, row.payload)) {
            throw new ApprovalError('Open the full details in Socio before you approve this.', 409);
        }
        const now = Date.now();
        // From a conversation, the request joins its turn's batch as it is
        // claimed ('deciding' while its action runs): a sibling decided
        // meanwhile waits for it rather than carrying on without it.
        const claimed = await this.uow.run(
            async () => {
                const changed = await this.repos.requests.decide(id, {
                    status: approve ? 'approved' : 'denied',
                    via: 'user',
                    at: now,
                    deciding: true,
                });
                if (changed) {
                    await this.audit(
                        row.userId,
                        row.dotId,
                        row.capability,
                        id,
                        approve ? 'approved' : 'denied',
                        userId,
                        null,
                    );
                    await this.decided(id, {
                        status: approve ? 'approved' : 'denied',
                        by: userId,
                        at: now,
                    });
                }
                return changed;
            },
            { label: 'decide approval' },
        );
        if (!claimed) {
            throw new ApprovalError('This request was already decided.', 409);
        }
        try {
            if (approve) {
                await this.execute({ ...row, status: 'approved' }).catch(() => undefined);
            }
        } finally {
            // From a conversation: the Dot carries on there, approved or denied.
            if (row.threadId) {
                await this.repos.requests.setContinuation([id], 'waiting');
            }
        }
        if (row.threadId) {
            await this.settled([row.threadId]);
        }
        return this.view((await this.row(id))!);
    }
    /**
     * Reverses an automatically approved action, when its capability can
     * (`undo`), once. The request stays approved; its review records the undo.
     */
    async undo(id: string, userId: string): Promise<ApprovalView> {
        const row = await this.row(id);
        if (!row || row.userId !== userId) {
            throw new ApprovalError('Approval request not found.', 404);
        }
        const auto = await this.repos.reviews.latest(id);
        if (!auto || auto.verdict !== 'approved' || row.decidedVia !== 'auto' || row.status !== 'approved') {
            throw new ApprovalError('Only actions approved automatically can be undone here.', 409);
        }
        const handler = this.handlers.get(row.capability);
        if (!handler?.undo) {
            throw new ApprovalError('This kind of action can’t be undone.', 400);
        }
        if (!(await this.repos.reviews.claimUndo(auto.id, Date.now()))) {
            throw new ApprovalError('This was already undone.', 409);
        }
        try {
            const outcome = (
                await handler.undo({
                    ...this.record(row),
                    outcome: row.outcome,
                    undoData: row.undoData,
                })
            ).slice(0, 300);
            await this.uow.run(
                async () => {
                    await this.repos.reviews.recordUndo(auto.id, outcome);
                    await this.audit(row.userId, row.dotId, row.capability, id, 'undone', userId, outcome);
                },
                { label: 'record undo' },
            );
        } catch (error) {
            await this.uow.run(
                async () => {
                    await this.repos.reviews.releaseUndo(auto.id, line(error));
                    await this.audit(row.userId, row.dotId, row.capability, id, 'undo_failed', userId, line(error));
                },
                { label: 'record undo failure' },
            );
            throw new ApprovalError(line(error), 409);
        }
        return this.view((await this.row(id))!);
    }
    async get(id: string, userId: string): Promise<ApprovalView> {
        const row = await this.row(id);
        if (!row || row.userId !== userId) {
            throw new ApprovalError('Approval request not found.', 404);
        }
        return this.view(row);
    }
    async list(
        userId: string,
        filter: {
            status?: ApprovalStatus;
            dotId?: string;
            limit?: number;
            /** Only requests an auto review looked at. */
            auto?: boolean;
        } = {},
    ): Promise<ApprovalView[]> {
        await this.expire();
        const rows = await this.repos.requests.list(userId, {
            ...filter,
            limit: Math.min(filter.limit ?? 100, 500),
        });
        return Promise.all(rows.map((row) => this.view(row)));
    }
    auditFor(userId: string, limit = 200): Promise<ApprovalAuditEntry[]> {
        return this.repos.audit.forUser(userId, Math.min(limit, 1000));
    }
    /** The socio's approval activity, for the admins' socio page (the port). */
    dotActivity(dotId: string, before: number, limit: number) {
        return this.repos.audit.forDot(dotId, before, limit);
    }
    /**
     * Marks overdue pending requests expired; returns how many. Their turns
     * carry on once the expiry has landed. A failure is logged, not thrown:
     * the views that expire first still show.
     */
    async expire(now = Date.now()): Promise<number> {
        try {
            if (!(await this.repos.requests.overdue(now)).length) {
                return 0;
            }
            // Read again in the unit: a parallel expiry may have taken some.
            const expired = await this.uow.run(
                async () => {
                    const done: ApprovalRequest[] = [];
                    for (const row of await this.repos.requests.overdue(now)) {
                        if (await this.repos.requests.expire(row.id, now)) {
                            await this.audit(
                                row.userId,
                                row.dotId,
                                row.capability,
                                row.id,
                                'expired',
                                'platform',
                                null,
                            );
                            await this.decided(row.id, {
                                status: 'expired',
                                by: 'platform',
                                at: now,
                            });
                            done.push(row);
                        }
                    }
                    return done;
                },
                { label: 'expire approvals' },
            );
            // The last of a turn's requests expiring lets its decided ones carry on.
            this.settleLater(expired.map((row) => row.threadId));
            return expired.length;
        } catch (error) {
            console.error(`Approvals: expiry failed: ${error instanceof Error ? error.name : 'unknown'}`);
            return 0;
        }
    }
    /** A deleted Dot: its pending requests expire and its policies go. */
    async forgetDot(dotId: string) {
        const now = Date.now();
        const rows = await this.uow.run(
            async () => {
                const rows = await this.repos.requests.pendingOfDot(dotId);
                for (const row of rows) {
                    await this.repos.requests.expire(row.id, now, 'The socio was deleted.');
                    await this.audit(
                        row.userId,
                        row.dotId,
                        row.capability,
                        row.id,
                        'expired',
                        'platform',
                        'The socio was deleted.',
                    );
                    // The module's own record too, as for any expiry.
                    await this.decided(row.id, {
                        status: 'expired',
                        by: 'platform',
                        at: now,
                    });
                }
                await this.repos.policies.removeForDot(dotId);
                return rows;
            },
            { label: 'forget socio approvals' },
        );
        this.settleLater(rows.map((row) => row.threadId));
    }
    /**
     * Ends what a person (or, without one, anyone) was asked in a
     * conversation and can no longer decide (CB-209): they left or were
     * removed from the room, it was archived or its socio withdrawn. Each
     * pending request expires with `detail` as its outcome; their turns
     * carry on (or are skipped) as for any expiry. How many.
     */
    async invalidate(threadId: string, userId: string | undefined, detail: string) {
        const now = Date.now();
        const ended = await this.uow.run(
            async () => {
                const done: ApprovalRequest[] = [];
                for (const row of await this.repos.requests.pendingIn(threadId, userId)) {
                    if (await this.repos.requests.expire(row.id, now, detail.slice(0, 300))) {
                        await this.audit(
                            row.userId,
                            row.dotId,
                            row.capability,
                            row.id,
                            'expired',
                            'platform',
                            detail.slice(0, 300),
                        );
                        // The module's own record too, as for any expiry.
                        await this.decided(row.id, {
                            status: 'expired',
                            by: 'platform',
                            at: now,
                        });
                        done.push(row);
                    }
                }
                return done;
            },
            { label: 'invalidate approvals' },
        );
        this.settleLater(ended.map((row) => row.threadId));
        return ended.length;
    }
    /**
     * Whether a turn left requests its socio carries on after (CB-209): its
     * work cycle waits for them, so the decision carries on in it.
     */
    awaitingInRun(threadId: string, runId: string, now = Date.now()) {
        return this.repos.requests.awaitingInRun(threadId, runId, now);
    }
    /**
     * A conversation's requests that its user decided and whose turn has no
     * request left waiting for them, oldest first (CB-58): what the next turn
     * that carries on reports. Overdue requests count as expired.
     */
    async readyToContinue(threadId: string, now = Date.now()): Promise<DecidedRequest[]> {
        const ready: DecidedRequest[] = [];
        for (const row of await this.repos.requests.waitingIn(threadId)) {
            if (!(await this.waitingFor(row, now))) {
                ready.push({
                    id: row.id,
                    userId: row.userId,
                    dotId: row.dotId,
                    summary: row.summary,
                    status: row.status,
                    outcome: row.outcome,
                    cycleId: row.cycleId,
                });
            }
        }
        return ready;
    }
    /** Conversations with decided requests whose Dot has not carried on yet. */
    waitingThreads(): Promise<string[]> {
        return this.repos.requests.waitingThreads();
    }
    /** Records how the Dot carried on after these requests. */
    markContinuation(
        ids: readonly string[],
        status: Exclude<ApprovalContinuationView['status'], 'waiting'>,
        options: { id?: string; detail?: string } = {},
    ) {
        return this.repos.requests.setContinuation(ids, status, {
            ...(options.id === undefined ? {} : { continuationId: options.id }),
            detail: options.detail?.slice(0, 300) ?? null,
        });
    }
    /**
     * Continuations a stopped process was running: they ended with it. A
     * decision it was still carrying out is reported as it stands (with
     * whatever outcome was recorded), so its batch is not held forever.
     */
    endRunningContinuations(detail: string) {
        return this.repos.requests.endRunning(detail.slice(0, 300));
    }
    /** Stores the hidden note a continuation turn starts with. */
    recordNote(id: string, threadId: string, userId: string, content: string) {
        return this.repos.notes.insert({
            id,
            threadId,
            userId,
            content,
            createdAt: Date.now(),
        });
    }
    /** Whether the server wrote this note, in this conversation, as it reads. */
    async isNote(id: string, threadId: string, content: unknown) {
        const note = await this.repos.notes.byId(id);
        return !!note && note.threadId === threadId && note.content === content;
    }
    /**
     * Other requests of the same turn still outstanding: waiting for the
     * user, or approved with their action still running.
     */
    private async waitingFor(row: ApprovalRequest, now = Date.now()) {
        if (!row.runId || !row.threadId) {
            return 0;
        }
        return this.repos.requests.outstandingInRun(row.threadId, row.runId, row.id, now);
    }
    private row(id: string) {
        return this.repos.requests.byId(id);
    }
    private async autoView(row: ApprovalRequest): Promise<ApprovalAutoView | null> {
        const auto = await this.repos.reviews.latest(row.id);
        if (!auto) {
            return null;
        }
        return {
            verdict: auto.verdict,
            risk: auto.risk,
            reason: auto.reason,
            cause: auto.cause,
            model: auto.model,
            backend: auto.backend,
            latencyMs: auto.latencyMs,
            at: auto.createdAt,
            undoneAt: auto.undoneAt,
            undoOutcome: auto.undoOutcome,
            undoable:
                auto.verdict === 'approved' &&
                row.decidedVia === 'auto' &&
                row.status === 'approved' &&
                !auto.undoneAt &&
                !!this.handlers.get(row.capability)?.undo,
        };
    }
    private async view(row: ApprovalRequest): Promise<ApprovalView> {
        return {
            id: row.id,
            dotId: row.dotId,
            dotName: this.options.dotName?.(row.dotId) ?? 'A deleted socio',
            capability: row.capability,
            capabilityLabel: this.handlers.get(row.capability)?.label ?? row.capability,
            summary: row.summary,
            details: row.details,
            threadId: row.threadId,
            status: row.status,
            decidedVia: row.decidedVia ?? null,
            createdAt: row.createdAt,
            expiresAt: row.expiresAt,
            decidedAt: row.decidedAt,
            outcome: row.outcome,
            auto: await this.autoView(row),
            continuation: row.continuation
                ? {
                      // Its own action still running reads as waiting.
                      status: row.continuation === 'deciding' ? 'waiting' : row.continuation,
                      id: row.continuationId,
                      detail: row.continuationDetail,
                      waitingFor:
                          row.continuation === 'waiting' || row.continuation === 'deciding'
                              ? await this.waitingFor(row)
                              : 0,
                  }
                : null,
            ...this.cardOf(row),
        };
    }
    /** A capability's card and review state (CB-232), when it has them. */
    private cardOf(row: ApprovalRequest): Partial<ApprovalView> {
        const handler = this.handlers.get(row.capability);
        if (!handler) {
            return {};
        }
        let card: ApprovalView['card'] = null;
        try {
            card = handler.card?.(this.record(row)) ?? null;
        } catch {
            // A card that can't be built leaves the summary and details.
        }
        return {
            ...(handler.card ? { card } : {}),
            ...(handler.review
                ? {
                      review: {
                          mustOpen: this.mustOpen(handler, row.payload),
                          opened: !!row.openedAt,
                      },
                  }
                : {}),
            ...(handler.consumable ? { consumedAt: row.consumedAt } : {}),
        };
    }
    private mustOpen(handler: ApprovalHandler | undefined, payload: unknown) {
        if (!handler?.review) {
            return false;
        }
        try {
            return handler.review.mustOpen(payload);
        } catch {
            // Unsure: the person opens it first.
            return true;
        }
    }
    /**
     * A request's full details, for its person only:
     * opening them is what lets Approve work when they are too long to show
     * inline. Recorded once, in the audit too.
     */
    async open(id: string, userId: string): Promise<{ full: string }> {
        const row = await this.row(id);
        if (!row || row.userId !== userId) {
            throw new ApprovalError('Approval request not found.', 404);
        }
        const handler = this.handlers.get(row.capability);
        if (!handler?.review) {
            throw new ApprovalError('This request has no further details.', 404);
        }
        const full = handler.review.full(row.payload);
        if (!row.openedAt) {
            await this.uow.run(
                async () => {
                    await this.repos.requests.markOpened(id, Date.now());
                    await this.audit(row.userId, row.dotId, row.capability, id, 'opened', userId, null);
                },
                { label: 'open approval details' },
            );
        }
        return { full };
    }
    /**
     * The consumable request bound to `bindingId` for `digest` that is
     * waiting, or approved and not yet used: asking again finds it.
     */
    async bound(bindingId: string, digest: string) {
        const row = await this.repos.requests.bound(bindingId, digest, Date.now());
        return row && this.view(row);
    }
    /**
     * Uses an approved consumable request once (CB-232): only for its
     * capability, digest and binding, never twice, never when denied,
     * expired or still waiting. `within` runs inside the same unit of work
     * when this call used it (the caller's own record). True when it did.
     */
    async consume(
        id: string,
        binding: { capability: string; digest: string; bindingId: string },
        within?: (request: ApprovalRecord) => void,
    ): Promise<boolean> {
        const handler = this.handlers.get(binding.capability);
        if (!handler?.consumable) {
            return false;
        }
        return this.uow.run(
            async () => {
                const row = await this.row(id);
                if (!row || row.capability !== binding.capability) {
                    return false;
                }
                // Using it is when it runs: in a room, only while its person may
                // still work there (CB-209).
                if (this.options.standing?.(row)) {
                    return false;
                }
                const at = Date.now();
                if (
                    !(await this.repos.requests.consume(
                        id,
                        { digest: binding.digest, bindingId: binding.bindingId },
                        at,
                    ))
                ) {
                    return false;
                }
                await this.audit(row.userId, row.dotId, row.capability, id, 'consumed', 'platform', null);
                handler.onDecision?.(this.record(row), {
                    status: 'consumed',
                    by: 'platform',
                    at,
                });
                within?.(this.record(row));
                return true;
            },
            { label: 'consume approval' },
        );
    }
    /**
     * Pending requests bound to these (grants that ended) expire now:
     * approvals made for a grant die with it (CB-232). Returns how many.
     */
    async expireBound(bindingIds: readonly string[], outcome: string) {
        if (!bindingIds.length) {
            return 0;
        }
        const now = Date.now();
        const expired = await this.uow.run(
            async () => {
                const done: ApprovalRequest[] = [];
                for (const row of await this.repos.requests.pendingBound(bindingIds)) {
                    if (await this.repos.requests.expire(row.id, now, outcome)) {
                        await this.audit(row.userId, row.dotId, row.capability, row.id, 'expired', 'platform', outcome);
                        await this.decided(row.id, {
                            status: 'expired',
                            by: 'platform',
                            at: now,
                        });
                        done.push(row);
                    }
                }
                return done;
            },
            { label: 'expire bound approvals' },
        );
        this.settleLater(expired.map((row) => row.threadId));
        return expired.length;
    }
    private audit(
        userId: string,
        dotId: string,
        capability: string,
        requestId: string | null,
        event: ApprovalAuditEntry['event'],
        actor: string,
        detail: string | null,
    ) {
        return this.repos.audit.append({
            id: randomUUID(),
            userId,
            dotId,
            capability,
            requestId,
            event,
            actor,
            detail,
            createdAt: Date.now(),
        });
    }
}
