import { LINK_HOST, LINK_STAGING_HOST, type LinkKind, parseAppLink } from '@socio/shared/device-sign-in';

import { type DeviceLinkConfig, readDeviceLink } from './add-device';
import { readWorkspaceLink } from './first-screen';
import { readInviteLink } from './invite';

// Add workspace's QR scanner (CB-566), the parts with no React Native: what a scanned code is,
// what the scanner does with it, the camera permission's steps and the words. The screen
// (screens/scan-qr.tsx) draws them; src/platform/qr-scan.ts binds this build's link config.
//
// - The codes are Socio's own links on the link domain, the ones the web shows as QR codes:
//   Get the app (`…/<variant path>/w/<host>`) and Add a device (`…/d/<host>#c=<pairing code>`),
//   and an invite (`…/i/<host>#t=<token>`), a link too. Each is read by the same reader the app
//   uses when that link opens it from outside, on this build's link host and variant only, and the
//   URL goes to the same place: root-navigation.tsx's `openExternalUrl`, through
//   src/navigation/scanned-link.ts. Nothing goes to the link domain: the app opens it itself.
// - Nothing else opens: a link of another build (another variant's path, or another link host
//   Socio uses) says so, and anything else, another URL or plain text, isn't a Socio code. The
//   sign-in sheet's callback (`cb`) and a sign-in code's link (`c`) never come from a QR code, so
//   a scan never hands them over.

/** Every word the scanner shows: one place, tested. "Device", never "phone". */
export const SCAN_COPY = {
    title: 'Scan the QR code',
    hint: 'Point the camera at the QR code from Socio on a computer.',
    cancel: 'Cancel',
    lightOn: 'Turn on the light',
    lightOff: 'Turn off the light',
    notSocio: 'This isn’t a Socio code.',
    otherBuild: 'This code is for another version of the Socio app.',
    tryAgain: 'Try again',
    opening: 'Opening…',
    deniedTitle: 'Socio can’t use the camera',
    deniedDetail: 'Allow the camera in Settings to scan the code, or enter the workspace address instead.',
    openSettings: 'Open Settings',
    allow: 'Allow the camera',
    noCamera: 'The camera didn’t start. Enter the workspace address instead.',
} as const;

/** The link kinds a QR code may carry: Add a device, Get the app, an invite. */
export const SCANNABLE_KINDS: readonly LinkKind[] = ['d', 'w', 'i'];

/** What a code a scan opens is: the screen it ends on. */
export type ScannedLink = 'device' | 'workspace' | 'invite';

export type ScanVerdict =
    | { readonly kind: 'open'; readonly link: ScannedLink; readonly url: string }
    | { readonly kind: 'other-build' }
    | { readonly kind: 'not-socio' };

/** Longer than any link of Socio's: a code this long is something else, never parsed. */
export const SCAN_MAX_LENGTH = 2048;

/**
 * A scanned value as a link reads it: trimmed, with an `https://` scheme and its host in lower
 * case (a QR code may carry a URL in capitals, which its alphanumeric mode packs tighter). The
 * path and the fragment stay as they are: an invite's token is case-sensitive.
 */
export function scannedUrl(data: string): string {
    const text = data.trim();
    const match = /^(https:\/\/)([^/?#]*)(.*)$/is.exec(text);
    return match === null ? text : `https://${match[2]?.toLowerCase() ?? ''}${match[3] ?? ''}`;
}

/** The link hosts a Socio link may be on: production's, development's default and this build's. */
const linkHostsFor = (config: DeviceLinkConfig | null) => [
    ...new Set([LINK_HOST, LINK_STAGING_HOST, ...(config === null ? [] : [config.linkHost])]),
];

/**
 * What a scanned code is, for this build (`config`, its link host and variant; null in a build with
 * none, which opens nothing): one of its own links, a Socio link of another build, or anything else.
 */
export function classifyScan(data: string, config: DeviceLinkConfig | null): ScanVerdict {
    if (data.length > SCAN_MAX_LENGTH) {
        return { kind: 'not-socio' };
    }
    const url = scannedUrl(data);
    if (config !== null) {
        if (readDeviceLink(url, config) !== null) {
            return { kind: 'open', link: 'device', url };
        }
        if (readWorkspaceLink(url, config) !== null) {
            return { kind: 'open', link: 'workspace', url };
        }
        if (readInviteLink(url, config) !== null) {
            return { kind: 'open', link: 'invite', url };
        }
    }
    for (const host of linkHostsFor(config)) {
        const link = parseAppLink(url, host);
        const ours = config !== null && host === config.linkHost && link?.variant === config.variant;
        if (link !== null && SCANNABLE_KINDS.includes(link.kind) && !ours) {
            return { kind: 'other-build' };
        }
    }
    return { kind: 'not-socio' };
}

/** How the scanner hands a code over: it closes, then the link opens as one from outside would. */
export interface ScanHandOff {
    /** Closes the scanner, back to Add a workspace. */
    readonly close: () => void;
    /** Opens the link (root-navigation.tsx's `openExternalUrl`). */
    readonly open: (url: string) => void;
}

/** Where the scanner stands: reading, a code it refused (and its line), or handing one over. */
export type ScanState =
    | { readonly step: 'scanning' }
    | { readonly step: 'refused'; readonly data: string; readonly line: string }
    | { readonly step: 'opening' };

export const SCANNING: ScanState = { step: 'scanning' };

/**
 * A code the camera read, in `state`: this build's link closes the scanner and opens; anything else
 * shows its line, and the camera keeps reading. The code still in view while its refusal shows is
 * passed over (the camera reads it many times a second); another code is read at once. Nothing is
 * read while one is being handed over.
 */
export function scanCode(
    state: ScanState,
    data: string,
    config: DeviceLinkConfig | null,
    handOff: ScanHandOff,
): ScanState {
    if (state.step === 'opening' || (state.step === 'refused' && state.data === data)) {
        return state;
    }
    const verdict = classifyScan(data, config);
    if (verdict.kind === 'open') {
        handOff.close();
        handOff.open(verdict.url);
        return { step: 'opening' };
    }
    return { step: 'refused', data, line: verdict.kind === 'other-build' ? SCAN_COPY.otherBuild : SCAN_COPY.notSocio };
}

/** The camera permission, as expo-camera's `PermissionResponse` says it. */
export interface CameraPermission {
    readonly status: 'granted' | 'denied' | 'undetermined';
    readonly granted: boolean;
    readonly canAskAgain: boolean;
}

/**
 * The scanner's camera step:
 * - `checking`: the permission isn't read yet;
 * - `asking`: the system's prompt is due (never asked, or Android's first "Don't allow"), asked
 *   once per opening of the scanner, which only a tap on Scan opens;
 * - `denied`: refused; `canAsk` when the prompt may show again (Android), else only Settings can
 *   turn it on;
 * - `ready`: the camera runs.
 */
export type CameraStep =
    | { readonly step: 'checking' }
    | { readonly step: 'asking' }
    | { readonly step: 'denied'; readonly canAsk: boolean }
    | { readonly step: 'ready' };

export function cameraStep(permission: CameraPermission | null, asked: boolean): CameraStep {
    if (permission === null) {
        return { step: 'checking' };
    }
    if (permission.granted) {
        return { step: 'ready' };
    }
    if (!asked && (permission.status === 'undetermined' || permission.canAskAgain)) {
        return { step: 'asking' };
    }
    return { step: 'denied', canAsk: permission.canAskAgain };
}
