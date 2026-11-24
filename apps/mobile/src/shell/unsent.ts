import { PROFILE_FIELDS, PROFILE_LABELS } from '@socio/shared/memory';
import { pageTitle } from '@socio/shared/pages/page-draft';

import {
    CHAT_DELETE_KIND,
    CHAT_UPDATE_KIND,
    type ChatUpdatePayload,
    REACTION_KIND,
    STEERING_CANCEL_KIND,
    STEERING_EDIT_KIND,
    type SteeringEditPayload,
} from '../sync/chat-manage';
import { CHAT_MESSAGE_KIND, type ChatMessagePayload } from '../sync/chat-send';
import {
    ISSUE_ATTACHMENT_KIND,
    ISSUE_ATTACHMENT_REFUSALS,
    type IssueAttachmentPayload,
} from '../sync/issue-attachments';
import {
    COMMENT_DELETE_KIND,
    COMMENT_EDIT_KIND,
    COMMENT_REFUSALS,
    type CommentEditPayload,
    ISSUE_COMMENT_KIND,
    type IssueCommentPayload,
} from '../sync/issue-comments';
import { ISSUE_CREATE_KIND, type IssueCreatePayload, ISSUE_REFUSALS, unsentIssueFields } from '../sync/issue-create';
import {
    ISSUE_EDIT_REFUSALS,
    ISSUE_UPDATE_KIND,
    ISSUE_VOTE_KIND,
    type IssueUpdatePayload,
    type IssueVotePayload,
} from '../sync/issue-edit';
import { isLocalIssue } from '../sync/local-ids';
import {
    MEMORY_ADD_KIND,
    MEMORY_APPROVE_KIND,
    MEMORY_CONFIRM_KIND,
    MEMORY_DELETE_KIND,
    MEMORY_REASON,
    MEMORY_UPDATE_KIND,
    type MemoryAddPayload,
    type MemoryUpdatePayload,
    PROFILE_CLEAR_KIND,
    PROFILE_SAVE_KIND,
    type ProfileSavePayload,
} from '../sync/memory-writes';
import { NEW_CHAT_KIND, type NewChatPayload } from '../sync/new-chat';
import { type HoldGroup, UNSENT_GONE, type UnsentWrite } from '../sync/outbox';
import {
    PAGE_COVER_KIND,
    PAGE_DELETE_KIND,
    PAGE_MANAGE_REFUSALS,
    PAGE_MOVE_KIND,
    type PageCoverPayload,
    type PageCreatePayload,
} from '../sync/page-manage';
import {
    decodeSave,
    isLocalPage,
    PAGE_CREATE_KIND,
    PAGE_SAVE_KIND,
    PAGE_SAVE_REFUSALS,
    type PageText,
} from '../sync/page-save';
import { pageOfLane } from '../sync/pages';
import { ROOM_MESSAGE_KIND } from '../sync/room-send';
import {
    GOAL_COMMENT_KIND,
    type GoalCommentPayload,
    SCHEDULE_ACTION_KIND,
    SCHEDULE_REASON,
    type ScheduleActionPayload,
} from '../sync/schedule-writes';

import { UNTITLED_CHAT } from './chat-list';
import { UNTITLED_PAGE } from './space-library';

// The account sheet's Unsent list: every write
// the server refused, oldest first, with what it was, where it went, why it
// didn't go (plain words, never the server's text), what it holds back, and
// the text Copy takes. A chat that answered 404 or 410 says "You no longer have
// access". No React Native, so tests/shell runs it under Node.

