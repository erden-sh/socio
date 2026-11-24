import { afterEach, describe, expect, it } from 'vitest';

import type { ActionTier, ActorDenyReason } from '@socio/shared/actor-scopes';

import { AUTHORIZE_CACHE_MS, grantFeatures } from '../src/server/actors/authorize.js';

import { fixture, grantInput, world } from './support/actor-fixture.js';

// CB-232: authorizeActor, the intersection of what the person may do,
// what the socio may do, what the audience entitles, the grant's scopes,
// the resource's rule and where the conversation's output goes.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});
const setup = () => {
    const f = fixture();
    cleanup.push(() => f.close());
    return f;
};

/** Each term of the intersection, with how to make it false. */
const TERMS: {
    name: string;
    reason: ActorDenyReason;
    breakIt: (f: ReturnType<typeof setup>) => void;
}[] = [
    {
        name: 'feature on',
        reason: 'feature_off',
        breakIt: (f) => f.w.flagsOff.add('socio-actor-access'),
    },
    {
        name: 'person active',
        reason: 'person_inactive',
        breakIt: (f) => f.w.inactive.add('alice'),
    },
    {
        name: 'socio usable',
        reason: 'socio_unavailable',
        breakIt: (f) => f.w.socioBlocked.add('alice|rulo'),
    },
    {
        name: 'conversation live',
        reason: 'conversation_gone',
        breakIt: (f) => f.w.conversations.delete('chat-1'),
    },
    {
        name: 'audience delegable',
        reason: 'audience_unavailable',
        breakIt: (f) => f.w.versions.delete('app:crm'),
    },
    {
        name: 'policy version current',
        reason: 'policy_stale',
        // A new app version changed its action set (unless it is gone).
        breakIt: (f) => {
            if (f.w.versions.has('app:crm')) {
                f.w.versions.set('app:crm', 'v2');
            }
        },
    },
    {
        name: 'person may open the app',
        reason: 'person_no_access',
        breakIt: (f) => f.w.noAccess.add('alice|app:crm'),
    },
    {
        name: 'resource allowed',
        reason: 'resource_denied',
        breakIt: (f) => f.w.deniedResources.add('dataset:sales'),
    },
];

