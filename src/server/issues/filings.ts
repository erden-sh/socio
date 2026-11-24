import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { UnitOfWork } from '@socio/data/uow';
import { guessArea } from '@socio/foundation/issues/capability-key';
import {
    addFilingDependencies,
    hasBlockingDependencies,
    linkedIssues,
} from '@socio/foundation/issues/filing-dependencies';
import { patchRefusal } from '@socio/foundation/issues/permissions';
import { DEFAULT_DOT_REQUEST_LIMITS, type DotRequestLimits } from '@socio/foundation/issues/settings';
import {
    DUPLICATE_OVERLAP,
    titleWords as words,
    wordOverlap as overlap,
} from '@socio/foundation/issues/similar-titles';
import { withoutEmails } from '@socio/foundation/issues/without-emails';
import { boardHistoryInput, filingDependencies, issueRef } from '@socio/shared/issues/board-inputs';
import { ISSUE_COMPONENTS_MAX } from '@socio/shared/issues/issue-components';
import {
    CLOSED_ISSUE_STATUSES,
    DOT_FILING_TRIGGERS,
    ISSUE_ATTACHMENTS_PER_ISSUE,
    ISSUE_ATTACHMENT_MAX_BYTES,
    ISSUE_STATUSES,
    ISSUE_PRIORITIES,
    ISSUE_AREAS,
    ISSUE_KINDS,
    type Issue,
    issueKey,
    type DotFiledItem,
    type DotFiling,
    type DotFilingTrigger,
    type IssueAttachment,
    type IssueStatus,
} from '@socio/shared/issues/issue-types';
import { formatSize } from '@socio/shared/text/format-size';
import type { User } from '@socio/shared/types';

import {
    DOT_FILING_FOOTER,
    DOT_FILING_HEADINGS,
    coverage,
    excerptOf,
    matchText,
    queryTerms,
    scoreText,
} from './board-search.js';
import {
    LIST_SORTS,
    type BoardAttachment,
    type BoardComponents,
    type BoardComponentTag,
    type BoardFilings,
    type BoardItem,
    type BoardMatch,
    type BoardNotFound,
    type BoardSearchStatus,
    type IssueFilter,
    type ListSort,
    type TurnFile,
    type DotActionRow,
    IssueError,
} from './contract.js';
import type { BoardRepositories } from './domain/repositories.js';
import { PRIORITY_RANKS } from './domain/rules.js';
import type { IssuePatch, IssueStore } from './store.js';
import type { IssueVotes } from './votes.js';

/** The kinds a Dot may file: an issue, a feature request, an improvement. */

export const DOT_FILING_KINDS = ['bug', 'feature', 'improvement'] as const;

// The board's input schemas and the filing's links live in
// `@socio/shared/issues/board-inputs` and
// `@socio/foundation/issues/filing-dependencies`.

const section = z.string().trim().max(4000);
/** Ids of files shared in the turn's conversation, to copy onto the item. */
const attachmentIds = z.array(z.string().trim().min(1).max(100)).max(ISSUE_ATTACHMENTS_PER_ISSUE);
export const dotFilingInput = z
    .object({
        title: z.string().trim().min(3).max(200),
        kind: z.enum(DOT_FILING_KINDS),
        problem: z.string().trim().min(1).max(4000),
        expected: section.optional(),
        observed: section.optional(),
        suspectedCause: section.optional(),
        proposal: section.optional(),
        workaround: section.optional(),
        /** Links or references the user gave (a page, a message); no secrets. */
        references: section.optional(),
        /** Set after the user saw the possible duplicates and wants it anyway. */
        fileAnyway: z.boolean().optional(),
        attachments: attachmentIds.optional(),
        /**
         * Component refs (CB-442); left out, the plugin or app this
         * conversation works in, when there is exactly one; [] for none.
         */
        components: z.array(z.string().trim().min(1).max(100)).max(ISSUE_COMPONENTS_MAX).optional(),
        ...filingDependencies,
    })
    .strict();
export type DotFilingInput = z.infer<typeof dotFilingInput>;

const numberOf = (ref: string) => Number(/(\d+)$/.exec(ref)![1]);

export const dotCommentInput = z
    .object({
        issue: issueRef,
        comment: z.string().trim().min(1).max(4000),
        impact: section.optional(),
        reproduction: section.optional(),
        affected: section.optional(),
        attachments: attachmentIds.optional(),
    })
    .strict();
export type DotCommentInput = z.infer<typeof dotCommentInput>;

export const dotVoteInput = z.object({ issue: issueRef, withdraw: z.boolean().optional() }).strict();
export type DotVoteInput = z.infer<typeof dotVoteInput>;

/**
 * Edit an item's title and/or description (CB-286): members may edit only
 * their own issues while in triage; admins may edit any issue. At least one
 * of `title` or `body` is required (checked in `DotFilings.edit`).
 */
export const dotEditInput = z
    .object({
        issue: issueRef,
        title: z.string().trim().min(3).max(200).optional(),
        body: z.string().trim().min(1).max(20_000).optional(),
    })
    .strict();
export type DotEditInput = z.infer<typeof dotEditInput>;

/**
 * Change one item's status (CB-520): one explicit item and one of the
 * board's statuses, never several at once.
 */
