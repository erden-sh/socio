import { afterEach, expect, it, vi } from 'vitest';

import { intentDigest } from '@socio/foundation/actors/principal';
import { canonicalJson } from '@socio/shared/jcs';
import {
    ACTION_PARAMS,
    SOCIO_ACCESS_APPROVAL_TTL_MS,
    SOCIO_ACCESS_CAPABILITIES,
    type AppActionCard,
} from '@socio/shared/socio-access';

import { consumeAppAction, requestAppAction } from '../src/server/actors/approvals.js';
import { ApprovalError } from '../src/server/approvals/contract.js';

import { RLO, ZWSP, cleanup, setup } from './support/consent-fixture.js';

// CB-232: consequential app actions as consumable approvals. What
// the internal apps listener's /api/apps/actor/approvals routes call.
// Denials, changed intent, replay, duplicate execution and card integrity
// first.

afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function fixture() {
    const f = await setup();
    const grant = (scopes: Array<'app:read' | 'app:write' | 'app:act'>) =>
        f.platform.actors.grants.create({
            personId: 'alice',
            socioId: f.company.id,
            audiences: ['app:crm'],
            scopes,
            conversationId: f.chat.id,
            conversationKind: 'private',
            task: 'Remind the team',
            policyVersion: 'v1',
            approvedBy: 'alice',
            correlationId: 'corr-grant',
        });
    const act = await grant(['app:act']);
    let n = 0;
    const request = (params: unknown, overrides: Partial<Parameters<typeof requestAppAction>[1]> = {}) =>
        requestAppAction(f.platform, {
            grantId: act.id,
            appId: 'crm',
            action: 'sms.send',
            params,
            display: { Summary: 'Send a reminder to Dana' },
            correlationId: `corr-${++n}`,
            ...overrides,
        });
    const consume = (
        approvalId: string,
        params: unknown,
        overrides: Partial<Parameters<typeof consumeAppAction>[1]> = {},
    ) =>
        consumeAppAction(f.platform, {
            approvalId,
            grantId: act.id,
            appId: 'crm',
            digest: intentDigest('crm', 'sms.send', params),
            correlationId: `corr-${++n}`,
            ...overrides,
        });
    const approve = (id: string) => f.platform.approvals.decide(id, 'alice', true);
    return { ...f, grant, act, request, consume, approve };
}

const idOf = (result: Awaited<ReturnType<typeof requestAppAction>>) => {
    if (!result.ok) {
        throw new Error(`Refused: ${result.reason}`);
    }
    return result.approval.id;
};

it('refuses a grant without app:act, an undeclared or admin action, and a non-consequential one', async () => {
    const f = await fixture();
    const write = await f.grant(['app:write']);
    expect(await f.request({ to: 'dana' }, { grantId: write.id })).toEqual({
        ok: false,
        status: 403,
        reason: 'scope_insufficient',
    });
    expect(await f.request({}, { action: 'nope' })).toMatchObject({
        status: 403,
        reason: 'action_undeclared',
    });
    expect(await f.request({}, { action: 'settings.update' })).toMatchObject({
        status: 403,
        reason: 'admin_tier',
    });
    expect(await f.request({}, { action: 'deal.update' })).toMatchObject({
        status: 400,
        reason: 'not_consequential',
    });
    // Another app's audience, or no such grant.
    expect(await f.request({}, { appId: 'hr' })).toMatchObject({
        status: 403,
        reason: 'audience_mismatch',
    });
    expect(await f.request({}, { grantId: 'missing' })).toMatchObject({
        status: 403,
        reason: 'audience_mismatch',
    });
    expect(await f.platform.approvals.list('alice')).toEqual([]);
});

it('refuses parameters over 64 KB before a card is made, and values JSON can’t hold', async () => {
    const f = await fixture();
    const big = { body: 'x'.repeat(ACTION_PARAMS.maxBytes) };
    expect(await f.request(big)).toEqual({
        ok: false,
        status: 413,
        reason: 'params_too_large',
    });
    // A value RFC 8785 can't hold is its own refusal, not "too large".
    for (const bad of [{ n: Number.NaN }, { n: Infinity }, { n: 10n }]) {
        expect(await f.request(bad)).toEqual({
            ok: false,
            status: 400,
            reason: 'params_invalid',
        });
    }
    expect(await f.platform.approvals.list('alice')).toEqual([]);
});

