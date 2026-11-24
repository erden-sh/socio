import { ATTACHMENT_HINT } from '@socio/shared/issues/issue-attachment-files';
import { areaLabel, KIND_LABEL, PRIORITY_LABEL } from '@socio/shared/issues/issue-board';
import {
    ISSUE_AREAS,
    ISSUE_KINDS,
    ISSUE_PRIORITIES,
    type IssueArea,
    type IssueKind,
    type IssuePriority,
} from '@socio/shared/issues/issue-types';
import type { AgentRunSummary } from '@socio/shared/types';

import type { MenuAction } from '../chat/long-press';
import type { Attachments } from '../sync/attachments';
import { DraftError, type Drafts } from '../sync/chat-drafts';
import {
    ISSUE_DRAFT,
    ISSUE_FIELD_DEFAULTS,
    ISSUE_REFUSALS,
    type IssueFields,
    issueDraftText,
    readIssueDraft,
    unsentIssueFields,
} from '../sync/issue-create';
import { ISSUE_BODY_MAX, ISSUE_TITLE_MAX, ISSUE_TITLE_MIN } from '../sync/issue-edit';
import type { UnsentWrite } from '../sync/outbox';

import type { PendingIssueAction } from './issue-filing';

// Filing an issue: the FileIssue
// modal's view model. The form is the web's ReportForm (ReportIssue.tsx): a
// title, a description, kind (Bug), priority (Medium), area (none) and, once
// the server has them, the plugins and apps it is about (CB-442, the picker in
// issue-components.ts), filed into triage, with the attachment hint. What is typed lives in the
// `issue:new` draft as `issueDraftText`'s JSON, so it survives a kill; the
// tray is the same draft scope's (the issue attachments' processor). A refused filing's
// Edit opens the form on what was written instead (`editIssueFields`; a filing
// refused because its run is gone loses the link), with its tray restored from
// the files' rows (`heldIssueFiles`): Remove discards a row, Add queues one
// behind the filing, and they follow it. No React Native: tests/shell runs it under Node.

export const FILE_ISSUE_TITLE = 'New issue';
export const EDIT_ISSUE_TITLE = 'Edit issue';
/** The web's dialog description, without its paste line (a phone pastes into a field). */
export const FILE_ISSUE_LEAD = 'It goes to the team’s tracker, into triage.';
export const FILE_ISSUE_RUN = 'It will be linked to the failed run.';
/** Edit of a filing refused because its run is gone: it goes again without the link. */
export const FILE_ISSUE_RUN_GONE = 'The failed run is no longer available, so it won’t be linked.';
export const TITLE_PLACEHOLDER = 'What went wrong, or what would help?';
export const BODY_PLACEHOLDER = 'Steps, what you expected, what happened (optional, markdown)';
export const NO_AREA = 'No area';
export const FILE_ISSUE_HINT = ATTACHMENT_HINT;
/** A filing's Edit that found its row gone: sent, discarded or already sent again. */
export const EDIT_GONE = 'This issue was already sent again or discarded.';
export const FILE_FAILED = 'The issue wasn’t saved. Try again.';

export { ISSUE_BODY_MAX, ISSUE_TITLE_MAX };

export interface Choice<T> {
    readonly value: T;
    readonly label: string;
    readonly testID: string;
}

const choices = <T extends string>(field: string, values: readonly T[], label: (value: T) => string): Choice<T>[] =>
    values.map((value) => ({ value, label: label(value), testID: `file-issue-${field}-${value}` }));

/** The web's three choice fields, in its order; Area starts with "No area". */
export const KIND_CHOICES: readonly Choice<IssueKind>[] = choices('kind', ISSUE_KINDS, (kind) => KIND_LABEL[kind]);
export const PRIORITY_CHOICES: readonly Choice<IssuePriority>[] = choices(
    'priority',
    ISSUE_PRIORITIES,
    (priority) => PRIORITY_LABEL[priority],
);
export const AREA_CHOICES: readonly Choice<IssueArea | null>[] = [
    { value: null, label: NO_AREA, testID: 'file-issue-area-none' },
    ...choices('area', ISSUE_AREAS, areaLabel),
];

const EMPTY_FIELDS: IssueFields = { title: '', body: '', ...ISSUE_FIELD_DEFAULTS };

/** The box's fields: what it holds, with the web's defaults for an empty or unreadable box. */
export const issueFormFields = (text: string): IssueFields => readIssueDraft(text) ?? EMPTY_FIELDS;

