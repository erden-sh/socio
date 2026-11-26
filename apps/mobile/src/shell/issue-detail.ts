import { ATTACHMENT_HINT } from '@socio/shared/issues/issue-attachment-files';
import {
    areaLabel,
    canDeleteComment,
    canEditComment,
    canEditText,
    canTriage,
    eventText,
    KIND_LABEL,
    PRIORITY_LABEL,
    STATUS_LABEL,
} from '@socio/shared/issues/issue-board';
import type { IssueComponentOption } from '@socio/shared/issues/issue-components';
import {
    type Issue,
    ISSUE_AREAS,
    ISSUE_KINDS,
    ISSUE_LABELS,
    ISSUE_PRIORITIES,
    ISSUE_STATUSES,
    type IssueAssignees,
    type IssueAttachment,
    type IssueComment,
    type IssueDetail,
    type IssueEvent,
    type IssueLinkRef,
    type IssueStatus,
} from '@socio/shared/issues/issue-types';
import type { User } from '@socio/shared/types';

import { ISSUE_ATTACHMENT_VIEWS, ISSUE_ATTACHMENTS } from '../sync/issue-attachments';
import { ISSUE_COMMENT_VIEWS, ISSUE_COMMENTS } from '../sync/issue-comments';
import type { PendingIssue } from '../sync/issue-create';
import { issueOfLane } from '../sync/issue-details';
import { componentsOf, isIssueConflict } from '../sync/issue-edit';
import { ISSUES } from '../sync/issues';
import { shownIssueKey } from '../sync/local-ids';
import { type HoldGroup, OUTBOX_COPY, type UnsentWrite } from '../sync/outbox';
import type { OverlayItem, OverlayKind, OverlayState } from '../sync/outbox-overlay';
import type { ToneName } from '../theme/theme';

import { BOARD_VIEWS, labelWords, PRIORITY_TONE, STATUS_TONE } from './board';
import {
    componentChip,
    type ComponentChipView,
    componentEventText,
    type ComponentLabels,
    componentText,
    COMPONENTS_LABEL,
    NO_COMPONENTS,
} from './issue-components';
import { PENDING_ISSUE_LABEL } from './issue-filing';
import { type UnsentListContext, unsentListRows } from './unsent';

// An issue's screen: the web's
// IssueDetail on a phone, read-only but for votes, comments and (a member's
// own issue in triage) the title and description. The held detail
// (issue-details.ts) with this device's writes laid over: field edits and the
// vote patch the issue, comments and files are added, changed or removed in
// place with the outbox's words while they wait, and what the server refused
// on this issue shows in place ("Couldn't save") with its actions. An issue
// filed offline (`CB-?`) shows its filing until its create resolves. Admins
// (shared's `canTriage`; the server decides) edit status, priority, kind,
// area, labels, assignee and resolution through `src/sync/issue-edit.ts`'s
// `editIssue`, each field marked while its edit waits; the assignee picker shows the last
// list (issue-assignees.ts) with its age offline. Proposals, links and delete
// open the web until the app does them natively. Components (CB-442): the
// detail's refs as the web's chips in the fields (by the detail's label map),
// an admin's Components row opening the picker (`components`, through
// `editIssue`), the history's components events in the web's words and the
// triage proposal's suggested ones; none of it from a server before CB-442.
// No React Native: tests/shell runs it under Node.

/** The kinds whose rows the issue's screen lays over its detail: the filing, edits and votes, comments and files. */
export const ISSUE_DETAIL_VIEWS: readonly OverlayKind<unknown>[] = [
    ...BOARD_VIEWS,
    ...ISSUE_COMMENT_VIEWS,
    ...ISSUE_ATTACHMENT_VIEWS,
];

export const NO_DESCRIPTION = 'No description.';
export const NO_COMMENTS = 'No comments yet.';
export const NO_HISTORY = 'No history yet.';
/** The issue's Attachments section with none: the web's words, but for paste, which the section doesn't take. */
export const NO_FILES = `None yet. Attach a photo or a file. ${ATTACHMENT_HINT}`;
/** The section's Attach button, as the web says it. */
export const ATTACH_TO_ISSUE = 'Attach files to the issue';
export const ISSUE_GONE = 'This issue isn’t available';
export const ISSUE_GONE_LINE = 'It was deleted, or you no longer have access.';
export const ISSUE_OFFLINE = 'This issue shows once you’re online.';
/** The words for a write the server refused, in place. */
export const NOT_SENT = 'Not sent';

