import { z } from 'zod';

import type { DataContext } from '@socio/data/uow';
import type { AgentActor } from '@socio/foundation/agents/actor';
import { inspectAttachment } from '@socio/foundation/issues/attachments';
import { guessArea } from '@socio/foundation/issues/capability-key';
import {
    addFilingDependencies,
    hasBlockingDependencies,
    linkedIssues,
} from '@socio/foundation/issues/filing-dependencies';
import { createRefusal, patchRefusal } from '@socio/foundation/issues/permissions';
import { withoutEmails } from '@socio/foundation/issues/without-emails';
import { filingDependencies, issueRef } from '@socio/shared/issues/board-inputs';
import { ISSUE_COMPONENTS_MAX } from '@socio/shared/issues/issue-components';
import {
    ISSUE_ATTACHMENT_MAX_BYTES,
    ISSUE_ATTACHMENTS_PER_ISSUE,
    ISSUE_AREAS,
    ISSUE_KINDS,
    ISSUE_LABELS,
    ISSUE_PRIORITIES,
    ISSUE_STATUSES,
    issueKey,
    type Issue,
    type IssueArea,
    type IssueAttachment,
    type IssueKind,
    type IssuePriority,
    type IssueStatus,
} from '@socio/shared/issues/issue-types';
import { isAdmin } from '@socio/shared/roles';
import type { User } from '@socio/shared/types';

import {
    IssueError,
    type BoardSearchStatus,
    type BoardShape,
    type IssueInput,
    type IssuePatch,
    type ListSort,
} from '../issues/contract.js';
import type { PageStoreShape } from '../pages/contract.js';
import type { SpaceAccessShape } from '../spaces/contract.js';
import type { AuditShape, PeopleShape } from '../workspace/contract.js';

/**
 * The parts of the workspace connected agents' tools read: its people, its
 * audit, its connection's unit of work, its pages and its Space access,
 * each typed by its owner's contract. `WorkspaceStore` satisfies it.
 */
export interface AgentsWorkspace extends Pick<PeopleShape, 'users' | 'isDeactivated'>, Pick<AuditShape, 'audit'> {
    readonly data: DataContext;
    readonly pages: PageStoreShape;
    readonly spaceAccess: SpaceAccessShape;
}

/** What a connected agent may file: everything but a Dot's `request`. */
export const AGENT_FILING_KINDS = ISSUE_KINDS.filter(
    (kind): kind is Exclude<IssueKind, 'request'> => kind !== 'request',
);

/**
 * What read_issue sends of an item's images, as image content: the newest
 * first, at most this many and this many bytes in all (one full-size
 * upload). The rest are listed, with why, for read_issue_attachment.
 */
export const READ_IMAGES_MAX = 5;
export const READ_IMAGES_MAX_BYTES = ISSUE_ATTACHMENT_MAX_BYTES;
/** How much of a text attachment read_issue_attachment gives. */
const ATTACHMENT_TEXT_CHARS = 20_000;
/** Base64 of an upload at the size limit, with room to say it's too big. */
const ATTACHMENT_DATA_CHARS = Math.ceil(ISSUE_ATTACHMENT_MAX_BYTES / 3) * 4 + 1024;

/** Files an agent sends with a filing or a comment, as base64. */
export const agentAttachments = z
    .array(
        z
            .object({
                name: z.string().trim().min(1).max(255),
                mediaType: z.string().trim().min(1).max(100),
                data: z
                    .string()
                    .max(ATTACHMENT_DATA_CHARS)
                    .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'Give the file as base64.'),
            })
            .strict(),
    )
    .max(ISSUE_ATTACHMENTS_PER_ISSUE);
export type AgentAttachmentInput = z.infer<typeof agentAttachments>[number];

/** Component refs an agent sends (CB-442); checked against the person's options. */
export const agentComponents = z.array(z.string().trim().min(1).max(100)).max(ISSUE_COMPONENTS_MAX);