/**
 * The box with `change` applied, as its text. A box back at the defaults is
 * empty text, which deletes the draft.
 */
export function withIssueField(text: string, change: Partial<IssueFields>): string {
    const next = { ...issueFormFields(text), ...change };
    const { runId, ...rest } = next;
    const blank =
        rest.title === '' &&
        rest.body === '' &&
        rest.kind === ISSUE_FIELD_DEFAULTS.kind &&
        rest.priority === ISSUE_FIELD_DEFAULTS.priority &&
        rest.area === null &&
        !rest.components?.length &&
        !runId;
    return blank ? '' : issueDraftText(runId ? next : rest);
}

/**
 * The fields for a failed run's "File issue": the web's
 * `runIssueDraft` (packages/client's FileIssueFromRun.tsx, which isn't in
 * shared), mirrored: "Run failed: <error>" as the title, a body with where it
 * ran, the run, when it started, its source, the error and its detail, filed
 * as a Medium bug under Runs and linked to the run.
 */
export function runIssueFields(run: AgentRunSummary): IssueFields {
    const what = run.title ?? 'a conversation';
    const started = new Date(run.startedAt).toISOString();
    const lines = [
        `A turn failed in ${run.readable ? `[${what}](/chats/${encodeURIComponent(run.threadId)})` : what}${run.dotName ? ` with ${run.dotName}` : ''}.`,
        '',
        `- Run: \`${run.runId}\``,
        `- Started: ${started}`,
        `- Source: ${run.source}`,
        '',
        ...(run.error ? [`**Error:** ${run.error}`, ''] : []),
        ...(run.errorDetail ? ['```', run.errorDetail, '```', ''] : []),
    ];
    const error = (run.error ?? 'failed').replace(/\s+/g, ' ').trim();
    return {
        title: `Run failed: ${error}`.slice(0, ISSUE_TITLE_MAX),
        body: lines.join('\n').trim().slice(0, ISSUE_BODY_MAX),
        kind: 'bug',
        priority: 'medium',
        area: 'runs',
        runId: run.runId,
    };
}

/**
 * The box as opened for `runId` (a failed run's "File issue", from Runs) or for no
 * run: the run it links to is always the one it was opened for, so a draft
 * left from a run's report never files a plain issue against that run. Given
 * the run (Runs' "File issue"), a box not yet linked to it is filled as the
 * web's `runIssueDraft` fills its form (`runIssueFields`; kind and priority
 * are the form's defaults, Bug and Medium, already), except what the person
 * already typed: a title or description stays, an area chosen stays.
 * A box already linked to the run is theirs, and stays as it is.
 */
export function forRun(text: string, runId: string | null | undefined, run?: AgentRunSummary): string {
    const current = issueFormFields(text).runId ?? null;
    const wanted = runId || null;
    if (current === wanted) {
        return text;
    }
    if (wanted === null || run === undefined || run.runId !== wanted) {
        return withIssueField(text, { runId: wanted });
    }
    const typed = issueFormFields(text);
    const filled = runIssueFields(run);
    return withIssueField(text, {
        runId: wanted,
        ...(typed.title === '' ? { title: filled.title } : {}),
        ...(typed.body === '' ? { body: filled.body } : {}),
        ...(typed.area === null ? { area: filled.area } : {}),
    });
}

/**
 * Opens FileIssue's box (the `issue:new` draft) for `runId` or for no run
 * (`forRun`), filled from `run` when given (Runs' "File issue"). A draft that
 * can't be written (a newer build's, the scope closing) stays as it is kept.
 */
export function openIssueFor(
    drafts: Pick<Drafts, 'read' | 'write'>,
    runId: string | null | undefined,
    run?: AgentRunSummary,
): void {
    const text = drafts.read(ISSUE_DRAFT).text;
    const next = forRun(text, runId, run);
    if (next === text) {
        return;
    }
    try {
        drafts.write(ISSUE_DRAFT, next);
    } catch (error) {
        if (!(error instanceof DraftError)) {
            throw error;
        }
    }
}

// ---- Cancel with a draft ------------------------------------------

/** The question New issue's Cancel asks while the box holds something. */
export const CANCEL_DRAFT_QUESTION = 'Keep this issue as a draft?';
export const KEEP_DRAFT: MenuAction = { name: 'keep-draft', label: 'Keep draft' };
export const DISCARD_DRAFT: MenuAction = { name: 'discard-draft', label: 'Discard', destructive: true };