export type IssueDetailState = 'ready' | 'loading' | 'gone' | 'offline';

export interface DetailFile {
    /** The server's id, or the outbox row's while it waits. */
    readonly id: string;
    readonly name: string;
    readonly mediaType: string;
    /** A picture the viewer shows (the server's copy only); other files open their page in Media (CB-558). */
    readonly picture: boolean;
    /** The outbox's words while it waits; null once it is the server's. */
    readonly pending: string | null;
    readonly accessibilityLabel: string;
}

export interface DetailComment {
    readonly id: string;
    readonly author: string;
    readonly when: string;
    readonly edited: boolean;
    readonly body: string;
    readonly canEdit: boolean;
    readonly canDelete: boolean;
    readonly pending: string | null;
    readonly files: readonly DetailFile[];
    readonly accessibilityLabel: string;
}

export interface DetailEvent {
    readonly id: string;
    readonly actor: string;
    readonly text: string;
    readonly when: string;
}

export interface DetailLink {
    /** The linked issue as the store keys it: its number. */
    readonly key: string;
    readonly relation: string;
    readonly label: string;
    readonly title: string;
    readonly status: string;
    readonly accessibilityLabel: string;
}

export type ProblemAction = 'keep-mine' | 'keep-theirs' | 'retry' | 'edit' | 'copy' | 'discard';

/** A write on this issue the server refused: what it was, why, and what the person can do. */
export interface DetailProblem {
    readonly id: string;
    readonly what: string;
    readonly why: string;
    readonly text: string | null;
    readonly actions: readonly ProblemAction[];
    readonly accessibilityLabel: string;
}

/** The fields an admin edits on the detail (the web's AdminFields). */
export const ADMIN_FIELDS = [
    'status',
    'priority',
    'kind',
    'area',
    'labels',
    'components',
    'assigneeId',
    'resolution',
] as const;
export type AdminFieldName = (typeof ADMIN_FIELDS)[number];
export type AdminValues = Omit<Pick<Issue, AdminFieldName>, 'components'> & { readonly components: string[] };

export const ADMIN_FIELD_LABEL: Readonly<Record<AdminFieldName, string>> = {
    status: 'Status',
    priority: 'Priority',
    kind: 'Kind',
    area: 'Area',
    labels: 'Labels',
    components: COMPONENTS_LABEL,
    assigneeId: 'Assignee',
    resolution: 'Resolution',
};

/**
 * The issue page's parts under its head, in the web's order (IssueDetail.tsx): the conversation first
 * (the description, the attachments, the comments, whose box is docked under the page, and the
 * history), then the triage proposal (the web's IssueTriage, at the top of its side panel), the fields
 * (with the admin's "on the web" row) and the links.
 */
export const ISSUE_SECTIONS = ['description', 'files', 'comments', 'history', 'triage', 'fields', 'links'] as const;
export type IssueSection = (typeof ISSUE_SECTIONS)[number];

/** Admin actions the phone doesn't do yet: they open the issue on the web. */
export const ADMIN_ON_WEB = 'Triage proposals, links and delete';
export const OPENS_IN_BROWSER = 'Opens in your browser';
export const NEEDS_CONNECTION = 'Needs a connection';

export interface AdminField {
    readonly field: AdminFieldName;
    readonly label: string;
    /** What it shows: "Open", "No area", "Unassigned". */
    readonly value: string;
    /** Its edit waits to send. */
    readonly pending: boolean;
    /** Components: the chips the row shows in place of its words. */
    readonly chips?: readonly ComponentChipView[];
    readonly accessibilityLabel: string;
}

/** A read-only field: its words, or (Components) its chips. */
export interface DetailField {
    readonly label: string;
    readonly value: string;
    readonly chips?: readonly ComponentChipView[];
}

