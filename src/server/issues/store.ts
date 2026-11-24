import { createHash, randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { DomainEvents } from '@socio/data/events';
import { deletedWith } from '@socio/data/soft-delete';
import type { UnitOfWork } from '@socio/data/uow';
import { BLOCKERS_MAX, RELATED_MAX } from '@socio/shared/issues/board-inputs';
import { ISSUE_COMPONENTS_MAX } from '@socio/shared/issues/issue-components';
import {
    CLOSED_ISSUE_STATUSES,
    isBlockerSatisfied,
    issueKey,
    ISSUE_AREAS,
    ISSUE_ATTACHMENTS_PER_ISSUE,
    ISSUE_KINDS,
    ISSUE_LABELS,
    ISSUE_PRIORITIES,
    ISSUE_STATUSES,
    type Issue,
    type IssueArea,
    type IssueAttachment,
    type IssueCard,
    type IssueComment,
    type IssueEvent,
    type IssueEventKind,
    type IssueImportResult,
    type IssueKind,
    type IssueLabel,
    type IssueLinkRef,
    type IssueLinkRelation,
    type IssuePriority,
    type IssueSource,
    type IssueStatus,
    type IssueTitle,
} from '@socio/shared/issues/issue-types';

import { checkAttachment } from './attachments.js';
import { type IssueFilter, type StoredAttachment, IssueError } from './contract.js';
import type { BoardIssues } from './contract.js';
import type { BoardEvents } from './domain/events.js';
import type { IssueTitles } from './domain/ports.js';
import type { BoardRepositories, IssueFields, IssueRunRow } from './domain/repositories.js';

export { IssueError };
export type { IssueFilter };

const title = z.string().trim().min(3).max(200);
const body = z.string().max(20_000);
const fields = {
    status: z.enum(ISSUE_STATUSES),
    priority: z.enum(ISSUE_PRIORITIES),
    kind: z.enum(ISSUE_KINDS),
    area: z.enum(ISSUE_AREAS).nullable(),
    labels: z.array(z.enum(ISSUE_LABELS)).max(ISSUE_LABELS.length),
    assigneeId: z.string().min(1).max(64).nullable(),
    resolution: z.string().trim().max(500).nullable(),
};
export const issueInput = z
    .object({
        title,
        body: body.optional(),
        status: fields.status.optional(),
        priority: fields.priority.optional(),
        kind: fields.kind.optional(),
        area: fields.area.optional(),
        labels: fields.labels.optional(),
        assigneeId: fields.assigneeId.optional(),
        resolution: fields.resolution.optional(),
        /**
         * Component refs (CB-442): set through `BoardComponents.set`, which
         * checks each against the person's options; the store ignores them.
         */
        components: z.array(z.string().trim().min(1).max(100)).max(ISSUE_COMPONENTS_MAX).optional(),
    })
    .strict();
export const issuePatch = issueInput.partial().strict();
export const commentInput = z.object({ body: z.string().trim().min(1).max(10_000) }).strict();
export type IssueInput = z.infer<typeof issueInput>;
export type IssuePatch = z.infer<typeof issuePatch>;

/** An issue as parsed from an ISSUES.md file, with its own number. */
export interface IssueImport {
    number: number;
    title: string;
    body: string;
    status: IssueStatus;
    priority: IssuePriority;
    kind: IssueKind;
    area: IssueArea | null;
    labels: IssueLabel[];
    resolution: string | null;
}

/** Told after an update that changed an issue's status has been saved. */
export type IssueStatusListener = (issue: Issue, from: IssueStatus) => void | Promise<void>;
/** After a new issue is saved (not an import's); automatic triage listens. */
export type IssueCreatedListener = (issue: Issue) => void | Promise<void>;
/** After an issue is deleted (stamped); `actorId` is who deleted it. */
export type IssueRemovedListener = (issue: Issue, actorId: string | null) => void | Promise<void>;

// The link limits live in `@socio/shared/issues/board-inputs`.

/** Who may make and lift blocking links: admins (triage fields, CB-29). */
export const BLOCKING_ADMINS_ONLY =
    'Only an admin can make, change or remove a blocking link. Anyone can link related issues.';
/** What a link change may touch (CB-274): members relate issues only. */
export interface LinkAccess {
    /** May make, change or lift blocking links (admins). */
    blocking?: boolean;
    now?: number;
}
const isBlocking = (relation: IssueLinkRelation | null) => relation === 'blocks' || relation === 'blocked_by';

/** Why a deactivated person can't be given an issue. */
export const ASSIGNEE_DEACTIVATED = 'This person is deactivated. Choose someone else.';

/** The scalar fields a patch may change, and the history kind of each. */
const SCALARS = [
    ['title', 'title'],
    ['body', 'body'],
    ['status', 'status'],
    ['priority', 'priority'],
    ['kind', 'kind'],
    ['area', 'area'],
    ['assigneeId', 'assignee'],
    ['resolution', 'resolution'],
] as const;

/**
 * The issue tracker (CB-110: a service over the Board's repositories): issues
 * numbered `CB-<n>`, their labels, comments, attachments (bytes stored once,
 * as BLOBs, so backups include them), blocked-by and related links and a
 * history row for every change. Each change is one unit of work, or part of
 * the caller's; what reacts to it (triage, request notices) is
 * told once it is committed (`onCreated`, `onStatusChange`, `onRemoved`).
 */
export class IssueStore implements IssueTitles, BoardIssues {
    constructor(
        private uow: UnitOfWork,
        private repos: BoardRepositories,
        private bus: DomainEvents<BoardEvents>,
        private userExists: (id: string) => boolean,
        /** Deactivated people keep their assignments but get no new ones. */
        private deactivated: (id: string) => boolean = () => false,
    ) {}

    /** Runs `work` as one unit of work (or in the caller's, if one is open). */
    transaction<T>(work: () => Promise<T>, label = 'issue tracker') {
        return this.uow.run(work, { label });
    }

    /** Calls `listener` after each status change is saved; returns the unsubscribe. */
    onStatusChange(listener: IssueStatusListener) {
        return this.bus.subscribe('statusChanged', ({ issue, from }) => listener(issue, from));
    }

    /**
     * Calls `listener` after each issue is filed, once it is saved (imports
     * excluded: they bring their own triage); returns the unsubscribe.
     */
    onCreated(listener: IssueCreatedListener) {
        return this.bus.subscribe('created', ({ issue }) => listener(issue));
    }

    /**
     * Calls `listener` after each delete, once it is saved; returns the
     * unsubscribe.
     */
    onRemoved(listener: IssueRemovedListener) {
        return this.bus.subscribe('removed', ({ issue, actorId }) => listener(issue, actorId));
    }

    private event(
        issueId: string,
        actorId: string | null,
        kind: IssueEventKind,
        fromValue: string | null,
        toValue: string | null,
        now: number,
    ) {
        return this.repos.history.append({
            id: randomUUID(),
            issueId,
            actorId,
            kind,
            fromValue,
            toValue,
            createdAt: now,
        });
    }

    /**
     * A new assignee must have signed in and not be deactivated. The issue's
     * `current` assignee stays allowed, so a patch that keeps it passes.
     */
    private checkAssignee(assigneeId: string | null | undefined, current?: string | null) {
        if (!assigneeId || assigneeId === current) {
            return;
        }
        if (!this.userExists(assigneeId)) {
            throw new IssueError('Choose an assignee who has signed in.');
        }
        if (this.deactivated(assigneeId)) {
            throw new IssueError(ASSIGNEE_DEACTIVATED);
        }
    }

    /** Ordered by priority, then most recently updated. */
    list(filter: IssueFilter = {}): Promise<Issue[]> {
        return this.repos.issues.list(filter);
    }

    /**
     * Live issues, number, title and status only, in `list`'s order; `open`
     * leaves closed ones out: the ⌘K palette's issue commands.
     */
    titles({ open = false }: { open?: boolean } = {}): Promise<IssueTitle[]> {
        return this.repos.queries.titles({ open });
    }

    /**
     * The Board's port for other contexts (schedules, a Dot's admin page):
     * issues by id, number, title and status only; deleted ones with `deleted`.
     */
    titlesById(ids: readonly string[], options?: { deleted?: boolean }) {
        return this.repos.queries.titlesById(ids, options);
    }

    /**
     * The live ones of these issues, for chat's issue cards; deleted and
     * missing numbers are left out.
     */
    cards(numbers: readonly number[]): Promise<IssueCard[]> {
        return this.repos.queries.cards(numbers);
    }

    /**
     * Live issues with their descriptions, in `list`'s order, no labels:
     * what the Dots' board search matches (board-search.ts).
     */
    texts() {
        return this.repos.queries.texts();
    }

    get(number: number): Promise<Issue | undefined> {
        return this.repos.issues.byNumber(number);
    }

    /** By internal id, as other contexts keep it; undefined once deleted. */
    byId(id: string): Promise<Issue | undefined> {
        return this.repos.issues.byId(id);
    }

    /** An issue row, deleted or not, with its stamp (admin, tests). */
    withDeleted(number: number) {
        return this.repos.issues.withDeleted(number);
    }

    async require(number: number): Promise<Issue> {
        const issue = await this.get(number);
        if (!issue) {
            throw new IssueError('Issue not found.', 404);
        }
        return issue;
    }

    /** Files an issue under the next number; numbers are never reused. */
    async create(
        input: IssueInput,
        actorId: string,
        now = Date.now(),
        source: IssueSource = 'web',
        number?: number,
    ): Promise<Issue> {
        const data = issueInput.parse(input);
        this.checkAssignee(data.assigneeId);
        return this.uow.run(
            async () => {
                const next = number ?? (await this.repos.issues.nextNumber());
                const status = data.status ?? 'triage';
                const id = randomUUID();
                await this.repos.issues.insert({
                    id,
                    number: next,
                    title: data.title,
                    body: data.body ?? '',
                    status,
                    priority: data.priority ?? 'medium',
                    kind: data.kind ?? 'bug',
                    area: data.area ?? null,
                    labels: data.labels ?? [],
                    reporterId: actorId,
                    assigneeId: data.assigneeId ?? null,
                    resolution: data.resolution || null,
                    source,
                    createdAt: now,
                    updatedAt: now,
                    closedAt: CLOSED_ISSUE_STATUSES.includes(status) ? now : null,
                });
                await this.event(id, actorId, source === 'import' ? 'imported' : 'created', null, status, now);
                const created = await this.require(next);
                if (source !== 'import') {
                    this.bus.publish('created', { issue: created });
                }
                return created;
            },
            { label: 'file issue' },
        );
    }

    /**
     * Files an issue about a turn (CB-194), "File issue" under a failed run:
     * the item and its link to the run in one unit of work.
     */
    createFromRun(
        input: IssueInput,
        actorId: string,
        run: { runId: string; threadId: string },
        now = Date.now(),
    ): Promise<Issue> {
        return this.uow.run(
            async () => {
                const issue = await this.create(input, actorId, now);
                await this.linkRun(issue.id, { ...run, via: 'report', linkedBy: actorId }, now);
                return issue;
            },
            { label: 'file issue from run' },
        );
    }

    /** Links an item to the turn it was filed from (CB-194). */
    linkRun(issueId: string, link: Omit<IssueRunRow, 'issueId' | 'createdAt'>, now = Date.now()) {
        return this.repos.runs.link({ issueId, ...link, createdAt: now });
    }

    /** The turns an item was filed from, oldest first. */
    runsOf(issueId: string) {
        return this.repos.runs.forIssue(issueId);
    }

    /** Applies a patch; every changed field writes a history row. */
    async update(number: number, patch: IssuePatch, actorId: string, now = Date.now()): Promise<Issue> {
        const data = issuePatch.parse(patch);
        return this.uow.run(
            async () => {
                const issue = await this.require(number);
                this.checkAssignee(data.assigneeId, issue.assigneeId);
                const changes: Array<[IssueEventKind, string | null, string | null]> = [];
                const set: IssueFields = {};
                for (const [key, kind] of SCALARS) {
                    if (data[key] === undefined) {
                        continue;
                    }
                    const next = data[key] === '' ? null : data[key];
                    if (next === issue[key]) {
                        continue;
                    }
                    changes.push([kind, issue[key], next]);
                    Object.assign(set, { [key]: next });
                }
                if (data.status && data.status !== issue.status) {
                    const closed = CLOSED_ISSUE_STATUSES.includes(data.status);
                    if (closed !== CLOSED_ISSUE_STATUSES.includes(issue.status)) {
                        set.closedAt = closed ? now : null;
                    }
                }
                await this.repos.issues.update(issue.id, set);
                if (data.labels) {
                    const next = [...new Set(data.labels)].sort();
                    if (next.join(',') !== issue.labels.join(',')) {
                        await this.repos.issues.setLabels(issue.id, next);
                        changes.push(['labels', issue.labels.join(',') || null, next.join(',') || null]);
                    }
                }
                for (const [kind, before, after] of changes) {
                    await this.event(issue.id, actorId, kind, before, after, now);
                }
                if (changes.length) {
                    await this.repos.issues.touch(issue.id, now);
                }
                const updated = await this.require(number);
                if (issue.status !== updated.status) {
                    this.bus.publish('statusChanged', {
                        issue: updated,
                        from: issue.status,
                    });
                }
                return updated;
            },
            { label: 'update issue' },
        );
    }

    // --- Blocked-by links (CB-29) ---------------------------------------------
    // `fromId` waits for `toId`. A blocker that is closed (done or won't fix)
    // is satisfied. Links to a deleted issue are dormant: not listed, not
    // counted, but kept, so they return if it does. Removing a link stamps it.

    /** The issues this one waits for, by number. */
    blockedBy(issueId: string): Promise<IssueLinkRef[]> {
        return this.repos.issues.links(issueId, 'blockedBy');
    }

    /** The issues waiting for this one, by number. */
    blocks(issueId: string): Promise<IssueLinkRef[]> {
        return this.repos.issues.links(issueId, 'blocks');
    }

    /** For each issue with any, the numbers of its blockers not yet closed. */
    openBlockerNumbers(): Promise<Map<string, number[]>> {
        return this.repos.queries.openBlockerNumbers();
    }

    /** Blockers of this issue that are not yet closed. */
    async openBlockers(issueId: string) {
        return (await this.blockedBy(issueId)).filter((blocker) => !isBlockerSatisfied(blocker.status));
    }

    /** The issue and its blocker, both live, or the 404s. */
    private async pair(number: number, blockerNumber: number) {
        const issue = await this.require(number);
        const blocker = await this.get(blockerNumber);
        if (!blocker) {
            throw new IssueError(`There is no ${issueKey(blockerNumber)}.`, 404);
        }
        return { issue, blocker };
    }

    /**
     * Makes `number` wait for `blockerNumber`. Refused for the issue itself
     * and for a link that would close a cycle (the blocker already waits,
     * directly or through others, for this issue). Adding a link that exists
     * changes nothing; a related link between the two becomes this one.
     * Both issues get a history row.
     */
    async addBlocker(number: number, blockerNumber: number, actorId: string, now = Date.now()) {
        await this.uow.run(
            async () => {
                const { issue, blocker } = await this.pair(number, blockerNumber);
                if (issue.id === blocker.id) {
                    throw new IssueError('An issue can’t be blocked by itself.');
                }
                const links = this.repos.issues;
                if (await links.hasLink(issue.id, blocker.id)) {
                    return;
                }
                if (await links.reaches(blocker.id, issue.id)) {
                    throw new IssueError(
                        `${issueKey(blocker.number)} already waits for ${issueKey(issue.number)}, directly or through other issues, so ${issueKey(issue.number)} can’t wait for it too.`,
                        409,
                    );
                }
                if ((await this.blockedBy(issue.id)).length >= BLOCKERS_MAX) {
                    throw new IssueError(`An issue can be blocked by at most ${BLOCKERS_MAX} others.`, 409);
                }
                // A pair has one link: blocking says more than related (CB-274).
                await this.unlinkRelated(issue, blocker, actorId, now);
                await links.addLink({
                    id: randomUUID(),
                    fromId: issue.id,
                    toId: blocker.id,
                    createdBy: actorId,
                    createdAt: now,
                });
                await this.event(issue.id, actorId, 'blocked_by', null, issueKey(blocker.number), now);
                await this.event(blocker.id, actorId, 'blocks', null, issueKey(issue.number), now);
                await links.touch(issue.id, now);
                await links.touch(blocker.id, now);
            },
            { label: 'add blocker' },
        );
    }

    /** Lifts the link; no error when there is none. */
    async removeBlocker(number: number, blockerNumber: number, actorId: string, now = Date.now()) {
        await this.uow.run(
            async () => {
                const { issue, blocker } = await this.pair(number, blockerNumber);
                const links = this.repos.issues;
                if (!(await links.removeLink(issue.id, blocker.id, actorId, now))) {
                    return;
                }
                await this.event(issue.id, actorId, 'blocked_by', issueKey(blocker.number), null, now);
                await this.event(blocker.id, actorId, 'blocks', issueKey(issue.number), null, now);
                await links.touch(issue.id, now);
                await links.touch(blocker.id, now);
            },
            { label: 'remove blocker' },
        );
    }

    // --- Related links (CB-274) ----------------------------------------------
    // A pair of issues has at most one link: related (no direction), or one
    // waiting for the other. Related links to a deleted issue are dormant, as
    // blocked-by links are; removing one stamps it.

    /** The issues related to this one, by number. */
    related(issueId: string): Promise<IssueLinkRef[]> {
        return this.repos.issues.relatedLinks(issueId);
    }

    /** How `issue` is linked to `other`, from `issue`'s side, or null. */
    private async relationOf(issue: Issue, other: Issue): Promise<IssueLinkRelation | null> {
        const links = this.repos.issues;
        if (await links.hasRelated(issue.id, other.id)) {
            return 'related';
        }
        if (await links.hasLink(issue.id, other.id)) {
            return 'blocked_by';
        }
        if (await links.hasLink(other.id, issue.id)) {
            return 'blocks';
        }
        return null;
    }

    /** The issue and the other end of a link, both live and not the same. */
    private async linkPair(number: number, otherNumber: number) {
        const { issue, blocker: other } = await this.pair(number, otherNumber);
        if (issue.id === other.id) {
            throw new IssueError('An issue can’t be linked to itself.');
        }
        return { issue, other };
    }

    /** How issue `number` is linked to `otherNumber`, or null. */
    async relation(number: number, otherNumber: number) {
        const { issue, other } = await this.linkPair(number, otherNumber);
        return this.relationOf(issue, other);
    }

    /**
     * Relates two issues, with no direction. Relating a related pair changes
     * nothing; a pair where one waits for the other is refused (change that
     * link with `setLink`). Both issues get a history row.
     */
    async addRelated(number: number, otherNumber: number, actorId: string, now = Date.now()) {
        await this.uow.run(
            async () => {
                const { issue, other } = await this.linkPair(number, otherNumber);
                const current = await this.relationOf(issue, other);
                if (current === 'related') {
                    return;
                }
                if (current) {
                    throw new IssueError(
                        current === 'blocks'
                            ? `${issueKey(other.number)} already waits for ${issueKey(issue.number)}. Change that link instead.`
                            : `${issueKey(issue.number)} already waits for ${issueKey(other.number)}. Change that link instead.`,
                        409,
                    );
                }
                for (const end of [issue, other]) {
                    if ((await this.related(end.id)).length >= RELATED_MAX) {
                        throw new IssueError(`An issue can be related to at most ${RELATED_MAX} others.`, 409);
                    }
                }
                await this.repos.issues.addRelated({
                    id: randomUUID(),
                    oneId: issue.id,
                    otherId: other.id,
                    createdBy: actorId,
                    createdAt: now,
                });
                await this.relatedEvents(issue, other, actorId, 'added', now);
            },
            { label: 'add related issue' },
        );
    }

    /** Lifts the related link; no error when there is none. */
    async removeRelated(number: number, otherNumber: number, actorId: string, now = Date.now()) {
        await this.uow.run(
            async () => {
                const { issue, blocker: other } = await this.pair(number, otherNumber);
                await this.unlinkRelated(issue, other, actorId, now);
            },
            { label: 'remove related issue' },
        );
    }

    /** Stamps a live related link removed, with history; false if none. */
    private async unlinkRelated(issue: Issue, other: Issue, actorId: string, now: number) {
        if (!(await this.repos.issues.removeRelated(issue.id, other.id, actorId, now))) {
            return false;
        }
        await this.relatedEvents(issue, other, actorId, 'removed', now);
        return true;
    }

    private async relatedEvents(issue: Issue, other: Issue, actorId: string, change: 'added' | 'removed', now: number) {
        for (const [own, end] of [
            [issue, other],
            [other, issue],
        ] as const) {
            const key = issueKey(end.number);
            await this.event(
                own.id,
                actorId,
                'related',
                change === 'removed' ? key : null,
                change === 'added' ? key : null,
                now,
            );
            await this.repos.issues.touch(own.id, now);
        }
    }

    /**
     * Makes the link between two issues `relation`, from `number`'s side
     * (the side panel's link editor): whatever linked them before is lifted
     * first, in the same unit of work, so a refused blocking link (a cycle,
     * too many blockers) leaves the old link as it was. The same link again
     * changes nothing. Without `blocking` (a member, CB-274) only a related
     * link may be made, and not over a blocking one: that is a triage change.
     */
    async setLink(
        number: number,
        otherNumber: number,
        relation: IssueLinkRelation,
        actorId: string,
        { blocking = true, now = Date.now() }: LinkAccess = {},
    ) {
        await this.uow.run(
            async () => {
                const { issue, other } = await this.linkPair(number, otherNumber);
                const current = await this.relationOf(issue, other);
                if (!blocking && (relation !== 'related' || isBlocking(current))) {
                    throw new IssueError(BLOCKING_ADMINS_ONLY, 403);
                }
                if (current === relation) {
                    return;
                }
                await this.unlinkBetween(issue, other, current, actorId, now);
                if (relation === 'related') {
                    await this.addRelated(number, otherNumber, actorId, now);
                } else if (relation === 'blocked_by') {
                    await this.addBlocker(number, otherNumber, actorId, now);
                } else {
                    await this.addBlocker(otherNumber, number, actorId, now);
                }
            },
            { label: 'set issue link' },
        );
    }

    /**
     * Lifts whatever links the two issues; no error when nothing does.
     * Without `blocking` (a member) only a related link may be lifted.
     */
    async unlink(
        number: number,
        otherNumber: number,
        actorId: string,
        { blocking = true, now = Date.now() }: LinkAccess = {},
    ) {
        await this.uow.run(
            async () => {
                const { issue, blocker: other } = await this.pair(number, otherNumber);
                const current = await this.relationOf(issue, other);
                if (!blocking && isBlocking(current)) {
                    throw new IssueError(BLOCKING_ADMINS_ONLY, 403);
                }
                await this.unlinkBetween(issue, other, current, actorId, now);
            },
            { label: 'remove issue link' },
        );
    }

    private async unlinkBetween(
        issue: Issue,
        other: Issue,
        current: IssueLinkRelation | null,
        actorId: string,
        now: number,
    ) {
        if (current === 'related') {
            await this.unlinkRelated(issue, other, actorId, now);
        } else if (current === 'blocked_by') {
            await this.removeBlocker(issue.number, other.number, actorId, now);
        } else if (current === 'blocks') {
            await this.removeBlocker(other.number, issue.number, actorId, now);
        }
    }

    /**
     * Deletes an issue (CB-64: hides it and keeps everything). Its live
     * comments and attachments are stamped with `deletedWith` issue:<id>;
     * labels, history and, for a Dot request, its key, requesters and
     * notices are read only through it. A new request with the same key
     * opens a new issue; the number is never reused.
     */
    async remove(number: number, actorId: string | null = null, now = Date.now()) {
        await this.uow.run(
            async () => {
                const issue = await this.require(number);
                const parent = deletedWith('issue', issue.id);
                await this.repos.comments.markDeletedWith(issue.id, actorId, parent, now);
                await this.repos.attachments.markDeletedWith({ issueId: issue.id }, actorId, parent, now);
                await this.repos.issues.markDeleted(issue.id, actorId, now);
                await this.event(issue.id, actorId, 'deleted', null, null, now);
                this.bus.publish('removed', { issue, actorId });
            },
            { label: 'delete issue' },
        );
    }

    comments(issueId: string): Promise<IssueComment[]> {
        return this.repos.comments.forIssue(issueId);
    }

    async comment(number: number, id: string): Promise<IssueComment> {
        const issue = await this.require(number);
        const found = (await this.comments(issue.id)).find((comment) => comment.id === id);
        if (!found) {
            throw new IssueError('Comment not found.', 404);
        }
        return found;
    }

    /** Saves a comment, its history row and the issue's new update time. */
    private async saveComment(comment: IssueComment, actorId: string | null) {
        await this.repos.comments.insert(comment);
        await this.event(comment.issueId, actorId, 'comment_added', null, comment.id, comment.createdAt);
        await this.repos.issues.touch(comment.issueId, comment.createdAt);
        return comment;
    }

    async addComment(number: number, text: string, actorId: string, now = Date.now()): Promise<IssueComment> {
        const { body } = commentInput.parse({ body: text });
        return this.uow.run(
            async () => {
                const issue = await this.require(number);
                return this.saveComment(
                    {
                        id: randomUUID(),
                        issueId: issue.id,
                        authorKind: 'user',
                        authorId: actorId,
                        body,
                        createdAt: now,
                        editedAt: null,
                    },
                    actorId,
                );
            },
            { label: 'add comment' },
        );
    }

    /**
     * A comment by an agent or the system (triage, requests), never through the
     * routes. Longer text is cut to the comment limit with a marker.
     */
    async postComment(
        issueId: string,
        authorKind: 'agent' | 'system',
        authorId: string | null,
        text: string,
        now = Date.now(),
    ): Promise<IssueComment> {
        const limit = 10_000;
        const { body } = commentInput.parse({
            body: text.length > limit ? `${text.slice(0, limit - 13)}\n\n[truncated]` : text,
        });
        return this.uow.run(
            () =>
                this.saveComment(
                    {
                        id: randomUUID(),
                        issueId,
                        authorKind,
                        authorId,
                        body,
                        createdAt: now,
                        editedAt: null,
                    },
                    authorId,
                ),
            { label: 'post comment' },
        );
    }

    /** A history row written outside the tracker (a triage proposal's). */
    record(
        issueId: string,
        actorId: string | null,
        kind: IssueEventKind,
        fromValue: string | null,
        toValue: string | null,
        now = Date.now(),
    ) {
        return this.event(issueId, actorId, kind, fromValue, toValue, now);
    }

    async editComment(
        number: number,
        id: string,
        text: string,
        actorId: string,
        now = Date.now(),
    ): Promise<IssueComment> {
        const { body } = commentInput.parse({ body: text });
        return this.uow.run(
            async () => {
                const comment = await this.comment(number, id);
                if (comment.body === body) {
                    return comment;
                }
                await this.repos.comments.edit(id, body, now);
                await this.event(comment.issueId, actorId, 'comment_edited', null, id, now);
                await this.repos.issues.touch(comment.issueId, now);
                return { ...comment, body, editedAt: now };
            },
            { label: 'edit comment' },
        );
    }

    /**
     * Deletes a comment and the files attached to it (CB-64: hides them;
     * the files are stamped with `deletedWith` comment:<id>).
     */
    async deleteComment(number: number, id: string, actorId: string, now = Date.now()) {
        await this.uow.run(
            async () => {
                const comment = await this.comment(number, id);
                await this.repos.attachments.markDeletedWith(
                    { commentId: id },
                    actorId,
                    deletedWith('comment', id),
                    now,
                );
                await this.repos.comments.markDeleted(id, actorId, now);
                await this.event(comment.issueId, actorId, 'comment_deleted', id, null, now);
            },
            { label: 'delete comment' },
        );
    }

    events(issueId: string): Promise<IssueEvent[]> {
        return this.repos.history.forIssue(issueId);
    }

    /** Bounded recorded status history; sequence remains authoritative when timestamps tie. */
    statusEvents(issueId: string, after = 0, limit = 101) {
        if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 101) {
            throw new IssueError('Invalid status history page.');
        }
        return this.repos.history.statusEvents(issueId, after, limit);
    }

    /** The newest history row's position, for reading what a change added. */
    historyCursor() {
        return this.repos.history.lastSeq();
    }

    /** An issue's history rows after `cursor` (`historyCursor`), oldest first. */
    historySince(cursor: number, filter: { issueId: string; kind?: IssueEventKind; actorId?: string }) {
        return this.repos.history.after(cursor, filter);
    }

    attachments(issueId: string): Promise<IssueAttachment[]> {
        return this.repos.attachments.forIssue(issueId);
    }

    attachment(id: string): Promise<StoredAttachment | undefined> {
        return this.repos.attachments.byId(id);
    }

    /** An attachment row, deleted or not, with its bytes (admin, tests). */
    withDeletedAttachment(id: string) {
        return this.repos.attachments.withDeleted(id);
    }

    /**
     * Stores a file on an issue, or on one of its comments. The type comes from
     * the content (see attachments.ts); anything else is refused.
     */
    async addAttachment(
        number: number,
        file: {
            name: string;
            mediaType?: string;
            data: Uint8Array;
            commentId?: string;
        },
        uploaderId: string,
        now = Date.now(),
    ): Promise<IssueAttachment> {
        const issue = await this.require(number);
        if (file.commentId) {
            await this.comment(number, file.commentId);
        }
        const { name, mediaType } = checkAttachment(file.name, file.mediaType, file.data);
        return this.uow.run(
            async () => {
                if ((await this.repos.attachments.liveCount(issue.id)) >= ISSUE_ATTACHMENTS_PER_ISSUE) {
                    throw new IssueError(`An issue can have at most ${ISSUE_ATTACHMENTS_PER_ISSUE} attachments.`, 413);
                }
                const saved = await this.repos.attachments.insert({
                    id: randomUUID(),
                    issueId: issue.id,
                    commentId: file.commentId ?? null,
                    name,
                    mediaType,
                    size: file.data.byteLength,
                    sha256: createHash('sha256').update(file.data).digest('hex'),
                    uploaderId,
                    createdAt: now,
                    data: file.data,
                });
                await this.event(issue.id, uploaderId, 'attachment_added', null, name, now);
                await this.repos.issues.touch(issue.id, now);
                return saved;
            },
            { label: 'add attachment' },
        );
    }

    /** Deletes an attachment (CB-64: hides it and keeps its bytes). */
    async deleteAttachment(id: string, actorId: string, now = Date.now()) {
        await this.uow.run(
            async () => {
                const found = await this.attachment(id);
                if (!found) {
                    throw new IssueError('Attachment not found.', 404);
                }
                await this.repos.attachments.markDeleted(id, actorId, now);
                await this.event(found.issueId, actorId, 'attachment_deleted', found.name, null, now);
            },
            { label: 'delete attachment' },
        );
    }

    /**
     * Imports issues under their own numbers. Idempotent: a number that
     * already exists is skipped and left as it is, deleted ones too (CB-64:
     * a deleted issue is kept; bringing it back is the admin view's). The
     * counter moves past the highest imported number, so new issues
     * continue after it.
     */
    import(drafts: IssueImport[], now = Date.now()): Promise<IssueImportResult> {
        return this.uow.run(
            async () => {
                const result: IssueImportResult = { created: [], skipped: [] };
                for (const draft of drafts) {
                    if (await this.withDeleted(draft.number)) {
                        result.skipped.push(draft.number);
                        continue;
                    }
                    const { number, ...input } = draft;
                    await this.create(input, 'import', now, 'import', number);
                    result.created.push(number);
                }
                return result;
            },
            { label: 'import issues' },
        );
    }
}