export const agentFilingInput = z
    .object({
        title: z.string().trim().min(3).max(200),
        kind: z.enum(AGENT_FILING_KINDS),
        description: z.string().trim().min(1).max(20_000),
        priority: z.enum(ISSUE_PRIORITIES).optional(),
        area: z.enum(ISSUE_AREAS).optional(),
        /** Set after the person saw the possible duplicates and wants it anyway. */
        force: z.boolean().optional(),
        attachments: agentAttachments.optional(),
        /** Component refs (CB-442), from the person's options. */
        components: agentComponents.optional(),
        ...filingDependencies,
    })
    .strict();
export const agentUpdateInput = z
    .object({
        issue: issueRef,
        status: z.enum(ISSUE_STATUSES).optional(),
        priority: z.enum(ISSUE_PRIORITIES).optional(),
        area: z.enum(ISSUE_AREAS).nullable().optional(),
        kind: z.enum(ISSUE_KINDS).optional(),
        /** `me`, a person's id or their exact name; null to unassign. */
        assignee: z.string().trim().min(1).max(100).nullable().optional(),
        labels: z.array(z.enum(ISSUE_LABELS)).max(ISSUE_LABELS.length).optional(),
        resolution: z.string().trim().max(500).nullable().optional(),
        /** The components the person may see, replacing those (CB-442); others stay. */
        components: agentComponents.optional(),
    })
    .strict();

type Forbidden = { outcome: 'forbidden'; message: string };
type NotFound = { outcome: 'not_found'; message: string };

const numberOf = (ref: string) => Number(/(\d+)$/.exec(issueRef.parse(ref))![1]);
const iso = (at: number) => new Date(at).toISOString();
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/**
 * The board as a connected agent works it (CB-90): always as its person,
 * through the checks the web routes use, so it can never do more than they
 * could. Every record it makes is the person's (reporter, comment author,
 * vote, history actor), and each write also records the agent, in the same
 * transaction. Text it reads comes without emails or other people's names,
 * as a Dot reads it (DotFilings.item).
 */
export class AgentBoard {
    constructor(
        private workspace: AgentsWorkspace,
        private board: BoardShape,
    ) {}

    private get issues() {
        return this.board.issues;
    }

    /** One unit of work on the workspace's connection (CB-110). */
    private transaction<T>(work: () => Promise<T>, label: string) {
        return this.workspace.data.uow.run(work, { label });
    }

    private url(number: number, origin: string) {
        return `${origin.replace(/\/$/, '')}/issues/${issueKey(number)}`;
    }

    private notFound(ref: string): NotFound {
        return {
            outcome: 'not_found',
            message: `There is no ${issueKey(numberOf(ref))} on the board (it may have been deleted). Find it with search_issues.`,
        };
    }

    /** The board search Dots use (board-search.ts): open, closed or all. */
    async search(query: string, options: { status?: BoardSearchStatus; limit?: number; origin?: string }) {
        return { matches: await this.board.filings.search(query, options) };
    }

    /** One item, as a Dot reads it, with its labels and who it's assigned to. */
    async read(ref: string, person: User, origin = '', history: { historyAfter?: number; historyLimit?: number } = {}) {
        const item = await this.board.filings.item(ref, {
            userId: person.id,
            origin,
            ...history,
        });
        if (item.outcome !== 'found') {
            return item;
        }
        const issue = await this.issues.require(numberOf(ref));
        return {
            ...item,
            labels: issue.labels,
            assignee: !issue.assigneeId
                ? null
                : issue.assigneeId === person.id
                  ? 'the person you act for'
                  : 'another person',
            ...(await this.attachmentList(issue, person, origin)),
        };
    }

    private attachmentUrl(id: string, origin: string) {
        return `${origin.replace(/\/$/, '')}/api/issue-attachments/${id}`;
    }

    /** An attachment as agents see it: no uploader's name, no emails. */
    private describe(file: IssueAttachment, person: User, origin: string, commentAt?: Map<string, number>) {
        const at = file.commentId ? commentAt?.get(file.commentId) : undefined;
        return {
            id: file.id,
            name: withoutEmails(file.name),
            mediaType: file.mediaType,
            size: file.size,
            on: file.commentId ? ('comment' as const) : ('item' as const),
            // Matches that comment's `at` in read_issue's comments.
            ...(at === undefined ? {} : { commentAt: iso(at) }),
            addedAt: iso(file.createdAt),
            addedBy: file.uploaderId === person.id ? 'the person you act for' : 'another person',
            url: this.attachmentUrl(file.id, origin),
        };
    }

