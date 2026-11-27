import type { MessageReactions, ReactionKind, ReactionsView } from '@socio/shared/chat/reactions';
import {
    REPORT_CONFIRMATION,
    REPORT_NOTE_MAX,
    REPORT_REASONS,
    fillReportText,
    isReportReason,
    reportNoteLength,
    type ReplyReportsState,
    type ReportOutcome,
    type ReportPreview,
    type ReportReason,
} from '@socio/shared/chat/reply-reports';

import type { AuthedFetch } from '../net/authed-fetch';
import { NetworkError } from '../net/errors';
import { readJson } from '../net/read-body';

// AI reply reports (CB-382, docs/specs/REPLY-REPORTS.md; the web's
// ReportDialog, MessageReactions and use-reactions): a thumbs-down on a
// socio's reply that the person confirms goes, while an admin shares
// reports, to Ingenio. The confirmation's text, the reasons and the note's
// limit are `@socio/shared/chat/reply-reports`'s, so web and app say the same
// thing; the words below are the web's own (packages/i18n's chat.report and
// chat's reactions), worded by code, never the server's text. No React
// Native here: tests/chat runs it under Node.

/** The web's chat.report and chat.reactions words the app shows around a report. */
export const REPORT_WORDS = {
    reason: 'Reason',
    noteLabel: 'Note (optional)',
    /** `{socio}` when the reply's socio can't be named here (chat:reactions.generic-socio). */
    genericSocio: 'The socio',
    /** `{author}` when the server's answer names nobody (chat:reactions.other-author). */
    otherAuthor: 'Another person',
    previewFailed: 'Couldn’t check what this report would include. Try again.',
    removeTitle: 'Remove your thumbs-down?',
    removeWent: 'Your report on this reply went to Ingenio.',
    removeCancel: 'Cancel',
    removeConfirm: 'Remove thumbs-down',
    removeSwitchUp: 'Switch to thumbs-up',
    /** The offer after a thumbs-down given offline, once the app is online again. */
    offer: 'Report it now?',
    offerReport: 'Report',
    offerDismiss: 'Not now',
} as const;

/** What a report's outcome says under its reply (the web's chat.report notices); none for the rest. */
export const REPORT_NOTICES: Partial<Record<ReportOutcome, string>> = {
    'not-sharing': 'Reports aren’t shared with Ingenio any more, so this is a plain thumbs-down.',
    'consent-changed': 'Reporting changed since you confirmed, so nothing was reported. It’s a plain thumbs-down.',
    unavailable: 'The report couldn’t be made this time, so this is a plain thumbs-down.',
};

/** How long a report's notice stays under its reply (the web's NOTICE_MS). */
export const REPORT_NOTICE_MS = 8000;

const REPORT_OUTCOMES: readonly string[] = ['queued', 'already', 'not-sharing', 'consent-changed', 'unavailable'];

export const isReportOutcome = (value: unknown): value is ReportOutcome =>
    typeof value === 'string' && REPORT_OUTCOMES.includes(value);

/** The quiet line a report's outcome gets, or null (queued and already say nothing). */
export const reportNotice = (outcome: ReportOutcome): string | null => REPORT_NOTICES[outcome] ?? null;

/**
 * Whether a thumbs-down may carry a report: `GET /api/workspace`'s
 * `replyReports` as the shell's workspace row holds it. Missing (an older
 * server) or anything else is null: a plain thumbs-down, no report UI.
 */
export function replyReportsOf(workspace: unknown): ReplyReportsState {
    const state = (workspace as { replyReports?: unknown } | null)?.replyReports as
        | { sharing?: unknown; consent?: unknown }
        | null
        | undefined;
    return state !== null &&
        typeof state === 'object' &&
        state.sharing === true &&
        typeof state.consent === 'string' &&
        state.consent !== ''
        ? { sharing: true, consent: state.consent }
        : null;
}

/** What a confirmed thumbs-down carries (§3): `shownByOther` is whether the sheet said another person's message goes. */
export interface ReportRequest {
    readonly reason: ReportReason;
    readonly note?: string;
    readonly consent: string;
    readonly shownByOther: boolean;
}

/** A report as the outbox keeps and sends it, checked whole; null when it isn't one. */
export function checkReportRequest(value: unknown): ReportRequest | null {
    const report = value as Record<string, unknown> | null;
    if (
        !report ||
        typeof report !== 'object' ||
        !isReportReason(report.reason) ||
        typeof report.consent !== 'string' ||
        report.consent === '' ||
        typeof report.shownByOther !== 'boolean' ||
        (report.note !== undefined &&
            (typeof report.note !== 'string' || reportNoteLength(report.note) > REPORT_NOTE_MAX))
    ) {
        return null;
    }
    return {
        reason: report.reason,
        ...(typeof report.note === 'string' && report.note.trim() !== '' ? { note: report.note.trim() } : {}),
        consent: report.consent,
        shownByOther: report.shownByOther,
    };
}

