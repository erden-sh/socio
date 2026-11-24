import { isComponentRef, ISSUE_COMPONENTS_MAX } from '@socio/shared/issues/issue-components';
import {
    type IssueArea,
    type IssueDetail,
    type IssueKind,
    type IssuePriority,
    type IssueSummary,
    ISSUE_AREAS,
    ISSUE_KINDS,
    ISSUE_PRIORITIES,
} from '@socio/shared/issues/issue-types';

import { NetworkError } from '../net/errors';
import { issueScreen, keptIssue, LAST_SCREEN_KEY } from '../shell/last-screen';

import type { Drafts } from './chat-drafts';
import type { IssueDetails } from './issue-details';
import { issueKey, ISSUES } from './issues';
import { isLocalIssue, ISSUE_IDS, newLocalIssueId, shownIssueKey } from './local-ids';
import type {
    CheckOutcome,
    NewOutboxWrite,
    Outbox,
    OutboxKind,
    OutboxRow,
    SendOutcome,
    SettleStatements,
    UnsentWrite,
} from './outbox';
import { type Answer, type ClassifierAction, classify, readAnswer } from './outbox-answers';
import { serverSince } from './server-clock';
import type { ViewState } from './view-state';

// Filing an issue, offline and exactly once. The server numbers issues,
// so one filed on the phone is known by a local key (`pending-issue-<uuid>`,
// local-ids.ts's `isLocalIssue`, never `local-`, which `isLocalChat` claims)
// until its create resolves. Routes carry that key; `CB-?` is only what a
// screen shows.
//
// - **One transaction.** `fileIssue` sends FileIssue's box (`issue:new`, its
//   fields as JSON): the create (`POST /api/issues`, the row's id the local
//   key, lane `issue:<local>`), any rows that go with it (its attachments,
//   `more`) and the box's clearing, so a kill leaves all or none.
// - **What goes.** `{title, body, kind, priority, area?, components?, runId?}`,
//   the members' fields (foundation's `createRefusal`). The title is trimmed
//   before it is queued, as the server stores it (`z.string().trim()`); the
//   body goes as typed, since the server keeps it so.
//   `components` (CB-442) goes only when some are picked: a server from before
//   CB-442 has a strict schema and answers an unknown field with 400 (an
//   `issue-invalid` refusal the person can Edit), so the form offers the
//   picker only once the list says the server has components. A row with
//   components is payload version 2, which a build from before them keeps and
//   never sends without them.
// - **Answers**: a 201's detail gives the number, written to `ids`
//   (`issue`) as the row settles, and the detail goes to `issueDetails` first
//   (the hand-off, which also puts its row in `issues`). 400 and 403 go to
//   `unsent` under codes the Unsent list words (the server's "Only an
//   admin can change this" is never shown); a 404 with `runId` is the run gone.
//   A readable 503 goes again; a proxy's page, a plain 5xx or no answer at all
//   may have made the issue, so they are `unknown`.
// - **The check**. Numbers only grow (`nextNumber`
//   takes the larger of a counter and `MAX(number)`, and deletes are soft), so
//   the watermark is the highest number the phone held as the person filed
//   (`after`), with the server's Date (`serverAt`, server-clock.ts). After a
//   fresh `GET /api/issues`, candidates are numbers above it, changed at or
//   after `serverSince` (an issue's `updatedAt` is never before its
//   `createdAt`), and no other write's (`context.claimed`). Their details are
//   read: a match has the same trimmed title and the same body as filed, the
//   person as reporter and `createdAt` at or after `serverSince`. The values
//   at filing come from the detail's `events` (an edit's `fromValue`), so an
//   admin who triaged or retitled it first doesn't hide it; kind, priority
//   and area only break a tie. One match is the create's. Two are
//   "Couldn't confirm this was sent", with their numbers for View. None
//   goes again when the attempt got no answer (a dropped connection, a kill,
//   a stop): the fresh list would hold it otherwise. After an error answer
//   (a proxy's page, a 5xx) the server may still be filing it, so it waits
//   for the person.
// - **Re-keying** (`createLocalIssues`): once the create resolves, the
//   issue's comment draft (`issue-comments:<local>`) and the last screen
//   (`Issue/<local>`) move to the number, and `subscribe` tells the screen,
//   which swaps its route param. The `ids` entry is written in the settle's
//   transaction, so the scope repeats the moves as it opens after a kill.
// - **On screen** (`overlay`): a row in `issues` under the local key, which the
//   board shows at the top of Triage as `CB-?` (src/shell/issue-filing.ts).
// - **Edit** for a refused filing (`unsentIssueFields`, `resendIssue`): the
//   form reopens with what was written, and Send changes the refused row in
//   place (`editUnsent`) and sends it again (`retryUnsent`), so the rows it
//   holds (its attachments, which wait on it) follow it.
//
// No React Native: tests/sync runs it under Node against a fake server.