/** The automatic triage proposal (CB-30), read-only here: what the web's IssueTriage shows. */
export interface TriageView {
    readonly title: string;
    /** The proposed kind, area, priority and labels, in words. */
    readonly tags: readonly string[];
    /** The suggested components the reader may see (CB-442). */
    readonly components: readonly ComponentChipView[];
    readonly reason: string;
    /** "Applied by Ada · Nov 8, 3:45 PM", once decided. */
    readonly decided: string | null;
    /** For a member while it waits: what happens next. */
    readonly note: string | null;
    readonly accessibilityLabel: string;
}

export const TRIAGE_TITLE = 'Triage proposal';
export const TRIAGE_WAITING = 'An admin can apply or ignore it. Nothing has changed yet.';

/** What an admin edits: the fields with their pending marks, what the screen shows, and each edit's base. */
export interface AdminView {
    readonly fields: readonly AdminField[];
    /** The values shown, this device's edits laid over. */
    readonly values: AdminValues;
    /** The issue as the server last sent it (or its filing): an edit's base, never the overlay. */
    readonly base: AdminValues;
}

export interface IssueDetailView {
    readonly state: IssueDetailState;
    /** `CB-12`, or `CB-?` for an issue filed offline. */
    readonly label: string;
    readonly title: string;
    readonly status: { readonly label: string; readonly tone: ToneName } | null;
    readonly priority: { readonly label: string; readonly tone: ToneName } | null;
    /** "Filed by Ben · Nov 8, 3:45 PM", with " · updated Nov 9, 10:02 AM" once it changed; once the detail has come. */
    readonly filed: string | null;
    /** The copy's age while the server can't be reached: "Saved Nov 8, 3:45 PM". */
    readonly age: string | null;
    /** The outbox's words while a field edit waits. */
    readonly pending: string | null;
    readonly body: string | null;
    readonly vote: {
        readonly voted: boolean;
        readonly votes: number;
        readonly pending: boolean;
        readonly label: string;
        readonly accessibilityLabel: string;
    } | null;
    readonly demand: string | null;
    readonly blocked: string | null;
    readonly fields: readonly DetailField[];
    /** The automatic triage proposal, when one was made. */
    readonly triage: TriageView | null;
    readonly links: readonly DetailLink[];
    readonly files: readonly DetailFile[];
    /** Every file on the issue, its comments' and the waiting ones too: toward the server's 10 (for Attach). */
    readonly fileCount: number;
    readonly comments: readonly DetailComment[];
    readonly history: readonly DetailEvent[];
    readonly problems: readonly DetailProblem[];
    /** A member's own issue in triage, or an admin: the title and description. */
    readonly canEditText: boolean;
    /** The issue as the server last sent it: an edit's base, never the overlay. */
    readonly base: Pick<Issue, 'title' | 'body'> | null;
    /** The vote as the server last sent it: a vote's base. */
    readonly voteBase: { readonly voted: boolean; readonly votes: number } | null;
    /** An admin's editable fields, or null for a member. */
    readonly admin: AdminView | null;
}

export interface IssueDetailInput {
    /** The issue as the store keys it: its number, or a local key. */
    readonly key: string;
    /** The held detail (issue-details.ts), or null. */
    readonly detail: IssueDetail | null;
    /** The bounded item's state. */
    readonly item: {
        readonly gone: boolean;
        readonly settled: boolean;
        readonly failed: boolean;
        readonly fetchedAt: number | null;
    };
    /** `overlaysOf` the outbox with ISSUE_DETAIL_VIEWS' kinds. */
    readonly overlays: readonly OverlayItem[];
    /** What the server refused, and what it holds (the outbox's `unsent()` and `holds()`). */
    readonly unsent: readonly UnsentWrite[];
    readonly groups?: readonly HoldGroup[];
    /** The person (`/api/workspace`'s user), or null before it has come. */
    readonly user: User | null;
    /** The scope's app user id: the person when `user` hasn't come. */
    readonly me: string;
    /** The ids map, for local keys. */
    readonly resolve: (kind: string, localId: string) => string | null;
    /** The component options kept on the phone (CB-442): names for a filing's or a just-picked component. */
    readonly options?: readonly IssueComponentOption[] | null;
    readonly timeZone?: string;
}