/**
 * What New issue's Cancel does: close at once with nothing typed in a field
 * and no file in the tray (the chips alone aren't a draft worth asking
 * about), else ask Keep draft or Discard. A refused filing's Edit never asks.
 */
export function cancelIssue(fields: Pick<IssueFields, 'title' | 'body'>, files: number): 'close' | 'ask' {
    return fields.title.trim() === '' && fields.body.trim() === '' && files === 0 ? 'close' : 'ask';
}

/**
 * Discard: the `issue:new` draft goes, and every file in its tray. A draft a
 * newer build locked stays (DraftError); a file that won't go is logged.
 */
export async function discardIssueDraft(
    drafts: Pick<Drafts, 'write'>,
    attachments: Pick<Attachments, 'list' | 'discard'>,
): Promise<void> {
    try {
        drafts.write(ISSUE_DRAFT, '');
    } catch (error) {
        if (!(error instanceof DraftError)) {
            throw error;
        }
    }
    const results = await Promise.allSettled(attachments.list(ISSUE_DRAFT).map((file) => attachments.discard(file.id)));
    for (const result of results) {
        if (result.status === 'rejected') {
            console.warn('[file-issue] a file was not discarded', result.reason);
        }
    }
}

export interface FileIssueInput {
    readonly fields: IssueFields;
    /** Editing a refused filing (Send again), not filing a new one. */
    readonly editing: boolean;
    /** Filing or sending again right now. */
    readonly busy: boolean;
    /** The tray is still taking a pick. */
    readonly picking: boolean;
    /** The draft can change (a newer build's draft is locked, a read-only user.db isn't). */
    readonly editable: boolean;
    /** Edit dropped the filing's run link: the server refused it because the run is gone. */
    readonly runUnlinked?: boolean;
}

export interface FileIssueView {
    readonly heading: string;
    readonly lead: string;
    readonly action: string;
    readonly canFile: boolean;
    /** Under the title: how many more characters it needs, or null. */
    readonly titleHint: string | null;
    readonly editable: boolean;
}

export function fileIssueView(input: FileIssueInput): FileIssueView {
    const { fields, editing, busy } = input;
    const title = fields.title.trim();
    const short = title.length > 0 && title.length < ISSUE_TITLE_MIN;
    const titleOk = title.length >= ISSUE_TITLE_MIN && title.length <= ISSUE_TITLE_MAX;
    return {
        heading: editing ? EDIT_ISSUE_TITLE : FILE_ISSUE_TITLE,
        lead: fields.runId
            ? `${FILE_ISSUE_LEAD} ${FILE_ISSUE_RUN}`
            : input.runUnlinked
              ? `${FILE_ISSUE_LEAD} ${FILE_ISSUE_RUN_GONE}`
              : FILE_ISSUE_LEAD,
        action: editing ? (busy ? 'Sending…' : 'Send again') : busy ? 'Filing…' : 'File issue',
        canFile: titleOk && fields.body.length <= ISSUE_BODY_MAX && !busy && !input.picking && input.editable,
        titleHint: short ? `At least ${ISSUE_TITLE_MIN} characters.` : null,
        editable: input.editable && !busy,
    };
}

export interface EditIssueFields {
    readonly fields: IssueFields;
    /** The run link was dropped (`FILE_ISSUE_RUN_GONE`). */
    readonly runUnlinked: boolean;
}

/**
 * What a refused filing's Edit opens on (`unsentIssueFields`), or null. A
 * filing refused because its run is gone (a 404 with `runId`) loses the link:
 * sent again with it, the server would refuse it again, and Discard would
 * drop the files waiting behind it.
 */
export function editIssueFields(
    write: Pick<UnsentWrite, 'kind' | 'payload' | 'payloadVersion' | 'reason'>,
): EditIssueFields | null {
    const fields = unsentIssueFields(write);
    if (fields === null) {
        return null;
    }
    if (write.reason !== ISSUE_REFUSALS.runGone || !fields.runId) {
        return { fields, runUnlinked: false };
    }
    return { fields: { ...fields, runId: null }, runUnlinked: true };
}

/** The buttons on a `CB-?` row of the Board, by its actions. */
export const PENDING_ACTION_LABELS: Readonly<Record<PendingIssueAction, string>> = {
    view: 'View',
    'send-again': 'Send again',
    edit: 'Edit',
    copy: 'Copy',
    discard: 'Discard',
};
