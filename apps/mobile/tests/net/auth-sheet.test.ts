import { describe, expect, it, vi } from 'vitest';

import { appLink, LINK_HOST, LINK_STAGING_HOST } from '@socio/shared/device-sign-in';

import { DEV_SCHEME_CALLBACK as PLUGIN_SCHEME_CALLBACK, sheetCallback } from '../../plugins/app-links';
import {
    type AuthTabAnswer,
    type BrowserSessionAnswer,
    callbackPath,
    classifyAuthTab,
    classifyBrowserSession,
    DEV_SCHEME_CALLBACK,
    isSheetCallback,
    openSheet,
    type SheetConfig,
    sheetConfig,
    type SheetPlatform,
} from '../../src/net/auth-sheet';
import { VARIANTS, type VariantName } from '../../variant';

// The system sign-in sheet's callback and the meaning of each platform's answer.

const variants = Object.keys(VARIANTS) as VariantName[];
const hostOf = (variant: VariantName) => (variant === 'development' ? LINK_STAGING_HOST : LINK_HOST);
/** The embedded config app.config.ts gives `variant` (its extra), through the plugin's own builder. */
const embedded = (variant: VariantName, personalTeam = false) => {
    const linkHost = hostOf(variant);
    const authCallback = sheetCallback(variant, linkHost, personalTeam);
    return { extra: { variant, linkHost, ...(authCallback === null ? {} : { authCallback }) } };
};
const configOf = (variant: VariantName): SheetConfig => {
    const config = sheetConfig(embedded(variant));
    if (config === null) {
        throw new Error(`no sheet for ${variant}`);
    }
    return config;
};
const callbackUrl = (variant: VariantName, linkHost = hostOf(variant)) =>
    appLink(
        {
            kind: 'cb',
            variant,
            host: 'acme.example.com',
            fields: { code: 'ABCDEFGHJKMN', state: 'state-0123456789ab' },
        },
        linkHost,
    );

describe("the sheet's config", () => {
    it.each(variants)('%s: waits for its own https callback on the link host', (variant) => {
        expect(configOf(variant)).toEqual({
            variant,
            linkHost: hostOf(variant),
            callback: {
                kind: 'https',
                url: `https://${hostOf(variant)}${callbackPath(variant)}`,
                host: hostOf(variant),
                path: callbackPath(variant),
            },
        });
    });

    it("takes each variant's path from @socio/shared's table, the server's", () => {
        expect(variants.map(callbackPath)).toEqual(['/dev/cb', '/preview/cb', '/app/cb']);
        // The callback the server's Continue page sends to reads back as this variant's.
        for (const variant of variants) {
            expect(callbackUrl(variant).startsWith(configOf(variant).callback.url)).toBe(true);
        }
    });

    it('gives a development Personal Team build the custom-scheme callback, and no other variant one', () => {
        expect(DEV_SCHEME_CALLBACK).toBe(PLUGIN_SCHEME_CALLBACK);
        expect(DEV_SCHEME_CALLBACK).toBe('socio-dev://auth-callback');
        expect(sheetConfig(embedded('development', true))?.callback).toEqual({
            kind: 'scheme',
            url: DEV_SCHEME_CALLBACK,
        });
        // A preview or production Personal Team build has no sheet.
        expect(sheetConfig(embedded('preview', true))).toBeNull();
        expect(sheetConfig(embedded('production', true))).toBeNull();
        // Nor does one whose config claims the scheme anyway: it fails closed.
        for (const variant of ['preview', 'production'] as const) {
            expect(
                sheetConfig({ extra: { variant, linkHost: LINK_HOST, authCallback: DEV_SCHEME_CALLBACK } }),
            ).toBeNull();
        }
    });

    it('fails closed on a callback that is not the variant’s own path on its link host', () => {
        const bad = [
            // Another variant's path.
            { variant: 'production', linkHost: LINK_HOST, authCallback: `https://${LINK_HOST}/preview/cb` },
            // Another host than the link host.
            { variant: 'production', linkHost: LINK_HOST, authCallback: 'https://evil.example/app/cb' },
            // Not https.
            { variant: 'production', linkHost: LINK_HOST, authCallback: `http://${LINK_HOST}/app/cb` },
            // Another scheme.
            { variant: 'development', linkHost: LINK_STAGING_HOST, authCallback: 'socio://auth-callback' },
            // Missing pieces.
            { variant: 'production', authCallback: `https://${LINK_HOST}/app/cb` },
            { variant: 'production', linkHost: LINK_HOST },
        ];
        for (const extra of bad) {
            expect(sheetConfig({ extra }), JSON.stringify(extra)).toBeNull();
        }
        expect(sheetConfig(null)).toBeNull();
    });

    it("reads a variant that isn't one as production's", () => {
        const config = sheetConfig({
            extra: { variant: 'staging', linkHost: LINK_HOST, authCallback: `https://${LINK_HOST}/app/cb` },
        });
        expect(config?.variant).toBe('production');
    });
});