/** "Nov 8, 3:45 PM". */
export const issueTime = (ms: number, timeZone?: string): string =>
    new Date(ms).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        ...(timeZone === undefined ? {} : { timeZone }),
    });

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function wordsOf(state: OverlayState): string | null {
    switch (state) {
        case 'sent':
            return null;
        case 'unconfirmed':
            return OUTBOX_COPY.unconfirmed;
        case 'unsent':
            return NOT_SENT;
        default:
            return OUTBOX_COPY.waitingToSend;
    }
}

/** "Couldn't confirm" says more than "Waiting to send". */
const stronger = (a: string | null, b: string | null) => (a === OUTBOX_COPY.unconfirmed ? a : (b ?? a));

const userName = (users: Readonly<Record<string, string>>, id: string) => users[id] ?? id;

/** The web's `authorName`: a socio's comment "<socio> for <person>", an agent's "<label> for <person>". */
function authorName(comment: IssueComment, users: Readonly<Record<string, string>>): string {
    const name =
        (comment.authorId && users[comment.authorId]) ??
        (comment.authorKind === 'system' ? 'Socio' : comment.authorKind);
    if (comment.agent) {
        return `${comment.agent.label} for ${name}`;
    }
    return comment.dot ? `${name} for ${userName(users, comment.dot.userId)}` : name;
}

/** The web's history actor. */
function actorName(event: IssueEvent, users: Readonly<Record<string, string>>): string {
    if (event.dot) {
        return `${users[`dot:${event.dot.dotId}`] ?? 'Socio'} for ${userName(users, event.dot.userId)}`;
    }
    const actor = event.actorId ? userName(users, event.actorId) : 'Socio';
    return event.agent ? `${event.agent.label} for ${actor}` : actor;
}

const PICTURE = /^image\/(png|jpeg|gif|webp)$/;

function fileOf(file: Pick<IssueAttachment, 'id' | 'name' | 'mediaType'>, pending: string | null): DetailFile {
    return {
        id: file.id,
        name: file.name,
        mediaType: file.mediaType,
        picture: pending === null && PICTURE.test(file.mediaType),
        pending,
        accessibilityLabel: pending === null ? file.name : `${file.name}, ${pending}`,
    };
}

const RELATIONS: readonly { readonly field: 'blockedBy' | 'blocks' | 'related'; readonly label: string }[] = [
    { field: 'blockedBy', label: 'Blocked by' },
    { field: 'blocks', label: 'Blocks' },
    { field: 'related', label: 'Related' },
];

function linkOf(relation: string, ref: IssueLinkRef): DetailLink {
    const label = `CB-${ref.number}`;
    const status = STATUS_LABEL[ref.status] ?? ref.status;
    return {
        key: String(ref.number),
        relation,
        label,
        title: ref.title,
        status,
        accessibilityLabel: `${relation} ${label}, ${ref.title}, ${status}`,
    };
}

/** This issue's writes the server refused, with their actions: Keep mine and Keep theirs for a conflict. */
function problemsOf(input: IssueDetailInput): DetailProblem[] {
    const mine = input.unsent.filter((write) => {
        const issue = issueOfLane(write.lane);
        return issue !== null && shownIssueKey(input.resolve, issue) === input.key;
    });
    const context: UnsentListContext = {
        chatTitle: () => null,
        resolve: () => null,
        issueNumber: (key) => input.resolve('issue', key),
    };
    const rows = unsentListRows(mine, input.groups ?? [], context);
    return rows.map((row) => {
        const write = mine.find((item) => item.id === row.id)!;
        // A refused filing reopens FileIssue on what was written: sending it as it was would only be refused again.
        const actions: ProblemAction[] = isIssueConflict(write)
            ? ['keep-mine', 'keep-theirs']
            : [row.editable ? 'edit' : 'retry', ...(row.text === null ? [] : (['copy'] as const)), 'discard'];
        return {
            id: row.id,
            what: row.what,
            why: row.why,
            text: row.text,
            actions,
            accessibilityLabel: [row.what, row.text, row.why].filter(Boolean).join(', '),
        };
    });
}

type Shown = Pick<
    Issue,
    | 'title'
    | 'body'
    | 'status'
    | 'priority'
    | 'kind'
    | 'area'
    | 'labels'
    | 'components'
    | 'assigneeId'
    | 'resolution'
    | 'votes'
    | 'voted'
    | 'demand'
    | 'openBlockers'
>;