export const ISSUE_CREATE_KIND = 'issue-create';
export const ISSUE_CREATE_VERSION = 2;
/** The version of a create with no components, which every build reads. */
const PLAIN_CREATE_VERSION = 1;

/** FileIssue's box: its text is `issueDraftText`'s JSON. */
export const ISSUE_DRAFT = 'issue:new';

/** The lane of issue `key`'s create and field edits (issue-edit.ts). */
export const issueLane = (key: string) => `issue:${key}`;
/** Issue `key`'s comment box (issue-comments.ts). */
export const issueCommentsDraft = (key: string) => `issue-comments:${key}`;

/** What the person files: the members' fields (foundation's MEMBER_CREATE), and the run it came from. */
export interface IssueFields {
    readonly title: string;
    readonly body: string;
    readonly kind: IssueKind;
    readonly priority: IssuePriority;
    readonly area: IssueArea | null;
    /** The plugins and apps it is about (CB-442): refs from the person's options, at most 10. */
    readonly components?: readonly string[];
    /** A failed run's "File issue" (Learning and Runs): the run it links to. */
    readonly runId?: string | null;
}

/** The create, as its outbox row keeps it. Its row's id is the issue's local key. */
export interface IssueCreatePayload extends IssueFields {
    /** The person filing (the scope's app user id): the check's reporter. */
    readonly reporterId: string;
    /** The check's watermark: the highest issue number the phone held, or null for none. */
    readonly after: number | null;
    /** The scope's newest Date header as the person filed, or null. */
    readonly serverAt: number | null;
}

/** The web's form defaults (ReportIssue.tsx). */
export const ISSUE_FIELD_DEFAULTS = { kind: 'bug', priority: 'medium', area: null } as const;

const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
    typeof value === 'string' && (values as readonly string[]).includes(value);

/** Component refs as a draft or a payload holds them: valid ones, each once, at most 10. */
export function issueComponents(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const refs = value.filter((ref): ref is string => typeof ref === 'string' && isComponentRef(ref));
    return [...new Set(refs)].slice(0, ISSUE_COMPONENTS_MAX);
}

/** FileIssue's box as text: the fields as JSON. */
export const issueDraftText = (fields: Partial<IssueFields>) => JSON.stringify(fields);

/** FileIssue's box read back: its fields with the web's defaults, or null for text that isn't one. */
export function readIssueDraft(text: string): IssueFields | null {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return null;
    }
    if (typeof value !== 'object' || value === null) {
        return null;
    }
    const fields = value as Record<string, unknown>;
    const components = issueComponents(fields.components);
    return {
        title: typeof fields.title === 'string' ? fields.title : '',
        body: typeof fields.body === 'string' ? fields.body : '',
        kind: oneOf(ISSUE_KINDS, fields.kind) ? fields.kind : ISSUE_FIELD_DEFAULTS.kind,
        priority: oneOf(ISSUE_PRIORITIES, fields.priority) ? fields.priority : ISSUE_FIELD_DEFAULTS.priority,
        area: oneOf(ISSUE_AREAS, fields.area) ? fields.area : null,
        ...(components.length ? { components } : {}),
        ...(typeof fields.runId === 'string' && fields.runId !== '' ? { runId: fields.runId } : {}),
    };
}