export const dotStatusInput = z.object({ issue: issueRef, status: z.enum(ISSUE_STATUSES) }).strict();
export type DotStatusInput = z.infer<typeof dotStatusInput>;

export const boardListInput = z
    .object({
        status: z.enum(ISSUE_STATUSES).optional(),
        priority: z.enum(ISSUE_PRIORITIES).optional(),
        area: z.enum(ISSUE_AREAS).optional(),
        kind: z.enum(ISSUE_KINDS).optional(),
        /** A component ref (CB-442): exact match. */
        component: z.string().trim().min(1).max(100).optional(),
        sort: z.enum(LIST_SORTS).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).max(100_000).optional(),
    })
    .strict();
/** The turn a filing comes from: never taken from the model's input. */
export interface DotFilingTurn {
    dotId: string;
    /** The person the Dot acts for this turn. */
    userId: string;
    trigger: DotFilingTrigger;
    /** The goal's id (`goal`) or the task's (`scheduled`); null otherwise. */
    causeId: string | null;
    threadId: string | null;
    /** The turn's run, which a filed item is linked to (CB-194). */
    runId?: string;
    /**
     * The conversation socio grants are bound to (`schedule:<task>` for a
     * scheduled turn); the thread when left out. Prefills components (CB-442).
     */
    conversationId?: string | null;
}

/** What happened to each file a filing or comment asked to attach. */
export interface AttachOutcome {
    attached: Array<{ id: string; name: string }>;
    notAttached: Array<{ id: string; name?: string; reason: string }>;
}

export type DotFilingResult =
    | {
          outcome: 'filed';
          issue: string;
          url: string;
          status: IssueStatus;
          message: string;
          attachments?: AttachOutcome;
          /** The components set on it (CB-442). */
          components?: string[];
      }
    | {
          outcome: 'possible_duplicates';
          matches: BoardMatch[];
          message: string;
      }
    | { outcome: 'rate_limited' | 'forbidden'; message: string };

type NotFound = BoardNotFound;
type RateLimited = { outcome: 'rate_limited'; message: string };
export type DotVoteResult =
    | {
          outcome: 'voted' | 'already_voted' | 'withdrawn' | 'not_voted';
          issue: string;
          url: string;
          votes: number;
          message: string;
      }
    | NotFound
    | RateLimited;
export type DotCommentResult =
    | {
          outcome: 'commented';
          issue: string;
          url: string;
          message: string;
          attachments?: AttachOutcome;
      }
    | NotFound
    | RateLimited;
export type DotEditResult =
    | {
          outcome: 'edited';
          issue: string;
          url: string;
          title: string;
          message: string;
      }
    | { outcome: 'forbidden'; message: string }
    | NotFound;
export type DotStatusResult =
    | {
          outcome: 'updated' | 'unchanged';
          issue: string;
          url: string;
          /** The status the item has now, read back after the change. */
          status: IssueStatus;
          /** The status it had before. */
          from: IssueStatus;
          message: string;
      }
    | { outcome: 'forbidden'; message: string }
    | NotFound;

/** The `issue_dot_actions` rows each limit counts. */
const LIMITED = {
    filing: ['create'],
    comment: ['comment'],
    vote: ['vote', 'unvote'],
} as const;
export type DotBoardAction = keyof typeof LIMITED;

export const DOT_COMMENT_FOOTER =
    '_Added by a socio with `comment_on_improvement`. The socio and the person it acted for are recorded on this comment._';

// The duplicate-title test lives in `@socio/foundation/issues/similar-titles`.
/**
 * Or one whose title's words are nearly all in the new item's title and
 * problem, or the other way round: the description counts too (CB-83).
 */
const DUPLICATE_COVERAGE = 0.75;
const SEARCH_SCORE = 0.1;
/** What `read_improvement` shows of an item's text and comments. */
const DESCRIPTION_CHARS = 4000;
const COMMENT_CHARS = 1500;
const RECENT_COMMENTS = 5;

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const iso = (at: number) => new Date(at).toISOString();

/** Why the store refused a file, as the Dot can tell the person. */
function refusal(error: IssueError) {
    if (error.status === 415) {
        return 'the board takes only PNG, JPEG, GIF or WebP images, PDFs and plain text files';
    }
    if (/at most \d+ attachments/.test(error.message)) {
        return `the item already has ${ISSUE_ATTACHMENTS_PER_ISSUE} attachments, the most the board allows`;
    }
    if (error.status === 413) {
        return `it is over the board’s ${ISSUE_ATTACHMENT_MAX_BYTES / 1048576} MB limit`;
    }
    return error.message;
}

/** The sentences a result adds about the files it was asked to attach. */
function attachNote(outcome: AttachOutcome | undefined) {
    if (!outcome) {
        return '';
    }
    const named = (file: { id: string; name?: string }) => (file.name ? `“${file.name}”` : file.id);
    return [
        '',
        outcome.attached.length ? `Attached ${outcome.attached.map(named).join(', ')}.` : 'Nothing was attached.',
        ...outcome.notAttached.map((file) => `Not attached: ${named(file)} (${file.reason}).`),
        ...(outcome.notAttached.length ? ['Tell the person; never describe those as attached.'] : []),
    ].join(' ');
}

