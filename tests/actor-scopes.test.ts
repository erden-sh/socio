import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
    appEnvelopeKey,
    contextKey,
    egressCredentialKey,
    gatewayStampKey,
    signContextProof,
    signEgressCredential,
    signGatewayStamp,
    verifyContextProof,
    verifyEgressCredential,
    verifyGatewayStamp,
} from '@socio/foundation/actors/keys';
import { intentDigest, opaqueActorIds } from '@socio/foundation/actors/principal';
import { hasSocioToken, redactSocioTokens, redactUrlUserinfo } from '@socio/foundation/actors/redact';
import {
    ACTOR_DENY_REASONS,
    ACTOR_REVOKE_REASONS,
    ACTOR_SCOPES,
    APP_ACCESS_SCOPES,
    DATA_OPERATION_TIERS,
    SCOPE_WORDS,
    closeScopes,
    parseAudience,
    scopeFitsAudience,
    scopesCoverTier,
    tierScope,
} from '@socio/shared/actor-scopes';
import { canonicalJson } from '@socio/shared/jcs';

// CB-232 (scope vocabulary, intent digest, opaque ids, context proof) and
// CB-239 (stamps, egress credentials).

describe('scope vocabulary', () => {
    it('closes act ⇒ write ⇒ read and drops unknown scopes', () => {
        expect(closeScopes(['app:act'])).toEqual(['app:read', 'app:write', 'app:act']);
        expect(closeScopes(['app:write'])).toEqual(['app:read', 'app:write']);
        expect(closeScopes(['app:read', 'app:admin', 'issues:write'])).toEqual(['app:read']);
        expect(closeScopes(['git:push', 'model:invoke'])).toEqual(['model:invoke', 'git:push']);
        for (const level of ['read', 'write', 'act'] as const) {
            expect(closeScopes(APP_ACCESS_SCOPES[level])).toEqual(
                [...APP_ACCESS_SCOPES[level]].sort((a, b) => ACTOR_SCOPES.indexOf(a) - ACTOR_SCOPES.indexOf(b)),
            );
        }
    });

    it('maps tiers to scopes, never admin', () => {
        expect(tierScope('read')).toBe('app:read');
        expect(tierScope('write')).toBe('app:write');
        expect(tierScope('consequential')).toBe('app:act');
        expect(tierScope('admin')).toBeNull();
        const matrix = (['read', 'write', 'act'] as const).map((level) =>
            (['read', 'write', 'consequential', 'admin'] as const).map((tier) =>
                scopesCoverTier(APP_ACCESS_SCOPES[level], tier),
            ),
        );
        expect(matrix).toEqual([
            [true, false, false, false],
            [true, true, false, false],
            [true, true, true, false],
        ]);
        // The data API's fixed tiers: destructive operations are consequential.
        expect(DATA_OPERATION_TIERS.deleteRows).toBe('consequential');
        expect(DATA_OPERATION_TIERS.query).toBe('read');
        expect(DATA_OPERATION_TIERS.insert).toBe('write');
    });

    it('parses audiences and fits scopes to them', () => {
        expect(parseAudience('app:crm')).toEqual({ kind: 'app', id: 'crm' });
        expect(parseAudience('plugin:social')).toEqual({
            kind: 'plugin',
            id: 'social',
        });
        expect(parseAudience('gateway:model')).toEqual({
            kind: 'gateway',
            id: 'model',
        });
        for (const bad of ['gateway:shell', 'app:', 'app:a b', 'crm', ':x', 'app:../x']) {
            expect(parseAudience(bad)).toBeUndefined();
        }
        expect(scopeFitsAudience('app:read', 'app:crm')).toBe(true);
        expect(scopeFitsAudience('app:read', 'plugin:x')).toBe(true);
        expect(scopeFitsAudience('app:read', 'gateway:git')).toBe(false);
        expect(scopeFitsAudience('git:push', 'gateway:git')).toBe(true);
        expect(scopeFitsAudience('git:push', 'gateway:model')).toBe(false);
        expect(scopeFitsAudience('git:extract', 'gateway:git')).toBe(true);
        expect(scopeFitsAudience('model:invoke', 'gateway:model')).toBe(true);
    });

    it('describes every scope and keeps reasons codes', () => {
        for (const scope of ACTOR_SCOPES) {
            expect(SCOPE_WORDS[scope]).toBeTruthy();
        }
        for (const code of [...ACTOR_DENY_REASONS, ...ACTOR_REVOKE_REASONS]) {
            expect(code).toMatch(/^[a-z0-9_]{1,64}$/);
        }
    });
});

