import type { Message, ToolCall } from '@ag-ui/core';

import { type ApprovalStatus, approvalCardId, isApprovalNote, pendingApproval } from '@socio/shared/approvals';
import { CODING_CARD_TOOLS, CODING_END_WORDS, CODING_PRIVATE_LINE } from '@socio/shared/coding/coding-sessions';
import { pageReviewTool } from '@socio/shared/pages/page-review';
import { toolImageOf } from '@socio/shared/tool-images';
import type { CallReceipt } from '@socio/shared/types';
import { voiceReceiptMessagePrefix } from '@socio/shared/voice/voice-receipt';

// The cards of a chat's transcript: what the web's renderers show for a
// socio's tool calls, matched the same way.
// - **Approvals**: the tool result names the request. A result that asked
//   the person stays `pending_approval` after they decide, so until the
//   screen has read the request (`approvals.watch`) the card says
//   "Approval requested" with the summary; then the actionable card
//   (approval-card.ts) takes its place. One an auto review decided says so
//   with its outcome. Each also opens its request on the web (`/approvals/<id>`).
// - **Coding sessions** (the web's CodingSessionRenderer): the `coding_*`
//   tools whose results name a session, with its repository, branch, state
//   and pull request; a refusal in the server's words; a result withheld
//   from everyone but its person, the neutral line.
// - **The computer's last screenshot** (`computer_screenshot`, CB-157; only
//   the chat's last one, `lastScreenshotCall`): the page it showed, and the
//   picture its result names (through the image cache, opening the
//   viewer); without one, where it shows (the web).
// - **Page reviews**: the one card with buttons, its words and its
//   sheet in page-review.ts.
// - **Voice receipts** (the web's Receipt): a call's line, after the message
//   it is anchored to, else before the transcript.
// The web pages open through `useOpenLink`, with its sign-in line.
// The server's prompts for the socio (voice receipts, the note a turn after
// an approval starts with) are never the person's bubbles (`isInternalNote`).
// No React Native here: tests/chat runs it under Node.

/** A request whose current status isn't known yet (offline, or not read yet): true whatever came of it. */
export const APPROVAL_REQUESTED = 'Approval requested';
/** Under a request's card before the phone has read it: its page in the app says where it stands. */
export const SEE_IN_APPROVALS = 'Open it in Approvals to see where it stands.';
export const APPROVED_AUTOMATICALLY = 'Approved automatically';
export const DENIED_AUTOMATICALLY = 'Denied automatically';
export const CODING_TITLE = 'Coding session';
export const CODING_WORKING = 'Working on the coding session…';
export const SCREENSHOT_ON_WEB = 'The screenshot shows in your browser.';

/** The computer tool whose result names a stored screenshot. */
export const SCREENSHOT_TOOL = 'computer_screenshot';

export type Card =
    | {
          readonly kind: 'approval';
          /** The request's id. */
          readonly id: string;
          /** `requested`: it asked the person, and where it stands now isn't known. */
          readonly state: 'requested' | ApprovalStatus;
          readonly title: string;
          /** The request's summary, or what the decided action came to. */
          readonly summary: string;
          /** The muted line under it, or null. */
          readonly note: string | null;
          /** The request's page on the web: a workspace path. */
          readonly href: string;
      }
    | {
          readonly kind: 'coding';
          readonly title: string;
          /** `owner/name · branch`, when the result names its session. */
          readonly repository: string | null;
          /** Its state in words ("Ready", "Reached its time limit"), or the refusal, or the private line. */
          readonly status: string;
          /** The session's pull request on GitHub: its number and address. */
          readonly pullRequest: { readonly label: string; readonly url: string } | null;
          /** Whether the web has more to show (not for the private line). */
          readonly web: boolean;
      }
    | {
          readonly kind: 'screenshot';
          readonly title: string;
          /** The page it showed, as text (never a link: the computer's page is anyone's). */
          readonly page: string | null;
          /** Why there is no picture, in the server's words, or where it shows. */
          readonly note: string;
          /** The picture the result names, or null. */
          readonly image: { readonly id: string; readonly name: string } | null;
      }
    | {
          readonly kind: 'page-review';
          /** The review's tool call. */
          readonly toolCallId: string;
          /** The call's arguments, parsed: the draft as the socio sent it. */
          readonly args: unknown;
          /** Its tool result as stored: saved (the page it saved), skipped, or none yet. */
          readonly result: {
              readonly approved: boolean;
              /** The page it saved, when the result names it. */
              readonly page: { readonly spaceId: string; readonly pageId: string } | null;
          } | null;
      }
    | {
          readonly kind: 'receipt';
          /** "12s · Call ended", "Call in progress", "Call failed". */
          readonly label: string;
          readonly error: string | null;
      };