    /**
     * The item's and its comments' files, newest first (all of them, so
     * this list takes the place of the item-only one `filings.item` may
     * give), and which images
     * read_issue sends: newest first within READ_IMAGES_MAX and
     * READ_IMAGES_MAX_BYTES; each one left out says why.
     */
    private async attachmentList(issue: Issue, person: User, origin: string) {
        const files = (await this.issues.attachments(issue.id)).reverse();
        const commentAt = new Map(
            (await this.issues.comments(issue.id)).map((comment) => [comment.id, comment.createdAt]),
        );
        const sent: string[] = [];
        const leftOut: Array<{ id: string; reason: string }> = [];
        let bytes = 0;
        for (const file of files) {
            if (!file.mediaType.startsWith('image/')) {
                continue;
            }
            if (sent.length >= READ_IMAGES_MAX) {
                leftOut.push({
                    id: file.id,
                    reason: `Only the newest ${READ_IMAGES_MAX} images are sent.`,
                });
            } else if (bytes + file.size > READ_IMAGES_MAX_BYTES) {
                leftOut.push({
                    id: file.id,
                    reason: `The images sent are at most ${READ_IMAGES_MAX_BYTES / 1024 / 1024} MB in all.`,
                });
            } else {
                sent.push(file.id);
                bytes += file.size;
            }
        }
        return {
            attachments: files.map((file) => this.describe(file, person, origin, commentAt)),
            images: {
                sent,
                leftOut,
                ...(files.length
                    ? {
                          note: 'The images in sent follow this text, in that order. Read any other attachment with read_issue_attachment.',
                      }
                    : {}),
            },
        };
    }

    /**
     * One live attachment of a live item, with its bytes when it is an
     * image and its text (no emails) when it is text; else metadata only.
     */
    async attachment(id: string, person: User, origin = '') {
        const file = await this.issues.attachment(id);
        const issue = file && (await this.issues.byId(file.issueId));
        if (!file || !issue) {
            return {
                result: {
                    outcome: 'not_found',
                    message:
                        'There is no attachment with this id (it may have been deleted). read_issue lists an item’s attachments.',
                } as NotFound,
            };
        }
        const commentAt = file.commentId
            ? new Map([[file.commentId, (await this.issues.comment(issue.number, file.commentId)).createdAt]])
            : undefined;
        const found = {
            outcome: 'found' as const,
            issue: issueKey(issue.number),
            ...this.describe(file, person, origin, commentAt),
        };
        if (file.mediaType.startsWith('image/')) {
            return {
                result: { ...found, content: 'image' as const },
                image: { data: file.data, mimeType: file.mediaType },
            };
        }
        if (file.mediaType === 'text/plain') {
            const text = new TextDecoder().decode(file.data);
            return {
                result: {
                    ...found,
                    content: 'text' as const,
                    text: cut(withoutEmails(text), ATTACHMENT_TEXT_CHARS),
                    truncated: text.length > ATTACHMENT_TEXT_CHARS,
                },
            };
        }
        return {
            result: {
                ...found,
                content: 'metadata only' as const,
                message: `A ${file.mediaType} file is not sent to agents; the person can open it at url.`,
            },
        };
    }

    /**
     * Decodes and checks every file before anything is written, so a bad
     * one fails the whole call: the type and size checks of the web upload
     * (attachments.ts) and room under the per-item cap.
     */
    private checkFiles(files: AgentAttachmentInput[] | undefined, existing = 0) {
        if (!files?.length) {
            return [];
        }
        const room = ISSUE_ATTACHMENTS_PER_ISSUE - existing;
        if (files.length > room) {
            throw new IssueError(
                `Nothing was written: an item can have at most ${ISSUE_ATTACHMENTS_PER_ISSUE} attachments${existing ? `, and this one has ${existing}` : ''}, so at most ${Math.max(room, 0)} more.`,
                413,
            );
        }
        return files.map((file) => {
            const data = Buffer.from(file.data, 'base64');
            const checked = inspectAttachment(file.name, file.mediaType, data);
            if (checked.refused) {
                throw new IssueError(
                    `Nothing was written: “${cut(file.name, 80)}” was refused. ${checked.message}`,
                    checked.status,
                );
            }
            return { name: file.name, mediaType: file.mediaType, data };
        });
    }