describe('JCS and the intent digest', () => {
    it('canonicalises per RFC 8785', () => {
        // RFC 8785 §3.2.3's sorting example and number forms.
        expect(
            canonicalJson({
                '\u20ac': 'Euro Sign',
                '\r': 'Carriage Return',
                '\ufb33': 'Hebrew Letter Dalet With Dagesh',
                '1': 'One',
                '\ud83d\ude00': 'Emoji: Grinning Face',
                '\u0080': 'Control',
                '\u00f6': 'Latin Small Letter O With Diaeresis',
            }),
        ).toBe(
            '{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis","\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}',
        );
        expect(
            canonicalJson({
                numbers: [333333333.3333333, 1e30, 4.5, 2e-3, 0.000001, -0, 1e21],
                literals: [null, true, false],
            }),
        ).toBe('{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,0.000001,0,1e+21]}');
        for (const bad of [undefined, NaN, Infinity, () => 1, 1n, new Date(0)]) {
            expect(() => canonicalJson({ x: bad })).toThrow(TypeError);
        }
        const cycle: Record<string, unknown> = {};
        cycle.self = cycle;
        expect(() => canonicalJson(cycle)).toThrow(TypeError);
    });

    it('gives one digest whatever the key order, and a new one for any change', () => {
        const a = intentDigest('crm', 'sms.send', {
            to: ['dana', 'lee'],
            body: 'Ciao ☕',
            opts: { a: 1, b: 2 },
        });
        const b = intentDigest('crm', 'sms.send', {
            opts: { b: 2, a: 1 },
            body: 'Ciao ☕',
            to: ['dana', 'lee'],
        });
        expect(a).toBe(b);
        expect(a).toMatch(/^[0-9a-f]{64}$/);
        expect(
            intentDigest('crm', 'sms.send', {
                to: ['dana', 'lee', 'all'],
                body: 'Ciao ☕',
                opts: { a: 1, b: 2 },
            }),
        ).not.toBe(a);
        expect(intentDigest('other', 'sms.send', {})).not.toBe(intentDigest('crm', 'sms.send', {}));
        // Composed and decomposed Unicode are different intents.
        expect(intentDigest('crm', 'x', { n: 'é' })).not.toBe(intentDigest('crm', 'x', { n: 'é' }));
    });
});

it('gives opaque ids per app, sub matching the apps proxy’s person id', () => {
    const ids = opaqueActorIds('s3cret', 'crm', {
        personId: 'alice',
        socioId: 'rulo',
        grantId: 'g-1',
    });
    // AppsService.personId's formula (x-cb-user).
    const expected = createHmac('sha256', 's3cret')
        .update('company-brain-app-user\u0000crm\u0000alice')
        .digest('base64url')
        .slice(0, 22);
    expect(ids.sub).toBe(expected);
    const other = opaqueActorIds('s3cret', 'other', {
        personId: 'alice',
        socioId: 'rulo',
        grantId: 'g-1',
    });
    expect(other.sub).not.toBe(ids.sub);
    expect(other.socio).not.toBe(ids.socio);
    expect(other.grant).not.toBe(ids.grant);
    expect(JSON.stringify(ids)).not.toMatch(/alice|rulo|g-1/);
});