/**
 * The report the sheet's Report sends: the reason, the note trimmed (left
 * out when empty), the consent it was shown for, and whether it said
 * another person's message goes too. Null while no reason is picked or the
 * note is over `REPORT_NOTE_MAX` code points.
 */
export function reportRequest(input: {
    readonly reason: ReportReason | null;
    readonly note: string;
    readonly consent: string;
    readonly shownByOther: boolean;
}): ReportRequest | null {
    if (input.reason === null || reportNoteLength(input.note) > REPORT_NOTE_MAX) {
        return null;
    }
    const note = input.note.trim();
    return {
        reason: input.reason,
        ...(note === '' ? {} : { note }),
        consent: input.consent,
        shownByOther: input.shownByOther,
    };
}

/** The note's counter and its warning, as the web's: code points after trimming. */
export interface NoteCount {
    readonly length: number;
    readonly over: boolean;
    /** "12 / 1,000". */
    readonly count: string;
    /** "The note is 3 characters too long.", or null within the limit. */
    readonly warning: string | null;
}

const number = (value: number) => value.toLocaleString('en-US');

export function noteCount(note: string): NoteCount {
    const length = reportNoteLength(note);
    const extra = length - REPORT_NOTE_MAX;
    return {
        length,
        over: extra > 0,
        count: `${number(length)} / ${number(REPORT_NOTE_MAX)}`,
        warning:
            extra > 0 ? `The note is ${number(extra)} ${extra === 1 ? 'character' : 'characters'} too long.` : null,
    };
}

/** `GET …/messages/:messageId/report`, checked; throws TypeError when it isn't one. */
export function checkReportPreview(body: unknown): ReportPreview {
    const preview = body as Partial<ReportPreview> | null;
    if (!preview || typeof preview !== 'object' || typeof preview.sharing !== 'boolean') {
        throw new TypeError('Not a report preview.');
    }
    return {
        sharing: preview.sharing,
        ...(typeof preview.consent === 'string' && preview.consent !== '' ? { consent: preview.consent } : {}),
        promptByOther: preview.promptByOther === true,
        ...(typeof preview.author === 'string' && preview.author !== '' ? { author: preview.author } : {}),
    };
}

export const reportPreviewPath = (threadId: string, messageId: string) =>
    `/api/conversations/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/report`;

/** What asking the server for a report's preview gave: the preview, no answer (offline), or another failure. */
export type PreviewRead =
    | { readonly kind: 'preview'; readonly preview: ReportPreview }
    | { readonly kind: 'offline' }
    | { readonly kind: 'failed' };

/**
 * `GET …/report` (§2), online only, never queued: no answer at all is
 * `offline` (the thumbs-down then goes plain, with "Report it now?" later);
 * any refusal or a body that isn't a preview is `failed` (nothing goes).
 */
export async function readReportPreview(
    fetch: AuthedFetch,
    threadId: string,
    messageId: string,
    signal?: AbortSignal,
): Promise<PreviewRead> {
    let response: Response;
    try {
        response = await fetch(reportPreviewPath(threadId, messageId), { signal });
    } catch (error) {
        return error instanceof NetworkError ? { kind: 'offline' } : { kind: 'failed' };
    }
    if (!response.ok) {
        return { kind: 'failed' };
    }
    try {
        return { kind: 'preview', preview: checkReportPreview(await readJson(response, signal)) };
    } catch (error) {
        return error instanceof NetworkError ? { kind: 'offline' } : { kind: 'failed' };
    }
}

/** What the sheet shows for one reply, from the server's preview: null when sharing went off (a plain thumbs-down). */
export interface ReportSheet {
    readonly messageId: string;
    readonly consent: string;
    /** `{socio}`: the reply's own socio. */
    readonly socio: string;
    /** `{author}` when the server said another person's message goes too (`promptByOther`). */
    readonly byOther?: string;
}

/**
 * The sheet for `messageId` from the server's answer (§2): its consent when
 * it gives one (a newer one than the workspace's), else the workspace's;
 * `byOther` exactly when `promptByOther`, named by the server's `author`,
 * else "Another person" (an older server). Null when the server says
 * sharing is off now.
 */
