import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { DomainEvents } from '@socio/data/events';
import { nextTurn } from '@socio/data/events';
import type { UnitOfWork } from '@socio/data/uow';
import { capabilityKey, guessArea } from '@socio/foundation/issues/capability-key';
import { DEFAULT_DOT_REQUEST_LIMITS, type DotRequestLimits } from '@socio/foundation/issues/settings';
import { withoutEmails } from '@socio/foundation/issues/without-emails';
import {
    CLOSED_ISSUE_STATUSES,
    DOT_REQUEST_LABEL,
    issueKey,
    issueLink,
    type DotRequester,
    type DotRequestNotice,
    type Issue,
    type IssueStatus,
} from '@socio/shared/issues/issue-types';

import { IssueError } from './contract.js';
import type { BoardRequests, DotRequestSummary, RecordedNotice } from './contract.js';
import type { BoardEvents } from './domain/events.js';
import type { BoardRepositories } from './domain/repositories.js';
import type { IssueStore } from './store.js';

// The capability key, the limits and `withoutEmails` live in
// `@socio/foundation/issues/*`.

// --- Intake ---------------------------------------------------------------

export const capabilityRequestInput = z
    .object({
        capability: z.string().trim().min(3).max(120),
        why: z.string().trim().min(1).max(2000),
        example: z.string().trim().min(1).max(2000),
        /** Optional: what sort of capability (a tool, data, an integration…). */
        kind: z.string().trim().max(60).optional(),
    })
    .strict();
export type CapabilityRequestInput = z.input<typeof capabilityRequestInput>;

export interface CapabilityRequestResult {
    outcome: 'filed' | 'merged' | 'already_requested' | 'rate_limited';
    /** `CB-12`; absent when rate limited. */
    issue?: string;
    key: string;
    /** Dot and user pairs that asked, this one included. */
    demand?: number;
    message: string;
}

export type NoticeListener = (notice: RecordedNotice) => void | Promise<void>;

/** The Telegram direct message for a notice: no emails, no user names. */
export function noticeMessage(notice: {
    number: number;
    capability: string;
    status: 'done' | 'wont_fix';
    resolution: string | null;
    dots: string[];
}) {
    const key = issueKey(notice.number);
    const who = notice.dots.length ? ` (asked by ${notice.dots.join(', ')})` : '';
    const head =
        notice.status === 'done'
            ? `A capability your socio asked for is done: “${notice.capability}”, ${key}${who}.`
            : `A capability your socio asked for won’t be built: “${notice.capability}”, ${key}${who}.`;
    return withoutEmails(notice.resolution ? `${head}\nResolution: ${notice.resolution}` : head);
}

/**
 * Capability requests from Dots: `request_capability` lands here. A
 * request is an issue of kind `request`, labeled `dot-request`, in triage;
 * an open request with the same capability key takes the new asker
 * instead (the demand count). When the issue closes, each user who asked
 * gets a notice and their Dots are told on their next turn.
 */
export class DotRequests implements BoardRequests {
    constructor(
        private uow: UnitOfWork,
        private repos: Pick<BoardRepositories, 'requests' | 'queries'>,
        private issues: IssueStore,
        private bus: DomainEvents<BoardEvents>,
        private dotName: (dotId: string) => string | undefined,
    ) {
        issues.onStatusChange((issue, from) => this.statusChanged(issue, from));
    }

    /** Called for each notice recorded, once saved; returns the unsubscribe. */
    onNotice(listener: NoticeListener) {
        return this.bus.subscribe('noticeRecorded', ({ notice }) => listener(notice));
    }

    demandOf(issueId: string) {
        return this.repos.requests.demandOf(issueId);
    }

    /** Demand per issue id, for every Dot request. */
    demand(): Promise<Map<string, number>> {
        return this.repos.queries.demand();
    }

    /** Whether the issue is a Dot request (has a key). */
    async isRequest(issueId: string) {
        return (await this.repos.requests.capability(issueId)) !== undefined;
    }

    requesters(issueId: string): Promise<DotRequester[]> {
        return this.repos.requests.requesters(issueId);
    }