/**
 * Items Dots file on the Improvements board (CB-31). Each one is an issue in
 * triage whose `reporterId` is `dot:<id>`, plus an `issue_dot_actions` row
 * with the Dot and the person it acted for, written in the same transaction
 * and both required by the schema. Rate limited per Dot and per person, with
 * the capability-request limits.
 *
 * Dots also search and read the board, comment with evidence, and vote for
 * the person they act for (CB-83, CB-84). A comment is an `agent` comment
 * by `dot:<id>`; a vote is the person's own vote, with the Dot recorded.
 * Each writes its own `issue_dot_actions` row, with the same attribution,
 * and each has its own count against the same limits.
 */
export class DotFilings implements BoardFilings {
    constructor(
        private uow: UnitOfWork,
        private repos: Pick<BoardRepositories, 'audit' | 'queries'>,
        private issues: IssueStore,
        private votes: IssueVotes,
        private dotOf: (dotId: string) => { name: string; ownerId?: string | null } | undefined,
        /** Whether a person exists and is not deactivated (CB-528). */
        private activePerson: (userId: string) => boolean,
        private canManageDependencies: (userId: string) => boolean = () => false,
        private user: (userId: string) => User | undefined = () => undefined,
        /** Issue components (CB-442); without them, none are read or set. */
        private components?: Pick<BoardComponents, 'view' | 'checkFilter' | 'set' | 'prefill' | 'options'>,
    ) {}

    /** What `userId` may tag (CB-442): refs with their names, for a tool's description. */
    componentChoices(userId: string) {
        return (this.components?.options(userId) ?? []).map(({ ref, label }) => ({
            ref,
            name: withoutEmails(label),
        }));
    }

    /** The components of these issues `userId` may see, as agents read them. */
    private async tagsOf(userId: string, issueIds?: readonly string[]) {
        const tags = new Map<string, BoardComponentTag[]>();
        if (!this.components) {
            return tags;
        }
        const view = await this.components.view(userId, issueIds);
        for (const [issueId, refs] of view.byIssue) {
            tags.set(
                issueId,
                refs.map((ref) => {
                    const label = view.labels[ref]!;
                    return {
                        ref,
                        name: withoutEmails(label.label),
                        ...(label.state === 'live' ? {} : { state: label.state }),
                    };
                }),
            );
        }
        return tags;
    }

    private url(number: number, origin = '') {
        return `${origin.replace(/\/$/, '')}/issues/${issueKey(number)}`;
    }

    /**
     * Live items matching `query` in their title or description, best first,
     * with an excerpt: whole words, word starts, and text inside words (see
     * board-search.ts). `status` picks open (not done or closed), closed or
     * all items. The board is team-shared, so this is the same for every Dot
     * and person.
     */
    async search(
        query: string,
        {
            status = 'all',
            limit = 8,
            origin = '',
        }: { status?: BoardSearchStatus; limit?: number; origin?: string } = {},
    ): Promise<BoardMatch[]> {
        const terms = queryTerms(query);
        if (!terms.length) {
            return [];
        }
        const votes = await this.votes.counts();
        return (await this.issues.texts())
            .filter((item) => {
                if (status === 'all') {
                    return true;
                }
                const closed = CLOSED_ISSUE_STATUSES.includes(item.status);
                return status === 'closed' ? closed : !closed;
            })
            .map((item) => ({
                item,
                score: scoreText(terms, matchText(item.title, item.body)).score,
            }))
            .filter(({ score }) => score >= SEARCH_SCORE)
            .sort((a, b) => b.score - a.score || b.item.number - a.item.number)
            .slice(0, limit)
            .map(({ item }) => ({
                issue: issueKey(item.number),
                title: item.title,
                status: item.status,
                kind: item.kind,
                votes: votes.get(item.id) ?? 0,
                url: this.url(item.number, origin),
                excerpt: withoutEmails(excerptOf(item.body, terms)),
            }));
    }

    /** Every live issue is eligible, including closed states; pages are live views, not snapshots. */
    async list(
        filter: IssueFilter,
        {
            userId,
            sort = 'priority',
            limit = 25,
            offset = 0,
            origin = '',
        }: {
            userId: string;
            sort?: ListSort;
            limit?: number;
            offset?: number;
            origin?: string;
        },
    ) {
        const parsed = boardListInput.parse({ ...filter, sort, limit, offset });
        if (parsed.component) {
            if (!this.components) {
                throw new IssueError(`Unknown component: ${parsed.component}.`);
            }
            await this.components.checkFilter(userId, parsed.component);
        }
        const tags = await this.tagsOf(userId);
        const counts = await this.votes.counts();
        const mine = await this.votes.mine(userId);
        const order: Record<ListSort, (a: Issue, b: Issue) => number> = {
            priority: (a, b) => PRIORITY_RANKS[a.priority] - PRIORITY_RANKS[b.priority] || b.updatedAt - a.updatedAt,
            updated: (a, b) => b.updatedAt - a.updatedAt,
            newest: (a, b) => b.createdAt - a.createdAt,
            votes: (a, b) =>
                (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0) ||
                PRIORITY_RANKS[a.priority] - PRIORITY_RANKS[b.priority],
        };
        const all = (
            await this.issues.list({
                status: parsed.status,
                priority: parsed.priority,
                kind: parsed.kind,
                area: parsed.area,
            })
        )
            .filter((issue) => !parsed.component || !!tags.get(issue.id)?.some((tag) => tag.ref === parsed.component))
            .sort((a, b) => order[sort](a, b) || b.number - a.number);
        const next = offset + limit < all.length ? offset + limit : null;
        return {
            total: all.length,
            offset,
            next,
            complete: next === null,
            enumeration: 'live' as const,
            items: all.slice(offset, offset + limit).map((issue) => ({
                issue: issueKey(issue.number),
                title: withoutEmails(issue.title),
                status: issue.status,
                kind: issue.kind,
                priority: issue.priority,
                area: issue.area,
                labels: issue.labels,
                components: tags.get(issue.id) ?? [],
                votes: counts.get(issue.id) ?? 0,
                personVoted: mine.has(issue.id),
                filedAt: iso(issue.createdAt),
                updatedAt: iso(issue.updatedAt),
                url: this.url(issue.number, origin),
            })),
        };
    }