it('caps waiting actions at three per grant; the same intent finds its own card', async () => {
    const f = await fixture();
    const first = idOf(await f.request({ to: 'a' }));
    // Reordered keys are the same intent (RFC 8785): the same approval.
    const twoKeys = { to: 'b', body: 'hi' };
    const second = idOf(await f.request(twoKeys));
    expect(idOf(await f.request({ body: 'hi', to: 'b' }))).toBe(second);
    idOf(await f.request({ to: 'c' }));
    expect(await f.request({ to: 'd' })).toEqual({
        ok: false,
        status: 409,
        reason: 'limit_reached',
    });
    // Deciding one frees a place.
    await f.platform.approvals.decide(first, 'alice', false);
    idOf(await f.request({ to: 'd' }));
});

it('makes one card for identical requests at the same moment (find-or-insert in one unit)', async () => {
    const f = await fixture();
    const params = { to: 'dana', body: 'Standup moved' };
    const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) => f.request(i % 2 ? { body: params.body, to: params.to } : params)),
    );
    const ids = new Set(results.map(idOf));
    expect(ids.size).toBe(1);
    expect((await f.platform.approvals.list('alice')).filter((view) => view.status === 'pending')).toHaveLength(1);
    // Approved and unused, it is still the one found.
    const [id] = [...ids];
    await f.approve(id!);
    expect(await f.request(params)).toMatchObject({
        ok: true,
        approval: { id, status: 'approved' },
    });
});

it('shows the app owner’s name inert on the stored card', async () => {
    const f = await fixture();
    f.workspace.recordUser({ id: 'alice', name: `Alice${RLO}`, role: 'member' });
    const id = idOf(await f.request({ to: 'dana' }));
    const view = await f.platform.approvals.get(id, 'alice');
    expect((view.card as AppActionCard).app.owner).toBe('Alice[U+202E]');
    expect(JSON.stringify(view)).not.toContain(RLO);
});

it('can never be bypassed or auto-approved, and waits 15 minutes', async () => {
    const f = await fixture();
    for (const policy of ['bypass', 'auto'] as const) {
        await expect(
            f.platform.approvals.setPolicy('alice', f.company.id, SOCIO_ACCESS_CAPABILITIES.action, policy),
        ).rejects.toThrow(ApprovalError);
    }
    const result = await f.request({ to: 'dana' });
    expect(result).toMatchObject({ ok: true, approval: { status: 'pending' } });
    const view = await f.platform.approvals.get(idOf(result), 'alice');
    expect(view.expiresAt - view.createdAt).toBe(SOCIO_ACCESS_APPROVAL_TTL_MS);
});

it('is consumed once, for its grant, app and digest, only once approved', async () => {
    const f = await fixture();
    const params = { to: 'dana', body: 'Standup moved' };
    const id = idOf(await f.request(params));
    // Waiting: not usable.
    expect(await f.consume(id, params)).toBe(false);
    await f.approve(id);
    // Changed intent: a different digest.
    expect(await f.consume(id, { ...params, to: 'everyone' })).toBe(false);
    // Another grant of the same person, socio and app.
    const other = await f.grant(['app:act']);
    expect(await f.consume(id, params, { grantId: other.id })).toBe(false);
    // Another app with the same digest value.
    expect(await f.consume(id, params, { appId: 'hr' })).toBe(false);
    // Once, then never again.
    expect(await f.consume(id, params)).toBe(true);
    expect(await f.consume(id, params)).toBe(false);
    expect((await f.platform.approvals.get(id, 'alice')).consumedAt).toEqual(expect.any(Number));
    // Asking again for the same intent after use makes a new card.
    expect(idOf(await f.request(params))).not.toBe(id);
});

it('lets exactly one of concurrent consumes win', async () => {
    const f = await fixture();
    const params = { to: 'dana' };
    const id = idOf(await f.request(params));
    await f.approve(id);
    const results = await Promise.all(Array.from({ length: 8 }, () => f.consume(id, params)));
    expect(results.filter(Boolean)).toHaveLength(1);
});

it('denied and expired approvals can’t be consumed; a revoked grant takes its approvals with it', async () => {
    const f = await fixture();
    const denied = idOf(await f.request({ to: 'a' }));
    await f.platform.approvals.decide(denied, 'alice', false);
    expect(await f.consume(denied, { to: 'a' })).toBe(false);
    const expired = idOf(await f.request({ to: 'b' }));
    await f.platform.approvals.expire(Date.now() + SOCIO_ACCESS_APPROVAL_TTL_MS + 1);
    expect(await f.consume(expired, { to: 'b' })).toBe(false);
    // Approved but unused, and one still waiting: the grant ends.
    const approved = idOf(await f.request({ to: 'c' }));
    await f.approve(approved);
    const waiting = idOf(await f.request({ to: 'd' }));
    await f.platform.actors.revoke({ grantId: f.act.id }, 'alice', 'person_revoked');
    expect(await f.consume(approved, { to: 'c' })).toBe(false);
    await vi.waitFor(async () => expect((await f.platform.approvals.get(waiting, 'alice')).status).toBe('expired'));
});