    /**
     * Files or merges a request from `dotId`, acting for `userId`. Rate
     * limited per Dot and per user over `limits.windowMs`; a refusal is a
     * result, not an error, so the Dot can tell the user.
     */
    async request(
        dotId: string,
        userId: string,
        input: CapabilityRequestInput,
        limits: DotRequestLimits = DEFAULT_DOT_REQUEST_LIMITS,
        now = Date.now(),
    ): Promise<CapabilityRequestResult> {
        const data = capabilityRequestInput.parse(input);
        const key = capabilityKey(data.capability);
        if (!key) {
            throw new IssueError('Name the capability in a few words.');
        }
        const dot = this.dotName(dotId) ?? 'A socio';
        const { requests, queries } = this.repos;
        return this.uow.run(
            async (): Promise<CapabilityRequestResult> => {
                const open = await queries.openRequest(key);
                if (open && (await requests.hasRequester(open.issueId, dotId, userId))) {
                    const issue = (await this.issues.byId(open.issueId))!;
                    return {
                        outcome: 'already_requested',
                        issue: issueKey(issue.number),
                        key,
                        demand: await this.demandOf(open.issueId),
                        message: `You already asked for this for this user: ${issueLink(issue.number)} (${issue.status}). Nothing new was filed.`,
                    };
                }
                const since = now - limits.windowMs;
                const byDot = await requests.countSince({ dotId }, since);
                const byUser = await requests.countSince({ userId }, since);
                if (byDot >= limits.perDot || byUser >= limits.perUser) {
                    return {
                        outcome: 'rate_limited',
                        key,
                        message:
                            byDot >= limits.perDot
                                ? `This socio has made ${byDot} capability requests in the last day, the limit. Try again tomorrow, or ask the user to file an issue.`
                                : `${byUser} capability requests were made for this user in the last day, the limit. Try again tomorrow, or ask the user to file an issue.`,
                    };
                }
                const details = [
                    `**Why:**\n\n${quote(data.why)}`,
                    `**Example:**\n\n${quote(data.example)}`,
                    ...(data.kind ? [`**Kind:** ${oneLine(data.kind)}`] : []),
                ];
                let issueId: string;
                let outcome: 'filed' | 'merged';
                if (open) {
                    issueId = open.issueId;
                    outcome = 'merged';
                    await this.addRequester(issueId, dotId, userId, data, now);
                    await this.issues.postComment(
                        issueId,
                        'agent',
                        `dot:${dotId}`,
                        [
                            `${dot} asked for this too (demand ${await this.demandOf(issueId)}), as “${oneLine(data.capability)}”.`,
                            ...details,
                        ].join('\n\n'),
                        now,
                    );
                } else {
                    const issue = await this.issues.create(
                        {
                            title: `Socio request: ${oneLine(data.capability)}`,
                            body: [
                                `${dot} asked for a capability it doesn’t have.`,
                                `**Capability:** ${oneLine(data.capability)}`,
                                ...details,
                                `_Filed by the socio with \`request_capability\`. Requests for the same capability (key \`${key}\`) are merged here while it is open; the demand count shows how many socios and users asked._`,
                            ].join('\n\n'),
                            kind: 'request',
                            labels: [DOT_REQUEST_LABEL],
                            area: guessArea(`${data.capability} ${data.kind ?? ''}`),
                            status: 'triage',
                            priority: 'medium',
                        },
                        `dot:${dotId}`,
                        now,
                    );
                    issueId = issue.id;
                    outcome = 'filed';
                    await requests.insert({
                        issueId,
                        key,
                        capability: oneLine(data.capability),
                        createdAt: now,
                    });
                    await this.addRequester(issueId, dotId, userId, data, now);
                }
                const issue = (await this.issues.byId(issueId))!;
                const demand = await this.demandOf(issueId);
                return {
                    outcome,
                    issue: issueKey(issue.number),
                    key,
                    demand,
                    message:
                        outcome === 'filed'
                            ? `Filed ${issueLink(issue.number)} in the team’s Improvements tracker, in triage. The user will be told when it is done.`
                            : `Added to ${issueLink(issue.number)}, which others already asked for (demand ${demand}). The user will be told when it is done.`,
                };
            },
            { label: 'request capability' },
        );
    }

    private addRequester(
        issueId: string,
        dotId: string,
        userId: string,
        data: { why: string; example: string },
        now: number,
    ) {
        return this.repos.requests.addRequester({
            id: randomUUID(),
            issueId,
            dotId,
            userId,
            why: data.why,
            example: data.example,
            createdAt: now,
        });
    }

