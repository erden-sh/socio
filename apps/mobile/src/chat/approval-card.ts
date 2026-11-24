import { APPROVAL_STATUSES, type ApprovalStatus, type ApprovalView, autoReasonLine } from '@socio/shared/approvals';
import { approvalAsk, decidedOnCard, mustOpenFirst } from '@socio/shared/approvals-view';
import type { CodingRuntimeCard, CodingSessionCard } from '@socio/shared/coding/coding-sessions';
import {
    ACCESS_VERB,
    ACTION_PARAMS,
    type AppAccessCard,
    type AppActionCard,
    type CardAppFacts,
    minutesText,
    type SocioAccessCard,
} from '@socio/shared/socio-access';
import { inertText } from '@socio/shared/text/inert-text';

import {
    type ApprovalBlock,
    type ApprovalOutcome,
    type ApprovalRequestState,
    approvalRule,
} from '../sync/approval-actions';

// The approval card and bar in a chat, in words, under Node. The data and the
// decisions are src/sync/approval-actions.ts's; this says what the card and
// the bar show.
// - **The card** (the web's ApprovalCard and SocioAccessCardBody, natively):
//   what is asked ("Ada asks to create datasets"), the status badge from the
//   app's copy table (status by `decidedVia`), the structured card's
//   platform facts (the app, its origin and owner, the room that sees the
//   answers), the parameters as inert text, the socio's or the app's own
//   words quoted last, the auto review's reason, and the decided line (how
//   the socio carries on). Everything a socio or an app wrote goes through
//   shared's `inertText`, as on the web.
// - **Its actions:** Deny and Approve ("Allow", "Allow for this task") while
//   it waits, "Open details" when the request has long details (the sheet,
//   `POST …/open`), which Approve waits for when the request says so, and
//   Undo for an automatic approval that can be. Offline, while the server is
//   away or writes wait, Approve and Deny are disabled with "Needs a
//   connection" (or the sign-in's or update's words); each disabled Approve's
//   reason is its accessibility hint.
// - **The bar** above the composer (the web's ApprovalBar, T3 Code's
//   pending-approval panel): the oldest request waiting among the chat's
//   cards, "1 of 2" in its label, Deny and Approve, or Deny and Show request
//   when only the card may allow it (`decidedOnCard`) or its details must be
//   opened first. Only requests this device can read take part: the server
//   answers only the reader's own (a room's other members' requests read as
//   gone), so in a room the bar shows only the reader's.
// The app never shows the server's refusal text: a 409 or 404 is
// worded from the request as read again.

export const ASKS_FALLBACK = 'Approval request';
export const NEEDS_YOUR_APPROVAL = 'Needs your approval';
export const UNDONE = 'Undone';
export const NEEDS_CONNECTION = 'Needs a connection';
export const SIGN_IN_TO_DECIDE = 'Sign in again to decide';
export const UPDATE_TO_DECIDE = 'Update Socio to decide';
export const OPEN_TO_APPROVE = 'Open the details to approve';
export const UNCONFIRMED = 'Couldn’t confirm your decision';
export const UNCONFIRMED_NOTE = 'Couldn’t confirm your decision. It’s checked again once you’re online.';
export const GONE = 'This request isn’t there any more.';
export const NOT_CHECKED = 'Couldn’t check this request. It’s read again soon.';
export const NOT_SENT = 'Couldn’t send that. Try again.';
export const ON_CARD = 'Show the request to see what it asks and decide on its card.';
export const OPEN_FIRST_ON_BAR = 'Show the request and open its details to approve it.';
export const APPROVE = 'Approve';
export const ALLOW = 'Allow';
export const ALLOW_FOR_TASK = 'Allow for this task';
export const DENY = 'Deny';
export const UNDO = 'Undo';
export const OPEN_DETAILS = 'Open details';
export const SHOW_REQUEST = 'Show request';
export const BAR_LABEL = 'Pending approval';
export const CARD_LABEL = 'Approval request';

/** How a request was decided, as the copy table keys it (`none`: not yet, or not said). */
export const DECIDED_VIA = ['user', 'bypass', 'auto', 'expiry', 'none'] as const;
export type DecidedVia = (typeof DECIDED_VIA)[number];