    /**
     * Open items close to a new one, closest first: titles sharing most
     * words, or either side's title words nearly all in the other's title
     * and description. Connected agents' `file_issue` checks the same
     * (CB-90).
     */
    async duplicates(title: string, problem: string, origin = '') {
        const wanted = words(title);
        const ownTerms = queryTerms(title);
        const own = matchText(title, problem);
        const votes = await this.votes.counts();
        return (await this.issues.texts())
            .filter((item) => !CLOSED_ISSUE_STATUSES.includes(item.status))
            .map((item) => {
                const titleOverlap = overlap(wanted, words(item.title));
                const forward = coverage(ownTerms, matchText(item.title, item.body));
                const backward = coverage(queryTerms(item.title), own);
                const close =
                    titleOverlap >= DUPLICATE_OVERLAP ||
                    forward >= DUPLICATE_COVERAGE ||
                    backward >= DUPLICATE_COVERAGE;
                return {
                    item,
                    close,
                    score: Math.max(titleOverlap, forward, backward),
                };
            })
            .filter(({ close }) => close)
            .sort((a, b) => b.score - a.score || b.item.number - a.item.number)
            .slice(0, 5)
            .map(({ item }) => ({
                issue: issueKey(item.number),
                title: item.title,
                status: item.status,
                kind: item.kind,
                votes: votes.get(item.id) ?? 0,
                url: this.url(item.number, origin),
                excerpt: withoutEmails(excerptOf(item.body, ownTerms)),
            }));
    }

    /** Who filed the issue from a Dot turn, if a Dot did. */
    filing(issueId: string): Promise<DotFiling | undefined> {
        return this.repos.audit.dotFiling(issueId);
    }

    /**
     * The live items a Dot filed for one person, newest first (CB-89: its
     * home page). Only theirs: what it filed for others stays out.
     */
    filedFor(dotId: string, userId: string, limit = 10): Promise<DotFiledItem[]> {
        return this.repos.queries.filedFor(dotId, userId, limit);
    }

    /** The Dot and the person behind each of the issue's Dot comments. */
    async commentAttributions(issueId: string): Promise<Map<string, DotFiling>> {
        return new Map(await this.repos.audit.dotComments(issueId));
    }

    /** The Dot and person behind newly audited history events, by event id. */
    async eventAttributions(issueId: string): Promise<Map<string, DotFiling>> {
        return new Map(await this.repos.audit.dotEvents(issueId));
    }

    /**
     * A person's Dot board actions in [from, to] from scheduled turns with
     * one of these causes (a schedule's task, its goal), oldest first.
     */
    byCause(userId: string, causeIds: readonly string[], from: number, to: number) {
        return this.repos.audit.dotByCause(userId, causeIds, from, to);
    }

    /** A Dot's board actions at or before `before`, newest first (its admin page). */
    activity(dotId: string, before: number, limit: number) {
        return this.repos.audit.dotActivity(dotId, before, limit);
    }

    /** How many items a Dot filed. */
    filedCount(dotId: string) {
        return this.repos.audit.dotFilingCount(dotId);
    }

    /**
     * Board actions in the window by this Dot, and for this person: items
     * filed (the default), comments, or votes cast and withdrawn.
     */
    async usage(dotId: string, userId: string, windowMs: number, now = Date.now(), action: DotBoardAction = 'filing') {
        const actions = LIMITED[action];
        const since = now - windowMs;
        return {
            byDot: await this.repos.audit.dotCountSince(actions, { dotId }, since),
            byUser: await this.repos.audit.dotCountSince(actions, { userId }, since),
        };
    }

    /** The limit's refusal for `action`, or undefined while under it. */
    private async limited(
        turn: DotFilingTurn,
        action: DotBoardAction,
        limits: DotRequestLimits,
        now: number,
    ): Promise<RateLimited | undefined> {
        const { byDot, byUser } = await this.usage(turn.dotId, turn.userId, limits.windowMs, now, action);
        if (byDot < limits.perDot && byUser < limits.perUser) {
            return undefined;
        }
        const [things, done, nothing, self] = {
            filing: ['items', 'filed', 'Nothing was filed', 'file it'],
            comment: ['comments', 'added', 'Nothing was added', 'comment'],
            vote: ['votes', 'changed', 'Nothing changed', 'vote'],
        }[action];
        const rest = `${nothing}; try again tomorrow, or ask the person to ${self} on the board.`;
        return {
            outcome: 'rate_limited',
            message:
                byDot >= limits.perDot
                    ? `This socio has ${done} ${byDot} ${things} in the last day, the limit. ${rest}`
                    : `${byUser} ${things} were ${done} for this person in the last day, the limit. ${rest}`,
        };
    }