export interface CardRow {
    readonly kind: 'card';
    /** `card:<tool call id>`, or `call:<receipt id>`. */
    readonly id: string;
    readonly card: Card;
}

/** A tool result as an object: parsed when it is JSON text. */
function objectOf(result: unknown): Record<string, unknown> | null {
    let value = result;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch {
            return null;
        }
    }
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A call shown as a card, never as a step of its turn's trace: approvals, page reviews, coding sessions. */
export function cardCalls(messages: readonly Message[]): (call: ToolCall) => boolean {
    const approvals = new Set(
        messages.flatMap((message) =>
            message.role === 'tool' && approvalCardId(message.content) ? [message.toolCallId] : [],
        ),
    );
    return (call) =>
        call.function.name === pageReviewTool.name ||
        CODING_CARD_TOOLS.includes(call.function.name) ||
        approvals.has(call.id);
}

/** An approval's card from its tool result, or null when the result isn't one. */
export function approvalCard(result: unknown): Card | null {
    const id = approvalCardId(result);
    if (id === undefined || !SAFE_ID.test(id)) {
        return null;
    }
    const href = `/approvals/${id}`;
    const pending = pendingApproval(result);
    if (pending !== undefined) {
        return {
            kind: 'approval',
            id,
            state: 'requested',
            title: APPROVAL_REQUESTED,
            summary: text(pending.approval.summary) ?? '',
            note: SEE_IN_APPROVALS,
            href,
        };
    }
    // approvalCardId's other case: decided by an auto review, possibly under `outcome`.
    const top = objectOf(result);
    const inner = top !== null && typeof top.status !== 'string' ? objectOf(top.outcome) : null;
    const decided = inner ?? top ?? {};
    const approved = decided.status === 'approved';
    return {
        kind: 'approval',
        id,
        state: approved ? 'approved' : 'denied',
        title: approved ? APPROVED_AUTOMATICALLY : DENIED_AUTOMATICALLY,
        summary: text(decided.outcome) ?? text(decided.reason) ?? '',
        note: null,
        href,
    };
}

/** The ids of the approval requests among `rows`' cards, in order: the requests the chat reads and decides. */
export const approvalCardIds = (rows: readonly { readonly kind: string; readonly card?: Card }[]): string[] =>
    rows.flatMap((row) => (row.kind === 'card' && row.card?.kind === 'approval' ? [row.card.id] : []));

const STATE_WORDS: Record<string, string> = {
    starting: 'Starting',
    ready: 'Ready',
    working: 'Working',
    running: 'Working',
    done: 'Done',
    opened: 'Pull request opened',
    failed: 'Failed',
    lost: 'Lost',
    stopped: 'Stopped',
    ended: 'Ended',
};

/** A coding tool's card: `result` is undefined while the call runs. */
export function codingCard(result: unknown): Card {
    const card = (status: string, extra: Partial<Extract<Card, { kind: 'coding' }>> = {}): Card => ({
        kind: 'coding',
        title: CODING_TITLE,
        repository: null,
        pullRequest: null,
        web: true,
        ...extra,
        status,
    });
    if (result === undefined) {
        return card(CODING_WORKING);
    }
    const value = objectOf(result);
    if (value === null) {
        return card(STATE_WORDS.ended!);
    }
    if (value.withheld === true) {
        return card(CODING_PRIVATE_LINE, { web: false });
    }
    if (value.status === 'refused') {
        return card(text(value.error) ?? 'Refused');
    }
    // A long result comes as a preview (the history's `lightToolResult`): its short fields only.
    const session = objectOf(value.session);
    const repository = text(session?.repository);
    const branch = text(session?.branch);
    const state = text(session?.state) ?? text(value.status);
    const endReason = text(session?.endReason);
    const status =
        state === 'ended' && endReason !== null
            ? (CODING_END_WORDS[endReason] ?? STATE_WORDS.ended!)
            : (STATE_WORDS[state ?? ''] ?? STATE_WORDS.ended!);
    const pull = objectOf(value.pullRequest);
    const pullUrl = text(pull?.url) ?? text(session?.pullRequest);
    const number = typeof pull?.number === 'number' ? pull.number : Number(/\/pull\/(\d+)/.exec(pullUrl ?? '')?.[1]);
    return card(status, {
        repository: repository === null ? null : branch === null ? repository : `${repository} · ${branch}`,
        pullRequest:
            pullUrl !== null && /^https:\/\//i.test(pullUrl)
                ? { label: Number.isFinite(number) ? `Pull request #${number}` : 'Pull request', url: pullUrl }
                : null,
    });
}