    private async summaries(
        dotId: string,
        userId: string,
        closed: boolean,
        unannounced = false,
    ): Promise<Array<DotRequestSummary & { issueId: string }>> {
        const rows = await this.repos.queries.requestSummaries(dotId, userId, {
            closed,
            unannounced,
        });
        const summaries: Array<DotRequestSummary & { issueId: string }> = [];
        for (const row of rows) {
            summaries.push({
                issueId: row.issueId,
                issue: issueKey(row.number),
                capability: row.capability,
                status: row.status,
                resolution: row.resolution,
                demand: await this.demandOf(row.issueId),
                requestedAt: row.requestedAt,
                closedAt: row.closedAt,
            });
        }
        return summaries;
    }

    /** What this Dot asked for, for this user, that is still open. */
    async pendingRequestsFor(dotId: string, userId: string): Promise<DotRequestSummary[]> {
        return (await this.summaries(dotId, userId, false)).map(strip);
    }

    /**
     * What this Dot asked for, for this user, that is done or won't be
     * built: newest first, the last 20. With `unannounced`, only those the
     * Dot hasn't been told about yet (see `markAnnounced`).
     */
    async resolvedRequestsFor(
        dotId: string,
        userId: string,
        options: { unannounced?: boolean } = {},
    ): Promise<DotRequestSummary[]> {
        return (await this.summaries(dotId, userId, true, options.unannounced)).map(strip);
    }

    /** The Dot has been told the outcome of these (by `CB-n` key). */
    markAnnounced(dotId: string, userId: string, issues: readonly string[], now = Date.now()) {
        const numbers = new Set(issues);
        return this.uow.run(
            async () => {
                for (const row of await this.summaries(dotId, userId, true)) {
                    if (numbers.has(row.issue)) {
                        await this.repos.requests.markAnnounced(row.issueId, dotId, userId, now);
                    }
                }
            },
            { label: 'announce requests' },
        );
    }

    /** The user's notices not yet seen, newest first. */
    async notices(userId: string): Promise<DotRequestNotice[]> {
        const notices: DotRequestNotice[] = [];
        for (const row of await this.repos.queries.notices(userId)) {
            notices.push({
                id: row.id,
                number: row.number,
                capability: row.capability,
                status: row.status,
                resolution: row.resolution,
                dots: await this.dotsOf(row.issueId, userId),
                createdAt: row.createdAt,
            });
        }
        return notices;
    }

    /** Marks the user's own notices seen; others' ids are ignored. */
    markSeen(userId: string, ids: readonly string[], now = Date.now()) {
        return this.uow.run(
            async () => {
                let changed = 0;
                for (const id of ids) {
                    if (await this.repos.requests.markSeen(userId, id, now)) {
                        changed++;
                    }
                }
                return changed;
            },
            { label: 'see notices' },
        );
    }

    private async dotsOf(issueId: string, userId: string) {
        return (await this.repos.requests.dotsFor(issueId, userId)).map(
            (dotId) => this.dotName(dotId) ?? 'A deleted socio',
        );
    }

    /**
     * An issue moved: on closing a Dot request (from an open status), one
     * notice per user who asked, and their Dots are to be told again.
     */
    private async statusChanged(issue: Issue, from: IssueStatus) {
        if (!CLOSED_ISSUE_STATUSES.includes(issue.status) || CLOSED_ISSUE_STATUSES.includes(from)) {
            return;
        }
        const capability = await this.repos.requests.capability(issue.id);
        if (capability === undefined) {
            return;
        }
        // Its own unit of work, on a turn of its own (CB-110).
        await nextTurn();
        const status = issue.status as 'done' | 'wont_fix';
        const now = Date.now();
        await this.uow.run(
            async () => {
                const users = [...new Set((await this.requesters(issue.id)).map((row) => row.userId))];
                await this.repos.requests.resetAnnounced(issue.id);
                for (const userId of users) {
                    await this.repos.requests.addNotice({
                        id: randomUUID(),
                        issueId: issue.id,
                        userId,
                        status,
                        resolution: issue.resolution,
                        createdAt: now,
                    });
                    this.bus.publish('noticeRecorded', {
                        notice: {
                            userId,
                            issue,
                            capability,
                            status,
                            dots: await this.dotsOf(issue.id, userId),
                        },
                    });
                }
            },
            { label: 'record request notices' },
        );
    }
}

const strip = ({ issueId: _, ...summary }: DotRequestSummary & { issueId: string }): DotRequestSummary => summary;
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const quote = (text: string) =>
    text
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