export function reportSheetOf(
    preview: ReportPreview,
    input: { readonly messageId: string; readonly consent: string; readonly socio: string },
): ReportSheet | null {
    if (!preview.sharing) {
        return null;
    }
    return {
        messageId: input.messageId,
        consent: preview.consent ?? input.consent,
        socio: input.socio,
        ...(preview.promptByOther ? { byOther: preview.author ?? REPORT_WORDS.otherAuthor } : {}),
    };
}

/** The confirmation's words for a sheet: the shared texts filled in. */
export function reportSheetText(sheet: Pick<ReportSheet, 'socio' | 'byOther'>) {
    return {
        title: REPORT_CONFIRMATION.title,
        body: fillReportText(REPORT_CONFIRMATION.body, { socio: sheet.socio }),
        byOther:
            sheet.byOther === undefined ? null : fillReportText(REPORT_CONFIRMATION.byOther, { author: sheet.byOther }),
        confirm: REPORT_CONFIRMATION.confirm,
        cancel: REPORT_CONFIRMATION.cancel,
        reasons: REPORT_REASONS,
    };
}

/**
 * The socio that wrote the reply, for `{socio}`: the id the reply carries
 * (`ReplyRow.socioId`: the runner's `SOCIO_METADATA` stamp, a room's live
 * `socioId`), named by the workspace's socios. One missing or this reader
 * can't name is "The socio", never the socio the chat has selected now
 * (the web's rule).
 */
export function replySocioName(
    socioId: string | undefined,
    dots: readonly { readonly id: string; readonly name?: unknown }[],
): string {
    const name = socioId === undefined || socioId === '' ? undefined : dots.find((dot) => dot.id === socioId)?.name;
    return typeof name === 'string' && name !== '' ? name : REPORT_WORDS.genericSocio;
}

const NONE: MessageReactions = { counts: {}, mine: [] };

/** What a press of `kind` on a reply does, before anything is sent (the web's `press`). */
export type ReactionPress =
    /** Its thumbs-down's report went: warn first that removing it doesn't recall it (§5). */
    | { readonly kind: 'warn'; readonly reaction: ReactionKind }
    /** A thumbs-down while sharing is on: ask the server what would go, then confirm. */
    | { readonly kind: 'report'; readonly consent: string }
    /** A plain toggle. */
    | { readonly kind: 'toggle' };

export function reactionPress(
    view: ReactionsView,
    messageId: string,
    kind: ReactionKind,
    reports: ReplyReportsState,
): ReactionPress {
    const current = view.messages[messageId] ?? NONE;
    const on = current.mine.includes(kind);
    const removesDown = current.mine.includes('down') && (kind === 'down' ? on : kind === 'up' && !on);
    if (removesDown && current.report === 'shared') {
        return { kind: 'warn', reaction: kind };
    }
    if (kind === 'down' && !on && reports !== null) {
        return { kind: 'report', consent: reports.consent };
    }
    return { kind: 'toggle' };
}

/** The warning before removing a thumbs-down whose report went (§5): its title, words and buttons. */
export function removeSharedAsk(reaction: ReactionKind) {
    return {
        title: REPORT_WORDS.removeTitle,
        message: `${REPORT_WORDS.removeWent} ${REPORT_CONFIRMATION.removeShared}`,
        cancel: REPORT_WORDS.removeCancel,
        confirm: reaction === 'up' ? REPORT_WORDS.removeSwitchUp : REPORT_WORDS.removeConfirm,
    };
}

/**
 * The line under a reply about its report: "Shared with Ingenio" while the
 * reader's thumbs-down is there and its report went; nothing for queued, and
 * nothing for failed, which is final (§4).
 */
export const reportMark = (view: ReactionsView, messageId: string): string | null => {
    const current = view.messages[messageId];
    return current?.mine.includes('down') === true && current.report === 'shared' ? REPORT_CONFIRMATION.shared : null;
};

/**
 * Whether to offer "Report it now?" under a reply whose thumbs-down went
 * plain while the app was offline: sharing is on, the app is online, the
 * reader's thumbs-down is there (as shown, the outbox laid over) and has no
 * report yet, and no reaction of the reply still waits in the outbox.
 */
export function offersReport(input: {
    readonly offered: boolean;
    readonly reports: ReplyReportsState;
    readonly online: boolean;
    readonly view: ReactionsView;
    readonly messageId: string;
    readonly waiting: boolean;
}): boolean {
    const current = input.view.messages[input.messageId];
    return (
        input.offered &&
        input.reports !== null &&
        input.online &&
        !input.waiting &&
        current?.mine.includes('down') === true &&
        current.report === undefined
    );
}