export function issueDetailView(input: IssueDetailInput): IssueDetailView {
    const { key, detail, overlays, timeZone } = input;
    const user: User = input.user ?? { id: input.me, name: '', role: 'member' };
    const users = detail?.users ?? {};
    const filed = overlays.find((item) => item.collection === ISSUES && item.mode === 'insert' && item.key === key);
    const filing = filed?.value as PendingIssue | undefined;
    const base: Shown | null =
        detail?.issue ??
        (filing
            ? { ...filing, components: [...(filing.components ?? [])], labels: [], assigneeId: null, resolution: null }
            : null);
    const problems = problemsOf(input);
    // Components (CB-442): a server from before them sends no label map, and its strict
    // patch would refuse the field, so none is shown or offered.
    const labels: ComponentLabels = detail?.components ?? {};
    const hasComponents = detail ? detail.components !== undefined : (filing?.components?.length ?? 0) > 0;
    const chipsOf = (refs: readonly string[]) => refs.map((ref) => componentChip(ref, labels, input.options));
    if (base === null) {
        const state: IssueDetailState = input.item.gone ? 'gone' : input.item.settled ? 'offline' : 'loading';
        return {
            ...EMPTY,
            state,
            label: `CB-${key}`,
            problems,
        };
    }
    // Field edits and the vote, over the server's (or the filing's) values.
    let issue: Shown = base;
    // A filing not yet numbered says where it stands; a refused one shows in its problems.
    let pending: string | null =
        detail === null && filed !== undefined && filed.state !== 'unsent' ? wordsOf(filed.state) : null;
    let votePending = false;
    const pendingFields = new Set<string>();
    for (const item of overlays) {
        if (item.collection !== ISSUES || item.mode !== 'patch' || item.key !== key || item.state === 'unsent') {
            continue;
        }
        const value = item.value as Partial<Shown>;
        issue = { ...issue, ...value };
        if ('voted' in value) {
            votePending ||= item.state !== 'sent';
        } else {
            pending = stronger(pending, wordsOf(item.state));
            if (item.state !== 'sent') {
                for (const field of Object.keys(value)) {
                    pendingFields.add(field);
                }
            }
        }
    }
    const votes = issue.votes ?? 0;
    const voted = issue.voted === true;
    const label = detail ? `CB-${detail.issue.number}` : PENDING_ISSUE_LABEL;

    // Files and comments: the server's, then this device's laid over by key.
    const fileOverlays = overlays.filter(
        (item) => item.collection === ISSUE_ATTACHMENTS && (item.value as { issue?: string }).issue === key,
    );
    const known = new Set((detail?.attachments ?? []).map((file) => file.id));
    const files = [
        ...(detail?.attachments ?? []).map((file) => ({ commentId: file.commentId, file: fileOf(file, null) })),
        ...fileOverlays
            .filter((item) => !known.has(item.key) && item.state !== 'sent')
            .map((item) => {
                const value = item.value as { commentId: string | null; name: string; mediaType: string };
                return {
                    commentId: value.commentId,
                    file: fileOf(
                        { id: item.key, name: value.name, mediaType: value.mediaType as IssueAttachment['mediaType'] },
                        wordsOf(item.state),
                    ),
                };
            }),
    ];
    const filesOf = (commentId: string | null) =>
        files.filter((entry) => entry.commentId === commentId).map((entry) => entry.file);

    const comments = new Map<string, { comment: IssueComment; pending: string | null }>();
    for (const comment of detail?.comments ?? []) {
        comments.set(comment.id, { comment, pending: null });
    }
    for (const item of overlays) {
        const value = item.value as { issue?: string; body?: string; authorId?: string; deleted?: boolean };
        if (item.collection !== ISSUE_COMMENTS || value.issue !== key) {
            continue;
        }
        const held = comments.get(item.key);
        if (item.mode === 'insert') {
            if (held === undefined) {
                comments.set(item.key, {
                    comment: {
                        id: item.key,
                        issueId: '',
                        authorKind: 'user',
                        authorId: value.authorId ?? input.me,
                        body: value.body ?? '',
                        createdAt: item.createdAt,
                        editedAt: null,
                    },
                    pending: wordsOf(item.state),
                });
            }
            continue;
        }
        if (held === undefined || item.state === 'unsent') {
            // A refused edit or delete shows the server's comment; "Couldn't save" says why.
            continue;
        }
        if (value.deleted === true) {
            comments.delete(item.key);
        } else if (typeof value.body === 'string') {
            comments.set(item.key, {
                comment: { ...held.comment, body: value.body },
                pending: stronger(held.pending, wordsOf(item.state)),
            });
        }
    }

    const fields = [
        { label: 'Status', value: STATUS_LABEL[issue.status] },
        { label: 'Priority', value: PRIORITY_LABEL[issue.priority] },
        { label: 'Kind', value: KIND_LABEL[issue.kind] },
        { label: 'Area', value: issue.area ? areaLabel(issue.area) : 'None' },
        { label: 'Labels', value: issue.labels.length ? issue.labels.map(labelWords).join(', ') : 'None' },
        ...(hasComponents
            ? [
                  {
                      label: COMPONENTS_LABEL,
                      value: componentsText(componentsOf(issue), labels, input.options),
                      chips: chipsOf(componentsOf(issue)),
                  },
              ]
            : []),
        {
            label: 'Assignee',
            value: issue.assigneeId ? userName(users, issue.assigneeId) : 'Unassigned',
        },
        ...(issue.resolution ? [{ label: 'Resolution', value: issue.resolution }] : []),
    ];
    const blockers = issue.openBlockers?.length ?? 0;
    const filedBy = detail
        ? [
              'Filed by ',
              detail.filedByAgent ? `${detail.filedByAgent.label} for ` : '',
              userName(users, detail.issue.reporterId),
              detail.filedBy ? ` for ${userName(users, detail.filedBy.userId)}` : '',
              ` · ${issueTime(detail.issue.createdAt, timeZone)}`,
              // The web's "· updated …", once it changed after it was filed (IssueDetail.tsx).
              detail.issue.updatedAt !== detail.issue.createdAt
                  ? ` · updated ${issueTime(detail.issue.updatedAt, timeZone)}`
                  : '',
          ].join('')
        : null;
    const offline = input.item.failed && input.item.fetchedAt !== null;
    const admin: AdminView | null = canTriage(user)
        ? {
              fields: ADMIN_FIELDS.filter((field) => field !== 'components' || hasComponents).map((field) => {
                  const value =
                      field === 'components'
                          ? componentsText(componentsOf(issue), labels, input.options)
                          : adminValueText(field, adminValues(issue), users);
                  const waiting = pendingFields.has(field);
                  return {
                      field,
                      label: ADMIN_FIELD_LABEL[field],
                      value,
                      pending: waiting,
                      ...(field === 'components' ? { chips: chipsOf(componentsOf(issue)) } : {}),
                      accessibilityLabel: [ADMIN_FIELD_LABEL[field], value, waiting ? OUTBOX_COPY.waitingToSend : null]
                          .filter(Boolean)
                          .join(', '),
                  };
              }),
              values: adminValues(issue),
              base: adminValues(base),
          }
        : null;
    return {
        state: 'ready',
        label,
        title: issue.title,
        status: { label: STATUS_LABEL[issue.status as IssueStatus], tone: STATUS_TONE[issue.status as IssueStatus] },
        priority: { label: PRIORITY_LABEL[issue.priority], tone: PRIORITY_TONE[issue.priority] },
        filed: filedBy,
        age: offline ? `Saved ${issueTime(input.item.fetchedAt!, timeZone)}` : null,
        pending,
        body: issue.body.trim() === '' ? null : issue.body,
        vote: {
            voted,
            votes,
            pending: votePending,
            label: voted ? 'Voted' : 'Vote',
            accessibilityLabel: `${voted ? 'Withdraw your vote on' : 'Vote for'} ${label}, ${plural(votes, 'vote')}`,
        },
        demand: issue.demand ? plural(issue.demand, 'ask') : null,
        blocked: blockers > 0 ? `Blocked by ${blockers}` : null,
        fields,
        triage: detail?.triage ? triageView(detail, labels, users, user, timeZone) : null,
        links: detail
            ? RELATIONS.flatMap(({ field, label: relation }) =>
                  (detail[field] ?? []).map((ref) => linkOf(relation, ref)),
              )
            : [],
        files: filesOf(null),
        fileCount: files.length,
        comments: [...comments.values()]
            .sort((a, b) => a.comment.createdAt - b.comment.createdAt)
            .map(({ comment, pending: words }) => {
                const author = authorName(comment, users);
                const when = issueTime(comment.createdAt, timeZone);
                const edited = comment.editedAt !== null;
                return {
                    id: comment.id,
                    author,
                    when,
                    edited,
                    body: comment.body,
                    canEdit: words !== NOT_SENT && canEditComment(comment, user),
                    canDelete: words !== NOT_SENT && canDeleteComment(comment, user),
                    pending: words,
                    files: filesOf(comment.id),
                    accessibilityLabel: [author, when, edited ? 'edited' : null, comment.body, words]
                        .filter(Boolean)
                        .join(', '),
                };
            }),
        history: (detail?.events ?? []).map((event) => ({
            id: event.id,
            actor: actorName(event, users),
            text: event.kind === 'components' ? componentEventText(event, labels) : eventText(event, users),
            when: issueTime(event.createdAt, timeZone),
        })),
        problems,
        canEditText: detail !== null ? canEditText(detail.issue, user) : true,
        base: detail
            ? { title: detail.issue.title, body: detail.issue.body }
            : filing
              ? { title: filing.title, body: filing.body }
              : null,
        voteBase: detail
            ? { voted: detail.issue.voted === true, votes: detail.issue.votes ?? 0 }
            : { voted: false, votes: 0 },
        admin,
    };
}