const every = (text: string): Record<DecidedVia, string> => ({
    user: text,
    bypass: text,
    auto: text,
    expiry: text,
    none: text,
});

/** The status badge's words: "Needs your approval", "Approved automatically", "Approved by your setting". */
export const STATUS_COPY: Record<ApprovalStatus, Record<DecidedVia, string>> = {
    pending: every(NEEDS_YOUR_APPROVAL),
    approved: {
        ...every('Approved'),
        bypass: 'Approved by your setting',
        auto: 'Approved automatically',
    },
    denied: {
        ...every('Denied'),
        bypass: 'Denied by your setting',
        auto: 'Denied automatically',
    },
    expired: every('Expired'),
    failed: every('Failed'),
};

export type BadgeTone = 'waiting' | 'approved' | 'other';

/** The badge: its words and tone. An undone automatic approval says so first. */
export function statusBadge(view: Pick<ApprovalView, 'status' | 'decidedVia' | 'auto'>): {
    text: string;
    tone: BadgeTone;
} {
    const tone: BadgeTone = view.status === 'pending' ? 'waiting' : view.status === 'approved' ? 'approved' : 'other';
    if (view.auto?.undoneAt) {
        return { text: UNDONE, tone: 'other' };
    }
    return { text: STATUS_COPY[view.status][view.decidedVia ?? 'none'], tone };
}

/** "Ada asks to create datasets" (the web's `asksTo`). */
export function asksTo(view: Pick<ApprovalView, 'dotName' | 'capabilityLabel'>): string {
    const { socio, capability } = approvalAsk(view);
    return `${socio} asks to ${capability}`;
}

/** What Approve says: "Allow" on a structured card, "Allow for this task" for access beyond read, else "Approve". */
export function approveLabel(card: SocioAccessCard | null | undefined): string {
    if (!card) {
        return APPROVE;
    }
    return card.kind === 'app_access' && card.access !== 'read' ? ALLOW_FOR_TASK : ALLOW;
}

/** The words for why nothing can be sent now. */
export function blockWords(block: ApprovalBlock): string {
    return block === 'sign-in' ? SIGN_IN_TO_DECIDE : block === 'update' ? UPDATE_TO_DECIDE : NEEDS_CONNECTION;
}

/**
 * The decided line (the web's `decidedLine`, with "socio"): how the socio
 * carries on after the person's decision, or how it was decided otherwise.
 */
export function decidedLine(view: ApprovalView): string {
    if (view.decidedVia === 'auto') {
        return 'Decided by auto review in your place.';
    }
    if (view.status === 'expired') {
        return 'Expired without a decision.';
    }
    if (view.status === 'failed') {
        return 'Approved, but it didn’t run.';
    }
    const verb = view.status === 'denied' ? 'Denied' : 'Approved';
    const continuation = view.continuation;
    if (!continuation) {
        return `${verb}.`;
    }
    const others = continuation.waitingFor;
    switch (continuation.status) {
        case 'waiting':
            return others
                ? `${verb}. The socio carries on once you decide ${others === 1 ? 'the other request' : `the other ${others} requests`} from this turn.`
                : `${verb}. The socio is carrying on…`;
        case 'running':
            return `${verb}. The socio is carrying on…`;
        case 'done':
            return `${verb}. The socio carried on in the chat.`;
        case 'failed':
            return `${verb}. The socio couldn’t carry on.`;
        case 'skipped':
            return `${verb}. The socio didn’t carry on.`;
    }
}

/** A request's expiry, as the card says it ("Nov 8, 3:45 PM"). */
export const expiryText = (ms: number, timeZone?: string): string =>
    new Date(ms).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        ...(timeZone === undefined ? {} : { timeZone }),
    });

// ----- The card's body -----

export interface BodyFact {
    readonly label: string;
    readonly value: string;
    /** An address, a branch or code: monospace. */
    readonly mono: boolean;
}

export interface BodyLine {
    readonly text: string;
    readonly tone: 'default' | 'muted' | 'warning';
}

