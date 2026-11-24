import { isComponentRef, ISSUE_COMPONENTS_MAX } from '@socio/shared/issues/issue-components';
import { type Issue, type IssueDetail, type IssueLabel, ISSUE_LABELS } from '@socio/shared/issues/issue-types';

import { NetworkError } from '../net/errors';

import { issueLane } from './issue-create';
import type { IssueDetails } from './issue-details';
import { ISSUES } from './issues';
import { isLocalIssue, ISSUE_IDS, serverIssueKey, shownIssueKey } from './local-ids';
import type { Outbox, OutboxContext, OutboxKind, OutboxRow, OutboxWrite, SendOutcome } from './outbox';
import { UNSENT_GONE } from './outbox';
import { type Answer, type ClassifierAction, classify, readAnswer, type WriteMethod } from './outbox-answers';
import type { Overlay, OverlayKind } from './outbox-overlay';

// Editing issues and voting: two outbox kinds, both safe to repeat.
//
// - **Fields** (`issue-update`, `PATCH /api/issues/:n`) in lane `issue:<n>`,
//   the create's (issue-create.ts), never the comments' or the vote's. The row
//   keeps only the fields the person changed, each with its value and its **base**: the
//   value the server had when the person first changed it (the held detail's,
//   never the overlay's). A later edit of the same issue folds into the queued
//   row and keeps each field's first base; a field changed back to its base
//   leaves the row, and a row with none left goes. Behind a row already going,
//   a new row's base for a field that row changes is that row's value, which
//   the server will have by then. Title and resolution are trimmed as the
//   server stores them (`issuePatch`); the body goes as typed. Components
//   (CB-442, admins only) are a set like labels: at most 10 valid refs, and the
//   server replaces only the refs the admin can see. A row that changes them is
//   payload version 2, which a build from before them keeps unsent (its
//   decode doesn't know the field).
// - **The version check** (the server has none of its own): the send reads the
//   detail fresh first. A field the server already has at the row's value is
//   dropped (an earlier attempt landed); one still at its base goes; one
//   changed to anything else is a conflict, and the row goes to `unsent` as
//   "Couldn't save" (`issue-conflict`), its fresh detail handed to the held
//   one so the screen shows theirs. **Keep mine** (`keepMine`) re-bases the
//   row on the issue the screen shows and sends it again; **Keep theirs**
//   (`keepTheirs`) discards it. Title and description take the same two
//   buttons until a line merge like the pages' (page-merge.ts) lands.
// - **Answers**, never the server's text: 400 is "couldn't be saved as
//   written", 403 a field the person may not change (a member edits only the
//   title and description of their own issue in triage; the screen offers
//   Retry, Copy and Discard), 404 and 410 the issue gone (`UNSENT_GONE`, and
//   issue-details.ts's `onGone` moves its lanes). An issue filed offline
//   whose create never resolved is `no-issue`.
// - **Votes** (`issue-vote`, `POST`/`DELETE /api/issues/:n/vote`) in lane
//   `vote:<n>`: voting again or withdrawing a vote one hasn't changes nothing
//   on the server, so the queued row folds to the newest intent (vote, unvote
//   and vote offline is one POST).
// - **The hand-off**: each answer's detail goes to `issueDetails`, which
//   refreshes the board's row too (the cache's `confirm`), before the row goes; then
//   `afterWrite` reads it again.
// - **On screen** (`overlay`): a patch of the issue's `issues` row (the list's
//   and the detail's, by the key a screen holds) with the pending fields, and
//   `voted`/`votes` for a vote, so a pending priority re-sorts the board.
//
// No React Native: tests/sync runs it under Node against a fake server.

export const ISSUE_UPDATE_KIND = 'issue-update';
export const ISSUE_VOTE_KIND = 'issue-vote';
const VERSION = 1;
/** An edit that changes components (CB-442). */
const COMPONENTS_VERSION = 2;
const versionOf = (fields: Partial<Record<IssueEditField, unknown>>) =>
    'components' in fields ? COMPONENTS_VERSION : VERSION;

/** The fields a `PATCH /api/issues/:n` may carry (`issuePatch`). */
export const ISSUE_EDIT_FIELDS = [
    'title',
    'body',
    'status',
    'priority',
    'kind',
    'area',
    'labels',
    'components',
    'assigneeId',
    'resolution',
] as const;
export type IssueEditField = (typeof ISSUE_EDIT_FIELDS)[number];
export type IssueEditValues = Partial<Pick<Issue, IssueEditField>>;
type FieldValue = Issue[IssueEditField];

