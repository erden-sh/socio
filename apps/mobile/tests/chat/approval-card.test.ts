import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { APPROVAL_STATUSES, type ApprovalView } from '@socio/shared/approvals';
import type { AppAccessCard, AppActionCard } from '@socio/shared/socio-access';

import {
    ALLOW,
    ALLOW_FOR_TASK,
    APPROVE,
    type ApprovalButton,
    type ApprovalContext,
    approvalBarView,
    approvalBody,
    approvalCardView,
    asksTo,
    DECIDED_VIA,
    decidedLine,
    DENY,
    GONE,
    inboxDecisionView,
    NEEDS_CONNECTION,
    NEEDS_YOUR_APPROVAL,
    NOT_CHECKED,
    NOT_SENT,
    ON_CARD,
    OPEN_DETAILS,
    OPEN_TO_APPROVE,
    OPEN_TO_DECIDE,
    outcomeNotice,
    SHOW_REQUEST,
    SIGN_IN_TO_DECIDE,
    STATUS_COPY,
    statusBadge,
    UNCONFIRMED,
    UNCONFIRMED_NOTE,
    UNDO,
    UNDONE,
    UPDATE_TO_DECIDE,
    waitingInChat,
} from '../../src/chat/approval-card';
import { SEE_IN_APPROVALS } from '../../src/chat/cards';
import { OPEN_IN_APPROVALS } from '../../src/chat/chat-view';

// The approval card and bar in a chat, in words and roles, over the approvals'
// views and states.

const view = (id: string, fields: Partial<ApprovalView> = {}): ApprovalView => ({
    id,
    dotId: 'sebas',
    dotName: 'Sebas',
    capability: 'data.create_dataset',
    capabilityLabel: 'Create dataset',
    summary: `Create dataset “${id}”`,
    details: ['Columns: name, price'],
    status: 'pending',
    decidedVia: null,
    createdAt: 1,
    expiresAt: Date.UTC(2026, 10, 8, 15, 45),
    ...fields,
});

const APP = { label: 'Ledger', origin: 'https://ledger.example.test', owner: 'Ada', development: false };

const access = (fields: Partial<AppAccessCard> = {}): AppAccessCard => ({
    kind: 'app_access',
    socioName: 'Sebas',
    access: 'write',
    minutes: 60,
    app: APP,
    allows: ['Read entries', 'Add entries'],
    never: 'It can’t change the app’s settings or sharing, and can’t act as you anywhere else.',
    visibleTo: 'Launch room',
    task: 'Log the​ invoices',
    widens: false,
    alwaysAsk: false,
    ...fields,
});

const action = (fields: Partial<AppActionCard['params']> = {}): AppActionCard => ({
    kind: 'app_action',
    socioName: 'Sebas',
    app: APP,
    action: 'send_invoice',
    tier: 'consequential',
    params: { preview: '{"to":"x"}', bytes: 9000, complete: false, counts: [{ path: 'lines', count: 3 }], ...fields },
    display: [{ label: 'To', value: 'Acme' }],
});

const idle: ApprovalContext = { state: { busy: null, unconfirmed: false }, blocked: null };
const byKey = (buttons: readonly ApprovalButton[]) => Object.fromEntries(buttons.map((b) => [b.key, b]));