/** The highest number of the issues a scope holds (its `issues` collection): the create's watermark. */
export function highestIssue(issues: Iterable<{ readonly number?: unknown }>): number | null {
    let highest: number | null = null;
    for (const issue of issues) {
        if (typeof issue.number === 'number' && (highest === null || issue.number > highest)) {
            highest = issue.number;
        }
    }
    return highest;
}

/** The create's payload from what the person filed: the title trimmed as the server stores it, the body as typed. */
export function issueCreatePayload(
    fields: IssueFields,
    watermark: { readonly reporterId: string; readonly after: number | null; readonly serverAt?: number | null },
): IssueCreatePayload {
    return {
        title: fields.title.trim(),
        body: fields.body,
        kind: fields.kind,
        priority: fields.priority,
        area: fields.area,
        ...(fields.components?.length ? { components: issueComponents(fields.components) } : {}),
        ...(fields.runId ? { runId: fields.runId } : {}),
        reporterId: watermark.reporterId,
        after: watermark.after,
        serverAt: watermark.serverAt ?? null,
    };
}

/** A create's payload version: 2 only when it names components (older builds keep it, unsent). */
export const issueCreateVersion = (payload: Pick<IssueFields, 'components'>) =>
    payload.components?.length ? ISSUE_CREATE_VERSION : PLAIN_CREATE_VERSION;

/** A box `fileIssue` can't send: no title, or text that isn't FileIssue's. */
export class IssueDraftError extends Error {
    override readonly name = 'IssueDraftError';
}

export interface FileIssueOptions {
    readonly drafts: Pick<Drafts, 'enqueueFromDraft'>;
    /** A fresh UUID (expo-crypto): the local key and the row's idempotency key. */
    readonly newId: () => string;
    /** The scope's app user id. */
    readonly reporterId: string;
    /** `highestIssue` of the scope's issues as the person filed. */
    readonly after: number | null;
    /** The scope's `serverClock.lastDate()`. */
    readonly serverAt?: number | null;
    /** The box sent: FileIssue's by default. */
    readonly draft?: string;
    /** Rows that go with the create, in its transaction (attachments: one per file, each waiting on it). */
    readonly more?: (localKey: string) => readonly NewOutboxWrite[];
    /** More statements for the insert's transaction (attachments: the tray's files move to their rows). */
    readonly also?: SettleStatements;
}

/**
 * Files what FileIssue's box holds: the issue's local key, which the screen
 * now shows, and the last row stored (the create's, unless `more` added rows). Rejects (IssueDraftError, OutboxError,
 * DraftError) with the box as it was.
 */
export async function fileIssue(
    options: FileIssueOptions,
): Promise<{ readonly localKey: string; readonly row: OutboxRow } | null> {
    const { drafts, newId, reporterId, after, serverAt = null, draft = ISSUE_DRAFT, more, also } = options;
    const localKey = newLocalIssueId(newId);
    const row = await drafts.enqueueFromDraft(
        draft,
        (text) => {
            const fields = readIssueDraft(text);
            if (fields === null) {
                throw new IssueDraftError('Not an issue.');
            }
            if (fields.title.trim() === '') {
                throw new IssueDraftError('An issue needs a title.');
            }
            const payload = issueCreatePayload(fields, { reporterId, after, serverAt });
            const write: NewOutboxWrite = {
                id: localKey,
                lane: issueLane(localKey),
                kind: ISSUE_CREATE_KIND,
                payload: JSON.stringify(payload),
                payloadVersion: issueCreateVersion(payload),
                idempotencyKey: newId(),
            };
            const rest = more?.(localKey) ?? [];
            return rest.length === 0 ? write : [write, ...rest];
        },
        also ? { also } : {},
    );
    return row === null ? null : { localKey, row };
}

