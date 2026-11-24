import { z } from 'zod';

/**
 * Device sign-in (CB-352): the contract between the
 * server's `/api/auth/device/*` endpoints, the workspace manifest at
 * `/.well-known/socio/workspace`, the link domain (`link.socio.sh`) and the
 * native app. Pure data and zod: the app bundles this file, so it runs on
 * Hermes, with no global beyond the language's own. Hashing (S256, SHA-256
 * of the install id) is each side's own: Node's crypto on the server,
 * expo-crypto in the app.
 *
 * Every change here is additive: the app reads it, and an app release lags
 * a server release.
 */

/** Where the device sign-in endpoints live (Better Auth plugin endpoints). */
export const DEVICE_AUTH_PATH = '/api/auth/device';
/** The public manifest a workspace serves. */
export const WORKSPACE_MANIFEST_PATH = '/.well-known/socio/workspace';
/** The device protocol's version in the manifest; a new version is a new number, never a change to this one. */
export const DEVICE_PROTOCOL = 1;

/**
 * `AUTH_APP_INVITE_LINKS`: invites and "Send me a link for the app"
 * use the link domain, so they open the Socio app. Off unless set; an
 * admin's choice in Settings → General wins.
 */
export const APP_INVITE_LINKS_ENV = 'AUTH_APP_INVITE_LINKS';
export const appInviteLinksFromEnv = (env: Record<string, string | undefined>) =>
    ['1', 'true', 'yes', 'on'].includes((env[APP_INVITE_LINKS_ENV] ?? '').trim().toLowerCase());
/**
 * The header the app sends to its workspace's origin only (never the link
 * domain or the push relay): this install's id for that workspace, 32
 * random bytes in base64url. The server keeps its SHA-256, never the value.
 */
export const INSTALL_HEADER = 'X-Socio-Install';

/** The link domain, and the one development builds and the bench use by default. */
export const LINK_HOST = 'link.socio.sh';
export const LINK_STAGING_HOST = 'link-staging.socio.sh';

/** The app's builds (`apps/mobile/variant.ts`). */
export const APP_VARIANTS = ['production', 'preview', 'development'] as const;
export type AppVariant = (typeof APP_VARIANTS)[number];
/** Each build's path prefix on the link domain: a build opens only its own. */
export const VARIANT_LINK_PATHS: Readonly<Record<AppVariant, string>> = {
    production: 'app',
    preview: 'preview',
    development: 'dev',
};