/** An issue's components as a base or a value: none when the server sent none. */
export const componentsOf = (issue: Pick<Issue, 'components'>): string[] => issue.components ?? [];

/** The server's limits (`issueInput`). */
export const ISSUE_TITLE_MIN = 3;
export const ISSUE_TITLE_MAX = 200;
export const ISSUE_BODY_MAX = 20_000;
export const ISSUE_RESOLUTION_MAX = 500;

/** Refusals' codes, which the Unsent list words. */
export const ISSUE_EDIT_REFUSALS = {
    /** The field changed on the server since the person's base: Keep mine or Keep theirs. */
    conflict: 'issue-conflict',
    invalid: 'issue-edit-invalid',
    /** A 403: a field the person may not change, or not their issue, or out of triage. */
    forbidden: 'issue-edit-refused',
    /** Its issue was filed offline and never created (issue-comments.ts's code). */
    noIssue: 'no-issue',
} as const;

/** Issue `key`'s vote lane. */
export const voteLane = (key: string) => `vote:${key}`;

export interface FieldChange {
    readonly value: FieldValue;
    /** What the server had when the person first changed it. */
    readonly base: FieldValue;
}

export interface IssueUpdatePayload {
    /** The issue's key: its number, or its local key while filed offline. */
    readonly issue: string;
    readonly fields: Partial<Record<IssueEditField, FieldChange>>;
}

export interface IssueVotePayload {
    readonly issue: string;
    /** The newest intent: true votes, false withdraws. */
    readonly vote: boolean;
    /** What the server showed when the person first tapped, for the overlay's count. */
    readonly baseVoted: boolean;
    readonly baseVotes: number;
}

/** A field's value the server won't take. */
export class IssueEditError extends RangeError {
    override readonly name = 'IssueEditError';
}

/** `value` for field `field` as the server stores it, or a throw (IssueEditError) for one it refuses. */
export function issueFieldValue<F extends IssueEditField>(field: F, value: Issue[F]): Issue[F] {
    if (field === 'title') {
        const title = String(value).trim();
        if (title.length < ISSUE_TITLE_MIN || title.length > ISSUE_TITLE_MAX) {
            throw new IssueEditError(`A title has ${ISSUE_TITLE_MIN} to ${ISSUE_TITLE_MAX} characters.`);
        }
        return title as Issue[F];
    }
    if (field === 'body' && String(value).length > ISSUE_BODY_MAX) {
        throw new IssueEditError(`A description has at most ${ISSUE_BODY_MAX.toLocaleString('en-US')} characters.`);
    }
    if (field === 'components') {
        const refs = (value ?? []) as unknown[];
        if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== 'string' || !isComponentRef(ref))) {
            throw new IssueEditError('A component isn’t one this workspace has.');
        }
        if (new Set(refs).size > ISSUE_COMPONENTS_MAX) {
            throw new IssueEditError(`An issue has at most ${ISSUE_COMPONENTS_MAX} components.`);
        }
        return [...new Set(refs as string[])] as Issue[F];
    }
    if (field === 'resolution' && typeof value === 'string') {
        const resolution = value.trim();
        if (resolution.length > ISSUE_RESOLUTION_MAX) {
            throw new IssueEditError(`A resolution has at most ${ISSUE_RESOLUTION_MAX} characters.`);
        }
        return resolution as Issue[F];
    }
    return value;
}

/** Whether two values of a field are the same (labels in any order). */
export function sameValue(a: unknown, b: unknown): boolean {
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((item) => b.includes(item));
    }
    return a === b || ((a === undefined || a === null) && (b === undefined || b === null));
}

type Lanes = Pick<Outbox, 'rows' | 'unsent' | 'resolve'>;

/**
 * Where an issue write in lanes `lane(key)` goes (issue-comments.ts's `commentRoute`): for an
 * issue not created yet, its local key's lane after its create; for a number,
 * the lane of a local key that resolved to it while that lane still holds a
 * write; else its own.
 */
export function issueRoute(
    outbox: Lanes,
    issue: string,
    lane: (key: string) => string = issueLane,
): { lane: string; dependsOn: string | null } {
    if (isLocalIssue(issue)) {
        return { lane: lane(issue), dependsOn: outbox.resolve(ISSUE_IDS, issue) === null ? issue : null };
    }
    const prefix = lane('');
    for (const write of [...outbox.rows(), ...outbox.unsent()]) {
        const local = write.lane.startsWith(prefix) ? write.lane.slice(prefix.length) : null;
        if (local !== null && isLocalIssue(local) && outbox.resolve(ISSUE_IDS, local) === issue) {
            return { lane: write.lane, dependsOn: null };
        }
    }
    return { lane: lane(issue), dependsOn: null };
}

