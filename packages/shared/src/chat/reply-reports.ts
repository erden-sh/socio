/**
 * AI reply reports (CB-382): a thumbs-down on a socio's reply that the
 * person confirms goes, while an admin shares reports, to Ingenio's
 * reports collector. What the server and its clients (web and mobile)
 * share: the state, the confirmation's text, the reasons, and which
 * message a reply answered. docs/specs/REPLY-REPORTS.md is the contract.
 */
import { SENDER_METADATA } from '../types.js';

// ── Is sharing on? (`GET /api/workspace`'s `replyReports`) ──────────────

/**
 * `null`: sharing is off, or this server can't share (no cloud connection,
 * or no `reports:write`). `consent` changes each time an admin turns
 * sharing on; a client sends back the one it showed the confirmation for.
 */
export type ReplyReportsState = { sharing: true; consent: string } | null;

// ── What the person picks ────────────────────────────────────────────────

export const REPORT_REASON_IDS = ['offensive', 'harmful', 'wrong', 'other'] as const;
export type ReportReason = (typeof REPORT_REASON_IDS)[number];

/** The reasons, in the order the picker shows them. */
export const REPORT_REASONS: readonly { id: ReportReason; label: string }[] = [
    { id: 'offensive', label: 'Offensive' },
    { id: 'harmful', label: 'Harmful or unsafe' },
    { id: 'wrong', label: 'Wrong or made up' },
    { id: 'other', label: 'Something else' },
];

export const isReportReason = (value: unknown): value is ReportReason =>
    (REPORT_REASON_IDS as readonly unknown[]).includes(value);

/** The longest note, in Unicode code points, after trimming. */
export const REPORT_NOTE_MAX = 1000;

/** A note's length as the server counts it: code points, after trimming. */
export const reportNoteLength = (note: string) => [...note.trim()].length;

// ── What the confirmation says ───────────────────────────────────────────

/**
 * The version of the texts below and of the admin's setting: the workspace
 * audit records it when an admin turns sharing on. Change it whenever what
 * they say about what leaves changes.
 */
export const REPLY_REPORTS_TEXT_VERSION = '2026-11-26';

/**
 * The confirmation a person sees before a report goes, every time. The
 * strings carry placeholders (`{socio}`, `{author}`) that clients fill in
 * with `fillReportText`, so web and mobile say the same thing.
 */
export const REPORT_CONFIRMATION = {
    title: 'Report this reply to Ingenio?',
    body: "{socio}'s reply, the message it answered, the reason you pick and your note go to Ingenio, who make Socio, to keep it safe. Ingenio keeps the report for a year. Your name, your email and the rest of the conversation stay here.",
    /** The extra line when the answered message is another person's (`promptByOther`). */
    byOther: "{author}'s message goes to Ingenio too.",
    confirm: 'Report',
    cancel: 'Cancel',
    /** Under a reaction whose report went (`report: 'shared'`). */
    shared: 'Shared with Ingenio',
    /** The warning before removing a thumbs-down whose report went. */
    removeShared: "Removing it doesn't recall the report.",
} as const;

/** The admins' setting (Settings → Cloud connection). */
export const REPLY_REPORTS_SETTING = {
    label: 'Share AI reply reports with Ingenio',
    body: "When someone gives a socio's reply a thumbs-down and confirms it, the reply, the message it answered, the reason and their note go to Ingenio, who make Socio, to keep it safe. Ingenio keeps each report for a year. Names, emails, the rest of the conversation and files stay here. Turning it off drops reports not sent yet.",
} as const;

/** The placeholders a text carries, in order: `{name}`. */
export const reportTextPlaceholders = (template: string) =>
    [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!);

/** `template` with each `{name}` replaced by `values[name]`; a value not given is left as it was. */
export const fillReportText = (template: string, values: Readonly<Record<string, string>>) =>
    template.replace(/\{(\w+)\}/g, (placeholder, name: string) => values[name] ?? placeholder);

// ── What the server answers ──────────────────────────────────────────────

/**
 * `PUT …/reactions/down` with a report: none is an error, so an offline
 * outbox sending later never retries or shows a failure. `unavailable`:
 * the server couldn't make the report this time (it couldn't read the
 * conversation), so the thumbs-down is a plain one and nothing is reported.
 */
export type ReportOutcome = 'queued' | 'already' | 'not-sharing' | 'consent-changed' | 'unavailable';

/**
 * A reader's own report on a reply (`GET …/reactions`). `failed` is final:
 * the server never sends it again, and the person can't act on it.
 */
export type ReportMark = 'queued' | 'shared' | 'failed';

/** Removing the thumbs-down (or replacing it with a thumbs-up). */
export type ReportRemoval = 'withdrawn' | 'kept';

/** `GET /api/conversations/:id/messages/:messageId/report`. */
export interface ReportPreview {
    sharing: boolean;
    consent?: string;
    promptByOther: boolean;
}

/** `GET /api/cloud/reply-reports` (admins). */
export interface ReplyReportsAdminView {
    /** The cloud connection is up and the issuer granted `reports:write`. */
    available: boolean;
    sharing: boolean;
    consent?: string;
    /** When sharing was turned on, and by whom (a user id). */
    since?: number;
    by?: string;
    /** Reports waiting to go, and those that never will. */
    queued: number;
    failed: number;
}

// ── Which message a reply answered ───────────────────────────────────────

/** A stored message, as far as this module reads it (AG-UI's `Message`). */
export interface StoredMessageLike {
    id: string;
    role: string;
    content?: unknown;
    metadata?: unknown;
}

/** The sender a stored message carries (CB-228), if any. */
export function messageSender(message: StoredMessageLike): string | undefined {
    const metadata = message.metadata as Record<string, unknown> | undefined;
    const sender = metadata && typeof metadata === 'object' ? metadata[SENDER_METADATA] : undefined;
    return typeof sender === 'string' ? sender : undefined;
}

/**
 * The message the reply `replyId` answered: the nearest `user` message
 * before it in the conversation's stored messages, with its author (its
 * sender, or `fallbackAuthor`, the conversation's owner, for a message
 * stored without one). Undefined when the reply isn't there or nothing
 * comes before it.
 */
export function answeredMessage<M extends StoredMessageLike>(
    messages: readonly M[],
    replyId: string,
    fallbackAuthor?: string,
): { message: M; author?: string } | undefined {
    const at = messages.findIndex((message) => message.id === replyId);
    for (let index = at - 1; index >= 0; index--) {
        const message = messages[index]!;
        if (message.role === 'user') {
            const author = messageSender(message) ?? fallbackAuthor;
            return author ? { message, author } : { message };
        }
    }
    return undefined;
}

/**
 * Whether the answered message is another person's: true exactly when its
 * author is known and isn't `reactorId`.
 */
export const promptByOther = (answered: { author?: string } | undefined, reactorId: string) =>
    !!answered?.author && answered.author !== reactorId;