    /**
     * The live Dot acting for a real, active person (never a deactivated
     * one, CB-528), or an error: a person's own Dot acts only for its
     * owner, and a scheduled turn names its cause.
     */
    private actor(turn: DotFilingTurn) {
        if (!DOT_FILING_TRIGGERS.includes(turn.trigger)) {
            throw new IssueError('Unknown trigger for a socio action.');
        }
        const dot = turn.dotId ? this.dotOf(turn.dotId) : undefined;
        if (!dot) {
            throw new IssueError('Acting on the board needs a live socio.');
        }
        if (!turn.userId || !this.activePerson(turn.userId)) {
            throw new IssueError('Acting on the board needs the person the socio acts for.');
        }
        // A person's own Dot works only for them.
        if (dot.ownerId && dot.ownerId !== turn.userId) {
            throw new IssueError('A person’s own socio acts only for them.');
        }
        if ((turn.trigger === 'goal' || turn.trigger === 'scheduled') && !turn.causeId) {
            throw new IssueError('A scheduled socio action needs its goal or task.');
        }
        return dot;
    }

    private record(
        action: DotActionRow['action'],
        issueId: string,
        targetId: string | null,
        turn: DotFilingTurn,
        dot: { ownerId?: string | null },
        now: number,
    ) {
        return this.repos.audit.recordDot({
            id: randomUUID(),
            issueId,
            action,
            targetId,
            dotId: turn.dotId,
            dotOwnerId: dot.ownerId ?? null,
            userId: turn.userId,
            trigger: turn.trigger,
            causeId: turn.causeId,
            threadId: turn.threadId,
            createdAt: now,
        });
    }

    private notFound(ref: string): NotFound {
        return {
            outcome: 'not_found',
            message: `There is no ${issueKey(numberOf(ref))} on the board (it may have been deleted). Search for it with search_improvements.`,
        };
    }

    /**
     * One live item for a Dot: its fields, vote count (and whether the person
     * it acts for voted), description and newest comments. Emails are taken
     * out; authors are told apart without names: the person the Dot acts
     * for, another person, a Dot (by name) and for whom, or an agent.
     */
    async item(
        ref: string,
        {
            userId,
            origin = '',
            historyAfter = 0,
            historyLimit = 100,
        }: {
            userId: string;
            origin?: string;
            historyAfter?: number;
            historyLimit?: number;
        },
    ): Promise<BoardItem | NotFound> {
        const issue = await this.issues.get(numberOf(issueRef.parse(ref)));
        if (!issue) {
            return this.notFound(ref);
        }
        const historyPage = z.object(boardHistoryInput).parse({ historyAfter, historyLimit });
        const recorded = await this.issues.statusEvents(issue.id, historyPage.historyAfter, historyLimit + 1);
        const page = recorded.slice(0, historyLimit);
        const statusHistory = {
            events: page.map((event) => ({ ...event, at: iso(event.at) })),
            next: recorded.length > historyLimit ? page.at(-1)!.sequence : null,
            complete: recorded.length <= historyLimit,
            coverage: 'recorded-only' as const,
            order: 'sequence' as const,
        };
        const comments = await this.issues.comments(issue.id);
        const dots = await this.commentAttributions(issue.id);
        const url = this.url(issue.number, origin);
        const files = await this.issues.attachments(issue.id);
        const listed = (commentId: string | null): BoardAttachment[] =>
            files
                .filter((file) => file.commentId === commentId)
                .map((file: IssueAttachment) => ({
                    name: withoutEmails(file.name),
                    type: file.mediaType,
                    size: formatSize(file.size),
                    url,
                }));
        const person = (id: string) => (id === userId ? 'the person you act for' : 'another person');
        const link = (other: { number: number; title: string; status: IssueStatus }) => ({
            issue: issueKey(other.number),
            title: withoutEmails(other.title),
            status: other.status,
        });
        const author = (comment: (typeof comments)[number]) => {
            const dot = dots.get(comment.id);
            if (dot) {
                return `Socio “${this.dotOf(dot.dotId)?.name ?? 'a socio'}” for ${person(dot.userId)}`;
            }
            if (comment.authorKind === 'system') {
                return 'Socio';
            }
            if (comment.authorKind === 'agent') {
                return 'an agent run';
            }
            return comment.authorId ? person(comment.authorId) : 'another person';
        };
        return {
            outcome: 'found',
            issue: issueKey(issue.number),
            url,
            title: withoutEmails(issue.title),
            status: issue.status,
            kind: issue.kind,
            priority: issue.priority,
            area: issue.area,
            components: (await this.tagsOf(userId, [issue.id])).get(issue.id) ?? [],
            resolution: issue.resolution && withoutEmails(issue.resolution),
            votes: await this.votes.count(issue.id),
            personVoted: await this.votes.has(issue.id, userId),
            filedAt: iso(issue.createdAt),
            updatedAt: iso(issue.updatedAt),
            description: cut(withoutEmails(issue.body), DESCRIPTION_CHARS),
            statusHistory,
            blockedBy: (await this.issues.blockedBy(issue.id)).map(link),
            blocks: (await this.issues.blocks(issue.id)).map(link),
            related: (await this.issues.related(issue.id)).map(link),
            attachments: listed(null),
            comments: {
                total: comments.length,
                recent: comments.slice(-RECENT_COMMENTS).map((comment) => ({
                    author: author(comment),
                    at: iso(comment.createdAt),
                    text: cut(withoutEmails(comment.body), COMMENT_CHARS),
                    attachments: listed(comment.id),
                })),
            },
        };
    }