describe('the copy table', () => {
    it('has words for every status by every way it was decided, never the web’s "Waiting for you" or "(auto)"', () => {
        for (const status of APPROVAL_STATUSES) {
            for (const via of DECIDED_VIA) {
                const text = STATUS_COPY[status][via];
                expect(text, `${status}/${via}`).toMatch(/^[A-Z]/);
                expect(text).not.toMatch(/Waiting for you|\(auto\)|\(bypass\)/);
            }
        }
        expect(STATUS_COPY.pending.none).toBe(NEEDS_YOUR_APPROVAL);
        expect(STATUS_COPY.approved.auto).toBe('Approved automatically');
        expect(STATUS_COPY.approved.bypass).toBe('Approved by your setting');
        expect(STATUS_COPY.denied.auto).toBe('Denied automatically');
        expect(STATUS_COPY.expired.expiry).toBe('Expired');
    });

    it('badges by status and how it was decided; an undone automatic approval says so', () => {
        expect(statusBadge(view('a'))).toEqual({ text: NEEDS_YOUR_APPROVAL, tone: 'waiting' });
        expect(statusBadge(view('a', { status: 'approved', decidedVia: 'auto' }))).toEqual({
            text: 'Approved automatically',
            tone: 'approved',
        });
        expect(statusBadge(view('a', { status: 'denied', decidedVia: undefined }))).toEqual({
            text: 'Denied',
            tone: 'other',
        });
        const undone = view('a', {
            status: 'approved',
            decidedVia: 'auto',
            auto: {
                verdict: 'approved',
                risk: 'low',
                reason: 'fine',
                cause: 'model',
                model: null,
                backend: null,
                latencyMs: null,
                at: 1,
                undoneAt: 2,
                undoOutcome: 'Deleted',
                undoable: false,
            },
        });
        expect(statusBadge(undone).text).toBe(UNDONE);
    });

    it('says what is asked and how the socio carries on, with "socio" and never the server’s text', () => {
        expect(asksTo(view('a'))).toBe('Sebas asks to create dataset');
        expect(decidedLine(view('a', { status: 'approved', decidedVia: 'user' }))).toBe('Approved.');
        expect(
            decidedLine(
                view('a', {
                    status: 'denied',
                    decidedVia: 'user',
                    continuation: { status: 'waiting', id: null, detail: null, waitingFor: 2 },
                }),
            ),
        ).toBe('Denied. The socio carries on once you decide the other 2 requests from this turn.');
        expect(
            decidedLine(
                view('a', {
                    status: 'approved',
                    decidedVia: 'user',
                    continuation: { status: 'failed', id: 'r', detail: 'Model exploded: 500', waitingFor: 0 },
                }),
            ),
        ).toBe('Approved. The socio couldn’t carry on.');
        expect(decidedLine(view('a', { status: 'expired', decidedVia: 'expiry' }))).toBe('Expired without a decision.');
        expect(decidedLine(view('a', { status: 'approved', decidedVia: 'auto' }))).toMatch(/auto review/);
    });

    it('words each outcome without the server’s text', () => {
        expect(outcomeNotice({ kind: 'blocked', reason: 'offline' })).toBe(NEEDS_CONNECTION);
        expect(outcomeNotice({ kind: 'blocked', reason: 'away' })).toBe(NEEDS_CONNECTION);
        expect(outcomeNotice({ kind: 'blocked', reason: 'sign-in' })).toBe(SIGN_IN_TO_DECIDE);
        expect(outcomeNotice({ kind: 'blocked', reason: 'update' })).toBe(UPDATE_TO_DECIDE);
        expect(outcomeNotice({ kind: 'refused', view: null })).toBe(GONE);
        expect(outcomeNotice({ kind: 'refused', view: undefined })).toBe(NOT_CHECKED);
        expect(outcomeNotice({ kind: 'refused', view: view('a', { status: 'approved' }) })).toBeNull();
        expect(outcomeNotice({ kind: 'unconfirmed' })).toBe(UNCONFIRMED_NOTE);
        expect(outcomeNotice({ kind: 'failed', status: 403 })).toBe(NOT_SENT);
        expect(outcomeNotice({ kind: 'not-allowed', reason: 'open-first' })).toBe(OPEN_TO_APPROVE);
        expect(outcomeNotice({ kind: 'done', view: view('a') })).toBeNull();
    });
});

