import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
    APP_VARIANTS,
    appLink,
    CODE_ALPHABET,
    codeRedeemBodySchema,
    codeRequestBodySchema,
    confirmationDigitsSchema,
    DEVICE_ERROR_CODES,
    deviceErrorSchema,
    deviceRedeemBodySchema,
    deviceStartQuerySchema,
    devicePushBodySchema,
    formatCode,
    formatDigits,
    installIdSchema,
    LINK_STAGING_HOST,
    normalizeCode,
    normalizeDigits,
    pairClaimBodySchema,
    pairConfirmBodySchema,
    parseAppLink,
    pkceChallengeSchema,
    pkceVerifierSchema,
    SHEET_CODE_LENGTH,
    SIGN_IN_CODE_LENGTH,
    signInCodeSchema,
    workspaceManifestSchema,
} from '@socio/shared/device-sign-in';

const b64 = (bytes: Buffer) => bytes.toString('base64url');
const verifier = b64(randomBytes(32));
const challenge = b64(createHash('sha256').update(verifier).digest());
const installId = b64(randomBytes(32));

describe('the code alphabet', () => {
    it('has 30 symbols, none alike: no 0 O 1 I L U', () => {
        expect(CODE_ALPHABET).toHaveLength(30);
        expect(new Set(CODE_ALPHABET).size).toBe(30);
        for (const symbol of '0O1ILU') {
            expect(CODE_ALPHABET).not.toContain(symbol);
        }
        expect(CODE_ALPHABET).toBe(CODE_ALPHABET.toUpperCase());
    });

    it('reads codes case-blind, with or without dashes and spaces', () => {
        expect(normalizeCode('abcd-efgh', SIGN_IN_CODE_LENGTH)).toBe('ABCDEFGH');
        expect(normalizeCode(' AbCd EfGh ', SIGN_IN_CODE_LENGTH)).toBe('ABCDEFGH');
        expect(normalizeCode('ABCD-EFGH-JKMN', SHEET_CODE_LENGTH)).toBe('ABCDEFGHJKMN');
    });

    it('refuses the wrong length and look-alike symbols', () => {
        expect(normalizeCode('ABCDEFG', SIGN_IN_CODE_LENGTH)).toBeNull();
        expect(normalizeCode('ABCDEFGHJ', SIGN_IN_CODE_LENGTH)).toBeNull();
        for (const symbol of '0O1ILU') {
            expect(normalizeCode(`ABCDEFG${symbol}`, SIGN_IN_CODE_LENGTH)).toBeNull();
        }
        expect(normalizeCode('ABCD_EFGH', SIGN_IN_CODE_LENGTH)).toBeNull();
        expect(signInCodeSchema.safeParse('ABCD-EFGO').success).toBe(false);
        expect(signInCodeSchema.parse('abcd-efgh')).toBe('ABCDEFGH');
    });

    it('shows codes in groups of four, and digits as two groups of three', () => {
        expect(formatCode('ABCDEFGH')).toBe('ABCD-EFGH');
        expect(formatCode('ABCDEFGHJKMN')).toBe('ABCD-EFGH-JKMN');
        expect(formatDigits('482913')).toBe('482 913');
    });

    it('takes six digits, spaced or not, from 000000 to 999999', () => {
        expect(normalizeDigits('482 913')).toBe('482913');
        expect(normalizeDigits('000000')).toBe('000000');
        expect(normalizeDigits('999999')).toBe('999999');
        for (const bad of ['48291', '4829134', '48291a', '-48291', '４８２９１３']) {
            expect(normalizeDigits(bad)).toBeNull();
        }
        expect(confirmationDigitsSchema.parse(' 482 913 ')).toBe('482913');
        expect(pairConfirmBodySchema.safeParse({ digits: '12345' }).success).toBe(false);
    });
});