describe('the intersection', () => {
    it('allows only when every term holds, for every combination', async () => {
        const f = setup();
        const reset = () => Object.assign(f.w, { ...world(), now: f.w.now });
        // 2^8 combinations, each on a fresh grant with a fresh decision.
        for (let mask = 0; mask < 1 << TERMS.length; mask++) {
            reset();
            const grant = await f.a.access.grants.create(grantInput());
            TERMS.forEach((term, i) => {
                if (mask & (1 << i)) {
                    term.breakIt(f);
                }
            });
            const decision = await f.a.access.authorizer.authorize(
                grant.id,
                {
                    audience: 'app:crm',
                    action: 'dashboard.view',
                    resource: { kind: 'dataset', id: 'sales' },
                },
                { fresh: true },
            );
            if (mask === 0) {
                expect(decision).toEqual({ allowed: true, tier: 'read' });
            } else {
                // The first broken term, in the documented order, is the reason.
                const first = TERMS.findIndex((_, i) => mask & (1 << i));
                expect(decision).toEqual({
                    allowed: false,
                    reason: TERMS[first]!.reason,
                });
            }
        }
    }, 60_000);

    it('matches each scope level against each action tier', async () => {
        const f = setup();
        const levels = {
            read: ['app:read'],
            write: ['app:write'],
            act: ['app:act'],
        } as const;
        const actions: Record<ActionTier, string> = {
            read: 'dashboard.view',
            write: 'deal.update',
            consequential: 'sms.send',
            admin: 'settings.update',
        };
        const results: Record<string, Record<string, string>> = {};
        let n = 0;
        for (const [level, scopes] of Object.entries(levels)) {
            const grant = await f.a.access.grants.create(
                grantInput({ scopes: [...scopes], conversationId: `chat-${++n}` }),
            );
            f.w.conversations.set(`chat-${n}`, 'private');
            results[level] = {};
            for (const [tier, action] of Object.entries(actions)) {
                const decision = await f.a.access.authorizer.authorize(grant.id, {
                    audience: 'app:crm',
                    action,
                });
                results[level][tier] = decision.allowed ? 'allow' : decision.reason;
            }
        }
        expect(results).toEqual({
            read: {
                read: 'allow',
                write: 'scope_insufficient',
                consequential: 'scope_insufficient',
                admin: 'admin_tier',
            },
            write: {
                read: 'allow',
                write: 'allow',
                consequential: 'scope_insufficient',
                admin: 'admin_tier',
            },
            act: {
                read: 'allow',
                write: 'allow',
                consequential: 'allow',
                admin: 'admin_tier',
            },
        });
    });

    it('decides by declared tier, never by HTTP method or a missing declaration', async () => {
        const f = setup();
        const grant = await f.a.access.grants.create(grantInput());
        const authorize = (request: Parameters<typeof f.a.access.authorizer.authorize>[1]) =>
            f.a.access.authorizer.authorize(grant.id, request);
        expect(await authorize({ audience: 'app:crm', action: 'not.declared' })).toEqual({
            allowed: false,
            reason: 'action_undeclared',
        });
        expect(await authorize({ audience: 'app:crm' })).toEqual({
            allowed: false,
            reason: 'action_undeclared',
        });
        // The data API passes its fixed tiers: a read-only grant can't insert.
        expect(await authorize({ audience: 'app:crm', action: 'insert', tier: 'write' })).toEqual({
            allowed: false,
            reason: 'scope_insufficient',
        });
        expect(await authorize({ audience: 'app:crm', action: 'query', tier: 'read' })).toEqual({
            allowed: true,
            tier: 'read',
        });
        // Another app: not this grant's audience.
        expect(await authorize({ audience: 'app:other', action: 'dashboard.view' })).toEqual({
            allowed: false,
            reason: 'audience_mismatch',
        });
    });

    it('checks gateway scopes and the flags each grant needs', async () => {
        const f = setup();
        const grant = await f.a.access.grants.create(
            grantInput({
                audiences: ['gateway:model', 'gateway:git'],
                scopes: ['model:invoke', 'git:read'],
                policyVersion: '',
            }),
        );
        const authorize = (scope: 'model:invoke' | 'git:read' | 'git:push') =>
            f.a.access.authorizer.authorize(
                grant.id,
                {
                    audience: scope === 'model:invoke' ? 'gateway:model' : 'gateway:git',
                    scope,
                },
                { fresh: true },
            );
        expect(await authorize('model:invoke')).toEqual({ allowed: true });
        expect(await authorize('git:read')).toEqual({ allowed: true });
        expect(await authorize('git:push')).toEqual({
            allowed: false,
            reason: 'scope_insufficient',
        });
        // A coding grant needs coding-sessions as well as socio-actor-access.
        expect(grantFeatures(grant)).toEqual(['socio-actor-access', 'coding-sessions']);
        f.w.flagsOff.add('coding-sessions');
        expect(await authorize('model:invoke')).toEqual({
            allowed: false,
            reason: 'feature_off',
        });
        // An extraction grant needs repo-extraction (CB-267).
        expect(grantFeatures({ audiences: ['gateway:git'], scopes: ['git:extract'] })).toEqual([
            'socio-actor-access',
            'repo-extraction',
        ]);
        expect(grantFeatures({ audiences: ['app:crm'], scopes: ['app:act'] })).toEqual(['socio-actor-access']);
    });
});