function parse<P>(text: string): P | null {
    try {
        return JSON.parse(text) as P;
    } catch {
        return null;
    }
}

type EditOutbox = Pick<Outbox, 'rows' | 'unsent' | 'resolve' | 'enqueue' | 'update' | 'remove' | 'revisionOf'>;

/** What an edit did: a new row, folded into the queued one, or nothing left to send. */
export type IssueEditResult = 'queued' | 'folded' | 'none';

export interface EditIssueInput {
    /** The issue's key as its screen holds it: a number, or a local key. */
    readonly issue: string;
    /** The fields the person changed, at their new values. */
    readonly changes: IssueEditValues;
    /**
     * The issue as the server last sent it (the held detail's `issue`, or a
     * `CB-?` issue's filing), never the overlay: each new field's base.
     */
    readonly base: IssueEditValues;
    /** A fresh UUID (expo-crypto): a new row's id and key. */
    readonly newId: () => string;
    /**
     * A label turned on or off: applied to the newest labels (the queued
     * row's, else the ones ahead of it, else the base), never to the ones a
     * screen drew, so two quick taps keep both.
     */
    readonly toggleLabel?: IssueLabel;
}

/** Label `label` turned on or off, in the web's order. */
export const toggleLabel = (labels: readonly IssueLabel[], label: IssueLabel): IssueLabel[] =>
    labels.includes(label)
        ? labels.filter((item) => item !== label)
        : ISSUE_LABELS.filter((item) => item === label || labels.includes(item));

/**
 * Edits issue `issue`'s fields: folds into its queued edit, or queues one.
 * Throws IssueEditError for a value the server would refuse, before anything is written.
 */
export async function editIssue(outbox: EditOutbox, input: EditIssueInput): Promise<IssueEditResult> {
    const { issue, changes, base, newId } = input;
    const wanted: Partial<Record<IssueEditField, FieldValue>> = {};
    for (const field of ISSUE_EDIT_FIELDS) {
        if (changes[field] !== undefined) {
            wanted[field] = issueFieldValue(field, changes[field] as never);
        }
    }
    const where = issueRoute(outbox, issue);
    const edits = outbox.rows().filter((row) => row.lane === where.lane && row.kind === ISSUE_UPDATE_KIND);
    const queued = [...edits].reverse().find((row) => row.state === 'queued') ?? null;
    // What the server will have once the rows ahead of a new one have gone.
    const ahead = new Map<IssueEditField, FieldValue>();
    for (const row of edits) {
        if (row === queued) {
            break;
        }
        const fields = parse<IssueUpdatePayload>(row.payload)?.fields ?? {};
        for (const [field, change] of Object.entries(fields) as [IssueEditField, FieldChange][]) {
            ahead.set(field, change.value);
        }
    }
    const held = queued === null ? null : parse<IssueUpdatePayload>(queued.payload);
    const fields: Partial<Record<IssueEditField, FieldChange>> = { ...held?.fields };
    if (input.toggleLabel !== undefined) {
        const newest = (fields.labels?.value ?? ahead.get('labels') ?? base.labels) as
            | readonly IssueLabel[]
            | undefined;
        if (newest === undefined) {
            throw new TypeError('No base value for the issue’s labels.');
        }
        wanted.labels = toggleLabel(newest, input.toggleLabel);
    }
    for (const [field, value] of Object.entries(wanted) as [IssueEditField, FieldValue][]) {
        const first =
            fields[field] !== undefined ? fields[field].base : ahead.has(field) ? ahead.get(field) : base[field];
        if (first === undefined) {
            throw new TypeError(`No base value for the issue's ${field}.`);
        }
        if (sameValue(value, first)) {
            delete fields[field];
        } else {
            fields[field] = { value, base: first };
        }
    }
    const empty = Object.keys(fields).length === 0;
    if (queued !== null && held !== null) {
        if (empty) {
            if ((await outbox.remove(queued.id, outbox.revisionOf(queued.id))) !== null) {
                return 'none';
            }
            // It started going meanwhile: setting the field back goes as a row of its own, behind it.
            return editIssue(outbox, input);
        }
        const payload: IssueUpdatePayload = { ...held, fields };
        if (
            await outbox.update(
                queued.id,
                { payload: JSON.stringify(payload), payloadVersion: versionOf(fields) },
                outbox.revisionOf(queued.id),
            )
        ) {
            return 'folded';
        }
        // It started going meanwhile: the change goes as a row of its own, behind it.
        return editIssue(outbox, input);
    }
    if (empty) {
        return 'none';
    }
    const payload: IssueUpdatePayload = { issue, fields };
    await outbox.enqueue({
        id: newId(),
        lane: where.lane,
        kind: ISSUE_UPDATE_KIND,
        payload: JSON.stringify(payload),
        payloadVersion: versionOf(fields),
        idempotencyKey: newId(),
        ...(where.dependsOn === null ? {} : { dependsOn: where.dependsOn }),
    });
    return 'queued';
}