/** What the card says between its heading and its actions, from the request's structured card or its summary. */
export interface ApprovalBody {
    /** One sentence: what is asked, in the platform's words. */
    readonly lead: string;
    /** "Consequential", for an app's action. */
    readonly tag: string | null;
    readonly facts: readonly BodyFact[];
    /** "This lets it" and its lines. */
    readonly list: { readonly title: string; readonly items: readonly string[] } | null;
    readonly lines: readonly BodyLine[];
    /** An action's parameters, as Socio received them (inert, wrapping). */
    readonly params: {
        readonly title: string;
        readonly counts: readonly string[];
        readonly text: string;
        /** "Showing the first 2.0 KB of 9.0 KB.", while not all of it shows. */
        readonly note: string | null;
    } | null;
    /** The app's own description of it, shown last as its own. */
    readonly display: readonly { readonly label: string; readonly value: string }[];
    /** The socio's words, quoted as theirs. */
    readonly quote: { readonly who: string; readonly text: string } | null;
    /** A coding runtime request's exact command or change, in monospace. */
    readonly code: string | null;
}

/** Text from a socio or an app, inert whatever it holds. */
export const inert = (value: string, max: number = ACTION_PARAMS.maxBytes + 1): string => inertText(value, { max });

/** Canonical JSON, indented when the whole of it parses; else as is (the web's `readable`). */
export function readableParams(text: string): string {
    try {
        return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
        return text;
    }
}