const adminValues = (issue: Omit<AdminValues, 'components'> & Pick<Issue, 'components'>): AdminValues => ({
    status: issue.status,
    priority: issue.priority,
    kind: issue.kind,
    area: issue.area,
    labels: issue.labels,
    components: componentsOf(issue),
    assigneeId: issue.assigneeId,
    resolution: issue.resolution,
});

/** Components in words: "Forms, CRM", or "None". */
const componentsText = (
    refs: readonly string[],
    labels: ComponentLabels,
    options: readonly IssueComponentOption[] | null | undefined,
) => (refs.length ? refs.map((ref) => componentText(ref, labels, options)).join(', ') : NO_COMPONENTS);

/** The web's IssueTriage, read-only: Apply and Ignore stay on the web for admins (ADMIN_ON_WEB). */
function triageView(
    detail: IssueDetail,
    labels: ComponentLabels,
    users: Readonly<Record<string, string>>,
    user: User,
    timeZone: string | undefined,
): TriageView {
    const proposal = detail.triage!;
    const tags = [
        KIND_LABEL[proposal.kind],
        ...(proposal.area ? [areaLabel(proposal.area)] : []),
        PRIORITY_LABEL[proposal.priority],
        ...proposal.labels.map(labelWords),
    ];
    const components = (proposal.components ?? []).map((ref) => componentChip(ref, labels));
    const decided =
        proposal.decidedAt !== null && proposal.decidedBy
            ? `${proposal.state === 'applied' ? 'Applied' : 'Ignored'} by ${userName(users, proposal.decidedBy)} · ${issueTime(proposal.decidedAt, timeZone)}`
            : null;
    const note = decided === null && !canTriage(user) ? TRIAGE_WAITING : null;
    return {
        title: TRIAGE_TITLE,
        tags,
        components,
        reason: proposal.reason,
        decided,
        note,
        accessibilityLabel: [
            TRIAGE_TITLE,
            ...tags,
            ...components.map((chip) => chip.accessibilityLabel),
            proposal.reason,
            decided ?? note,
        ]
            .filter(Boolean)
            .join(', '),
    };
}