type UnsentOutbox = Pick<Outbox, 'unsent' | 'editUnsent' | 'retryUnsent' | 'discardUnsent'>;

/** A refused edit that conflicted: what Keep mine and Keep theirs act on. */
export const isIssueConflict = (write: { readonly kind: string; readonly reason: string }) =>
    write.kind === ISSUE_UPDATE_KIND && write.reason === ISSUE_EDIT_REFUSALS.conflict;

/**
 * Keep mine: refused edit `id` re-based on `current` (the issue the screen
 * shows, the server's newest) and sent again in its place, under a fresh key.
 * False when it is gone or a row with its id is queued.
 */
export async function keepMine(
    outbox: UnsentOutbox,
    input: { readonly id: string; readonly current: IssueEditValues; readonly idempotencyKey: string },
): Promise<boolean> {
    const write = outbox.unsent().find((item) => item.id === input.id && item.kind === ISSUE_UPDATE_KIND);
    const payload = write === undefined ? null : parse<IssueUpdatePayload>(write.payload);
    if (payload === null) {
        return false;
    }
    const fields: Partial<Record<IssueEditField, FieldChange>> = {};
    for (const [field, change] of Object.entries(payload.fields) as [IssueEditField, FieldChange][]) {
        const now = input.current[field];
        fields[field] = { value: change.value, base: now === undefined ? change.base : now };
    }
    const edited = await outbox.editUnsent(input.id, {
        payload: JSON.stringify({ ...payload, fields }),
        payloadVersion: versionOf(fields),
    });
    return edited && outbox.retryUnsent(input.id, input.idempotencyKey);
}

/** Keep theirs: refused edit `id` is discarded. False when it is gone. */
export async function keepTheirs(outbox: UnsentOutbox, id: string): Promise<boolean> {
    return (await outbox.discardUnsent(id)) !== null;
}

export interface VoteInput {
    readonly issue: string;
    /** True votes, false withdraws the person's vote. */
    readonly vote: boolean;
    /** The issue as the server last sent it: whether the person had voted, and the count. */
    readonly base: { readonly voted: boolean; readonly votes: number };
    readonly newId: () => string;
}

/** Votes for issue `issue` or withdraws the vote: folds into its queued vote (the newest intent), or queues one. */
export async function voteOnIssue(outbox: EditOutbox, input: VoteInput): Promise<IssueEditResult> {
    const { issue, vote, newId } = input;
    const where = issueRoute(outbox, issue, voteLane);
    const votes = outbox.rows().filter((row) => row.lane === where.lane && row.kind === ISSUE_VOTE_KIND);
    const queued = [...votes].reverse().find((row) => row.state === 'queued') ?? null;
    const held = queued === null ? null : parse<IssueVotePayload>(queued.payload);
    if (queued !== null && held !== null) {
        if (
            await outbox.update(
                queued.id,
                { payload: JSON.stringify({ ...held, vote }), payloadVersion: VERSION },
                outbox.revisionOf(queued.id),
            )
        ) {
            return 'folded';
        }
        return voteOnIssue(outbox, input);
    }
    // Behind a vote already going, the server will have that vote's outcome.
    const last = votes.length === 0 ? null : parse<IssueVotePayload>(votes[votes.length - 1]!.payload);
    const base = last === null ? input.base : { voted: last.vote, votes: votedCount(last) };
    const payload: IssueVotePayload = { issue, vote, baseVoted: base.voted, baseVotes: base.votes };
    await outbox.enqueue({
        id: newId(),
        lane: where.lane,
        kind: ISSUE_VOTE_KIND,
        payload: JSON.stringify(payload),
        payloadVersion: VERSION,
        idempotencyKey: newId(),
        ...(where.dependsOn === null ? {} : { dependsOn: where.dependsOn }),
    });
    return 'queued';
}