export const DEVICE_PLATFORMS = ['ios', 'android'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

/**
 * The links on the link domain, by kind:
 * - `cb`: the sign-in sheet's callback, `#code=…&state=…&ws=<host>`;
 * - `c`: a sign-in code sent by email or Telegram, `#code=…&ws=<host>`;
 * - `d`: Add a device's QR code, `/d/<host>#c=<pairing code>`;
 * - `i`: an invite, `/i/<host>#t=<token>`;
 * - `w`: the workspace only (Get the app, "Send me a link for the app"), `/w/<host>`, no fragment.
 * Codes and tokens ride in the fragment, which no request carries.
 */
export const LINK_KINDS = ['cb', 'c', 'd', 'i', 'w'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];
/** The kinds whose workspace host is a path segment; the others carry it as `ws` in the fragment. */
const HOST_IN_PATH: ReadonlySet<LinkKind> = new Set(['d', 'i', 'w']);

// ---------------------------------------------------------------------------
// Codes

/**
 * The alphabet of every code people read or type: digits and capitals
 * without the ones that look alike (`0 O 1 I L U`), 30 symbols.
 */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
/** The sign-in sheet's one-time code: 12 symbols, about 59 bits. */
export const SHEET_CODE_LENGTH = 12;
/** Add a device's pairing code, in its QR code: 12 symbols. */
export const PAIRING_CODE_LENGTH = 12;
/** A sign-in code sent by email or Telegram: 8 symbols, about 39 bits, typed by people. */
export const SIGN_IN_CODE_LENGTH = 8;
/** Add a device's confirmation: 6 digits the new device shows and the web types. */
export const CONFIRMATION_DIGITS = 6;

/**
 * A code as typed or pasted, in its canonical form (capitals, no spaces or
 * dashes), or null when it isn't `length` symbols of the alphabet. Compared
 * case-blind: `abcd-efgh` is `ABCDEFGH`.
 */
export function normalizeCode(input: string, length: number): string | null {
    const code = input.replace(/[\s-]/g, '').toUpperCase();
    if (code.length !== length) {
        return null;
    }
    for (const symbol of code) {
        if (!CODE_ALPHABET.includes(symbol)) {
            return null;
        }
    }
    return code;
}

/** A canonical code shown in groups of four: `ABCD-EFGH-JKMN`. */
export function formatCode(code: string): string {
    const groups: string[] = [];
    for (let at = 0; at < code.length; at += 4) {
        groups.push(code.slice(at, at + 4));
    }
    return groups.join('-');
}

/** Six digits as typed (spaces allowed), or null: `482 913` is `482913`. */
export function normalizeDigits(input: string): string | null {
    const digits = input.replace(/\s/g, '');
    return /^\d{6}$/.test(digits) ? digits : null;
}

/** Six digits shown as two groups of three: `482 913`. */
export function formatDigits(digits: string): string {
    return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

/** A zod schema for a code of `length`, taking any case, spaces and dashes, giving the canonical form. */
const codeOf = (length: number) =>
    z
        .string()
        .max(64)
        .transform((value, ctx) => {
            const code = normalizeCode(value, length);
            if (code === null) {
                ctx.addIssue({ code: 'custom', message: 'Not a code.' });
                return z.NEVER;
            }
            return code;
        });
export const sheetCodeSchema = codeOf(SHEET_CODE_LENGTH);
export const pairingCodeSchema = codeOf(PAIRING_CODE_LENGTH);
export const signInCodeSchema = codeOf(SIGN_IN_CODE_LENGTH);
export const confirmationDigitsSchema = z
    .string()
    .max(16)
    .transform((value, ctx) => {
        const digits = normalizeDigits(value);
        if (digits === null) {
            ctx.addIssue({ code: 'custom', message: 'Not six digits.' });
            return z.NEVER;
        }
        return digits;
    });

// ---------------------------------------------------------------------------
// PKCE, state and install ids

const base64url = /^[A-Za-z0-9_-]+$/;
/** A PKCE verifier (RFC 7636): 43 to 128 base64url characters. */
export const pkceVerifierSchema = z.string().min(43).max(128).regex(base64url);
/** An S256 challenge, `base64url(sha256(verifier))` without padding: always 43 characters. S256 is the only method. */
export const pkceChallengeSchema = z.string().length(43).regex(base64url);
/** The sheet's `state`, made by the app and checked on its callback. */
export const sheetStateSchema = z.string().min(16).max(128).regex(base64url);
/** An install id: 32 random bytes in base64url, 43 characters. */
export const installIdSchema = z.string().length(43).regex(base64url);
/** A request or claim id the server made (random, base64url). */
export const deviceRequestIdSchema = z.string().min(16).max(64).regex(base64url);
/** What the device calls itself ("Pixel 4", "Ana's iPhone"), as 9.1 makes it. */
export const deviceLabelSchema = z.string().trim().min(1).max(64);
export const appVariantSchema = z.enum(APP_VARIANTS);
export const devicePlatformSchema = z.enum(DEVICE_PLATFORMS);

// ---------------------------------------------------------------------------
// What the app is told when something is refused (10.2 words each)

/**
 * Every refusal's `code`, in the answer's JSON `{ error, code }` (the
 * session check's 401 too). The app words them from its copy table, never
 * from `error`'s text.
 */
export const DEVICE_ERROR_CODES = [
    /** No such code, or used already. */
    'code_invalid',
    'code_expired',
    /** Add a device: the web hasn't typed the 6 digits yet; poll again. */
    'not_allowed_yet',
    /** Add a device: "Not my device", three wrong tries, or the claim ran out. */
    'denied',
    'too_many',
    /** The access policy turned this way in off. */
    'method_off',
    /** The code was made for another build of the app. */
    'wrong_variant',
    /** This person may not sign in this way, or not here. */
    'not_authorized',
    /** Better Auth's code for a deactivated person. */
    'BANNED_USER',
    /** The session check's 401s, for requests with an install id. */
    'session_expired',
    'session_ended',
    'device_revoked',
    'deactivated',
] as const;
export type DeviceErrorCode = (typeof DEVICE_ERROR_CODES)[number];
export const deviceErrorSchema = z.object({
    error: z.string(),
    code: z.enum(DEVICE_ERROR_CODES),
});
export type DeviceError = z.infer<typeof deviceErrorSchema>;

// ---------------------------------------------------------------------------
// The sign-in sheet

/** `GET /api/auth/device/start?…`, opened in the system sign-in sheet. */
export const deviceStartQuerySchema = z
    .object({
        challenge: pkceChallengeSchema,
        state: sheetStateSchema,
        platform: devicePlatformSchema,
        variant: appVariantSchema,
    })
    .strict();
export type DeviceStartQuery = z.infer<typeof deviceStartQuerySchema>;

/** `POST /api/auth/device/approve`: the Continue click, on the web's session. */
export const deviceApproveBodySchema = z
    .object({
        request: deviceRequestIdSchema,
        /** The session the Continue page showed (WC): another one approves nothing. */
        session: z.string().min(1).max(128).optional(),
    })
    .strict();
/** Where the Continue page sends the browser: the link domain's `cb` link. */
export const deviceApproveAnswerSchema = z.object({ redirect: z.url() });

/** `POST /api/auth/device/redeem`: the app, with the code from the callback. */
export const deviceRedeemBodySchema = z
    .object({
        code: sheetCodeSchema,
        verifier: pkceVerifierSchema,
        installId: installIdSchema,
        label: deviceLabelSchema,
        variant: appVariantSchema,
    })
    .strict();
export type DeviceRedeemBody = z.input<typeof deviceRedeemBodySchema>;

/** Every redeem that signs in answers this, with the session cookie in `Set-Cookie`. */
export const deviceSignedInSchema = z.object({ deviceId: z.string().min(1) });
export type DeviceSignedIn = z.infer<typeof deviceSignedInSchema>;

// ---------------------------------------------------------------------------
// Add a device

/**
 * `POST /api/auth/device/pair`'s optional body: which build the QR code is
 * for. Without it the server picks (production, or preview or development
 * where those test settings are on).
 */
export const pairBodySchema = z.object({ variant: appVariantSchema.optional() }).strict();
export type PairBody = z.input<typeof pairBodySchema>;

/** `POST /api/auth/device/pair` on the web's session: the QR code's link. */
export const pairAnswerSchema = z.object({
    /** What the web polls, confirms and denies by: the claim's id is the device's alone. */
    pairingId: deviceRequestIdSchema,
    link: z.url(),
    variant: appVariantSchema,
    expiresAt: z.string(),
});
export type PairAnswer = z.infer<typeof pairAnswerSchema>;

/** `POST /api/auth/device/pair/claim`: the new device, with the code from the QR link. */
export const pairClaimBodySchema = z
    .object({
        code: pairingCodeSchema,
        challenge: pkceChallengeSchema,
        label: deviceLabelSchema,
        platform: devicePlatformSchema,
        variant: appVariantSchema,
    })
    .strict();
export type PairClaimBody = z.input<typeof pairClaimBodySchema>;

/**
 * The claim's answer, to the claiming device only: who it would sign in as,
 * and the 6 digits to show. No answer to the web ever holds the digits.
 */
export const pairClaimAnswerSchema = z.object({
    claimId: deviceRequestIdSchema,
    digits: z.string().regex(/^\d{6}$/),
    expiresAt: z.string(),
    workspace: z.object({ name: z.string(), host: z.string() }),
    account: z.object({ name: z.string(), email: z.string() }),
});
export type PairClaimAnswer = z.infer<typeof pairClaimAnswerSchema>;

/** `unclaimed`: the QR code waits for a device; `waiting`: claimed, the web hasn't typed the digits. */
export const PAIR_STATES = ['unclaimed', 'waiting', 'allowed', 'denied', 'expired', 'signed_in'] as const;
export type PairState = (typeof PAIR_STATES)[number];
/** `GET /api/auth/device/pair/:pairingId`, the minting web session only: what the page shows. */
export const pairStatusSchema = z.object({
    state: z.enum(PAIR_STATES),
    /** The claiming device's, once claimed; null before. */
    platform: devicePlatformSchema.nullable(),
    label: z.string().nullable(),
    claimedAt: z.string().nullable(),
});
export type PairStatus = z.infer<typeof pairStatusSchema>;

/** `POST /api/auth/device/pair/:pairingId/confirm`: the digits typed on the web. */
export const pairConfirmBodySchema = z.object({ digits: confirmationDigitsSchema }).strict();
/** A wrong try says how many are left; none left is `denied`. */
export const pairConfirmAnswerSchema = z.object({
    state: z.enum(PAIR_STATES),
    triesLeft: z.number().int().min(0),
});

/** `POST /api/auth/device/pair/redeem`: the new device polling until the web confirms. */
export const pairRedeemBodySchema = z
    .object({
        claimId: deviceRequestIdSchema,
        verifier: pkceVerifierSchema,
        installId: installIdSchema,
    })
    .strict();
export type PairRedeemBody = z.input<typeof pairRedeemBodySchema>;

/**
 * `POST /api/auth/device/pair/cancel`: the new device's Cancel. The claim id,
 * which only the claiming device holds, is the proof; it ends the claim and
 * its QR code. Always `{ state: 'denied' }`, whatever the claim.
 */
export const pairCancelBodySchema = z.object({ claimId: deviceRequestIdSchema }).strict();
export type PairCancelBody = z.input<typeof pairCancelBodySchema>;

// ---------------------------------------------------------------------------
// Sign-in codes the app asks for

/** `POST /api/auth/device/code`: always answers a request id, whether or not the account exists. */
export const codeRequestBodySchema = z
    .object({
        email: z.string().trim().toLowerCase().pipe(z.email()),
        challenge: pkceChallengeSchema,
        platform: devicePlatformSchema,
        variant: appVariantSchema,
    })
    .strict();
export type CodeRequestBody = z.input<typeof codeRequestBodySchema>;
export const codeRequestAnswerSchema = z.object({ requestId: deviceRequestIdSchema });

/** `POST /api/auth/device/code/redeem`: the code typed, or filled in from its link. */
export const codeRedeemBodySchema = z
    .object({
        requestId: deviceRequestIdSchema,
        code: signInCodeSchema,
        verifier: pkceVerifierSchema,
        installId: installIdSchema,
        label: deviceLabelSchema,
        variant: appVariantSchema,
    })
    .strict();
export type CodeRedeemBody = z.input<typeof codeRedeemBodySchema>;

// ---------------------------------------------------------------------------
// Devices

export const DEVICE_STATES = ['active', 'revoked', 'revoked_and_erase'] as const;
export type DeviceState = (typeof DEVICE_STATES)[number];
/** One device in the person's (or an admin's) list. */
export const deviceSummarySchema = z.object({
    id: z.string(),
    label: z.string(),
    /** From the app's User-Agent on a password sign-in; null when it didn't say. */
    platform: devicePlatformSchema.nullable(),
    /** Which build: known once the device signs in through a device endpoint, null before. */
    variant: appVariantSchema.nullable(),
    state: z.enum(DEVICE_STATES),
    /** How its current session began (`auth_session.signInMethod`), null with none. */
    signInMethod: z.string().nullable(),
    createdAt: z.string(),
    lastSeenAt: z.string().nullable(),
    /** The device making this request. */
    current: z.boolean(),
});
export type DeviceSummary = z.infer<typeof deviceSummarySchema>;
export const deviceListSchema = z.object({ devices: z.array(deviceSummarySchema) });

/** `PUT /api/auth/device/push`: the push subscription this device registered. */
export const devicePushBodySchema = z.object({ endpoint: z.url({ protocol: /^https$/ }).max(2048) }).strict();

// ---------------------------------------------------------------------------
// The workspace manifest

/** How sign-in codes travel here, if they do. */
export const SIGN_IN_CODE_CHANNELS = ['email', 'telegram'] as const;

/**
 * `GET /.well-known/socio/workspace`: public, no cookies read. The app
 * reads it before sign-in, keeps `id`, and refuses a saved origin whose
 * manifest names another workspace.
 */
export const workspaceManifestSchema = z.object({
    /** Random, made once at migration; never changes. */
    id: z.string().min(1),
    origin: z.url(),
    name: z.string(),
    branding: z.object({ name: z.string(), logo: z.string() }),
    methods: z.object({
        password: z.boolean(),
        passkey: z.boolean(),
        /** The system sign-in sheet. */
        sheet: z.boolean(),
        signInCodes: z.enum(SIGN_IN_CODE_CHANNELS).nullable(),
        addDevice: z.boolean(),
    }),
    serverVersion: z.string(),
    protocol: z.number().int().min(1),
    policy: z.object({
        /** Days without a successful request before the app locks (4.1). */
        leaseDays: z.number().int().min(1),
        /** Days after that lock before the app erases its copy. */
        wipeDays: z.number().int().min(1),
        /** The workspace requires Face ID or a fingerprint. */
        appLock: z.boolean(),
        /** Notifications may show message text (9.1). */
        notificationText: z.boolean(),
    }),
});
export type WorkspaceManifest = z.infer<typeof workspaceManifestSchema>;

// ---------------------------------------------------------------------------
// The app's lease and notification policy (CB-379)

/** The policy the manifest gives the app (4.1, 9.1). */
export type AppPolicy = WorkspaceManifest['policy'];

/** The app's own defaults: 30 days to the lock, 30 more to the erase, no app lock, message text in notifications. */
export const APP_POLICY_DEFAULTS: AppPolicy = { leaseDays: 30, wipeDays: 30, appLock: false, notificationText: true };

/** What an admin may set, as the app holds them (apps/mobile/src/data/lease.ts: at least 1 and 7 days, at most 365). */
export const APP_LEASE_DAYS_RANGE = { min: 1, max: 365 } as const;
export const APP_WIPE_DAYS_RANGE = { min: 7, max: 365 } as const;

/** An admin's change to the policy (`PATCH /api/settings` `appPolicy`): the ones left out stay as they are. */
export const appPolicyChangeSchema = z
    .object({
        leaseDays: z.number().int().min(APP_LEASE_DAYS_RANGE.min).max(APP_LEASE_DAYS_RANGE.max).optional(),
        wipeDays: z.number().int().min(APP_WIPE_DAYS_RANGE.min).max(APP_WIPE_DAYS_RANGE.max).optional(),
        appLock: z.boolean().optional(),
        notificationText: z.boolean().optional(),
    })
    .strict();

/** The variables that set the server's policy, under an admin's in Settings. */
export const APP_POLICY_ENV = {
    leaseDays: 'AUTH_APP_LEASE_DAYS',
    wipeDays: 'AUTH_APP_WIPE_DAYS',
    appLock: 'AUTH_APP_LOCK',
    notificationText: 'AUTH_APP_NOTIFICATION_TEXT',
} as const;

/**
 * The server's policy from the environment, each unset one the app's
 * default. A value that isn't one stops the server, as other settings do.
 */
export function appPolicyFromEnv(env: Record<string, string | undefined>): AppPolicy {
    const days = (key: 'leaseDays' | 'wipeDays', range: { min: number; max: number }) => {
        const name = APP_POLICY_ENV[key];
        const raw = env[name]?.trim();
        if (!raw) {
            return APP_POLICY_DEFAULTS[key];
        }
        const value = Number(raw);
        if (!Number.isInteger(value) || value < range.min || value > range.max) {
            throw new Error(`${name} must be a whole number of days from ${range.min} to ${range.max}.`);
        }
        return value;
    };
    const flag = (key: 'appLock' | 'notificationText') => {
        const name = APP_POLICY_ENV[key];
        const raw = env[name]?.trim().toLowerCase();
        if (!raw) {
            return APP_POLICY_DEFAULTS[key];
        }
        if (['1', 'true', 'yes', 'on'].includes(raw)) {
            return true;
        }
        if (['0', 'false', 'no', 'off'].includes(raw)) {
            return false;
        }
        throw new Error(`${name} must be true or false.`);
    };
    return {
        leaseDays: days('leaseDays', APP_LEASE_DAYS_RANGE),
        wipeDays: days('wipeDays', APP_WIPE_DAYS_RANGE),
        appLock: flag('appLock'),
        notificationText: flag('notificationText'),
    };
}

/** The policy in force: each of an admin's choices over the server's. */
export function appPolicyInForce(saved: Partial<AppPolicy> | undefined, server: AppPolicy = APP_POLICY_DEFAULTS) {
    return {
        leaseDays: saved?.leaseDays ?? server.leaseDays,
        wipeDays: saved?.wipeDays ?? server.wipeDays,
        appLock: saved?.appLock ?? server.appLock,
        notificationText: saved?.notificationText ?? server.notificationText,
    } satisfies AppPolicy;
}

// ---------------------------------------------------------------------------
// Links on the link domain

/** What a link carries in its fragment, by kind. */
export interface AppLinkFields {
    cb: { code: string; state: string };
    c: { code: string };
    d: { c: string };
    i: { t: string };
    w: Record<string, never>;
}

export interface AppLink<K extends LinkKind = LinkKind> {
    kind: K;
    variant: AppVariant;
    /** The workspace's host (`URL.host`: a port is kept). */
    host: string;
    fields: AppLinkFields[K];
}

const FRAGMENT_KEYS: { [K in LinkKind]: readonly (keyof AppLinkFields[K] & string)[] } = {
    cb: ['code', 'state'],
    c: ['code'],
    d: ['c'],
    i: ['t'],
    w: [],
};

/** A workspace host as links carry it: lower case, letters, digits, dots, dashes and an optional port. */
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;
export const isLinkHost = (host: string) => host.length <= 260 && HOST.test(host);

/**
 * A link on the link domain, `https://<linkHost>/<variant path>/<kind>…`.
 * Codes and tokens go in the fragment only. Throws on a host links can't carry.
 */
export function appLink<K extends LinkKind>(link: AppLink<K>, linkHost: string = LINK_HOST): string {
    const host = link.host.toLowerCase();
    if (!isLinkHost(host)) {
        throw new Error('Not a workspace host.');
    }
    const prefix = `https://${linkHost}/${VARIANT_LINK_PATHS[link.variant]}/${link.kind}`;
    const pairs: [string, string][] = FRAGMENT_KEYS[link.kind].map((key) => [
        key,
        String((link.fields as Record<string, string>)[key]),
    ]);
    if (HOST_IN_PATH.has(link.kind)) {
        const fragment = pairs.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
        return `${prefix}/${host}${fragment ? `#${fragment}` : ''}`;
    }
    pairs.push(['ws', host]);
    return `${prefix}#${pairs.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}`;
}

const VARIANT_BY_PATH = new Map(APP_VARIANTS.map((variant) => [VARIANT_LINK_PATHS[variant], variant]));

/**
 * A link on `linkHost` read back, or null when it isn't one: another host,
 * not https, an unknown variant or kind, a bad workspace host, a missing
 * or extra fragment field, or a query (links never have one). Nothing here
 * says whether the workspace may be used: the app checks the host as any
 * address.
 */
export function parseAppLink(href: string, linkHost: string = LINK_HOST): AppLink | null {
    const prefix = `https://${linkHost}/`;
    if (!href.startsWith(prefix)) {
        return null;
    }
    const rest = href.slice(prefix.length);
    const hashAt = rest.indexOf('#');
    const path = hashAt < 0 ? rest : rest.slice(0, hashAt);
    const fragment = hashAt < 0 ? '' : rest.slice(hashAt + 1);
    if (path.includes('?')) {
        return null;
    }
    const segments = path.split('/');
    const variant = VARIANT_BY_PATH.get(segments[0] ?? '');
    const kind = segments[1] as LinkKind;
    if (!variant || !(LINK_KINDS as readonly string[]).includes(kind)) {
        return null;
    }
    const pairs = new Map<string, string>();
    if (fragment) {
        for (const part of fragment.split('&')) {
            const eq = part.indexOf('=');
            if (eq <= 0) {
                return null;
            }
            const key = part.slice(0, eq);
            let value: string;
            try {
                value = decodeURIComponent(part.slice(eq + 1));
            } catch {
                return null;
            }
            if (pairs.has(key) || !value) {
                return null;
            }
            pairs.set(key, value);
        }
    }
    let host: string | undefined;
    if (HOST_IN_PATH.has(kind)) {
        if (segments.length !== 3) {
            return null;
        }
        host = segments[2];
    } else {
        if (segments.length !== 2) {
            return null;
        }
        host = pairs.get('ws');
        pairs.delete('ws');
    }
    if (!host || !isLinkHost(host)) {
        return null;
    }
    const keys = FRAGMENT_KEYS[kind] as readonly string[];
    if (pairs.size !== keys.length || !keys.every((key) => pairs.has(key))) {
        return null;
    }
    return { kind, variant, host, fields: Object.fromEntries(pairs) as AppLinkFields[typeof kind] };
}