describe('the grant and its conversation', () => {
    it('refuses revoked, expired and idle grants', async () => {
        const f = setup();
        const { access } = f.a;
        const grant = await access.grants.create(grantInput({ minutes: 120 }));
        const whole = () => access.authorizer.authorizeGrant(grant.id, { fresh: true });
        expect(await whole()).toEqual({ allowed: true });
        // Idle: 30 minutes without use.
        f.advance(30 * 60_000);
        expect(await whole()).toEqual({ allowed: false, reason: 'grant_idle' });
        const used = await access.grants.create(grantInput({ minutes: 60, conversationId: 'chat-2' }));
        f.advance(20 * 60_000);
        access.grants.touch(used.id);
        f.advance(20 * 60_000);
        expect(await access.authorizer.authorizeGrant(used.id, { fresh: true })).toEqual({ allowed: true });
        f.advance(20 * 60_000);
        expect(await access.authorizer.authorizeGrant(used.id, { fresh: true })).toEqual({
            allowed: false,
            reason: 'grant_expired',
        });
        expect(await access.authorizer.authorizeGrant('nope')).toEqual({
            allowed: false,
            reason: 'grant_missing',
        });
    });

    it('refuses Telegram groups, and a chat turned into a room', async () => {
        const f = setup();
        const { access } = f.a;
        const grant = await access.grants.create(grantInput());
        const whole = () => access.authorizer.authorizeGrant(grant.id, { fresh: true });
        f.w.conversations.set('chat-1', 'telegram-group');
        expect(await whole()).toEqual({
            allowed: false,
            reason: 'conversation_shared',
        });
        f.w.conversations.set('chat-1', 'room');
        expect(await whole()).toEqual({
            allowed: false,
            reason: 'conversation_changed',
        });
        // A grant made in a room is fine while it stays one.
        const roomGrant = await access.grants.create(
            grantInput({ conversationId: 'room-1', conversationKind: 'room' }),
        );
        expect(await access.authorizer.authorizeGrant(roomGrant.id, { fresh: true })).toEqual({ allowed: true });
    });

    it('caches a decision at most 5 s, and forgets it on a local revocation', async () => {
        const f = setup();
        const { access } = f.a;
        const grant = await access.grants.create(grantInput());
        const request = { audience: 'app:crm' as const, action: 'dashboard.view' };
        expect((await access.authorizer.authorize(grant.id, request)).allowed).toBe(true);
        // A change the event path missed: cached for under 5 s, then seen.
        f.w.inactive.add('alice');
        expect((await access.authorizer.authorize(grant.id, request)).allowed).toBe(true);
        f.advance(AUTHORIZE_CACHE_MS - 1);
        expect((await access.authorizer.authorize(grant.id, request)).allowed).toBe(true);
        f.advance(1);
        expect(await access.authorizer.authorize(grant.id, request)).toEqual({
            allowed: false,
            reason: 'person_inactive',
        });
        f.w.inactive.delete('alice');
        const other = await access.grants.create(grantInput({ conversationId: 'chat-2' }));
        expect((await access.authorizer.authorize(other.id, request)).allowed).toBe(true);
        await access.revoke({ grantId: other.id }, 'alice', 'person_revoked');
        expect(await access.authorizer.authorize(other.id, request)).toEqual({
            allowed: false,
            reason: 'grant_revoked',
        });
    });

    it('reuses a grant only in its own conversation, with scopes and time to spare', async () => {
        const f = setup();
        const { access } = f.a;
        const grant = await access.grants.create(grantInput({ scopes: ['app:write'], minutes: 30 }));
        const ask = (over: Partial<Parameters<typeof access.grants.reusable>[0]> = {}) =>
            access.grants.reusable({
                personId: 'alice',
                socioId: 'rulo',
                audience: 'app:crm',
                conversationId: 'chat-1',
                scopes: ['app:read'],
                ...over,
            })?.id;
        expect(ask()).toBe(grant.id);
        expect(ask({ scopes: ['app:write'] })).toBe(grant.id);
        expect(ask({ scopes: ['app:act'] })).toBeUndefined();
        // Another conversation is a new request.
        expect(ask({ conversationId: 'chat-2' })).toBeUndefined();
        expect(ask({ personId: 'bob' })).toBeUndefined();
        expect(ask({ socioId: 'sebas' })).toBeUndefined();
        expect(ask({ audience: 'app:other' })).toBeUndefined();
        // Less than 5 minutes left: not reused.
        f.advance(25 * 60_000 + 1);
        expect(ask()).toBeUndefined();
    });

    it('replaces a narrower grant with a wider one, never widening in place', async () => {
        const f = setup();
        const { access } = f.a;
        const read = await access.grants.create(grantInput());
        const write = await access.grants.create(grantInput({ scopes: ['app:write'], replaces: read.id }));
        expect(access.grants.get(read.id)).toMatchObject({
            revokeReason: 'replaced',
            replacedBy: write.id,
            scopes: ['app:read'],
        });
        expect(access.grants.get(write.id)).toMatchObject({
            revokedAt: null,
            scopes: ['app:read', 'app:write'],
        });
        // Only the person's and socio's own grant can be replaced.
        await expect(
            access.grants.create(
                grantInput({
                    personId: 'bob',
                    scopes: ['app:act'],
                    replaces: write.id,
                }),
            ),
        ).rejects.toThrow();
        expect(access.grants.get(write.id)?.revokedAt).toBeNull();
    });

    it('refuses grants whose scopes don’t fit their audiences', async () => {
        const f = setup();
        for (const bad of [
            grantInput({ scopes: ['git:push'] }),
            grantInput({ audiences: ['gateway:git'], scopes: ['app:read'] }),
            grantInput({ audiences: [] }),
            grantInput({ minutes: 4 }),
            grantInput({ minutes: 481 }),
        ]) {
            await expect(f.a.access.grants.create(bad)).rejects.toThrow();
        }
    });
});