describe('a callback URL', () => {
    it.each(variants)("%s: only its own variant's callback is taken", (variant) => {
        const config = configOf(variant);
        expect(isSheetCallback(callbackUrl(variant), config)).toBe(true);
        for (const other of variants.filter((name) => name !== variant)) {
            // Another variant's path on the same host: what keeps a preview build from a production
            // callback, since webcredentials covers the whole host.
            expect(isSheetCallback(callbackUrl(other, hostOf(variant)), config), other).toBe(false);
        }
    });

    it('is refused on another host, with a query, or without its fields', () => {
        const config = configOf('production');
        const good = callbackUrl('production');
        expect(isSheetCallback(good.replace(LINK_HOST, 'link.socio.sh.evil.example'), config)).toBe(false);
        expect(isSheetCallback(good.replace('/app/cb#', '/app/cb?x=1#'), config)).toBe(false);
        expect(isSheetCallback(`https://${LINK_HOST}/app/cb`, config)).toBe(false);
        expect(isSheetCallback(`https://${LINK_HOST}/app/cb#code=ABCDEFGHJKMN&ws=acme.example.com`, config)).toBe(
            false,
        );
        expect(isSheetCallback(`https://${LINK_HOST}/app/c#code=ABCDEFGH&ws=acme.example.com`, config)).toBe(false);
    });

    it('in a development Personal Team build, is the scheme callback alone', () => {
        const config = sheetConfig(embedded('development', true));
        if (config === null) {
            throw new Error('no sheet');
        }
        expect(isSheetCallback(`${DEV_SCHEME_CALLBACK}#code=ABCDEFGHJKMN&state=s`, config)).toBe(true);
        expect(isSheetCallback(`${DEV_SCHEME_CALLBACK}x#code=ABCDEFGHJKMN`, config)).toBe(false);
        expect(isSheetCallback('socio-preview://auth-callback#code=A', config)).toBe(false);
        expect(isSheetCallback(callbackUrl('development'), config)).toBe(false);
    });
});