    /**
     * Stores checked files as the person's, on the item or one comment;
     * each one's history row is recorded with the agent, as an update.
     */
    private async attach(
        actor: AgentActor,
        person: User,
        issue: Issue,
        files: ReturnType<AgentBoard['checkFiles']>,
        commentId: string | undefined,
        now: number,
    ) {
        if (!files.length) {
            return undefined;
        }
        const { agentActions } = this.board;
        // The history rows the uploads add, by their position.
        const cursor = await this.issues.historyCursor();
        const made = [];
        for (const file of files) {
            made.push(
                await this.issues.addAttachment(
                    issue.number,
                    { ...file, ...(commentId ? { commentId } : {}) },
                    person.id,
                    now,
                ),
            );
        }
        const events = await this.issues.historySince(cursor, {
            issueId: issue.id,
            kind: 'attachment_added',
        });
        for (const event of events) {
            await agentActions.record(actor, 'update', issue.id, event.id, now);
        }
        return made.map(({ id, name, mediaType, size }) => ({
            id,
            name,
            mediaType,
            size,
        }));
    }

    /** Live items by status, priority, area and kind; sorted and paged. */
    async list(
        filter: {
            status?: IssueStatus;
            priority?: IssuePriority;
            area?: IssueArea;
            kind?: IssueKind;
            component?: string;
        },
        { sort = 'priority', limit = 25, offset = 0 }: { sort?: ListSort; limit?: number; offset?: number },
        person: User,
        origin = '',
    ) {
        return this.board.filings.list(filter, {
            sort,
            limit,
            offset,
            userId: person.id,
            origin,
        });
    }

    /**
     * Files an item as the person: their role's rules for a new issue, and
     * the close open items first (as for a Dot's filing) unless `force`.
     */
    async file(
        actor: AgentActor,
        person: User,
        input: z.input<typeof agentFilingInput>,
        { origin = '', now = Date.now() }: { origin?: string; now?: number } = {},
    ) {
        const data = agentFilingInput.parse(input);
        if (hasBlockingDependencies(data) && !isAdmin(person)) {
            return {
                outcome: 'forbidden',
                message:
                    'Only an admin can set blocking links (blockedBy, blocks). Nothing was filed; related links are fine.',
            } as const;
        }
        const fields: IssueInput = {
            title: data.title,
            body: data.description,
            kind: data.kind,
            ...(data.priority ? { priority: data.priority } : {}),
            area: data.area ?? guessArea(`${data.title} ${data.description}`),
        };
        const refused = createRefusal(person, fields);
        if (refused) {
            return { outcome: 'forbidden', message: refused } as const;
        }
        const unknown = this.unknownComponents(person, data.components);
        if (unknown) {
            return unknown;
        }
        const files = this.checkFiles(data.attachments);
        return this.transaction(async () => {
            if (!data.force) {
                const matches = await this.board.filings.duplicates(data.title, data.description, origin);
                if (matches.length) {
                    return {
                        outcome: 'possible_duplicates',
                        matches,
                        message:
                            'Nothing was filed: these open items look close. Show them to the person. If none is the same, call file_issue again with force: true; if one is, vote for it or comment on it instead, if they want.',
                    } as const;
                }
            }
            const issue = await this.issues.create(fields, person.id, now, 'agent');
            if (data.components?.length) {
                await this.board.components.set(issue.id, data.components, {
                    actorId: person.id,
                    viewerId: person.id,
                    now,
                    initial: true,
                });
            }
            const dependencyCursor = await this.issues.historyCursor();
            await addFilingDependencies(this.issues, issue.number, data, person.id, now);
            const affected = [issue, ...(await linkedIssues(this.issues, issue.id))];
            for (const ref of affected) {
                const linked = await this.issues.require(ref.number);
                for (const event of await this.issues.historySince(dependencyCursor, {
                    issueId: linked.id,
                })) {
                    await this.board.agentActions.record(actor, 'update', linked.id, event.id, now);
                }
            }
            await this.board.agentActions.record(actor, 'create', issue.id, null, now);
            const attachments = await this.attach(actor, person, issue, files, undefined, now);
            return {
                outcome: 'filed',
                issue: issueKey(issue.number),
                url: this.url(issue.number, origin),
                status: issue.status,
                ...(attachments ? { attachments } : {}),
                message: `Filed ${issueKey(issue.number)} on the board, in ${issue.status}${attachments ? `, with ${attachments.length} attachment${attachments.length === 1 ? '' : 's'}` : ''}.`,
            } as const;
        }, 'agent filing');
    }