describe('the card', () => {
    it('offers Deny and Approve while it waits, with the expiry, labelled for a screen reader', () => {
        const card = approvalCardView(view('a'), idle, null, 'UTC');
        expect(card.title).toBe('Sebas asks to create dataset');
        expect(card.badge.text).toBe(NEEDS_YOUR_APPROVAL);
        expect(card.line).toBe('Nothing happens until you decide. Expires Nov 8, 3:45 PM.');
        expect(card.accessibilityLabel).toBe(`Approval request: Sebas asks to create dataset. ${NEEDS_YOUR_APPROVAL}`);
        expect(card.actions).toEqual([
            { key: 'deny', label: DENY, variant: 'secondary', disabled: false, busy: false, hint: null },
            { key: 'approve', label: APPROVE, variant: 'primary', disabled: false, busy: false, hint: null },
        ]);
        expect(card.body).toMatchObject({ lead: 'Create dataset “a”.', lines: [{ text: 'Columns: name, price' }] });
        expect(card.notice).toBeNull();
    });

    it('disables Approve and Deny offline with "Needs a connection" as their hint, and the sign-in’s or update’s words', () => {
        for (const [blocked, words] of [
            ['offline', NEEDS_CONNECTION],
            ['away', NEEDS_CONNECTION],
            ['sign-in', SIGN_IN_TO_DECIDE],
            ['update', UPDATE_TO_DECIDE],
        ] as const) {
            const card = approvalCardView(view('a'), { ...idle, blocked });
            const buttons = byKey(card.actions);
            expect(buttons.approve).toMatchObject({ disabled: true, hint: words });
            expect(buttons.deny).toMatchObject({ disabled: true, hint: words });
            expect(card.notice).toBe(words);
        }
    });

    it('keeps Approve until the details are opened, "Open the details to approve" its hint; Deny goes', () => {
        const waiting = view('a', { card: action(), review: { mustOpen: true, opened: false } });
        const buttons = byKey(approvalCardView(waiting, idle).actions);
        expect(buttons.open).toMatchObject({ label: OPEN_DETAILS, disabled: false, variant: 'secondary' });
        expect(buttons.approve).toMatchObject({ label: ALLOW, disabled: true, hint: OPEN_TO_APPROVE });
        expect(buttons.deny).toMatchObject({ disabled: false });
        const opened = byKey(approvalCardView({ ...waiting, review: { mustOpen: true, opened: true } }, idle).actions);
        expect(opened.approve).toMatchObject({ disabled: false, hint: null });
        // Offline the reason to open first still comes first; the details can't open either.
        const offline = byKey(approvalCardView(waiting, { ...idle, blocked: 'offline' }).actions);
        expect(offline.approve.hint).toBe(OPEN_TO_APPROVE);
        expect(offline.open).toMatchObject({ disabled: true, hint: NEEDS_CONNECTION });
    });

    it('shows one request in flight as busy and holds every other button; an unconfirmed decision holds them all', () => {
        const busy = byKey(
            approvalCardView(view('a'), { ...idle, state: { busy: 'approve', unconfirmed: false } }).actions,
        );
        expect(busy.approve).toMatchObject({ busy: true });
        expect(busy.deny).toMatchObject({ busy: false, disabled: true });
        const unconfirmed = approvalCardView(view('a'), { ...idle, state: { busy: null, unconfirmed: true } });
        expect(byKey(unconfirmed.actions).approve).toMatchObject({ disabled: true, hint: UNCONFIRMED });
        expect(unconfirmed.notice).toBe(UNCONFIRMED_NOTE);
    });

    it('offers Undo only for an automatic approval that can be undone, and nothing to decide once decided', () => {
        const auto = {
            verdict: 'approved' as const,
            risk: 'low' as const,
            reason: 'Looks routine',
            cause: 'model' as const,
            model: 'm',
            backend: null,
            latencyMs: null,
            at: 1,
            undoneAt: null,
            undoOutcome: null,
            undoable: true,
        };
        const card = approvalCardView(view('a', { status: 'approved', decidedVia: 'auto', auto }), idle);
        expect(card.actions.map((b) => [b.key, b.label])).toEqual([['undo', UNDO]]);
        expect(card.auto).toEqual({ lead: 'Approved by auto review', reason: 'Looks routine. (risk low)' });
        expect(card.badge.text).toBe('Approved automatically');
        expect(approvalCardView(view('a', { status: 'denied', decidedVia: 'user' }), idle).actions).toEqual([]);
        expect(
            approvalCardView(
                view('a', { status: 'approved', decidedVia: 'user', auto: { ...auto, undoable: true } }),
                idle,
            ).actions,
        ).toEqual([]);
    });

    it('says "Allow for this task" for access beyond read, "Allow" for read, with the facts and the socio’s words inert', () => {
        const write = approvalCardView(view('a', { card: access() }), idle);
        expect(byKey(write.actions).approve.label).toBe(ALLOW_FOR_TASK);
        expect(
            byKey(approvalCardView(view('a', { card: access({ access: 'read' }) }), idle).actions).approve.label,
        ).toBe(ALLOW);
        expect(write.body.lead).toBe('Sebas wants to read and change Ledger for you for 1 hour.');
        expect(write.body.facts).toEqual([
            { label: 'App', value: 'Ledger', mono: false },
            { label: 'Address', value: 'https://ledger.example.test', mono: true },
            { label: 'Owner', value: 'Ada', mono: false },
        ]);
        expect(write.body.lines.map((line) => line.text)).toContain(
            'Sebas’s answers here are visible to everyone in Launch room.',
        );
        // A zero-width space shows as its code point, never hidden.
        expect(write.body.quote).toEqual({ who: 'Sebas', text: 'Log the[U+200B] invoices' });
    });

    it('shows an action’s parameters as text, always says it is cut, whole and indented once complete', () => {
        const cut = approvalBody(view('a', { card: action(), review: { mustOpen: true, opened: false } }));
        expect(cut.tag).toBe('Consequential');
        expect(cut.params).toMatchObject({
            text: '{"to":"x"}',
            counts: ['3 items in lines'],
            note: 'Showing the first 2.0 KB of 8.8 KB. Open the details before you allow this.',
        });
        expect(cut.display).toEqual([{ label: 'To', value: 'Acme' }]);
        // Opened, the card still holds only the cut: it keeps saying so, without the instruction to open first.
        const opened = approvalBody(view('a', { card: action(), review: { mustOpen: true, opened: true } }));
        expect(opened.params).toMatchObject({
            text: '{"to":"x"}',
            note: 'Showing the first 2.0 KB of 8.8 KB. Open details to see all of it.',
        });
        const decided = approvalBody(view('a', { status: 'denied', card: action() }));
        expect(decided.params?.note).toBe('Showing the first 2.0 KB of 8.8 KB.');
        const whole = approvalBody(view('a', { card: action({ complete: true, bytes: 10 }) }));
        expect(whole.params).toMatchObject({ text: '{\n  "to": "x"\n}', note: null });
    });
});