/** The count a vote's overlay shows. */
const votedCount = (payload: IssueVotePayload) =>
    Math.max(0, payload.baseVotes + (payload.vote ? 1 : 0) - (payload.baseVoted ? 1 : 0));

// ---- The kinds -----------------------------------------------------------------

export interface IssueEditOptions {
    /** The scope's issue details: each answer's detail is handed off there. */
    readonly issueDetails?: Pick<IssueDetails, 'put'>;
    /** After a write the server took: the issue is read again (`notesForWrite`). */
    readonly afterWrite?: (path: string) => void;
}

const detailPath = (number: string) => `/api/issues/${encodeURIComponent(number)}`;
const gone = (status: number) => status === 404 || status === 410;

/** The detail an answer carries, or null for a body that isn't one. */
function detailOf(body: unknown): IssueDetail | null {
    const detail = body as Partial<IssueDetail> | null;
    const issue = detail?.issue as Partial<Issue> | undefined;
    return detail &&
        issue &&
        typeof issue.number === 'number' &&
        typeof issue.updatedAt === 'number' &&
        Array.isArray(detail.comments) &&
        Array.isArray(detail.attachments) &&
        Array.isArray(detail.events) &&
        typeof detail.users === 'object' &&
        detail.users !== null
        ? (detail as IssueDetail)
        : null;
}

/** A classifier action as a send's outcome. */
function outcome(action: Exclude<ClassifierAction, { action: 'delivered' }>, answer: Answer): SendOutcome {
    switch (action.action) {
        case 'retry':
        case 'unknown':
        case 'unsent':
            return action;
        case 'back-off':
            return action.delayMs === null
                ? { action: 'retry', reason: action.reason }
                : { action: 'retry', delayMs: action.delayMs, reason: action.reason };
        default:
            return { action: 'unsent', reason: `http-${answer.status}` };
    }
}

/** Answers both kinds read the same way, before the outbox's defaults. */
function editAnswer(answer: Answer): ClassifierAction | undefined {
    if (gone(answer.status)) {
        return { action: 'unsent', reason: UNSENT_GONE };
    }
    if (answer.status === 400) {
        return { action: 'unsent', reason: ISSUE_EDIT_REFUSALS.invalid };
    }
    if (answer.status === 403) {
        return { action: 'unsent', reason: ISSUE_EDIT_REFUSALS.forbidden };
    }
    if (answer.status === 413) {
        return { action: 'unsent', reason: 'too-large' };
    }
    return undefined;
}

const decodeChange = (value: unknown): value is FieldChange =>
    typeof value === 'object' && value !== null && 'value' in value && 'base' in value;

function decodeUpdate(text: string): IssueUpdatePayload {
    const value = JSON.parse(text) as Partial<IssueUpdatePayload> | null;
    const fields = value?.fields as Record<string, unknown> | undefined;
    if (
        !value ||
        typeof value.issue !== 'string' ||
        !fields ||
        typeof fields !== 'object' ||
        !Object.entries(fields).every(
            ([field, change]) => (ISSUE_EDIT_FIELDS as readonly string[]).includes(field) && decodeChange(change),
        )
    ) {
        throw new TypeError('Not an issue edit.');
    }
    return value as IssueUpdatePayload;
}

function decodeVote(text: string): IssueVotePayload {
    const value = JSON.parse(text) as Partial<IssueVotePayload> | null;
    if (
        !value ||
        typeof value.issue !== 'string' ||
        typeof value.vote !== 'boolean' ||
        typeof value.baseVoted !== 'boolean' ||
        typeof value.baseVotes !== 'number'
    ) {
        throw new TypeError('Not a vote.');
    }
    return value as IssueVotePayload;
}

/** The pending fields' values, as an overlay patches a row with them. */
export function pendingFields(payload: IssueUpdatePayload): IssueEditValues {
    const values: Record<string, unknown> = {};
    for (const [field, change] of Object.entries(payload.fields)) {
        values[field] = change.value;
    }
    return values as IssueEditValues;
}