describe("expo-web-browser's answer", () => {
    const config = configOf('preview');

    it('success with the callback is the callback', () => {
        const url = callbackUrl('preview');
        expect(classifyBrowserSession({ type: 'success', url }, config)).toEqual({ type: 'callback', url });
    });

    it("success with another URL is a wrong callback, and the URL isn't kept", () => {
        const url = callbackUrl('production');
        const result = classifyBrowserSession({ type: 'success', url }, config);
        expect(result).toEqual({ type: 'failed', reason: 'wrong-callback' });
        expect(JSON.stringify(result)).not.toContain('ABCDEFGHJKMN');
        expect(classifyBrowserSession({ type: 'success', url: null }, config)).toEqual({
            type: 'failed',
            reason: 'wrong-callback',
        });
    });

    it('cancel with no error is the person cancelling', () => {
        expect(classifyBrowserSession({ type: 'cancel' }, config)).toEqual({ type: 'cancelled' });
        expect(classifyBrowserSession({ type: 'cancel', error: null }, config)).toEqual({ type: 'cancelled' });
        expect(classifyBrowserSession({ type: 'cancel', error: '  ' }, config)).toEqual({ type: 'cancelled' });
        // `dismiss` is our own dismissal (expo-web-browser's dismissAuthSession).
        expect(classifyBrowserSession({ type: 'dismiss' }, config)).toEqual({ type: 'cancelled' });
    });

    it("the sheet's Cancel, which iOS reports as canceledLogin's words, is the person cancelling (a device check)", () => {
        // What expo-web-browser answered on the iOS 27.2 simulator when the person tapped Cancel.
        const error =
            'The operation couldn’t be completed. (com.apple.AuthenticationServices.WebAuthenticationSession error 1.)';
        expect(classifyBrowserSession({ type: 'cancel', error }, config)).toEqual({ type: 'cancelled' });
        // The same code in another language's sentence.
        expect(
            classifyBrowserSession(
                {
                    type: 'cancel',
                    error: 'Der Vorgang konnte nicht abgeschlossen werden. (com.apple.AuthenticationServices.WebAuthenticationSession error 1.)',
                },
                config,
            ),
        ).toEqual({ type: 'cancelled' });
        // Another code of the same domain isn't the person's.
        expect(
            classifyBrowserSession(
                {
                    type: 'cancel',
                    error: 'The operation couldn’t be completed. (com.apple.AuthenticationServices.WebAuthenticationSession error 2.)',
                },
                config,
            ),
        ).toMatchObject({ type: 'failed', reason: 'config' });
    });

    it("cancel with an error string is a config failure, never the person's cancel", () => {
        // iOS 27.2's words for a build with applinks only, as expo-web-browser hands them back.
        const error =
            'Application with identifier com.ingenioventures.socio.preview is not associated with domain link.socio.sh. Using HTTPS callbacks requires Associated Domains using the `webcredentials` service type for link.socio.sh.';
        const answer: BrowserSessionAnswer = { type: 'cancel', error };
        const result = classifyBrowserSession(answer, config);
        expect(result).toEqual({ type: 'failed', reason: 'config', detail: error });
        expect(result.type).not.toBe('cancelled');
    });

    it('anything else is an error', () => {
        expect(classifyBrowserSession({ type: 'locked' }, config)).toMatchObject({ type: 'failed', reason: 'error' });
        expect(classifyBrowserSession({ type: 'opened' }, config)).toMatchObject({ type: 'failed', reason: 'error' });
    });
});

describe("the Auth Tab's answer", () => {
    const config = configOf('production');
    const cases: [AuthTabAnswer, ReturnType<typeof classifyAuthTab>][] = [
        [{ type: 'unavailable', reason: 'no-auth-tab' }, 'fallback'],
        [{ type: 'unavailable', reason: 'no-browser' }, 'fallback'],
        [{ type: 'unavailable', reason: 'no-activity' }, 'fallback'],
        [{ type: 'cancel' }, { type: 'cancelled' }],
        [{ type: 'cancel', reason: 'replaced' }, { type: 'cancelled' }],
        [{ type: 'verification-failed' }, { type: 'failed', reason: 'verification', detail: 'verification-failed' }],
        [
            { type: 'verification-timed-out' },
            { type: 'failed', reason: 'verification', detail: 'verification-timed-out' },
        ],
        [
            { type: 'unknown', code: 7 },
            { type: 'failed', reason: 'error', detail: 'The Auth Tab answered 7.' },
        ],
        [
            { type: 'success', url: callbackUrl('production') },
            { type: 'callback', url: callbackUrl('production') },
        ],
        [
            { type: 'success', url: callbackUrl('preview', LINK_HOST) },
            { type: 'failed', reason: 'wrong-callback' },
        ],
        [
            { type: 'success', url: null },
            { type: 'failed', reason: 'wrong-callback' },
        ],
    ];

    it.each(cases)('%j is %j', (answer, expected) => {
        expect(classifyAuthTab(answer, config)).toEqual(expected);
    });
});