/** The computer screenshot's card: the page it showed, from its result. */
export function screenshotCard(result: unknown, socio: string | null): Card {
    const value = objectOf(result) ?? {};
    const image = toolImageOf(value);
    return {
        kind: 'screenshot',
        title: `${socio ?? 'Your socio'}’s computer`,
        page: text(value.url),
        note: text(value.error) ?? (image === undefined ? SCREENSHOT_ON_WEB : ''),
        image: image === undefined ? null : { id: image.id, name: 'Screenshot' },
    };
}

/** A page review's card: the draft as sent, and its result once stored. */
export function pageReviewCard(call: ToolCall, result: string | undefined): Card {
    let args: unknown;
    try {
        args = JSON.parse(call.function.arguments);
    } catch {
        args = undefined;
    }
    const value = result === undefined ? null : objectOf(result);
    const approved = value?.approved === true;
    const page =
        approved && typeof value.spaceId === 'string' && typeof value.pageId === 'string'
            ? { spaceId: value.spaceId, pageId: value.pageId }
            : null;
    return {
        kind: 'page-review',
        toolCallId: call.id,
        args,
        result: result === undefined ? null : { approved, page },
    };
}

/** The chat's last finished `computer_screenshot` call, the only one shown as a card. */
export function lastScreenshotCall(messages: readonly Message[], results: ReadonlyMap<string, string>): string | null {
    let last: string | null = null;
    for (const message of messages) {
        if (message.role !== 'assistant') {
            continue;
        }
        for (const call of message.toolCalls ?? []) {
            if (call.function.name === SCREENSHOT_TOOL && results.has(call.id)) {
                last = call.id;
            }
        }
    }
    return last;
}

/**
 * The cards an assistant message's calls show, in order: `results` by call id (absent while a call runs).
 * Only `screenshot`'s call (the chat's last, `lastScreenshotCall`) shows its card; without it, every one.
 */
export function cardsOf(
    message: Message,
    results: ReadonlyMap<string, string>,
    socio: string | null,
    screenshot?: string | null,
): CardRow[] {
    if (message.role !== 'assistant') {
        return [];
    }
    const rows: CardRow[] = [];
    for (const call of message.toolCalls ?? []) {
        const result = results.get(call.id);
        if (call.function.name === pageReviewTool.name) {
            rows.push({ kind: 'card', id: `card:${call.id}`, card: pageReviewCard(call, result) });
            continue;
        }
        const card =
            (result === undefined ? null : approvalCard(result)) ??
            (CODING_CARD_TOOLS.includes(call.function.name)
                ? codingCard(result)
                : call.function.name === SCREENSHOT_TOOL &&
                    result !== undefined &&
                    (screenshot === undefined || screenshot === call.id)
                  ? screenshotCard(result, socio)
                  : null);
        if (card !== null) {
            rows.push({ kind: 'card', id: `card:${call.id}`, card });
        }
    }
    return rows;
}

/** A voice call's line, as the web's Receipt says it. */
export function receiptLabel(call: Pick<CallReceipt, 'status' | 'startedAt' | 'endedAt'>): string {
    if (call.status === 'failed') {
        return 'Call failed';
    }
    return call.endedAt !== null && call.endedAt !== undefined
        ? `${Math.round((call.endedAt - call.startedAt) / 1000)}s · Call ended`
        : 'Call in progress';
}

export function receiptRow(call: CallReceipt): CardRow {
    return {
        kind: 'card',
        id: `call:${call.id}`,
        card: { kind: 'receipt', label: receiptLabel(call), error: text(call.error) },
    };
}

/**
 * A prompt the server wrote for the socio, never the person's message: a
 * voice receipt, or the note a turn carrying on after an approval starts
 * with. The markers only decide how it shows.
 */
export function isInternalNote(message: Message): boolean {
    if (message.role !== 'user') {
        return false;
    }
    const metadata = (message as { metadata?: unknown }).metadata;
    const voice =
        message.id.startsWith(voiceReceiptMessagePrefix) ||
        (metadata !== null &&
            typeof metadata === 'object' &&
            (metadata as { socioSource?: unknown }).socioSource === 'voice_receipt');
    return voice || isApprovalNote(message);
}