/** A field's value in words, as the admin's row shows it. */
function adminValueText(field: AdminFieldName, issue: AdminValues, users: Readonly<Record<string, string>>): string {
    switch (field) {
        case 'status':
            return STATUS_LABEL[issue.status];
        case 'priority':
            return PRIORITY_LABEL[issue.priority];
        case 'kind':
            return KIND_LABEL[issue.kind];
        case 'area':
            return issue.area ? areaLabel(issue.area) : 'No area';
        case 'labels':
            return issue.labels.length ? issue.labels.map(labelWords).join(', ') : 'No labels';
        case 'components':
            return issue.components.length ? issue.components.join(', ') : NO_COMPONENTS;
        case 'assigneeId':
            return issue.assigneeId ? userName(users, issue.assigneeId) : 'Unassigned';
        case 'resolution':
            return issue.resolution ?? 'None';
    }
}

/** One choice of a picker: its value (null for "no area" or "Unassigned"), its words, and whether it is the one shown. */
export interface FieldChoice {
    readonly value: string | null;
    readonly label: string;
    readonly selected: boolean;
}

/** The choices for a one-of field (status, priority, kind, area), in the web's order. */
export function fieldChoices(
    field: 'status' | 'priority' | 'kind' | 'area',
    values: AdminValues,
): readonly FieldChoice[] {
    const of = <T extends string>(options: readonly T[], label: (value: T) => string, current: T | null) =>
        options.map((value) => ({ value, label: label(value), selected: value === current }));
    switch (field) {
        case 'status':
            return of(ISSUE_STATUSES, (value) => STATUS_LABEL[value], values.status);
        case 'priority':
            return of(ISSUE_PRIORITIES, (value) => PRIORITY_LABEL[value], values.priority);
        case 'kind':
            return of(ISSUE_KINDS, (value) => KIND_LABEL[value], values.kind);
        case 'area':
            return [
                { value: null, label: 'No area', selected: values.area === null },
                ...of(ISSUE_AREAS, areaLabel, values.area),
            ];
    }
}