    /** A comment by the person, the agent recorded beside it. */
    async comment(
        actor: AgentActor,
        person: User,
        {
            issue: ref,
            comment,
            attachments,
        }: {
            issue: string;
            comment: string;
            attachments?: z.input<typeof agentAttachments>;
        },
        { origin = '', now = Date.now() }: { origin?: string; now?: number } = {},
    ) {
        const issue = await this.issues.get(numberOf(ref));
        if (!issue) {
            return this.notFound(ref);
        }
        const files = this.checkFiles(
            attachments && agentAttachments.parse(attachments),
            (await this.issues.attachments(issue.id)).length,
        );
        return this.transaction(async () => {
            const made = await this.issues.addComment(issue.number, comment, person.id, now);
            await this.board.agentActions.record(actor, 'comment', issue.id, made.id, now);
            const added = await this.attach(actor, person, issue, files, made.id, now);
            return {
                outcome: 'commented',
                issue: issueKey(issue.number),
                url: this.url(issue.number, origin),
                ...(added ? { attachments: added } : {}),
                message: `Added the comment to ${issueKey(issue.number)}${added ? `, with ${added.length} attachment${added.length === 1 ? '' : 's'}` : ''}.`,
            } as const;
        }, 'agent comment');
    }

    /**
     * The person's one vote on an item (shared with their own from the web),
     * or withdrawing it; a vote they already have, or don't, changes nothing.
     */
    async vote(
        actor: AgentActor,
        person: User,
        ref: string,
        { withdraw = false, origin = '', now = Date.now() }: { withdraw?: boolean; origin?: string; now?: number } = {},
    ) {
        const issue = await this.issues.get(numberOf(ref));
        if (!issue) {
            return this.notFound(ref);
        }
        const { votes, agentActions } = this.board;
        const key = issueKey(issue.number);
        return this.transaction(async () => {
            const id = withdraw
                ? await votes.withdraw(issue.id, person.id, now)
                : await votes.cast(issue.id, person.id, null, now);
            if (id) {
                await agentActions.record(actor, withdraw ? 'unvote' : 'vote', issue.id, id, now);
            }
            const [outcome, message] = id
                ? withdraw
                    ? (['withdrawn', `Withdrew the person’s vote on ${key}.`] as const)
                    : (['voted', `Voted for ${key} for the person.`] as const)
                : withdraw
                  ? (['not_voted', `The person has no vote on ${key}; nothing changed.`] as const)
                  : (['already_voted', `The person has already voted for ${key}; nothing changed.`] as const);
            return {
                outcome,
                issue: key,
                url: this.url(issue.number, origin),
                votes: await votes.count(issue.id),
                message,
            };
        }, 'agent vote');
    }

    /**
     * What the person may tag (CB-442), without owner names: agents read
     * authors without names too.
     */
    componentOptions(person: User) {
        return this.board.components.options(person.id).map(({ ref, label, kind, state }) => ({
            ref,
            name: withoutEmails(label),
            kind,
            ...(state === 'disabled' ? { state } : {}),
        }));
    }

    private async componentRefs(person: User, issueId: string) {
        return (await this.board.components.view(person.id, [issueId])).byIssue.get(issueId) ?? [];
    }

    /**
     * New refs must be the person's options; a stale tools list may name
     * one that's gone, so the answer lists the current ones.
     */
    private unknownComponents(person: User, refs: readonly string[] | undefined) {
        if (!refs?.length) {
            return undefined;
        }
        const options = new Set(this.board.components.options(person.id).map((option) => option.ref));
        const unknown = refs.filter((ref) => !options.has(ref));
        return unknown.length
            ? ({
                  outcome: 'forbidden',
                  message: `Unknown component: ${unknown.join(', ')}. Nothing was filed. The current choices are: ${[...options].join(', ')}; list_issue_components names them.`,
              } as const)
            : undefined;
    }