    /**
     * Copies the turn's files onto item `number`, or onto one of its
     * comments, through the store's attachment path (its type and size
     * checks and the per-item cap), uploaded by the person the Dot acts for.
     * Each file is refused on its own; the rest still go on.
     */
    private async attach(
        number: number,
        files: readonly TurnFile[] | undefined,
        userId: string,
        now: number,
        commentId?: string,
    ): Promise<AttachOutcome | undefined> {
        if (!files?.length) {
            return undefined;
        }
        const outcome: AttachOutcome = { attached: [], notAttached: [] };
        for (const file of files) {
            if ('reason' in file) {
                outcome.notAttached.push(file);
                continue;
            }
            try {
                const saved = await this.issues.addAttachment(
                    number,
                    { name: file.name, data: file.data, commentId },
                    userId,
                    now,
                );
                outcome.attached.push({ id: file.id, name: saved.name });
            } catch (error) {
                if (!(error instanceof IssueError)) {
                    throw error;
                }
                outcome.notAttached.push({
                    id: file.id,
                    name: file.name,
                    reason: refusal(error),
                });
            }
        }
        return outcome;
    }

    /**
     * Votes for an item, or withdraws the vote, as the person `turn` acts
     * for: one vote per person, whoever cast it, so a vote they already have
     * changes nothing. Each change is rate limited and recorded with the Dot.
     */
    async vote(
        turn: DotFilingTurn,
        input: DotVoteInput,
        {
            limits = DEFAULT_DOT_REQUEST_LIMITS,
            origin = '',
            now = Date.now(),
        }: { limits?: DotRequestLimits; origin?: string; now?: number } = {},
    ): Promise<DotVoteResult> {
        const data = dotVoteInput.parse(input);
        const dot = this.actor(turn);
        return this.uow.run(
            async (): Promise<DotVoteResult> => {
                const issue = await this.issues.get(numberOf(data.issue));
                if (!issue) {
                    return this.notFound(data.issue);
                }
                const key = issueKey(issue.number);
                const url = this.url(issue.number, origin);
                const had = await this.votes.has(issue.id, turn.userId);
                const answer = async (
                    outcome: 'voted' | 'already_voted' | 'withdrawn' | 'not_voted',
                    message: string,
                ): Promise<DotVoteResult> => ({
                    outcome,
                    issue: key,
                    url,
                    votes: await this.votes.count(issue.id),
                    message,
                });
                if (!data.withdraw && had) {
                    return answer('already_voted', `The person has already voted for ${key}; nothing changed.`);
                }
                if (data.withdraw && !had) {
                    return answer('not_voted', `The person has no vote on ${key}; nothing changed.`);
                }
                const refused = await this.limited(turn, 'vote', limits, now);
                if (refused) {
                    return refused;
                }
                if (data.withdraw) {
                    const id = (await this.votes.withdraw(issue.id, turn.userId, now))!;
                    await this.record('unvote', issue.id, id, turn, dot, now);
                    return answer('withdrawn', `Withdrew the person’s vote on ${key}.`);
                }
                const id = (await this.votes.cast(issue.id, turn.userId, turn.dotId, now))!;
                await this.record('vote', issue.id, id, turn, dot, now);
                return answer('voted', `Voted for ${key} for the person.`);
            },
            { label: 'socio vote' },
        );
    }

    /**
     * Adds the person's evidence to an item as a comment: what they want
     * said, and optionally the impact, how to reproduce it and who is
     * affected. An `agent` comment by `dot:<id>`, recorded with the person;
     * `files` (read from `input.attachments`) go on the comment.
     */
    async comment(
        turn: DotFilingTurn,
        input: DotCommentInput,
        {
            limits = DEFAULT_DOT_REQUEST_LIMITS,
            origin = '',
            now = Date.now(),
            files,
        }: {
            limits?: DotRequestLimits;
            origin?: string;
            now?: number;
            files?: readonly TurnFile[];
        } = {},
    ): Promise<DotCommentResult> {
        const data = dotCommentInput.parse(input);
        const dot = this.actor(turn);
        return this.uow.run(
            async (): Promise<DotCommentResult> => {
                const issue = await this.issues.get(numberOf(data.issue));
                if (!issue) {
                    return this.notFound(data.issue);
                }
                const refused = await this.limited(turn, 'comment', limits, now);
                if (refused) {
                    return refused;
                }
                const parts: Array<[string, string | undefined]> = [
                    ['Impact', data.impact],
                    ['Reproduction (as reported)', data.reproduction],
                    ['Who is affected', data.affected],
                ];
                const body = withoutEmails(
                    [
                        data.comment,
                        ...parts
                            .filter((part): part is [string, string] => !!part[1])
                            .map(([heading, text]) => `**${heading}**\n\n${text}`),
                        DOT_COMMENT_FOOTER,
                    ].join('\n\n'),
                );
                const comment = await this.issues.postComment(issue.id, 'agent', `dot:${turn.dotId}`, body, now);
                await this.record('comment', issue.id, comment.id, turn, dot, now);
                const attachments = await this.attach(issue.number, files, turn.userId, now, comment.id);
                const key = issueKey(issue.number);
                return {
                    outcome: 'commented',
                    issue: key,
                    url: this.url(issue.number, origin),
                    message: `Added the comment to ${key}.${attachNote(attachments)}`,
                    ...(attachments ? { attachments } : {}),
                };
            },
            { label: 'socio comment' },
        );
    }

