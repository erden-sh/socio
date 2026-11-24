import {
    type AppVariant,
    DEVICE_AUTH_PATH,
    type DevicePlatform,
    parseAppLink,
    VARIANT_LINK_PATHS,
    type WorkspaceManifest,
} from '@socio/shared/device-sign-in';

import type { SheetConfig } from './auth-sheet';
import type { ManifestRead } from './probe';

// Signing in through the system sign-in sheet:
// the PKCE pair, the state, the device start page the sheet opens, and the callback read back.
// No React Native here, so the Node tests run it as the app does; src/data/sheet-flow.ts keeps
// the pending flow, and src/platform/sheet-sign-in.ts binds both.
//
// - The verifier is 32 random bytes in unpadded base64url (43 characters, RFC 7636), its
//   challenge `base64url(SHA-256(verifier))`, S256 only. The state is 32 random bytes too.
// - The callback is the server's `https://<link host>/<variant path>/cb#code=…&state=…&ws=<host>`
//   (a development Personal Team build's `socio-dev://auth-callback#…` carries the same
//   fragment). It is read with @socio/shared's `parseAppLink` on this build's link host and
//   taken only for this build's variant; whether its state and host are the pending flow's is
//   sheet-flow.ts's check.
// - Nothing here logs, and no result holds the URL: the code, the verifier and the state go only
//   where the flow sends them.

/** The server's device start page: the sheet opens it, and it sends the browser to the Continue page. */
export const DEVICE_START_PATH = `${DEVICE_AUTH_PATH}/start`;

/** Random bytes in a verifier and in a state. */
const PKCE_BYTES = 32;
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** `bytes` in unpadded base64url. */
export function base64url(bytes: Uint8Array): string {
    let text = '';
    let held = 0;
    let bits = 0;
    for (const byte of bytes) {
        held = ((held << 8) | byte) & 0xffff;
        bits += 8;
        while (bits >= 6) {
            bits -= 6;
            text += BASE64URL[(held >> bits) & 63];
        }
    }
    return bits > 0 ? text + BASE64URL[(held << (6 - bits)) & 63] : text;
}

/** Standard base64 (SHA-256 as expo-crypto gives it) in unpadded base64url. */
export const toBase64url = (base64: string) => base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** SHA-256 of an ASCII string, in standard base64: expo-crypto's `digestStringAsync` with BASE64, or Node's. */
export type Sha256Base64 = (text: string) => Promise<string>;

/** `length` random bytes from a secure source (src/data/keys.ts's RandomBytes). */
type RandomBytes = (length: number) => Uint8Array;

function randomText(randomBytes: RandomBytes): string {
    const bytes = randomBytes(PKCE_BYTES);
    if (bytes.length !== PKCE_BYTES) {
        throw new Error(`The random source gave ${bytes.length} bytes, not ${PKCE_BYTES}.`);
    }
    return base64url(bytes);
}

/** A sheet's secrets: the verifier, its S256 challenge, and the state its callback must bring back. */
export interface SheetSecrets {
    readonly verifier: string;
    readonly challenge: string;
    readonly state: string;
}

/** A fresh verifier, its challenge and a state. */
export async function newSheetSecrets(randomBytes: RandomBytes, sha256: Sha256Base64): Promise<SheetSecrets> {
    const verifier = randomText(randomBytes);
    const state = randomText(randomBytes);
    return { verifier, challenge: toBase64url(await sha256(verifier)), state };
}

/** The device start page on `origin`, with the challenge, the state, the platform and the variant (the server's query). */
export function deviceStartUrl(
    origin: string,
    query: {
        readonly challenge: string;
        readonly state: string;
        readonly platform: DevicePlatform;
        readonly variant: AppVariant;
    },
): string {
    const url = new URL(DEVICE_START_PATH, origin);
    url.searchParams.set('challenge', query.challenge);
    url.searchParams.set('state', query.state);
    url.searchParams.set('platform', query.platform);
    url.searchParams.set('variant', query.variant);
    return url.href;
}

/** What a sheet callback carries: the code, the state, and the workspace host it came from. */
export interface SheetCallbackFields {
    readonly code: string;
    readonly state: string;
    /** `URL.host` of the workspace that made the code (a port kept). */
    readonly host: string;
}

/**
 * The sheet callback in `url`, or null when it isn't this build's: another host, path, variant
 * or scheme, a query, or a missing or extra field. A development Personal Team build's custom
 * scheme callback is read as the https one it stands for.
 */
export function readSheetCallback(url: string, config: SheetConfig): SheetCallbackFields | null {
    let href = url;
    if (config.callback.kind === 'scheme') {
        const prefix = `${config.callback.url}#`;
        if (!url.startsWith(prefix)) {
            return null;
        }
        href = `https://${config.linkHost}/${VARIANT_LINK_PATHS[config.variant]}/cb#${url.slice(prefix.length)}`;
    }
    const link = parseAppLink(href, config.linkHost);
    if (link === null || link.kind !== 'cb' || link.variant !== config.variant) {
        return null;
    }
    const { code, state } = link.fields as { code: string; state: string };
    return { code, state, host: link.host };
}

/**
 * What the person's device list calls this device: the platform only, as the User-Agent names it
 * (src/net/user-agent.ts), never the phone's name or model.
 */
export function deviceLabel(platform: DevicePlatform, tablet = false): string {
    return platform === 'ios' ? (tablet ? 'Socio app on iPad' : 'Socio app on iPhone') : 'Socio app on Android';
}

/**
 * A way of signing in the SignIn screen offers. Only what this build can carry out: the sheet,
 * a sign-in code by email or Telegram (`methods.signInCodes`) and the password form.
 */
export type SignInWay = 'sheet' | 'code' | 'password';

/**
 * The ways in, in the order the screen shows them, by the manifest and whether this build has a
 * sheet (src/platform/auth-sheet.ts' `SHEET_CONFIG`):
 * - the sheet when the manifest says `methods.sheet` and the build has one;
 * - a sign-in code when the manifest names a channel for them (`methods.signInCodes`);
 * - the password form unless the manifest says `methods.password: false`. A server with no
 *   manifest (an older server) gets the password form alone.
 * Empty when the workspace offers nothing this build can do: the screen sends the person to the web.
 */
export function signInWays(manifest: WorkspaceManifest | null, hasSheet: boolean): SignInWay[] {
    const ways: SignInWay[] = [];
    if (manifest?.methods.sheet === true && hasSheet) {
        ways.push('sheet');
    }
    // The channel is sign-in-codes.ts's `codeChannel`: email only while the manifest says email links are in force.
    if (manifest?.methods.signInCodes === 'email' || manifest?.methods.signInCodes === 'telegram') {
        ways.push('code');
    }
    if (manifest === null || manifest.methods.password) {
        ways.push('password');
    }
    return ways;
}

/**
 * The manifest SignIn chooses the ways by: the probe's, else (signing in again, which comes with
 * none) the workspace's own, read now, so an SSO or passkey person is offered the sheet there too.
 * No manifest this build can read, or no answer, is null: the password form alone.
 * Rejects only as `read` does (AbortedError once the screen goes).
 */
export async function signInManifest(
    given: WorkspaceManifest | null | undefined,
    read: () => Promise<ManifestRead>,
): Promise<WorkspaceManifest | null> {
    if (given != null) {
        return given;
    }
    const answer = await read();
    return answer.kind === 'manifest' ? answer.manifest : null;
}