    /** `me`, an id, or an exact name (case aside) of someone signed in. */
    private assigneeId(person: User, wanted: string | null) {
        if (wanted === null) {
            return null;
        }
        if (wanted.toLowerCase() === 'me') {
            return person.id;
        }
        const people = this.workspace.users();
        const byId = people.find((user) => user.id === wanted);
        if (byId) {
            return byId.id;
        }
        const named = people.filter((user) => user.name.toLowerCase() === wanted.toLowerCase());
        if (named.length === 1) {
            return named[0]!.id;
        }
        throw new IssueError(
            named.length
                ? `More than one person is named “${wanted}”; give their id.`
                : `Nobody named “${wanted}” has signed in.`,
        );
    }

    /**
     * Changes fields as the person, within their role (a member changes
     * none of these; an admin any). Each changed field is a history row by
     * the person, with the agent recorded for it.
     */
    async update(
        actor: AgentActor,
        person: User,
        input: z.input<typeof agentUpdateInput>,
        { origin = '', now = Date.now() }: { origin?: string; now?: number } = {},
    ): Promise<Forbidden | NotFound | { outcome: 'updated' | 'unchanged'; [key: string]: unknown }> {
        const { issue: ref, assignee, components, ...rest } = agentUpdateInput.parse(input);
        const issue = await this.issues.get(numberOf(ref));
        if (!issue) {
            return this.notFound(ref);
        }
        const patch: IssuePatch = {
            ...rest,
            ...(assignee === undefined ? {} : { assigneeId: assignee }),
            ...(components === undefined ? {} : { components }),
        };
        if (!Object.keys(patch).length) {
            throw new IssueError('Give at least one field to change.');
        }
        const refused = patchRefusal(person, issue, patch);
        if (refused) {
            return { outcome: 'forbidden', message: refused };
        }
        if (assignee !== undefined) {
            patch.assigneeId = this.assigneeId(person, assignee);
        }
        if (components?.length) {
            // Kept tags the person sees count too (an uninstalled plugin's).
            const allowed = new Set([
                ...this.board.components.options(person.id).map((option) => option.ref),
                ...(await this.componentRefs(person, issue.id)),
            ]);
            const unknown = components.filter((ref) => !allowed.has(ref));
            if (unknown.length) {
                throw new IssueError(
                    `Unknown component: ${unknown.join(', ')}. Nothing changed. The current choices are: ${[...allowed].join(', ')}; list_issue_components names them.`,
                );
            }
        }
        const { agentActions } = this.board;
        return this.transaction(async () => {
            // The history rows the update adds, by their position.
            const cursor = await this.issues.historyCursor();
            const { components: wanted, ...fields } = patch;
            let updated = await this.issues.update(issue.number, fields, person.id, now);
            if (wanted !== undefined) {
                await this.board.components.set(issue.id, wanted, { actorId: person.id, viewerId: person.id, now });
                updated = await this.issues.require(issue.number);
            }
            const changed = await this.issues.historySince(cursor, {
                issueId: issue.id,
                actorId: person.id,
            });
            for (const event of changed) {
                await agentActions.record(actor, 'update', issue.id, event.id, now);
            }
            const key = issueKey(updated.number);
            return {
                outcome: changed.length ? 'updated' : 'unchanged',
                issue: key,
                url: this.url(updated.number, origin),
                changed: changed.map((event) => String(event.kind)),
                status: updated.status,
                priority: updated.priority,
                kind: updated.kind,
                area: updated.area,
                labels: updated.labels,
                components: await this.componentRefs(person, updated.id),
                resolution: updated.resolution && withoutEmails(updated.resolution),
                assignee: !updated.assigneeId
                    ? null
                    : updated.assigneeId === person.id
                      ? 'the person you act for'
                      : 'another person',
                message: changed.length
                    ? `Changed ${changed.map((event) => String(event.kind)).join(', ')} on ${key}.`
                    : `${key} already had these values; nothing changed.`,
            };
        }, 'agent update');
    }
}
