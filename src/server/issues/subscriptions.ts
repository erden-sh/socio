import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { UnitOfWork } from '@socio/data/uow';
import { issueWatchInput, issueWatchPage } from '@socio/shared/issues/board-inputs';
import type { IssueWatchView } from '@socio/shared/issues/issue-subscriptions';
import { ISSUE_STATUSES, issueKey, type IssueStatus } from '@socio/shared/issues/issue-types';

import type { AppDeliveriesShape } from '../notifications/contract.js';

import { type IssueWatchSource, IssueError } from './contract.js';
import type { BoardWatches } from './contract.js';
import type { IssueWatchRepository, IssueWatchRow } from './domain/repositories.js';
import type { IssueStore } from './store.js';

// The watch inputs live in `@socio/shared/issues/board-inputs`.

const MAX_ACTIVE = 50;
const EVENTS_PER_WATCH = 200;

/** One-shot future status watches; persisted issue events are the recovery journal. */
export class IssueSubscriptions implements BoardWatches {
    private scanAfter: string | undefined;
    constructor(
        private uow: UnitOfWork,
        private repo: IssueWatchRepository,
        private issues: IssueStore,
        private activeUser: (id: string) => boolean,
    ) {}
    private person(userId: string) {
        if (!this.activeUser(userId)) {
            throw new IssueError('Sign in with an active account.', 403);
        }
    }
    private async view(watch: IssueWatchRow): Promise<IssueWatchView> {
        return {
            id: watch.id,
            issues: (await this.repo.members(watch.id)).map((m) => issueKey(m.number)),
            targetStatus: watch.targetStatus,
            state: watch.state,
            createdAt: new Date(watch.createdAt).toISOString(),
            triggeredAt: watch.triggeredAt === null ? null : new Date(watch.triggeredAt).toISOString(),
            cancelledAt: watch.cancelledAt === null ? null : new Date(watch.cancelledAt).toISOString(),
            cancelReason: watch.cancelReason,
        };
    }
    async create(userId: string, input: z.input<typeof issueWatchInput>, source: IssueWatchSource, now = Date.now()) {
        this.person(userId);
        if (source.sourceKind === 'person' && source.sourceId !== userId) {
            throw new IssueError('Subscriptions belong to the person creating them.', 403);
        }
        const data = issueWatchInput.parse(input);
        return this.uow.run(
            async () => {
                this.person(userId);
                const numbers = [...new Set(data.issues.map((ref) => Number(/(\d+)$/.exec(ref)![1])))].sort(
                    (a, b) => a - b,
                );
                const members = [];
                for (const number of numbers) {
                    const issue = await this.issues.require(number);
                    members.push({
                        issueId: issue.id,
                        number: issue.number,
                        status: issue.status,
                    });
                }
                const fingerprint = numbers.join(',') + '|' + data.targetStatus;
                const existing = await this.repo.activeDuplicate(userId, fingerprint);
                if (existing) {
                    return {
                        outcome: 'already_watching' as const,
                        watch: await this.view(existing),
                        alreadyMatched: members.every((m) => m.status === data.targetStatus),
                        futureTransitionsOnly: true as const,
                    };
                }
                if ((await this.repo.activeCount(userId)) >= MAX_ACTIVE) {
                    throw new IssueError(`At most ${MAX_ACTIVE} active issue subscriptions per person.`, 409);
                }
                const watch: IssueWatchRow = {
                    id: randomUUID(),
                    userId,
                    targetStatus: data.targetStatus,
                    state: 'watching',
                    fingerprint,
                    cursor: await this.issues.historyCursor(),
                    createdAt: now,
                    triggeredAt: null,
                    cancelledAt: null,
                    cancelReason: null,
                    cancelSourceKind: null,
                    cancelSourceId: null,
                    cancelThreadId: null,
                    cancelCauseId: null,
                    ...source,
                };
                await this.repo.insert(watch, members);
                return {
                    outcome: 'subscribed' as const,
                    watch: await this.view(watch),
                    alreadyMatched: members.every((m) => m.status === data.targetStatus),
                    futureTransitionsOnly: true as const,
                };
            },
            { label: 'subscribe to issue status' },
        );
    }
    async list(userId: string, input: { limit?: number; offset?: number } = {}) {
        this.person(userId);
        const { limit, offset } = issueWatchPage.parse(input);
        const rows = await this.repo.forUser(userId, limit + 1, offset);
        return {
            items: await Promise.all(rows.slice(0, limit).map((w) => this.view(w))),
            next: rows.length > limit ? offset + limit : null,
        };
    }
    async cancel(
        userId: string,
        id: string,
        source: IssueWatchSource = {
            sourceKind: 'person',
            sourceId: userId,
            threadId: null,
            causeId: null,
        },
        now = Date.now(),
    ) {
        this.person(userId);
        if (source.sourceKind === 'person' && source.sourceId !== userId) {
            throw new IssueError('Subscriptions belong to the person canceling them.', 403);
        }
        z.uuid().parse(id);
        return this.uow.run(
            async () => {
                const watch = await this.repo.owned(userId, id);
                if (!watch) {
                    throw new IssueError('Subscription not found.', 404);
                }
                if (watch.state === 'cancelled') {
                    return {
                        outcome: 'cancelled' as const,
                        watch: await this.view(watch),
                    };
                }
                if (watch.state === 'triggered') {
                    return {
                        outcome: 'already_triggered' as const,
                        watch: await this.view(watch),
                        message: 'Its notification is already recorded; cancellation cannot recall a delivery.',
                    };
                }
                await this.repo.cancel(id, 'unsubscribed', now, source);
                return {
                    outcome: 'cancelled' as const,
                    watch: await this.view((await this.repo.owned(userId, id))!),
                };
            },
            { label: 'unsubscribe from issue status' },
        );
    }
    private async readable(watch: IssueWatchRow) {
        if (!this.activeUser(watch.userId)) {
            return 'person_unavailable' as const;
        }
        for (const member of await this.repo.members(watch.id)) {
            const issue = await this.issues.get(member.number);
            if (!issue || issue.id !== member.issueId) {
                return 'issue_unavailable' as const;
            }
        }
        return undefined;
    }
    /** At most 100 watches and 200 later status events per watch per pass. No pre-subscription backfill. */
    async replay(now = Date.now()) {
        const watches = await this.repo.watching(this.scanAfter, 100);
        this.scanAfter = watches.length === 100 ? watches.at(-1)!.id : undefined;
        for (const initial of watches) {
            await this.uow.run(
                async () => {
                    const watch = await this.repo.owned(initial.userId, initial.id);
                    if (watch?.state !== 'watching') {
                        return;
                    }
                    const unavailable = await this.readable(watch);
                    if (unavailable) {
                        await this.repo.cancel(watch.id, unavailable, now);
                        return;
                    }
                    const members = await this.repo.members(watch.id);
                    const through = await this.issues.historyCursor();
                    const events = await this.repo.statusEvents(
                        members.map((m) => m.issueId),
                        watch.cursor,
                        through,
                        EVENTS_PER_WATCH + 1,
                    );
                    const batch = events.slice(0, EVENTS_PER_WATCH);
                    for (const event of batch) {
                        if (!ISSUE_STATUSES.includes(event.to as IssueStatus)) {
                            throw new IssueError('Invalid recorded issue status.');
                        }
                        const member = members.find((m) => m.issueId === event.issueId)!;
                        member.status = event.to as IssueStatus;
                        await this.repo.memberStatus(watch.id, event.issueId, member.status);
                        if (members.every((m) => m.status === watch.targetStatus)) {
                            const keys = members.map((m) => issueKey(m.number));
                            await this.repo.ready(watch.id, {
                                id: randomUUID(),
                                watchId: watch.id,
                                userId: watch.userId,
                                title: 'Watched issues matched',
                                message: `All watched issues reached ${watch.targetStatus.replaceAll('_', ' ')}: ${keys.join(', ')}.`,
                                path: '/issues',
                                createdAt: now,
                                claimedAt: null,
                            });
                            return;
                        }
                    }
                    await this.repo.cursor(
                        watch.id,
                        events.length > EVENTS_PER_WATCH ? batch.at(-1)!.sequence : through,
                    );
                },
                { label: 'replay issue subscription events' },
            );
        }
    }
    /** Claim, notification identity and in-app notice commit together; external sends happen after commit. */
    async flush(notifications: Pick<AppDeliveriesShape, 'queueFromApp'>, now = Date.now()) {
        for (const initial of await this.repo.pending(20)) {
            await this.uow.run(
                async () => {
                    const watch = await this.repo.owned(initial.userId, initial.watchId);
                    if (watch?.state !== 'ready') {
                        return;
                    }
                    const unavailable = await this.readable(watch);
                    if (unavailable) {
                        await this.repo.cancel(watch.id, unavailable, now);
                        return;
                    }
                    const claimed = await this.repo.claim(initial.id, now);
                    if (!claimed) {
                        return;
                    }
                    await notifications.queueFromApp({
                        ...claimed,
                        trigger: 'issue_subscription',
                    });
                },
                { label: 'claim issue subscription notification' },
            );
        }
    }
}