/** The plain words for a refusal's code; any other code gets `UNSENT_FALLBACK`. */
export const UNSENT_REASON_COPY: Readonly<Record<string, string>> = {
    [UNSENT_GONE]: 'You no longer have access',
    'no-chat': 'Its chat was never created',
    'socio-gone': 'That socio is no longer here',
    'too-large': 'Too long to send',
    'http-413': 'Too long to send',
    content: 'It couldn’t be sent as written',
    'http-400': 'It couldn’t be sent as written',
    refused: 'You can’t send this there',
    'http-403': 'You can’t send this there',
    'attachment-failed': 'A file couldn’t be sent',
    'attachment-expired': 'A file couldn’t be sent',
    'copy-failed': 'A file couldn’t be sent',
    delivered: 'It had gone to the socio already',
    conflict: 'It changed somewhere else first',
    // A filing's refusals, never the server's text ("Only an admin can change this.").
    [ISSUE_REFUSALS.invalid]: 'It couldn’t be filed as written',
    [ISSUE_REFUSALS.forbidden]: 'You can’t file it like this',
    [ISSUE_REFUSALS.runGone]: 'That run is no longer available',
    // Issue comments.
    [COMMENT_REFUSALS.invalid]: 'It couldn’t be sent as written',
    [COMMENT_REFUSALS.notYours]: 'You can change only your own comments',
    [COMMENT_REFUSALS.noIssue]: 'Its issue was never filed',
    [COMMENT_REFUSALS.noComment]: 'Its comment was never sent',
    // Issue field edits and votes (no-issue is the comments' code, worded above).
    [ISSUE_EDIT_REFUSALS.conflict]: 'Couldn’t save: someone changed it first',
    [ISSUE_EDIT_REFUSALS.invalid]: 'It couldn’t be saved as written',
    [ISSUE_EDIT_REFUSALS.forbidden]: 'You can’t change this',
    // Files on an issue (a 413 is either cause: the server answers both alike).
    [ISSUE_ATTACHMENT_REFUSALS.tooLarge]: 'Too large, or the issue already has 10 files',
    [ISSUE_ATTACHMENT_REFUSALS.type]: 'Only images, PDFs and plain text can be attached',
    [ISSUE_ATTACHMENT_REFUSALS.invalid]: 'The file couldn’t be sent as it is',
    [ISSUE_ATTACHMENT_REFUSALS.missing]: 'The file is no longer on this phone',
    // Memories.
    [MEMORY_REASON.gone]: 'That memory was deleted',
    [MEMORY_REASON.noMemory]: 'Its memory was never added',
    // Schedules and goals.
    [SCHEDULE_REASON.closed]: 'That schedule was cancelled, or its socio is archived',
    [SCHEDULE_REASON.gone]: 'That schedule is no longer here',
    [SCHEDULE_REASON.goalClosed]: 'That goal is closed, or keeps no more comments',
    [SCHEDULE_REASON.goalGone]: 'That goal is no longer here',
    // A page's save ("Couldn’t save"; a conflict's `conflict` is worded above, and its page's banner
    // settles it).
    [PAGE_SAVE_REFUSALS.deleted]: 'This page was deleted',
    [PAGE_SAVE_REFUSALS.refused]: 'You can’t edit this page',
    [PAGE_SAVE_REFUSALS.invalid]: 'It couldn’t be saved as written',
    [PAGE_SAVE_REFUSALS.noPage]: 'Its page was never created',
    // Creating, moving and deleting pages, and covers.
    [PAGE_MANAGE_REFUSALS.noParent]: 'Its parent page was never created',
    [PAGE_MANAGE_REFUSALS.parentDeleted]: 'Its parent page was deleted',
    [PAGE_MANAGE_REFUSALS.moveTarget]: 'That Space or parent page is no longer there',
    [PAGE_MANAGE_REFUSALS.newSubpages]: 'This page has new subpages',
    [PAGE_MANAGE_REFUSALS.hasSubpages]: 'This page has subpages. Delete them with it, or move them first',
    [PAGE_MANAGE_REFUSALS.deleteRefused]: 'Only an admin or the person who created a page can delete it',
    [PAGE_MANAGE_REFUSALS.coverTooLarge]: 'Images can be at most 5 MB',
    [PAGE_MANAGE_REFUSALS.coverType]: 'Use a PNG, JPEG or WebP image',
    [PAGE_MANAGE_REFUSALS.coverGone]: 'That image is no longer there',
    'upload-failed': 'The image couldn’t be uploaded',
    'upload-missing': 'The image is no longer on this phone',
    // A chat's model the server doesn't take (chat-manage.ts).
    model: 'That model isn’t available to you',
    // A room's refusals, by the code the server sends, and a Telegram topic's.
    archived: 'This room is archived',
    rooms_off: 'Rooms are turned off',
    read_only: 'This room is read-only',
    not_admin: 'Only a room admin can do that',
    not_initiator: 'Only its sender or a room admin can do that',
    telegram: 'Send this one in Telegram',
};
/** The writes on one issue, which say `CB-<n>` where they went. */
const ISSUE_KINDS = new Set([
    ISSUE_COMMENT_KIND,
    COMMENT_EDIT_KIND,
    COMMENT_DELETE_KIND,
    ISSUE_UPDATE_KIND,
    ISSUE_VOTE_KIND,
    ISSUE_ATTACHMENT_KIND,
]);
/** An issue filed offline, not numbered yet (the filing's `CB-?`). */
const PENDING_ISSUE_REF = 'CB-?';
export const UNSENT_FALLBACK = 'It wasn’t sent';
/** Where a filing went: the board. */
export const ISSUE_BOARD = 'Board';
/** A chat the workspace no longer lists. */
export const UNKNOWN_CHAT = 'A chat';
/** Where a memory's write went. */
export const MEMORIES_WHERE = 'Memories';
/** Where a profile's write went. */
export const PROFILE_WHERE = 'Your profile';
/** Where a schedule's or a goal's write went. */
export const SCHEDULES_WHERE = 'Schedules';
/** A page save's button when its page is gone. */
export const SAVE_AS_NEW_PAGE = 'Save as a new page';
/** A page conflict's button: its page, where the banner settles it. */
export const OPEN_PAGE = 'Open page';
/** Where a page's write went when the phone doesn't list its Space. */
export const SOME_SPACE = 'A Space';