it('shows the parameters themselves, inert, before the app’s words', async () => {
    const f = await fixture();
    const params = {
        recipients: Array.from({ length: 142 }, (_, i) => `+1555000${i}`),
        body: `Pay ${RLO}0001$${ZWSP}`,
    };
    const id = idOf(
        await f.request(params, {
            display: { Summary: `Send a reminder to Dana${RLO}`, Count: 1 },
        }),
    );
    const view = await f.platform.approvals.get(id, 'alice');
    const card = view.card as AppActionCard;
    expect(card).toMatchObject({
        kind: 'app_action',
        action: 'sms.send',
        tier: 'consequential',
        app: { label: 'CRM Dashboard', owner: 'Alice' },
    });
    // Platform-computed counts head the parameters.
    expect(card.params.counts[0]).toEqual({ path: 'recipients', count: 142 });
    // Canonical: keys sorted, so `body` first, its hidden character escaped.
    expect(card.params.preview.startsWith('{"body":"Pay [U+202E]0001$[U+200B]"')).toBe(true);
    expect(card.params.bytes).toBe(Buffer.byteLength(canonicalJson(params)));
    expect(card.params.preview).not.toContain(RLO);
    expect(card.display).toEqual([
        { label: 'Summary', value: 'Send a reminder to Dana[U+202E]' },
        { label: 'Count', value: '1' },
    ]);
    expect(JSON.stringify(view)).not.toContain(RLO);
});

it('keeps Allow off past 2 KB until the person opens the full parameters, on every surface', async () => {
    const f = await fixture();
    const small = idOf(await f.request({ to: 'dana' }));
    expect((await f.platform.approvals.get(small, 'alice')).review).toEqual({
        mustOpen: false,
        opened: false,
    });
    const params = { body: `${'y'.repeat(ACTION_PARAMS.inlineBytes)}${RLO}end` };
    const id = idOf(await f.request(params));
    const view = await f.platform.approvals.get(id, 'alice');
    expect(view.review).toEqual({ mustOpen: true, opened: false });
    const card = view.card as AppActionCard;
    expect(card.params.complete).toBe(false);
    expect(Buffer.byteLength(card.params.preview)).toBeLessThanOrEqual(ACTION_PARAMS.inlineBytes);
    // The chat card, the bar and Telegram's button all decide through here.
    await expect(f.approve(id)).rejects.toThrow(/Open the full details/);
    // Someone else can't open it for them.
    await expect(f.platform.approvals.open(id, 'bob')).rejects.toThrow(/not found/);
    const { full } = await f.platform.approvals.open(id, 'alice');
    expect(full).toContain('[U+202E]end');
    expect(full).not.toContain(RLO);
    expect((await f.platform.approvals.get(id, 'alice')).review).toEqual({
        mustOpen: true,
        opened: true,
    });
    expect((await f.approve(id)).status).toBe('approved');
    expect(await f.consume(id, params)).toBe(true);
    // Denying never needs the details opened.
    const other = idOf(await f.request({ body: 'z'.repeat(ACTION_PARAMS.inlineBytes + 1) }));
    expect((await f.platform.approvals.decide(other, 'alice', false)).status).toBe('denied');
});

it('audits request, decision and use with the digest, never the parameters', async () => {
    const f = await fixture();
    const params = { to: 'dana', body: 'TOP-SECRET-BODY' };
    const id = idOf(await f.request(params));
    await f.approve(id);
    expect(await f.consume(id, params)).toBe(true);
    expect(await f.consume(id, params)).toBe(false);
    await vi.waitFor(() => {
        const rows = f.platform.actors.audit.list({ grantId: f.act.id });
        const digest = intentDigest('crm', 'sms.send', params);
        expect(
            rows
                .filter((row) => row.phase === 'approval')
                .map((row) => [row.status ?? row.reason, row.digest ?? null])
                .reverse(),
        ).toEqual([
            ['requested', digest],
            ['approved', digest],
            ['consumed', digest],
            ['approval_unusable', null],
        ]);
        expect(JSON.stringify(rows)).not.toContain('TOP-SECRET-BODY');
    });
});