export const sizeText = (bytes: number): string =>
    bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KB`;

const tokensText = (value: number) => (value >= 1000 ? `${Math.round(value / 1000)}k` : String(value));

const EMPTY_BODY = {
    tag: null,
    facts: [],
    list: null,
    lines: [],
    params: null,
    display: [],
    quote: null,
    code: null,
} as const;

function appFacts(app: CardAppFacts): BodyFact[] {
    return [
        { label: 'App', value: inert(app.label, 200), mono: false },
        { label: 'Address', value: app.origin, mono: true },
        { label: 'Owner', value: inert(app.owner, 200), mono: false },
    ];
}

const visibleLine = (socio: string, room: string | null): BodyLine[] =>
    room === null
        ? []
        : [{ text: `${socio}’s answers here are visible to everyone in ${inert(room, 200)}.`, tone: 'default' }];

function accessBody(card: AppAccessCard): ApprovalBody {
    return {
        ...EMPTY_BODY,
        lead: `${card.socioName} wants to ${ACCESS_VERB[card.access]} ${inert(card.app.label, 200)} for you for ${minutesText(card.minutes)}.`,
        facts: appFacts(card.app),
        list: { title: 'This lets it', items: card.allows },
        lines: [
            { text: card.never, tone: 'muted' },
            ...visibleLine(card.socioName, card.visibleTo),
            ...(card.app.development
                ? [
                      {
                          text: 'This is a development app on your own socio’s computer: that socio can change its code, so these limits rely on your trust in it.',
                          tone: 'warning' as const,
                      },
                  ]
                : []),
            ...(card.widens
                ? [{ text: 'Allowing replaces the narrower access it has in this chat.', tone: 'muted' as const }]
                : []),
            ...(card.alwaysAsk
                ? [{ text: 'This app asks for your decision every time.', tone: 'muted' as const }]
                : []),
        ],
        quote: { who: card.socioName, text: inert(card.task, 600) },
    };
}

function actionBody(card: AppActionCard, view: ApprovalView): ApprovalBody {
    const { params } = card;
    // The card holds only the inline cut: the whole text lives in the details sheet, so a cut
    // preview always says it is cut, opened or not (the web counts it whole only once it holds it).
    const nextStep =
        view.review?.opened === true
            ? ' Open details to see all of it.'
            : view.status === 'pending'
              ? ' Open the details before you allow this.'
              : '';
    return {
        ...EMPTY_BODY,
        lead: card.operation
            ? `${card.socioName} asks to ${inert(card.operation.words, 200)} through ${inert(card.app.label, 200)} for you (Socio data operation ${inert(card.operation.op, 100)}).`
            : `${card.socioName} asks to run ${inert(card.action, 200)} in ${inert(card.app.label, 200)} for you.`,
        tag: 'Consequential',
        facts: appFacts(card.app),
        params: {
            title: `What will run: its parameters, as Socio received them (${sizeText(params.bytes)})`,
            counts: params.counts.map(
                (item) => `${item.count} ${item.count === 1 ? 'item' : 'items'} in ${inert(item.path, 200)}`,
            ),
            text: params.complete ? readableParams(inert(params.preview)) : inert(params.preview),
            note: params.complete
                ? null
                : `Showing the first ${sizeText(ACTION_PARAMS.inlineBytes)} of ${sizeText(params.bytes)}.${nextStep}`,
        },
        display: card.display.map((line) => ({ label: inert(line.label, 100), value: inert(line.value, 400) })),
    };
}

function codingBody(card: CodingSessionCard): ApprovalBody {
    return {
        ...EMPTY_BODY,
        lead: `${card.socioName} wants to work on ${card.repository} for you for ${minutesText(card.minutes)}.`,
        facts: [
            {
                label: 'Coding agent',
                value: `${card.harness?.label ?? 'OpenCode'}${card.harness?.route === 'subscription' ? ', outside Socio’s gateway' : ', on Socio’s model gateway'}`,
                mono: false,
            },
            { label: 'Base', value: card.base, mono: true },
            ...(card.push ? [{ label: 'Its branch', value: card.branchPattern, mono: true }] : []),
            {
                label: 'Model',
                value: `${card.model.label}${card.plan ? ', on your own plan' : card.model.outsideProvider ? `, at ${card.model.host ?? 'an outside provider'}` : ', on the operator’s own servers'}`,
                mono: false,
            },
            { label: 'Budget', value: `${tokensText(card.budgetTokens)} tokens`, mono: false },
        ],
        list: { title: 'It can', items: card.allows },
        lines: [
            ...(card.plan
                ? [
                      {
                          text: `This session runs on your own ${card.plan.label} plan, and uses your plan’s limits.`,
                          tone: 'warning' as const,
                      },
                  ]
                : card.model.outsideProvider
                  ? [
                        {
                            text: `The repository’s code it works on is sent to ${card.model.host ?? 'an outside provider'}.`,
                            tone: 'warning' as const,
                        },
                    ]
                  : []),
            { text: card.never, tone: 'muted' },
            ...visibleLine(card.socioName, card.visibleTo),
        ],
        quote: { who: card.socioName, text: inert(card.task, 600) },
    };
}

function runtimeBody(card: CodingRuntimeCard): ApprovalBody {
    return {
        ...EMPTY_BODY,
        lead: `${card.socioName} asks for a ${card.kindLabel.toLowerCase()} in ${card.repository}.`,
        code: inert(card.action),
    };
}

/** The card's body: the structured card's, else the summary and its detail lines. */
export function approvalBody(view: ApprovalView): ApprovalBody {
    const card = view.card;
    if (card?.kind === 'app_access') {
        return accessBody(card);
    }
    if (card?.kind === 'app_action') {
        return actionBody(card, view);
    }
    if (card?.kind === 'coding_session') {
        return codingBody(card);
    }
    if (card?.kind === 'coding_runtime') {
        return runtimeBody(card);
    }
    const summary = view.summary.trim();
    return {
        ...EMPTY_BODY,
        lead: summary === '' || /[.!?…]$/.test(summary) ? summary : `${summary}.`,
        lines: view.details.map((line) => ({ text: inert(line, 2000), tone: 'muted' })),
    };
}

// ----- Actions -----

export type ApprovalButtonKey = 'approve' | 'deny' | 'open' | 'undo' | 'show';

/** A button of the card or the bar: its words, its look, and why it can't be pressed. */
export interface ApprovalButton {
    readonly key: ApprovalButtonKey;
    readonly label: string;
    readonly variant: 'primary' | 'secondary' | 'ghost';
    readonly disabled: boolean;
    /** Its request in flight. */
    readonly busy: boolean;
    /** Why it is disabled, read out with it, or null. */
    readonly hint: string | null;
}

/** What the card or the bar knows of the request on this device. */
export interface ApprovalContext {
    readonly state: ApprovalRequestState;
    /** Why nothing can be sent now (`approvals.blocked()`), or null. */
    readonly blocked: ApprovalBlock | null;
}

const button = (
    key: ApprovalButtonKey,
    label: string,
    variant: ApprovalButton['variant'],
    busy: ApprovalRequestState['busy'],
    hint: string | null = null,
): ApprovalButton => ({
    key,
    label,
    variant,
    // One request at a time per request: every button waits while one is in flight.
    disabled: hint !== null || (busy !== null && busy !== key),
    busy: busy === key,
    hint,
});

/** Why a request to the server can't go now: the block's words, or the unconfirmed decision. */
function sendHint(context: ApprovalContext): string | null {
    if (context.blocked !== null) {
        return blockWords(context.blocked);
    }
    return context.state.unconfirmed ? UNCONFIRMED : null;
}

export interface ApprovalCardView {
    readonly id: string;
    /** "Ada asks to create datasets". */
    readonly title: string;
    readonly badge: { readonly text: string; readonly tone: BadgeTone };
    readonly body: ApprovalBody;
    /** What the decision came to, in the server's words (a failure in red). */
    readonly outcome: { readonly text: string; readonly failed: boolean } | null;
    /** The auto review: its verdict and reason. */
    readonly auto: { readonly lead: string; readonly reason: string } | null;
    /** "Nothing happens until you decide. Expires …", or the decided line. */
    readonly line: string;
    /** Why it can't be decided now, the unconfirmed decision, or what the last tap came to. */
    readonly notice: string | null;
    readonly actions: readonly ApprovalButton[];
    /** The card's label for a screen reader: what is asked and where it stands. */
    readonly accessibilityLabel: string;
}

/** What an action's outcome leaves on the card, beyond the request read again (never the server's text). */
export function outcomeNotice(outcome: ApprovalOutcome): string | null {
    switch (outcome.kind) {
        case 'blocked':
            return blockWords(outcome.reason);
        case 'refused':
            return outcome.view === null ? GONE : outcome.view === undefined ? NOT_CHECKED : null;
        case 'unconfirmed':
            return UNCONFIRMED_NOTE;
        case 'failed':
            return NOT_SENT;
        case 'not-allowed':
            return outcome.reason === 'open-first' ? OPEN_TO_APPROVE : null;
        default:
            return null;
    }
}

/**
 * The card of a request this device has read: its words, and its buttons
 * with each one's state. `notice` is what the last tap came to, if anything.
 */
export function approvalCardView(
    view: ApprovalView,
    context: ApprovalContext,
    notice: string | null = null,
    timeZone?: string,
): ApprovalCardView {
    const { busy } = context.state;
    const waiting = view.status === 'pending';
    const send = sendHint(context);
    const actions: ApprovalButton[] = [];
    if (view.review) {
        actions.push(button('open', OPEN_DETAILS, 'secondary', busy, context.blocked === null ? null : send));
    }
    if (waiting) {
        actions.push(button('deny', DENY, 'secondary', busy, send));
        actions.push(
            button('approve', approveLabel(view.card), 'primary', busy, mustOpenFirst(view) ? OPEN_TO_APPROVE : send),
        );
    }
    const auto = view.auto;
    if (view.status === 'approved' && view.decidedVia === 'auto' && auto?.undoable && !auto.undoneAt) {
        actions.push(button('undo', UNDO, 'secondary', busy, send));
    }
    const badge = statusBadge(view);
    const title = asksTo(view);
    const unconfirmed = context.state.unconfirmed ? UNCONFIRMED_NOTE : null;
    const blocked =
        context.blocked !== null && actions.some((action) => action.key !== 'open')
            ? blockWords(context.blocked)
            : null;
    return {
        id: view.id,
        title,
        badge,
        body: approvalBody(view),
        outcome: view.outcome ? { text: view.outcome, failed: view.status === 'failed' } : null,
        auto: auto
            ? {
                  lead:
                      auto.verdict === 'escalated'
                          ? 'Auto review passed this to you'
                          : auto.verdict === 'approved'
                            ? 'Approved by auto review'
                            : 'Denied by auto review',
                  reason: autoReasonLine(auto),
              }
            : null,
        line: waiting
            ? `Nothing happens until you decide. Expires ${expiryText(view.expiresAt, timeZone)}.`
            : decidedLine(view),
        notice: blocked ?? unconfirmed ?? notice,
        actions,
        accessibilityLabel: `${CARD_LABEL}: ${title}. ${badge.text}`,
    };
}

// ----- The bar -----

/** The requests waiting among a chat's cards, oldest first: only those this device has read. */
export function waitingInChat(ids: readonly string[], view: (id: string) => ApprovalView | undefined): ApprovalView[] {
    const seen = new Set<string>();
    const waiting: ApprovalView[] = [];
    for (const id of ids) {
        const found = seen.has(id) ? undefined : view(id);
        seen.add(id);
        if (found?.status === 'pending') {
            waiting.push(found);
        }
    }
    return waiting.sort((a, b) => a.createdAt - b.createdAt);
}

export interface ApprovalBarView {
    /** The request it decides: the oldest waiting. */
    readonly id: string;
    readonly title: string;
    readonly summary: string;
    /** "1 of 2" while more wait, else null. */
    readonly count: string | null;
    /** The bar's label for a screen reader, with the count. */
    readonly accessibilityLabel: string;
    /** "Needs a connection", or why it must be decided on the card. */
    readonly note: string | null;
    /** Deny and Approve, or Deny and Show request. */
    readonly actions: readonly ApprovalButton[];
}

/** The bar above the composer for `waiting` (oldest first), or null when nothing waits. */
export function approvalBarView(waiting: readonly ApprovalView[], context: ApprovalContext): ApprovalBarView | null {
    const first = waiting[0];
    if (first === undefined) {
        return null;
    }
    const { busy } = context.state;
    const send = sendHint(context);
    const onCard = decidedOnCard(first.card);
    const openFirst = !onCard && mustOpenFirst(first);
    const title = asksTo(first);
    const count = waiting.length > 1 ? `1 of ${waiting.length}` : null;
    return {
        id: first.id,
        title,
        summary: first.summary,
        count,
        accessibilityLabel: `${BAR_LABEL}: ${title}${count === null ? '' : `, ${count}`}`,
        note: send ?? (onCard ? ON_CARD : openFirst ? OPEN_FIRST_ON_BAR : null),
        actions: [
            button('deny', DENY, 'secondary', busy, send),
            onCard || openFirst
                ? { key: 'show', label: SHOW_REQUEST, variant: 'primary', disabled: false, busy: false, hint: null }
                : button('approve', approveLabel(first.card), 'primary', busy, send),
        ],
    };
}

/** Every status the copy table covers, for its tests. */
export const COPY_STATUSES: readonly ApprovalStatus[] = APPROVAL_STATUSES;

// ----- The Inbox's row -----

/** The Inbox row's line when its request must be decided on its page. */
export const OPEN_TO_DECIDE = 'Open the request to decide';

/** An Inbox row's decision: Deny and Approve in place, or none, and the row opens the request. */
export interface InboxDecisionView {
    /** Deny and Approve, or empty when the request must be opened to decide. */
    readonly actions: readonly ApprovalButton[];
    /** Why the buttons can't be pressed, the unconfirmed decision, what the last tap came to, or why to open it. */
    readonly note: string | null;
}

/**
 * Deny and Approve on an Inbox row, as the web's approval cards decide in place, by the request
 * page's rules (`approvalRule`): one whose long details must be opened first (`mustOpenFirst`), or
 * whose card asks for more than a yes (`decidedOnCard`), has no buttons, and its row opens the
 * request. Online only, as every decision (`blocked`). `notice` is what the last tap came to.
 */
export function inboxDecisionView(
    view: ApprovalView,
    context: ApprovalContext,
    notice: string | null = null,
): InboxDecisionView {
    if (view.status !== 'pending') {
        return { actions: [], note: notice };
    }
    if (approvalRule(view, 'approve') === 'open-first') {
        return { actions: [], note: OPEN_TO_APPROVE };
    }
    if (decidedOnCard(view.card)) {
        return { actions: [], note: OPEN_TO_DECIDE };
    }
    const send = sendHint(context);
    const { busy } = context.state;
    return {
        actions: [
            button('deny', DENY, 'secondary', busy, send),
            button('approve', approveLabel(view.card), 'primary', busy, send),
        ],
        note:
            (context.blocked === null ? null : blockWords(context.blocked)) ??
            (context.state.unconfirmed ? UNCONFIRMED_NOTE : null) ??
            notice,
    };
}