/** The page writes, which say their Space where they went and the page's title in what. */
const PAGE_KINDS: readonly string[] = [
    PAGE_SAVE_KIND,
    PAGE_CREATE_KIND,
    PAGE_MOVE_KIND,
    PAGE_DELETE_KIND,
    PAGE_COVER_KIND,
];
/** A save refused because its page is gone: the list offers Save as a new page. */
const PAGE_GONE: readonly string[] = [PAGE_SAVE_REFUSALS.deleted, PAGE_SAVE_REFUSALS.noPage, UNSENT_GONE];

const SCHEDULE_ACTION_WHAT: Readonly<Record<string, string>> = {
    pause: 'Pause schedule',
    resume: 'Resume schedule',
    cancel: 'Cancel schedule',
};

const MEMORY_KINDS: readonly string[] = [
    MEMORY_ADD_KIND,
    MEMORY_UPDATE_KIND,
    MEMORY_APPROVE_KIND,
    MEMORY_CONFIRM_KIND,
    MEMORY_DELETE_KIND,
];
const PROFILE_KINDS: readonly string[] = [PROFILE_SAVE_KIND, PROFILE_CLEAR_KIND];

export interface UnsentListRow {
    readonly id: string;
    /** What it was: "Message", "Rename", ... */
    readonly what: string;
    /** Where it went: the chat's title, Memories, Your profile or Schedules. */
    readonly where: string;
    /** Why it didn't go, in plain words. */
    readonly why: string;
    /** "2 more wait behind it", or null. */
    readonly holding: string | null;
    /** What the person wrote, shown and copied; null when there is nothing to copy (a reaction, a delete). */
    readonly text: string | null;
    /** Whether it offers Edit: a refused filing reopens FileIssue with what was written. */
    readonly editable: boolean;
    /** A page's save whose page is gone: Save as a new page, in this Space by default. */
    readonly saveAsNew: { readonly spaceId: string; readonly mine: PageText } | null;
    /** A page's conflict: Open page, where its banner settles it. */
    readonly opens: { readonly spaceId: string; readonly pageId: string } | null;
    readonly accessibilityLabel: string;
}

export interface UnsentListContext {
    /** A chat's title by its server id, or null when the workspace doesn't list it. */
    readonly chatTitle: (threadId: string) => string | null;
    /** A local id's server id (new chats), or null. */
    readonly resolve: (localId: string) => string | null;
    /** An issue's local key's number (`ids`' `issue`), or null while its create hasn't resolved. */
    readonly issueNumber?: (localKey: string) => string | null;
    /** A Space's name, or null when the phone doesn't list it. */
    readonly spaceName?: (spaceId: string) => string | null;
    /** A page's title as the phone holds it (its summary), or null. */
    readonly pageTitle?: (spaceId: string, pageId: string) => string | null;
    /** A page's server id for its local id (`ids`' `page`), or null while its create hasn't resolved. */
    readonly pageId?: (localId: string) => string | null;
}

/** The badge's label: null for none, `9+` past nine. */
export function unsentBadge(count: number): string | null {
    if (count <= 0) {
        return null;
    }
    return count > 9 ? '9+' : String(count);
}

export function unsentWhy(reason: string): string {
    return UNSENT_REASON_COPY[reason] ?? UNSENT_FALLBACK;
}