    /**
     * Files an item for `turn`: refused without both identities, shown the
     * close open items first unless `fileAnyway`, rate limited. A refusal is a
     * result, not an error, so the Dot can tell the person. `files` (read
     * from `input.attachments`) go on the new item.
     */
    async file(
        turn: DotFilingTurn,
        input: DotFilingInput,
        {
            limits = DEFAULT_DOT_REQUEST_LIMITS,
            origin = '',
            now = Date.now(),
            files,
        }: {
            limits?: DotRequestLimits;
            origin?: string;
            now?: number;
            files?: readonly TurnFile[];
        } = {},
    ): Promise<DotFilingResult> {
        const data = dotFilingInput.parse(input);
        const dot = this.actor(turn);
        if (hasBlockingDependencies(data) && !this.canManageDependencies(turn.userId)) {
            return {
                outcome: 'forbidden',
                message:
                    'Only an admin can set blocking links (blockedBy, blocks). Nothing was filed; related links are fine.',
            };
        }
        if (data.components?.length) {
            const options = new Set((this.components?.options(turn.userId) ?? []).map((option) => option.ref));
            const unknown = data.components.filter((ref) => !options.has(ref));
            if (unknown.length) {
                return {
                    outcome: 'forbidden',
                    message: `Unknown component: ${unknown.join(', ')}. Nothing was filed. Choose from: ${[...options].join(', ') || 'none'}.`,
                };
            }
        }
        return this.uow.run(
            async (): Promise<DotFilingResult> => {
                if (!data.fileAnyway) {
                    const matches = await this.duplicates(data.title, data.problem, origin);
                    if (matches.length) {
                        return {
                            outcome: 'possible_duplicates',
                            matches,
                            message:
                                'Nothing was filed: these open items look close. Show them to the person. If none is the same, call file_improvement again with fileAnyway: true; if one is, link it instead (you can vote for it or add their evidence as a comment, if they want).',
                        };
                    }
                }
                const refused = await this.limited(turn, 'filing', limits, now);
                if (refused) {
                    return refused;
                }
                const [problem, expected, observed, cause, proposal, workaround, refs] = DOT_FILING_HEADINGS;
                const parts: Array<[string, string | undefined]> = [
                    [problem, data.problem],
                    [expected, data.expected],
                    [observed, data.observed],
                    [cause, data.suspectedCause],
                    [proposal, data.proposal],
                    [workaround, data.workaround],
                    [refs, data.references],
                ];
                const body = withoutEmails(
                    [
                        ...parts
                            .filter((part): part is [string, string] => !!part[1])
                            .map(([heading, text]) => `**${heading}**\n\n${text}`),
                        DOT_FILING_FOOTER,
                    ].join('\n\n'),
                );
                const issue = await this.issues.create(
                    {
                        title: withoutEmails(data.title),
                        body,
                        kind: data.kind,
                        area: guessArea(`${data.title} ${data.problem}`),
                        status: 'triage',
                        priority: 'medium',
                    },
                    `dot:${turn.dotId}`,
                    now,
                    'dot',
                );
                // As the person the socio acts for may tag (CB-442): theirs to see.
                const components =
                    data.components ??
                    this.components?.prefill({
                        personId: turn.userId,
                        socioId: turn.dotId,
                        conversationId: turn.conversationId ?? turn.threadId,
                    }) ??
                    [];
                if (components.length) {
                    if (!this.components) {
                        throw new IssueError(`Unknown component: ${components[0]}.`);
                    }
                    await this.components.set(issue.id, components, {
                        actorId: `dot:${turn.dotId}`,
                        viewerId: turn.userId,
                        now,
                        initial: true,
                    });
                }
                const dependencyCursor = await this.issues.historyCursor();
                await addFilingDependencies(this.issues, issue.number, data, `dot:${turn.dotId}`, now);
                // Attribute only events created by this filing transaction. Historical
                // events retain their original provenance, even on the same linked item.
                const affected = [issue, ...(await linkedIssues(this.issues, issue.id))];
                for (const ref of affected) {
                    const linked = await this.issues.require(ref.number);
                    for (const event of await this.issues.historySince(dependencyCursor, {
                        issueId: linked.id,
                    })) {
                        await this.record('update', linked.id, event.id, turn, dot, now);
                    }
                }
                await this.record('create', issue.id, null, turn, dot, now);
                // The turn it was filed in (CB-194).
                if (turn.runId && turn.threadId) {
                    await this.issues.linkRun(
                        issue.id,
                        {
                            runId: turn.runId,
                            threadId: turn.threadId,
                            via: 'socio',
                            linkedBy: `dot:${turn.dotId}`,
                        },
                        now,
                    );
                }
                const attachments = await this.attach(issue.number, files, turn.userId, now);
                return {
                    outcome: 'filed',
                    issue: issueKey(issue.number),
                    url: this.url(issue.number, origin),
                    status: issue.status,
                    message: `Filed ${issueKey(issue.number)} on the Improvements board, in triage.${components.length ? ` Components: ${components.join(', ')}${data.components === undefined ? ' (from this conversation; tell the person)' : ''}.` : ''}${attachNote(attachments)}`,
                    ...(components.length ? { components } : {}),
                    ...(attachments ? { attachments } : {}),
                };
            },
            { label: 'socio filing' },
        );
    }