function decodePayload(text: string): IssueCreatePayload {
    const value = JSON.parse(text) as Partial<IssueCreatePayload> | null;
    if (
        !value ||
        typeof value.title !== 'string' ||
        typeof value.body !== 'string' ||
        !oneOf(ISSUE_KINDS, value.kind) ||
        !oneOf(ISSUE_PRIORITIES, value.priority) ||
        (value.area !== null && !oneOf(ISSUE_AREAS, value.area)) ||
        (value.runId !== undefined && value.runId !== null && typeof value.runId !== 'string') ||
        (value.components !== undefined &&
            (!Array.isArray(value.components) ||
                issueComponents(value.components).length !== value.components.length)) ||
        typeof value.reporterId !== 'string' ||
        (value.after !== null && typeof value.after !== 'number') ||
        (value.serverAt !== null && typeof value.serverAt !== 'number')
    ) {
        throw new TypeError('Not an issue create.');
    }
    return value as IssueCreatePayload;
}

/**
 * What the server takes: no `area` without one, no `components` without any,
 * no `runId` without a run (its schema is strict).
 */
export function issueCreateBody(payload: IssueFields): Record<string, unknown> {
    return {
        title: payload.title,
        body: payload.body,
        kind: payload.kind,
        priority: payload.priority,
        ...(payload.area ? { area: payload.area } : {}),
        ...(payload.components?.length ? { components: [...payload.components] } : {}),
        ...(payload.runId ? { runId: payload.runId } : {}),
    };
}

/** Refusals' codes, which the Unsent list words. */
export const ISSUE_REFUSALS = {
    invalid: 'issue-invalid',
    forbidden: 'issue-refused',
    runGone: 'run-gone',
} as const;

/** The create's answers before the outbox's defaults. */
function createAnswer(answer: Answer, payload: IssueCreatePayload): ClassifierAction | undefined {
    const { status, code, unreadable } = answer;
    if (status === 400) {
        return { action: 'unsent', reason: ISSUE_REFUSALS.invalid };
    }
    if (status === 403) {
        return { action: 'unsent', reason: ISSUE_REFUSALS.forbidden };
    }
    if (status === 404 && payload.runId) {
        return { action: 'unsent', reason: ISSUE_REFUSALS.runGone };
    }
    if (status === 413) {
        return { action: 'unsent', reason: 'too-large' };
    }
    if (status === 503 && !unreadable && code !== 'draining') {
        // The server's own answer before it filed anything.
        return { action: 'retry', reason: 'unavailable' };
    }
    if ((status === 502 || status === 504 || status === 503) && code !== 'draining') {
        // A proxy's page may come after the server filed it: only the check can tell.
        return { action: 'unknown', reason: 'away' };
    }
    return undefined;
}

const ISSUES_PATH = '/api/issues';
const detailPath = (number: number) => `${ISSUES_PATH}/${number}`;

/** The detail a 201 carries, or null for a body that isn't one. */
function detailOf(body: unknown): IssueDetail | null {
    const detail = body as Partial<IssueDetail> | null;
    const issue = detail?.issue as Partial<IssueDetail['issue']> | undefined;
    if (
        !detail ||
        !issue ||
        typeof issue.number !== 'number' ||
        !Number.isSafeInteger(issue.number) ||
        issue.number <= 0 ||
        typeof issue.updatedAt !== 'number' ||
        !Array.isArray(detail.comments) ||
        !Array.isArray(detail.attachments) ||
        !Array.isArray(detail.events) ||
        typeof detail.users !== 'object' ||
        detail.users === null
    ) {
        return null;
    }
    return detail as IssueDetail;
}

type FiledField = 'title' | 'body' | 'kind' | 'priority' | 'area';