describe('PKCE and install ids', () => {
    it('takes base64url verifiers of 43 to 128 characters, and S256 challenges', () => {
        expect(pkceVerifierSchema.safeParse(verifier).success).toBe(true);
        expect(pkceVerifierSchema.safeParse('a'.repeat(128)).success).toBe(true);
        expect(pkceVerifierSchema.safeParse('a'.repeat(42)).success).toBe(false);
        expect(pkceVerifierSchema.safeParse('a'.repeat(129)).success).toBe(false);
        // RFC 7636 allows . and ~; the app makes base64url only.
        expect(pkceVerifierSchema.safeParse(`${'a'.repeat(42)}~`).success).toBe(false);
        expect(pkceChallengeSchema.safeParse(challenge).success).toBe(true);
        // Padding, or a plain challenge (the verifier itself, too long), is no S256 challenge.
        expect(pkceChallengeSchema.safeParse(`${challenge}=`).success).toBe(false);
        expect(pkceChallengeSchema.safeParse(b64(randomBytes(48))).success).toBe(false);
    });

    it('takes 32 random bytes in base64url as an install id, nothing else', () => {
        expect(installIdSchema.safeParse(installId).success).toBe(true);
        // Standard base64 pads 32 bytes to 44 characters.
        expect(installIdSchema.safeParse(randomBytes(32).toString('base64')).success).toBe(false);
        expect(installIdSchema.safeParse(b64(randomBytes(31))).success).toBe(false);
        expect(installIdSchema.safeParse(b64(randomBytes(33))).success).toBe(false);
    });
});

describe('the request schemas', () => {
    it('take the sheet’s start and redeem, and refuse unknown keys', () => {
        expect(
            deviceStartQuerySchema.safeParse({
                challenge,
                state: b64(randomBytes(16)),
                platform: 'ios',
                variant: 'production',
            }).success,
        ).toBe(true);
        expect(
            deviceStartQuerySchema.safeParse({
                challenge,
                state: b64(randomBytes(16)),
                platform: 'windows',
                variant: 'production',
            }).success,
        ).toBe(false);
        const redeem = {
            code: 'abcd-efgh-jkmn',
            verifier,
            installId,
            label: ' Pixel 4 ',
            variant: 'preview',
        };
        expect(deviceRedeemBodySchema.parse(redeem)).toEqual({ ...redeem, code: 'ABCDEFGHJKMN', label: 'Pixel 4' });
        expect(deviceRedeemBodySchema.safeParse({ ...redeem, challengeMethod: 'plain' }).success).toBe(false);
        expect(deviceRedeemBodySchema.safeParse({ ...redeem, variant: 'beta' }).success).toBe(false);
        expect(deviceRedeemBodySchema.safeParse({ ...redeem, label: '' }).success).toBe(false);
    });

    it('take Add a device’s claim and sign-in codes', () => {
        expect(
            pairClaimBodySchema.safeParse({
                code: 'ABCDEFGHJKMN',
                challenge,
                label: 'iPhone',
                platform: 'ios',
                variant: 'production',
            }).success,
        ).toBe(true);
        expect(
            codeRequestBodySchema.parse({
                email: ' Ana@Example.COM ',
                challenge,
                platform: 'android',
                variant: 'production',
            }).email,
        ).toBe('ana@example.com');
        expect(
            codeRequestBodySchema.safeParse({
                email: 'not an email',
                challenge,
                platform: 'android',
                variant: 'production',
            }).success,
        ).toBe(false);
        expect(
            codeRedeemBodySchema.safeParse({
                requestId: b64(randomBytes(16)),
                code: 'ABCD-EFGH-J',
                verifier,
                installId,
                label: 'Pixel',
                variant: 'production',
            }).success,
        ).toBe(false);
    });

    it('takes only an https push endpoint', () => {
        expect(devicePushBodySchema.safeParse({ endpoint: 'https://relay.example/p/1' }).success).toBe(true);
        expect(devicePushBodySchema.safeParse({ endpoint: 'http://relay.example/p/1' }).success).toBe(false);
    });

    it('reads every refusal code the app words, and no other', () => {
        for (const code of DEVICE_ERROR_CODES) {
            expect(deviceErrorSchema.safeParse({ error: 'x', code }).success).toBe(true);
        }
        expect(deviceErrorSchema.safeParse({ error: 'x', code: 'sign_in' }).success).toBe(false);
    });

    it('reads a manifest', () => {
        const manifest = {
            id: 'w_123',
            origin: 'https://acme.example.com',
            name: 'Acme',
            branding: { name: 'Acme', logo: '/favicon.svg' },
            methods: { password: true, passkey: true, sheet: true, signInCodes: 'telegram', addDevice: true },
            serverVersion: '0.40.0',
            protocol: 1,
            policy: { leaseDays: 30, wipeDays: 30, appLock: false, notificationText: true },
        };
        expect(workspaceManifestSchema.safeParse(manifest).success).toBe(true);
        expect(
            workspaceManifestSchema.safeParse({ ...manifest, methods: { ...manifest.methods, signInCodes: 'sms' } })
                .success,
        ).toBe(false);
    });
});