function parse(write: UnsentWrite): Record<string, unknown> | null {
    try {
        const value: unknown = JSON.parse(write.payload);
        return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);

const quoted = (title: string) => `“${pageTitle(title) || UNTITLED_PAGE}”`;

/** A page's title and text as Copy takes them: the title, a blank line, then the text when it has one. */
const pageCopy = (page: Partial<PageText> | null) => {
    const title = text(page?.title);
    const body = text(page?.content);
    return title !== null && body !== null ? `${title}\n\n${body}` : (title ?? body);
};

/** A page write's what: "Couldn’t save “Roadmap”", "Move “Roadmap”", ... */
function describePage(
    write: UnsentWrite,
    payload: Record<string, unknown> | null,
    context: UnsentListContext,
): { what: string; text: string | null } {
    const spaceId = typeof payload?.spaceId === 'string' ? payload.spaceId : null;
    const pageId = typeof payload?.pageId === 'string' ? payload.pageId : null;
    const held = spaceId === null || pageId === null ? null : (context.pageTitle?.(spaceId, pageId) ?? null);
    const named = (verb: string, fallback: string) => (held === null ? fallback : `${verb} ${quoted(held)}`);
    switch (write.kind) {
        case PAGE_SAVE_KIND: {
            const draft = (payload?.draft ?? null) as Partial<PageText> | null;
            const title = typeof draft?.title === 'string' ? draft.title : (held ?? '');
            return { what: `Couldn’t save ${quoted(title)}`, text: pageCopy(draft) };
        }
        case PAGE_CREATE_KIND: {
            const create = payload as Partial<PageCreatePayload> | null;
            return {
                what: `New page ${quoted(typeof create?.title === 'string' ? create.title : '')}`,
                text: pageCopy(create),
            };
        }
        case PAGE_MOVE_KIND:
            return { what: named('Move', 'Move a page'), text: null };
        case PAGE_DELETE_KIND:
            return { what: named('Delete', 'Delete a page'), text: null };
        default: {
            const removed = (payload as Partial<PageCoverPayload> | null)?.change?.kind === 'remove';
            return {
                what: removed ? named('Remove the cover of', 'Remove a cover') : named('Cover of', 'Page cover'),
                text: null,
            };
        }
    }
}

/** A page's save whose page is gone, with what the person wrote: Save as a new page takes it. */
function savedAsNew(write: UnsentWrite): UnsentListRow['saveAsNew'] {
    if (write.kind !== PAGE_SAVE_KIND || !PAGE_GONE.includes(write.reason)) {
        return null;
    }
    try {
        const save = decodeSave(write.payload);
        return { spaceId: save.spaceId, mine: { title: save.draft.title, content: save.draft.content } };
    } catch {
        return null;
    }
}

/** A page's conflict opens its page, by the id its lane names (the server's once its create resolved). */
function conflictPage(
    write: UnsentWrite,
    payload: Record<string, unknown> | null,
    context: UnsentListContext,
): UnsentListRow['opens'] {
    if (write.kind !== PAGE_SAVE_KIND || write.reason !== PAGE_SAVE_REFUSALS.conflict) {
        return null;
    }
    const theirs = payload?.theirs as { spaceId?: unknown } | undefined;
    const spaceId =
        typeof theirs?.spaceId === 'string'
            ? theirs.spaceId
            : typeof payload?.spaceId === 'string'
              ? payload.spaceId
              : null;
    const named = pageOfLane(write.lane) ?? (typeof payload?.pageId === 'string' ? payload.pageId : null);
    if (spaceId === null || named === null) {
        return null;
    }
    return { spaceId, pageId: isLocalPage(named) ? (context.pageId?.(named) ?? named) : named };
}

/** What the write was and what of it the person wrote. */
function describe(
    write: UnsentWrite,
    payload: Record<string, unknown> | null,
    context: UnsentListContext,
): { what: string; text: string | null } {
    if (PAGE_KINDS.includes(write.kind)) {
        return describePage(write, payload, context);
    }
    switch (write.kind) {
        case CHAT_MESSAGE_KIND:
        case ROOM_MESSAGE_KIND: {
            const message = payload as Partial<ChatMessagePayload> | null;
            const files = Array.isArray(message?.attachments) ? message.attachments.length : 0;
            const what = files === 0 ? 'Message' : files === 1 ? 'Message with 1 file' : `Message with ${files} files`;
            return { what, text: text(message?.text) };
        }
        case ISSUE_CREATE_KIND: {
            const filing = payload as Partial<IssueCreatePayload> | null;
            const title = text(filing?.title);
            const body = text(filing?.body);
            return {
                what: 'New issue',
                text: title !== null && body !== null ? `${title}\n\n${body}` : (title ?? body),
            };
        }
        case ISSUE_COMMENT_KIND:
            return { what: 'Comment', text: text((payload as Partial<IssueCommentPayload> | null)?.body) };
        case COMMENT_EDIT_KIND:
            return { what: 'Edited comment', text: text((payload as Partial<CommentEditPayload> | null)?.body) };
        case COMMENT_DELETE_KIND:
            return { what: 'Delete comment', text: null };
        case ISSUE_UPDATE_KIND: {
            // What the person wrote: a new title and description, when they changed them.
            const fields = (payload as Partial<IssueUpdatePayload> | null)?.fields;
            const written = [fields?.title?.value, fields?.body?.value, fields?.resolution?.value]
                .map(text)
                .filter((value): value is string => value !== null);
            return { what: 'Issue edit', text: written.length === 0 ? null : written.join('\n\n') };
        }
        case ISSUE_VOTE_KIND:
            return {
                what: (payload as Partial<IssueVotePayload> | null)?.vote === false ? 'Remove vote' : 'Vote',
                text: null,
            };
        case ISSUE_ATTACHMENT_KIND: {
            const name = text((payload as Partial<IssueAttachmentPayload> | null)?.name);
            return { what: name === null ? 'File' : `File “${name}”`, text: null };
        }
        case NEW_CHAT_KIND:
            return { what: 'New chat', text: text((payload as Partial<NewChatPayload> | null)?.title) };
        case STEERING_EDIT_KIND:
            return { what: 'Edited message', text: text((payload as Partial<SteeringEditPayload> | null)?.text) };
        case STEERING_CANCEL_KIND:
            return { what: 'Cancel a queued message', text: null };
        case CHAT_UPDATE_KIND: {
            const update = payload as Partial<ChatUpdatePayload> | null;
            const title = text(update?.title);
            if (title !== null) {
                return { what: 'Rename', text: title };
            }
            if (update?.inference !== undefined && update.archived === undefined) {
                return { what: 'Chat model', text: null };
            }
            return { what: update?.archived === false ? 'Unarchive' : 'Archive', text: null };
        }
        case CHAT_DELETE_KIND:
            return { what: 'Delete chat', text: null };
        case REACTION_KIND:
            return { what: 'Reaction', text: null };
        case MEMORY_ADD_KIND:
            return { what: 'New memory', text: text((payload as Partial<MemoryAddPayload> | null)?.text) };
        case MEMORY_UPDATE_KIND: {
            const update = payload as Partial<MemoryUpdatePayload> | null;
            const edited = text(update?.text);
            if (edited !== null) {
                return { what: 'Edited memory', text: edited };
            }
            return { what: update?.shareable === false ? 'Stop sharing a memory' : 'Share a memory', text: null };
        }
        case MEMORY_APPROVE_KIND:
            return { what: 'Approve a memory', text: null };
        case MEMORY_CONFIRM_KIND:
            return { what: 'Still true', text: null };
        case MEMORY_DELETE_KIND:
            return { what: 'Delete memory', text: null };
        case PROFILE_SAVE_KIND: {
            const fields = (payload as Partial<ProfileSavePayload> | null)?.fields ?? {};
            const lines = PROFILE_FIELDS.flatMap((field) =>
                typeof fields[field] === 'string' ? [`${PROFILE_LABELS[field]}: ${fields[field]}`] : [],
            );
            return { what: 'Profile', text: lines.length === 0 ? null : lines.join('\n') };
        }
        case PROFILE_CLEAR_KIND:
            return { what: 'Clear profile', text: null };
        case SCHEDULE_ACTION_KIND: {
            const action = (payload as Partial<ScheduleActionPayload> | null)?.action;
            return { what: (action && SCHEDULE_ACTION_WHAT[action]) ?? 'Schedule', text: null };
        }
        case GOAL_COMMENT_KIND:
            return { what: 'Goal comment', text: text((payload as Partial<GoalCommentPayload> | null)?.body) };
        default:
            return { what: 'Change', text: null };
    }
}

function chatOf(write: UnsentWrite, payload: Record<string, unknown> | null, context: UnsentListContext): string {
    if (write.kind === ISSUE_CREATE_KIND) {
        return ISSUE_BOARD;
    }
    if (ISSUE_KINDS.has(write.kind)) {
        // Issue comments, edits and votes: the issue it was on, `CB-?` while one filed offline has no number.
        const issue = typeof payload?.issue === 'string' ? payload.issue : null;
        const number = issue === null ? null : isLocalIssue(issue) ? (context.issueNumber?.(issue) ?? null) : issue;
        return number === null ? PENDING_ISSUE_REF : `CB-${number}`;
    }
    if (MEMORY_KINDS.includes(write.kind)) {
        return MEMORIES_WHERE;
    }
    if (PROFILE_KINDS.includes(write.kind)) {
        return PROFILE_WHERE;
    }
    if (write.kind === SCHEDULE_ACTION_KIND || write.kind === GOAL_COMMENT_KIND) {
        return SCHEDULES_WHERE;
    }
    if (PAGE_KINDS.includes(write.kind)) {
        const spaceId = typeof payload?.spaceId === 'string' ? payload.spaceId : null;
        return (spaceId === null ? null : (context.spaceName?.(spaceId) ?? null)) ?? SOME_SPACE;
    }
    const named = typeof payload?.threadId === 'string' ? payload.threadId : null;
    // A new chat's create is its own row: its id is the chat's local id.
    const local = named ?? (write.kind === NEW_CHAT_KIND ? write.id : null);
    if (local === null) {
        return UNKNOWN_CHAT;
    }
    if (write.kind === NEW_CHAT_KIND) {
        return text((payload as Partial<NewChatPayload> | null)?.title) ?? UNTITLED_CHAT;
    }
    const title = context.chatTitle(context.resolve(local) ?? local);
    return title === null ? UNKNOWN_CHAT : title.trim() === '' ? UNTITLED_CHAT : title;
}

/** At most this many characters of a row's text go in its screen-reader label: a page's whole body would be read out. */
export const UNSENT_LABEL_TEXT_MAX = 200;

/** A row's text for its label: one line, at most UNSENT_LABEL_TEXT_MAX characters, cut at a word with "…". */
export function labelExcerpt(text: string | null): string | null {
    const line = text?.replace(/\s+/g, ' ').trim() ?? '';
    if (line === '') {
        return null;
    }
    if (line.length <= UNSENT_LABEL_TEXT_MAX) {
        return line;
    }
    const cut = line.slice(0, UNSENT_LABEL_TEXT_MAX - 1);
    const space = cut.lastIndexOf(' ');
    return `${(space > UNSENT_LABEL_TEXT_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The list's rows, oldest first, each with how many rows its refusal holds back (`holds()`). */
export function unsentListRows(
    writes: readonly UnsentWrite[],
    groups: readonly HoldGroup[],
    context: UnsentListContext,
): UnsentListRow[] {
    const held = new Map(groups.map((group) => [group.root.id, group.rows.length]));
    return [...writes]
        .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((write) => {
            const payload = parse(write);
            const { what, text: written } = describe(write, payload, context);
            const where = chatOf(write, payload, context);
            const why = unsentWhy(write.reason);
            const behind = held.get(write.id) ?? 0;
            const holding =
                behind === 0 ? null : behind === 1 ? '1 more waits behind it' : `${behind} more wait behind it`;
            return {
                id: write.id,
                what,
                where,
                why,
                holding,
                text: written,
                editable: unsentIssueFields(write) !== null,
                saveAsNew: savedAsNew(write),
                opens: conflictPage(write, payload, context),
                accessibilityLabel: [what, where, labelExcerpt(written), why, holding].filter(Boolean).join(', '),
            };
        });
}

/**
 * At most this many rows show in the Account sheet; past them, "See all" opens the Unsent page with every
 * row. Two, so See all and Sign out stay on the screen: five pushed both off it on both platforms.
 */
export const UNSENT_SHOWN = 2;

/**
 * The rows the sheet draws, and the label of the button to the Unsent page when there are more.
 * The sheet sizes to its content, and on iOS a ScrollView inside it was taken as the sheet's own (its
 * top cut off), so the sheet doesn't scroll: it shows the oldest `UNSENT_SHOWN`, and the page (its
 * own ScrollView) lists them all, each with Copy and Discard.
 */
export function shownUnsent<Row>(rows: readonly Row[]): {
    readonly shown: readonly Row[];
    readonly seeAll: string | null;
} {
    return {
        shown: rows.slice(0, UNSENT_SHOWN),
        seeAll: rows.length > UNSENT_SHOWN ? `See all ${rows.length} unsent` : null,
    };
}