/** The labels, each on or off. */
export function labelChoices(values: AdminValues): readonly FieldChoice[] {
    return ISSUE_LABELS.map((label) => ({
        value: label,
        label: labelWords(label),
        selected: values.labels.includes(label),
    }));
}

/** A resolution as typed, as the edit sends it: blank is none. */
export const resolutionValue = (text: string): string | null => (text.trim() === '' ? null : text);

export interface AssigneePickerInput {
    /** The assignee list's bounded item (issue-assignees.ts). */
    readonly list: {
        readonly value: IssueAssignees | null;
        readonly fetchedAt: number | null;
        readonly settled: boolean;
        readonly failed: boolean;
    };
    /** The assignee shown now (this device's edit laid over). */
    readonly current: string | null;
    /** The detail's names, for a current assignee the list lacks. */
    readonly users: Readonly<Record<string, string>>;
    readonly timeZone?: string;
}

export interface AssigneePickerView {
    readonly choices: readonly FieldChoice[];
    /** "Loading people…" before the first answer, "Needs a connection" when the server can't be reached. */
    readonly line: string | null;
    /** The kept list's age when it couldn't be read again: "Saved Nov 8, 3:45 PM". */
    readonly age: string | null;
}

/**
 * The assignee picker (the web's): Unassigned, then the people the server
 * offers; deactivated people aren't, but the current assignee always shows
 * ("(Deactivated)" when the list says so). Offline it is the last list with
 * its age.
 */
export function assigneePicker(input: AssigneePickerInput): AssigneePickerView {
    const { list, current, users, timeZone } = input;
    const people = list.value?.users ?? [];
    const choices: FieldChoice[] = [
        { value: null, label: 'Unassigned', selected: current === null },
        ...people.map((person) => ({ value: person.id, label: person.name, selected: person.id === current })),
    ];
    if (current !== null && !people.some((person) => person.id === current)) {
        const name = users[current] ?? list.value?.deactivated.find((person) => person.id === current)?.name ?? current;
        const deactivated = list.value?.deactivated.some((person) => person.id === current) === true;
        choices.push({ value: current, label: deactivated ? `${name} (Deactivated)` : name, selected: true });
    }
    return {
        choices,
        line: list.failed ? NEEDS_CONNECTION : !list.settled && list.value === null ? 'Loading people…' : null,
        age: list.failed && list.fetchedAt !== null ? `Saved ${issueTime(list.fetchedAt, timeZone)}` : null,
    };
}

const EMPTY: IssueDetailView = {
    state: 'loading',
    label: '',
    title: '',
    status: null,
    priority: null,
    filed: null,
    age: null,
    pending: null,
    body: null,
    vote: null,
    demand: null,
    blocked: null,
    fields: [],
    triage: null,
    links: [],
    files: [],
    fileCount: 0,
    comments: [],
    history: [],
    problems: [],
    canEditText: false,
    base: null,
    voteBase: null,
    admin: null,
};