describe('links on the link domain', () => {
    const host = 'acme.example.com';

    it('carry codes and tokens in the fragment only, under each build’s own path', () => {
        expect(
            appLink({ kind: 'cb', variant: 'production', host, fields: { code: 'ABCDEFGHJKMN', state: 'st' } }),
        ).toBe('https://link.socio.sh/app/cb#code=ABCDEFGHJKMN&state=st&ws=acme.example.com');
        expect(appLink({ kind: 'c', variant: 'preview', host, fields: { code: 'ABCDEFGH' } })).toBe(
            'https://link.socio.sh/preview/c#code=ABCDEFGH&ws=acme.example.com',
        );
        expect(appLink({ kind: 'd', variant: 'production', host, fields: { c: 'ABCDEFGHJKMN' } })).toBe(
            'https://link.socio.sh/app/d/acme.example.com#c=ABCDEFGHJKMN',
        );
        expect(appLink({ kind: 'i', variant: 'development', host, fields: { t: 'tok/en+=' } }, LINK_STAGING_HOST)).toBe(
            'https://link-staging.socio.sh/dev/i/acme.example.com#t=tok%2Fen%2B%3D',
        );
        expect(appLink({ kind: 'w', variant: 'production', host, fields: {} })).toBe(
            'https://link.socio.sh/app/w/acme.example.com',
        );
        for (const variant of APP_VARIANTS) {
            const link = appLink({ kind: 'd', variant, host, fields: { c: 'SECRET' } });
            expect(new URL(link).search).toBe('');
            expect(new URL(link).pathname).not.toContain('SECRET');
        }
    });

    it('read back what they wrote, and keep a port', () => {
        const links = [
            { kind: 'cb', variant: 'production', host, fields: { code: 'ABCDEFGHJKMN', state: 'st' } },
            { kind: 'c', variant: 'preview', host: 'brain.local:8443', fields: { code: 'ABCDEFGH' } },
            { kind: 'd', variant: 'development', host, fields: { c: 'ABCDEFGHJKMN' } },
            { kind: 'i', variant: 'production', host, fields: { t: 'a&b=c' } },
            { kind: 'w', variant: 'production', host, fields: {} },
        ] as const;
        for (const link of links) {
            expect(parseAppLink(appLink(link))).toEqual(link);
        }
    });

    it('refuse what isn’t one', () => {
        for (const href of [
            'http://link.socio.sh/app/w/acme.example.com',
            'https://evil.example/app/w/acme.example.com',
            'https://link.socio.sh.evil.example/app/w/acme.example.com',
            'https://link.socio.sh/beta/w/acme.example.com',
            'https://link.socio.sh/app/x/acme.example.com',
            'https://link.socio.sh/app/w/acme.example.com?x=1',
            'https://link.socio.sh/app/w/acme.example.com/more',
            'https://link.socio.sh/app/w/ACME.example.com',
            'https://link.socio.sh/app/w/user@acme.example.com',
            'https://link.socio.sh/app/d/acme.example.com',
            'https://link.socio.sh/app/d/acme.example.com#c=A&c=B',
            'https://link.socio.sh/app/d/acme.example.com#c=A&x=B',
            'https://link.socio.sh/app/cb#code=A&state=B',
            'https://link.socio.sh/app/c#code=%E0%A4%A&ws=acme.example.com',
            'https://link.socio.sh/app/c/acme.example.com#code=A',
        ]) {
            expect(parseAppLink(href), href).toBeNull();
        }
        expect(() =>
            appLink({ kind: 'w', variant: 'production', host: 'acme.example.com/evil', fields: {} }),
        ).toThrow();
    });
});

// The app bundles this file: the socio/hermes lint rule covers packages/shared/src,
// and nothing here may reach Node's or the browser's own APIs.
describe('what the app can bundle', () => {
    it('imports only zod', () => {
        const source = readFileSync(new URL('../packages/shared/src/device-sign-in.ts', import.meta.url), 'utf8');
        const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1]);
        expect(imports).toEqual(['zod']);
        expect(source).not.toMatch(/\bcrypto\b\.|URLSearchParams|structuredClone|toSorted/);
    });
});