/** The field edit and vote kinds, over the scope's issue details. */
export function issueEditKinds(options: IssueEditOptions = {}): OutboxKind<unknown>[] {
    const { issueDetails, afterWrite } = options;

    const numberOf = (context: Pick<OutboxContext, 'resolve'>, issue: string) => serverIssueKey(context.resolve, issue);

    /** Hands an answer's detail to the held one, then reads it again. */
    const handOff = (number: string, detail: IssueDetail | null) => async () => {
        if (issueDetails && detail !== null) {
            await issueDetails.put(number, detail);
        }
        afterWrite?.(detailPath(number));
    };

    async function request(
        context: OutboxContext,
        write: OutboxWrite<unknown>,
        number: string,
        path: string,
        method: WriteMethod,
        json?: unknown,
    ): Promise<SendOutcome> {
        const response = await context.fetch(path, { method, ...(json === undefined ? {} : { json }) });
        const answer = await readAnswer(response, context.signal);
        const action = classify(answer, { method, ambiguous: write.ambiguous === true, special: editAnswer });
        if (action.action !== 'delivered') {
            return outcome(action, answer);
        }
        return { action: 'done', handOff: handOff(number, detailOf(answer.body)) };
    }

    const update: OutboxKind<IssueUpdatePayload> = {
        kind: ISSUE_UPDATE_KIND,
        payloadVersion: COMPONENTS_VERSION,
        repeatable: true,
        decode: decodeUpdate,
        async send(write, context) {
            const number = numberOf(context, write.payload.issue);
            if (number === null) {
                return { action: 'unsent', reason: ISSUE_EDIT_REFUSALS.noIssue };
            }
            // The version check: what the server has now, against each field's base.
            const read = await readAnswer(await context.fetch(detailPath(number)), context.signal);
            if (gone(read.status)) {
                return { action: 'unsent', reason: UNSENT_GONE };
            }
            const fresh = detailOf(read.body);
            if (read.status < 200 || read.status >= 300 || fresh === null) {
                // Can't compare now: the outbox tries again after the back-off.
                throw new NetworkError(detailPath(number));
            }
            const patch: Record<string, unknown> = {};
            let conflict = false;
            for (const [field, change] of Object.entries(write.payload.fields) as [IssueEditField, FieldChange][]) {
                // Components: the refs this admin sees, none from a server that sent none.
                const now = field === 'components' ? componentsOf(fresh.issue) : fresh.issue[field];
                if (sameValue(now, change.value)) {
                    // Already there: an earlier attempt landed, or someone made the same change.
                } else if (sameValue(now, change.base)) {
                    patch[field] = change.value;
                } else {
                    conflict = true;
                }
            }
            if (conflict) {
                // The screen shows theirs, beside Keep mine and Keep theirs.
                await handOff(number, fresh)();
                return { action: 'unsent', reason: ISSUE_EDIT_REFUSALS.conflict };
            }
            if (Object.keys(patch).length === 0) {
                return { action: 'done', handOff: handOff(number, fresh) };
            }
            return request(context, write, number, detailPath(number), 'PATCH', patch);
        },
        overlay({ payload }, scope): Overlay {
            return {
                collection: ISSUES,
                key: shownIssueKey(scope.resolve, payload.issue),
                mode: 'patch',
                value: pendingFields(payload),
            };
        },
    };

    const vote: OutboxKind<IssueVotePayload> = {
        kind: ISSUE_VOTE_KIND,
        payloadVersion: VERSION,
        repeatable: true,
        decode: decodeVote,
        async send(write, context) {
            const number = numberOf(context, write.payload.issue);
            if (number === null) {
                return { action: 'unsent', reason: ISSUE_EDIT_REFUSALS.noIssue };
            }
            return request(
                context,
                write,
                number,
                `${detailPath(number)}/vote`,
                write.payload.vote ? 'POST' : 'DELETE',
            );
        },
        overlay({ payload }, scope): Overlay {
            return {
                collection: ISSUES,
                key: shownIssueKey(scope.resolve, payload.issue),
                mode: 'patch',
                value: { voted: payload.vote, votes: votedCount(payload) },
            };
        },
    };

    return [update, vote] as OutboxKind<unknown>[];
}

/** How the edit and vote kinds' rows look on screen (`overlaysOf`), without anything that sends. */
export const ISSUE_EDIT_VIEWS: readonly OverlayKind<unknown>[] = issueEditKinds();

/** The edit rows of issue `issue`'s lane, for a screen's "Waiting to send" (oldest first). */
export const pendingEdits = (outbox: Pick<Outbox, 'rows' | 'unsent' | 'resolve'>, issue: string): OutboxRow[] =>
    outbox.rows().filter((row) => row.lane === issueRoute(outbox, issue).lane && row.kind === ISSUE_UPDATE_KIND);