/** Field `field` as it was filed: the first edit's `fromValue` when the detail's events have one, else its value now. */
export function filedValue(detail: IssueDetail, field: FiledField): string | null {
    let first: { createdAt: number; fromValue: string | null } | null = null;
    for (const event of detail.events) {
        if (event.kind === field && (first === null || event.createdAt < first.createdAt)) {
            first = event;
        }
    }
    if (first !== null) {
        return first.fromValue;
    }
    const value = detail.issue[field];
    return typeof value === 'string' ? value : null;
}

/** Whether `detail` is what `payload` filed: title, body, reporter and time. */
function isFiling(detail: IssueDetail, payload: IssueCreatePayload, since: number | null): boolean {
    return (
        detail.issue.reporterId === payload.reporterId &&
        (filedValue(detail, 'title') ?? '').trim() === payload.title.trim() &&
        (filedValue(detail, 'body') ?? '') === payload.body &&
        (since === null || detail.issue.createdAt >= since)
    );
}

/** Whether `detail`'s kind, priority and area at filing are `payload`'s: only to break a tie. */
const sameChoices = (detail: IssueDetail, payload: IssueCreatePayload) =>
    filedValue(detail, 'kind') === payload.kind &&
    filedValue(detail, 'priority') === payload.priority &&
    filedValue(detail, 'area') === payload.area;

/** A row's last error that was an answer (a proxy's page, a 5xx), not a request with none: the server may still be filing it. */
export const answeredWithError = (lastError: string | null) => lastError !== null && !lastError.endsWith('Error');

export interface IssueCreateOptions {
    /** The scope's issue details: a 201's or a check's detail is handed off there, which also puts its list row. */
    readonly issueDetails?: Pick<IssueDetails, 'put'>;
    /** After a create the server took: the list is pulled (`notesForWrite`). */
    readonly afterWrite?: (path: string) => void;
}