describe('opening the sheet', () => {
    const fake = (
        os: 'ios' | 'android',
        session: BrowserSessionAnswer | Error,
        tab: AuthTabAnswer | Error = { type: 'unavailable', reason: 'no-auth-tab' },
    ) => {
        const platform = {
            os,
            openAuthSession: vi.fn(async () => {
                if (session instanceof Error) {
                    throw session;
                }
                return session;
            }),
            openAuthTab: vi.fn(async () => {
                if (tab instanceof Error) {
                    throw tab;
                }
                return tab;
            }),
        } satisfies SheetPlatform;
        return platform;
    };
    const start = 'https://acme.example.com/api/auth/device/start?challenge=c&state=s&platform=ios&variant=production';

    it('on iOS, opens expo-web-browser with the https callback, universal links, not ephemeral', async () => {
        const url = callbackUrl('production');
        const platform = fake('ios', { type: 'success', url });
        await expect(openSheet(start, configOf('production'), platform)).resolves.toEqual({ type: 'callback', url });
        expect(platform.openAuthSession).toHaveBeenCalledWith(start, `https://${LINK_HOST}/app/cb`, {
            preferUniversalLinks: true,
            preferEphemeralSession: false,
        });
        expect(platform.openAuthTab).not.toHaveBeenCalled();
    });

    it("on Android, opens the Auth Tab on the variant's own host and path", async () => {
        const url = callbackUrl('preview');
        const platform = fake('android', { type: 'cancel' }, { type: 'success', url });
        await expect(openSheet(start, configOf('preview'), platform)).resolves.toEqual({ type: 'callback', url });
        expect(platform.openAuthTab).toHaveBeenCalledWith(start, LINK_HOST, '/preview/cb');
        expect(platform.openAuthSession).not.toHaveBeenCalled();
    });

    it("on Android without an Auth Tab, falls back to the Custom Tab and the variant's App Link", async () => {
        const url = callbackUrl('development');
        const platform = fake('android', { type: 'success', url });
        await expect(openSheet(start, configOf('development'), platform)).resolves.toEqual({ type: 'callback', url });
        expect(platform.openAuthTab).toHaveBeenCalledWith(start, LINK_STAGING_HOST, '/dev/cb');
        expect(platform.openAuthSession).toHaveBeenCalledWith(start, `https://${LINK_STAGING_HOST}/dev/cb`, {
            preferUniversalLinks: true,
            preferEphemeralSession: false,
        });
    });

    it('on Android, a cancel or verification failure in the Auth Tab opens no Custom Tab', async () => {
        for (const tab of [{ type: 'cancel' }, { type: 'verification-failed' }] as AuthTabAnswer[]) {
            const platform = fake('android', { type: 'success', url: callbackUrl('production') }, tab);
            const result = await openSheet(start, configOf('production'), platform);
            expect(result.type).not.toBe('callback');
            expect(platform.openAuthSession).not.toHaveBeenCalled();
        }
    });

    it('a development Personal Team build opens expo-web-browser with the scheme callback on both', async () => {
        const config = sheetConfig(embedded('development', true));
        for (const os of ['ios', 'android'] as const) {
            const url = `${DEV_SCHEME_CALLBACK}#code=ABCDEFGHJKMN&state=s`;
            const platform = fake(os, { type: 'success', url });
            await expect(openSheet(start, config, platform)).resolves.toEqual({ type: 'callback', url });
            expect(platform.openAuthSession).toHaveBeenCalledWith(start, DEV_SCHEME_CALLBACK, {
                preferUniversalLinks: false,
                preferEphemeralSession: false,
            });
            expect(platform.openAuthTab).not.toHaveBeenCalled();
        }
    });

    it('a build with no sheet is unavailable and opens nothing', async () => {
        const platform = fake('ios', { type: 'cancel' });
        await expect(openSheet(start, null, platform)).resolves.toEqual({ type: 'unavailable', reason: 'no-sheet' });
        expect(platform.openAuthSession).not.toHaveBeenCalled();
    });

    it('never throws: a sheet that fails to start is failed', async () => {
        const ios = fake('ios', new Error('WebAuthSession failed to start'));
        await expect(openSheet(start, configOf('production'), ios)).resolves.toEqual({
            type: 'failed',
            reason: 'error',
            detail: 'WebAuthSession failed to start',
        });
        const android = fake('android', { type: 'cancel' }, new Error('boom'));
        await expect(openSheet(start, configOf('production'), android)).resolves.toMatchObject({
            type: 'failed',
            reason: 'error',
        });
    });
});