describe('the bar', () => {
    it('takes the oldest request waiting among the chat’s, only those this device has read', () => {
        const views = new Map([
            ['new', view('new', { createdAt: 30 })],
            ['old', view('old', { createdAt: 10 })],
            ['done', view('done', { status: 'approved', createdAt: 5 })],
        ]);
        // 'theirs' is a room member's request: the server answers only the reader's, so it never reads.
        expect(waitingInChat(['new', 'theirs', 'done', 'old', 'new'], (id) => views.get(id)).map((v) => v.id)).toEqual([
            'old',
            'new',
        ]);
        expect(approvalBarView([], idle)).toBeNull();
    });

    it('says "1 of 2" in its label and offers Deny and Approve', () => {
        const bar = approvalBarView([view('old'), view('new')], idle)!;
        expect(bar).toMatchObject({
            id: 'old',
            title: 'Sebas asks to create dataset',
            count: '1 of 2',
            accessibilityLabel: 'Pending approval: Sebas asks to create dataset, 1 of 2',
            note: null,
        });
        expect(bar.actions.map((b) => [b.key, b.label, b.variant])).toEqual([
            ['deny', DENY, 'secondary'],
            ['approve', APPROVE, 'primary'],
        ]);
        expect(approvalBarView([view('one')], idle)!.count).toBeNull();
    });

    it('offers Deny and Show request when only the card may allow it, or its details must be opened first', () => {
        for (const waiting of [
            view('a', { card: action() }),
            view('a', { card: access() }),
            view('a', { review: { mustOpen: true, opened: false } }),
        ]) {
            const bar = approvalBarView([waiting], idle)!;
            expect(bar.actions.map((b) => [b.key, b.label, b.disabled])).toEqual([
                ['deny', DENY, false],
                ['show', SHOW_REQUEST, false],
            ]);
        }
        expect(approvalBarView([view('a', { card: action() })], idle)!.note).toBe(ON_CARD);
        // Read access may be allowed from the bar.
        expect(approvalBarView([view('a', { card: access({ access: 'read' }) })], idle)!.actions[1]!.label).toBe(ALLOW);
    });

    it('disables Deny and Approve offline with "Needs a connection"; Show request still works', () => {
        const offline = approvalBarView([view('a')], { ...idle, blocked: 'offline' })!;
        expect(offline.note).toBe(NEEDS_CONNECTION);
        expect(offline.actions.every((b) => b.disabled && b.hint === NEEDS_CONNECTION)).toBe(true);
        const onCard = approvalBarView([view('a', { card: action() })], { ...idle, blocked: 'offline' })!;
        expect(byKey(onCard.actions).show).toMatchObject({ disabled: false });
    });
});