/** The issue create kind. */
export function issueCreateKind(options: IssueCreateOptions = {}): OutboxKind<IssueCreatePayload> {
    const { issueDetails, afterWrite } = options;
    const settled = (detail: IssueDetail) => {
        const key = issueKey(detail.issue.number);
        afterWrite?.(ISSUES_PATH);
        return {
            serverId: key,
            ...(issueDetails ? { handOff: () => issueDetails.put(key, detail) } : {}),
        };
    };
    return {
        kind: ISSUE_CREATE_KIND,
        payloadVersion: ISSUE_CREATE_VERSION,
        repeatable: false,
        creates: ISSUE_IDS,
        decode: (payload) => decodePayload(payload),

        async send({ payload }, context): Promise<SendOutcome> {
            const response = await context.fetch(ISSUES_PATH, { method: 'POST', json: issueCreateBody(payload) });
            const answer = await readAnswer(response, context.signal);
            const action = classify(answer, { method: 'POST', special: (read) => createAnswer(read, payload) });
            switch (action.action) {
                case 'delivered': {
                    const detail = detailOf(answer.body);
                    // A 2xx without the issue: the check finds it.
                    return detail === null
                        ? { action: 'unknown', reason: `http-${answer.status}` }
                        : { action: 'done', ...settled(detail) };
                }
                case 'back-off':
                    return action.delayMs === null
                        ? { action: 'retry', reason: action.reason }
                        : { action: 'retry', delayMs: action.delayMs, reason: action.reason };
                case 'retry':
                case 'unknown':
                case 'unsent':
                    return action;
                default:
                    return { action: 'unsent', reason: `http-${answer.status}` };
            }
        },

        async check({ row, payload }, context): Promise<CheckOutcome> {
            const read = async (path: string) => {
                const answer = await readAnswer(await context.fetch(path), context.signal);
                if (answer.status === 404 || answer.status === 410) {
                    return null;
                }
                if (answer.status < 200 || answer.status >= 300 || answer.body === null) {
                    // Can't tell now: the outbox asks again after the back-off.
                    throw new NetworkError(path);
                }
                return answer.body;
            };
            const list = (await read(ISSUES_PATH)) as { issues?: unknown } | null;
            if (list === null || !Array.isArray(list.issues)) {
                throw new NetworkError(ISSUES_PATH);
            }
            const since = serverSince(payload.serverAt);
            const unbounded = payload.after === null && since === null;
            const numbers = (list.issues as Partial<IssueSummary>[])
                .filter(
                    (issue) =>
                        typeof issue?.number === 'number' &&
                        (payload.after === null || issue.number > payload.after) &&
                        (since === null || (typeof issue.updatedAt === 'number' && issue.updatedAt >= since)) &&
                        // With no bound at all, the list's title narrows what is read.
                        (!unbounded || (issue.title ?? '').trim() === payload.title.trim()) &&
                        !context.claimed(ISSUE_IDS, issueKey(issue.number)),
                )
                .map((issue) => issue.number as number)
                .sort((a, b) => a - b);
            const found: IssueDetail[] = [];
            for (const number of numbers) {
                const detail = detailOf(await read(detailPath(number)));
                if (detail !== null && isFiling(detail, payload, since)) {
                    found.push(detail);
                }
            }
            const narrowed = found.length > 1 ? found.filter((detail) => sameChoices(detail, payload)) : found;
            const matches = narrowed.length === 0 ? found : narrowed;
            if (matches.length === 1) {
                return { action: 'sent', ...settled(matches[0]!) };
            }
            if (matches.length > 1) {
                return { action: 'unconfirmed', candidates: matches.map((detail) => issueKey(detail.issue.number)) };
            }
            // None, on a fresh list: it never landed, unless an error answer says it may yet.
            return answeredWithError(row.lastError)
                ? { action: 'unconfirmed', candidates: [] }
                : { action: 'not-sent' };
        },

        overlay({ id, payload }) {
            return { collection: ISSUES, key: id, mode: 'insert', value: pendingIssue(id, payload) };
        },
    };
}

/** A filing not yet numbered, as the board lays it over its rows (`CB-?`). */
export interface PendingIssue {
    /** The local key: the row's view-model key and its route param. */
    readonly key: string;
    readonly number: null;
    readonly title: string;
    readonly body: string;
    readonly status: 'triage';
    readonly kind: IssueKind;
    readonly priority: IssuePriority;
    readonly area: IssueArea | null;
    /** The components picked (CB-442); none on an overlay made before them. */
    readonly components?: readonly string[];
}

const pendingIssue = (key: string, payload: IssueCreatePayload): PendingIssue => ({
    key,
    number: null,
    title: payload.title,
    body: payload.body,
    status: 'triage',
    kind: payload.kind,
    priority: payload.priority,
    area: payload.area,
    components: payload.components ?? [],
});

// ---- Edit for a refused filing ------------------------------------------------

/** What a refused filing wrote, for FileIssue to show again; null for another kind's write or one this build can't read. */
export function unsentIssueFields(write: Pick<UnsentWrite, 'kind' | 'payload' | 'payloadVersion'>): IssueFields | null {
    if (write.kind !== ISSUE_CREATE_KIND || write.payloadVersion > ISSUE_CREATE_VERSION) {
        return null;
    }
    try {
        const { title, body, kind, priority, area, components, runId } = decodePayload(write.payload);
        return {
            title,
            body,
            kind,
            priority,
            area,
            ...(components?.length ? { components } : {}),
            ...(runId ? { runId } : {}),
        };
    } catch {
        return null;
    }
}

export interface ResendIssueOptions {
    readonly outbox: Pick<Outbox, 'unsent' | 'editUnsent' | 'retryUnsent'>;
    /** The refused filing's id: its local key. */
    readonly id: string;
    readonly fields: IssueFields;
    /** A fresh UUID: the refusal was the old key's outcome. */
    readonly idempotencyKey: string;
}