    /**
     * Edits an item's title and/or description (CB-286) for the person `turn`
     * acts for: members may edit only their own issues while they are in
     * triage; admins may edit any issue. Reuses the routes' permission check
     * (`patchRefusal`); the actor is the person, not the Dot. Records the
     * Dot and the person on each history event the edit adds.
     */
    async edit(
        turn: DotFilingTurn,
        input: DotEditInput,
        { origin = '', now = Date.now() }: { origin?: string; now?: number } = {},
    ): Promise<DotEditResult> {
        const data = dotEditInput.parse(input);
        if (data.title === undefined && data.body === undefined) {
            throw new IssueError('Provide a title or body to edit.');
        }
        const dot = this.actor(turn);
        const user = this.user(turn.userId);
        return this.uow.run(
            async (): Promise<DotEditResult> => {
                const issue = await this.issues.get(numberOf(data.issue));
                if (!issue) {
                    return this.notFound(data.issue);
                }
                if (!user) {
                    return {
                        outcome: 'forbidden',
                        message: 'Only an admin can change this.',
                    };
                }
                const patch: IssuePatch = {};
                if (data.title !== undefined) {
                    patch.title = withoutEmails(data.title);
                }
                if (data.body !== undefined) {
                    patch.body = withoutEmails(data.body);
                }
                const refused = patchRefusal(user, issue, patch);
                if (refused) {
                    return { outcome: 'forbidden', message: refused };
                }
                const cursor = await this.issues.historyCursor();
                const updated = await this.issues.update(issue.number, patch, turn.userId, now);
                for (const event of await this.issues.historySince(cursor, {
                    issueId: issue.id,
                    actorId: turn.userId,
                })) {
                    await this.record('update', issue.id, event.id, turn, dot, now);
                }
                const key = issueKey(updated.number);
                return {
                    outcome: 'edited',
                    issue: key,
                    url: this.url(updated.number, origin),
                    title: withoutEmails(updated.title),
                    message: `Edited ${key} for the person.`,
                };
            },
            { label: 'socio edit' },
        );
    }

    /**
     * Changes an item's status (CB-520) for the person `turn` acts for,
     * through the same check and store write as the board's own status
     * change (`patchRefusal`, `IssueStore.update`): only what the person's
     * role allows, so a member's change comes back forbidden. The history
     * row is the person's, with the Dot recorded for it. Setting the status
     * the item already has changes nothing and records nothing.
     */
    async setStatus(
        turn: DotFilingTurn,
        input: DotStatusInput,
        { origin = '', now = Date.now() }: { origin?: string; now?: number } = {},
    ): Promise<DotStatusResult> {
        const data = dotStatusInput.parse(input);
        const dot = this.actor(turn);
        const user = this.user(turn.userId);
        return this.uow.run(
            async (): Promise<DotStatusResult> => {
                const issue = await this.issues.get(numberOf(data.issue));
                if (!issue) {
                    return this.notFound(data.issue);
                }
                if (!user) {
                    return { outcome: 'forbidden', message: 'Only an admin can change this.' };
                }
                const patch: IssuePatch = { status: data.status };
                const refused = patchRefusal(user, issue, patch);
                if (refused) {
                    return {
                        outcome: 'forbidden',
                        message: `${refused} The status of ${issueKey(issue.number)} was not changed.`,
                    };
                }
                const key = issueKey(issue.number);
                const url = this.url(issue.number, origin);
                if (issue.status === data.status) {
                    return {
                        outcome: 'unchanged',
                        issue: key,
                        url,
                        status: issue.status,
                        from: issue.status,
                        message: `${key} is already ${issue.status}; nothing changed.`,
                    };
                }
                const cursor = await this.issues.historyCursor();
                const updated = await this.issues.update(issue.number, patch, turn.userId, now);
                for (const event of await this.issues.historySince(cursor, {
                    issueId: issue.id,
                    actorId: turn.userId,
                })) {
                    await this.record('update', issue.id, event.id, turn, dot, now);
                }
                return {
                    outcome: updated.status === issue.status ? 'unchanged' : 'updated',
                    issue: key,
                    url,
                    status: updated.status,
                    from: issue.status,
                    message:
                        updated.status === data.status
                            ? `Moved ${key} from ${issue.status} to ${updated.status} for the person.`
                            : `${key} is ${updated.status}, not ${data.status}; tell the person it did not change as asked.`,
                };
            },
            { label: 'socio status change' },
        );
    }
}