describe('keys and MAC codecs', () => {
    const request = {
        method: 'POST',
        host: 'ghl1.apps.example',
        requestTarget: '/api/deals?id=1',
        bodyDigest: 'ab'.repeat(32),
    };

    it('binds a context proof to the context, request and time', () => {
        const key = contextKey('s', 'ctx-1');
        const proof = signContextProof(key, request, 5_000);
        expect(verifyContextProof(key, proof, request, 5_000)).toBe(true);
        expect(verifyContextProof(key, proof, request, 35_000)).toBe(true);
        expect(verifyContextProof(key, proof, request, 35_001)).toBe(false);
        expect(verifyContextProof(contextKey('s', 'ctx-2'), proof, request, 5_000)).toBe(false);
        expect(verifyContextProof(contextKey('t', 'ctx-1'), proof, request, 5_000)).toBe(false);
        for (const changed of [
            { ...request, method: 'GET' },
            { ...request, host: 'other.apps.example' },
            { ...request, requestTarget: '/api/deals?id=2' },
            { ...request, requestTarget: '/api/deals?id=%31' },
            { ...request, bodyDigest: 'cd'.repeat(32) },
        ]) {
            expect(verifyContextProof(key, proof, changed, 5_000)).toBe(false);
        }
        expect(verifyContextProof(key, undefined, request, 5_000)).toBe(false);
        expect(verifyContextProof(key, 'garbage', request, 5_000)).toBe(false);
    });

    it('stamps gateway requests for one sandbox, method and path', () => {
        const key = gatewayStampKey('egress-secret');
        const stamp = signGatewayStamp(key, 'sbx_1', 'POST', '/v1/chat/completions', 1_000);
        expect(verifyGatewayStamp(key, stamp, 'POST', '/v1/chat/completions', 1_000)).toBe('sbx_1');
        expect(verifyGatewayStamp(key, stamp, 'GET', '/v1/chat/completions', 1_000)).toBeUndefined();
        expect(verifyGatewayStamp(key, stamp, 'POST', '/v1/models', 1_000)).toBeUndefined();
        expect(verifyGatewayStamp(key, stamp, 'POST', '/v1/chat/completions', 40_000)).toBeUndefined();
        expect(
            verifyGatewayStamp(gatewayStampKey('other'), stamp, 'POST', '/v1/chat/completions', 1_000),
        ).toBeUndefined();
        const forged = stamp.replace('sbx_1', 'sbx_2');
        expect(verifyGatewayStamp(key, forged, 'POST', '/v1/chat/completions', 1_000)).toBeUndefined();
        expect(() => signGatewayStamp(key, 'a.b', 'GET', '/')).toThrow();
        // The stamp key and the egress credential key differ.
        expect(gatewayStampKey('x').equals(egressCredentialKey('x'))).toBe(false);
    });

    it('signs egress credentials that expire and can’t be edited', () => {
        const key = egressCredentialKey('egress-secret');
        const claims = {
            sandboxId: 'sbx_1',
            allow: ['npm.registry.socio.internal'],
            subnet: '172.30.4.0/28',
            expiresAt: 10_000,
        };
        const { user, password } = signEgressCredential(key, claims);
        expect(verifyEgressCredential(key, user, password, 9_999)).toEqual(claims);
        expect(verifyEgressCredential(key, user, password, 10_000)).toBeUndefined();
        const widened = Buffer.from(JSON.stringify({ s: 'sbx_1', a: ['*'], n: '0.0.0.0/0', e: 10_000 })).toString(
            'base64url',
        );
        expect(verifyEgressCredential(key, widened, password, 1)).toBeUndefined();
        expect(verifyEgressCredential(egressCredentialKey('x'), user, password, 1)).toBeUndefined();
    });

    it('derives a new envelope key per app and epoch', () => {
        const one = appEnvelopeKey('apps', 'crm', 1);
        expect(one.equals(appEnvelopeKey('apps', 'crm', 1))).toBe(true);
        expect(one.equals(appEnvelopeKey('apps', 'crm', 2))).toBe(false);
        expect(one.equals(appEnvelopeKey('apps', 'other', 1))).toBe(false);
    });
});

it('redacts a URL’s user:password, such as a sandbox’s proxy credential', () => {
    expect(redactUrlUserinfo('HTTP_PROXY=http://eyJzIjoxfQ:secretpw@10.213.0.2:3128 and HTTPS://u:p@x.example/a')).toBe(
        'HTTP_PROXY=http://[redacted]@10.213.0.2:3128 and HTTPS://[redacted]@x.example/a',
    );
    // A user without a password, and ordinary text, stay.
    expect(redactUrlUserinfo('ssh://git@github.com/a.git, a:b@c')).toBe('ssh://git@github.com/a.git, a:b@c');
});

it('redacts every Socio token by shape, live or not', () => {
    const tokens = [
        `cbsa_${'A'.repeat(43)}`,
        `cbgw_${'b'.repeat(43)}`,
        `cbob_v1.${'c'.repeat(80)}`,
        `cbob_${'d'.repeat(43)}`,
        `cbdt_${'e'.repeat(43)}`,
        `cbk_${'f'.repeat(30)}`,
    ];
    const text = `header ${tokens.join(' and ')} end`;
    const out = redactSocioTokens(text);
    for (const token of tokens) {
        expect(out).not.toContain(token);
    }
    expect(out).toBe(`header ${tokens.map(() => '[redacted]').join(' and ')} end`);
    expect(hasSocioToken(text)).toBe(true);
    // Prose about tokens stays.
    expect(redactSocioTokens('a cbsa_ token is 15 minutes')).toBe('a cbsa_ token is 15 minutes');
    expect(hasSocioToken('a cbsa_ token')).toBe(false);
    const envelope = `x-cb-actor: v1.${'e'.repeat(60)}.${'f'.repeat(43)}`;
    expect(redactSocioTokens(envelope)).toBe(envelope);
    expect(redactSocioTokens(envelope, { envelopes: true })).toBe('x-cb-actor: [redacted]');
});