describe('the Inbox row’s decision', () => {
    it('offers Deny and Approve in place, as the web’s approval cards do', () => {
        const decision = inboxDecisionView(view('a'), idle);
        expect(decision.actions.map((b) => [b.key, b.label, b.variant, b.disabled])).toEqual([
            ['deny', DENY, 'secondary', false],
            ['approve', APPROVE, 'primary', false],
        ]);
        expect(decision.note).toBeNull();
        expect(inboxDecisionView(view('a', { card: access({ access: 'read' }) }), idle).actions[1]!.label).toBe(ALLOW);
    });

    it('has no buttons for a request whose details must be opened first: the row opens it', () => {
        const decision = inboxDecisionView(view('a', { review: { mustOpen: true, opened: false } }), idle);
        expect(decision).toEqual({ actions: [], note: OPEN_TO_APPROVE });
        // Once opened, it decides in place again.
        expect(inboxDecisionView(view('a', { review: { mustOpen: true, opened: true } }), idle).actions).toHaveLength(
            2,
        );
    });

    it('has no buttons for a request its card must decide', () => {
        for (const card of [action(), access()]) {
            expect(inboxDecisionView(view('a', { card }), idle)).toEqual({ actions: [], note: OPEN_TO_DECIDE });
        }
    });

    it('is online only: both buttons wait with "Needs a connection", and one request at a time', () => {
        const offline = inboxDecisionView(view('a'), { ...idle, blocked: 'offline' });
        expect(offline.note).toBe(NEEDS_CONNECTION);
        expect(offline.actions.every((b) => b.disabled && b.hint === NEEDS_CONNECTION)).toBe(true);
        const busy = inboxDecisionView(view('a'), { state: { busy: 'approve', unconfirmed: false }, blocked: null });
        expect(byKey(busy.actions).approve).toMatchObject({ busy: true });
        expect(byKey(busy.actions).deny).toMatchObject({ disabled: true });
        const unconfirmed = inboxDecisionView(view('a'), { state: { busy: null, unconfirmed: true }, blocked: null });
        expect(unconfirmed.note).toBe(UNCONFIRMED_NOTE);
        expect(inboxDecisionView(view('a'), idle, NOT_SENT).note).toBe(NOT_SENT);
    });

    it('offers nothing once decided', () => {
        expect(inboxDecisionView(view('a', { status: 'approved' }), idle).actions).toEqual([]);
    });
});

describe("where a card's link goes", () => {
    const card = () => readFileSync(new URL('../../src/screens/approval-card.tsx', import.meta.url), 'utf8');

    it("opens the request's page in the app from a chat, as the web's Open in Approvals, never the browser", () => {
        expect(OPEN_IN_APPROVALS).toBe('Open in Approvals');
        const source = card();
        expect(source).not.toContain('OPEN_IN_BROWSER');
        expect(source).not.toContain('openLink(');
        expect(source).toContain('onOpen={() => navigation.dispatch(approvalAction(fallback.id))}');
        expect(source).toContain('<Button label={OPEN_IN_APPROVALS} variant="ghost" onPress={onOpen}');
    });

    it("opens the app's request page from the plain card shown before the request is read (the cards' fallback)", () => {
        const cards = readFileSync(new URL('../../src/screens/chat-cards.tsx', import.meta.url), 'utf8');
        const view = cards.slice(cards.indexOf('export function CardView'), cards.indexOf('const REACTION_ICONS'));
        expect(view).toContain("card.kind === 'approval' || (card.kind === 'coding' && !card.web) ? null : webUrl");
        expect(view).toMatch(
            /label=\{OPEN_IN_APPROVALS\}\s*variant="ghost"\s*onPress=\{\(\) => navigation\.dispatch\(approvalAction\(card\.id\)\)\}/,
        );
        expect(SEE_IN_APPROVALS).not.toContain('browser');
    });

    it('takes no openLink: nothing passes one any more', () => {
        expect(card()).not.toMatch(/openLink\??:/);
        const approvals = readFileSync(new URL('../../src/screens/approvals.tsx', import.meta.url), 'utf8');
        expect(approvals).not.toContain('openLink');
    });

    it("shows no link on the approvals list or the request's own page, as the web shows none there", () => {
        const byId = card().slice(card().indexOf('export function ApprovalCardById'));
        expect(byId.slice(0, byId.indexOf('\n}\n'))).toContain('onOpen={null}');
    });
});