/**
 * Sends a refused filing again as edited (FileIssue's Edit): in place, so the
 * rows waiting on it follow. False when it is gone, or a row with its id is queued.
 */
export async function resendIssue({ outbox, id, fields, idempotencyKey }: ResendIssueOptions): Promise<boolean> {
    const write = outbox.unsent().find((item) => item.id === id && item.kind === ISSUE_CREATE_KIND);
    if (write === undefined) {
        return false;
    }
    const old = decodePayload(write.payload);
    const payload = issueCreatePayload(fields, old);
    const edited = await outbox.editUnsent(id, {
        payload: JSON.stringify(payload),
        payloadVersion: issueCreateVersion(payload),
    });
    return edited && outbox.retryUnsent(id, idempotencyKey);
}

// ---- Re-keying ---------------------------------------------------------------

// The last screen's `Issue/<key>` (issueScreen, keptIssue) is last-screen.ts's; re-exported for this file's callers.
export { issueScreen, keptIssue };

/** A filed issue's local key resolved: the number (as a string) a screen showing `localKey` moves to. */
export type IssueResolved = (localKey: string, key: string) => void;

export interface LocalIssues {
    /** Issue `key` as a screen or a link opens it: a resolved local key's number, else `key`. */
    resolve(key: string): string;
    /** Each filing whose create resolved (the screen swaps its route param). Returns the unsubscribe. */
    subscribe(listener: IssueResolved): () => void;
    dispose(): void;
}

export interface LocalIssuesOptions {
    readonly outbox: Pick<Outbox, 'resolve' | 'subscribe'>;
    readonly drafts: Pick<Drafts, 'scopes' | 'rekey'>;
    readonly viewState: Pick<ViewState, 'get' | 'set'>;
    readonly onError?: (error: unknown) => void;
}

/**
 * Re-keys what a filing's local key named once its create resolves: its
 * comment draft and the last screen, then tells the screens. As it starts it
 * repeats the moves for every local key that resolved before a kill.
 */
export function createLocalIssues(options: LocalIssuesOptions): LocalIssues {
    const { outbox, drafts, viewState, onError = () => {} } = options;
    const listeners = new Set<IssueResolved>();
    const numberOf = (localKey: string) => outbox.resolve(ISSUE_IDS, localKey);

    const move = (localKey: string, key: string) => {
        drafts.rekey(issueCommentsDraft(localKey), issueCommentsDraft(key));
        if (keptIssue(viewState.get(LAST_SCREEN_KEY)) === localKey) {
            viewState.set(LAST_SCREEN_KEY, issueScreen(key));
        }
    };

    // A kill after the create settled and before the moves: do them now.
    const prefix = issueCommentsDraft('');
    const named = new Set<string>();
    for (const scope of drafts.scopes()) {
        if (scope.startsWith(prefix)) {
            named.add(scope.slice(prefix.length));
        }
    }
    const kept = keptIssue(viewState.get(LAST_SCREEN_KEY));
    if (kept !== null) {
        named.add(kept);
    }
    for (const key of named) {
        const number = isLocalIssue(key) ? numberOf(key) : null;
        if (number !== null) {
            move(key, number);
        }
    }

    const unsubscribe = outbox.subscribe((change) => {
        if (change.type !== 'remove' || !isLocalIssue(change.id)) {
            return;
        }
        const number = numberOf(change.id);
        if (number === null) {
            return;
        }
        move(change.id, number);
        for (const listener of [...listeners]) {
            try {
                listener(change.id, number);
            } catch (error) {
                onError(error);
            }
        }
    });

    return {
        resolve: (key) => shownIssueKey(outbox.resolve, key),
        subscribe(listener) {
            listeners.add(listener);
            return () => void listeners.delete(listener);
        },
        dispose() {
            unsubscribe();
            listeners.clear();
        },
    };
}
