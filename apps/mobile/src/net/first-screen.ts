import { parseAppLink } from '@socio/shared/device-sign-in';

import type { DeviceLinkConfig } from './add-device';

// Add workspace's first screen, the parts with
// no React Native: its words, the workspace link read back, and the view the screen draws. With no
// directory the app can't find a workspace from an email, so the screen only says the
// ways in, in this order, and never lists workspaces:
//
// 1. the invite link an admin sent (src/data/invite.ts opens it);
// 2. the QR code from Socio on a computer: Get the app (a `w` link, the workspace only) or Add a
//    device (a `d` link, src/data/add-device.ts), read by the app's own scanner (CB-566,
//    qr-scan.ts), which opens either as the link from outside would;
// 3. the workspace's address, typed: the address screen.
//
// A `w` link (`https://<link host>/<variant path>/w/<host>`, @socio/shared's `parseAppLink`, the
// workspace only and nothing secret) is taken only for this build's link host and variant. The screen
// checks its host as a typed address and probes it, then opens Confirm with the workspace filled in.

/** Every word the first screen shows: one place, tested (the copy table). "Device", never "phone". */
export const FIRST_SCREEN_COPY = {
    title: 'Add a workspace',
    lead: 'Get into your workspace one of these ways.',
    ways: [
        {
            id: 'invite',
            title: 'Open your invite link',
            detail: 'Your admin sent it to you. Open it on this device.',
        },
        {
            id: 'qr',
            title: 'Scan the QR code from Socio on a computer',
            detail: 'On Socio, choose Get the app, or Add a device to sign in at once.',
        },
        {
            id: 'address',
            title: 'Enter your workspace address',
            detail: 'Your company gives it to you.',
        },
    ],
    /** While a workspace link's host is checked and probed. */
    checking: 'Finding your workspace…',
    /** Anything the probe didn't word (it threw). */
    failure: "Couldn't continue. Try again.",
} as const;

export type FirstScreenWayId = (typeof FIRST_SCREEN_COPY.ways)[number]['id'];

/** The address screen's words (the typed address, reached from the first screen's third way). */
export const ADDRESS_COPY = {
    title: 'Your workspace address',
    lead: 'Enter your workspace’s web address. Your company gives it to you.',
    label: 'Workspace address',
    placeholder: 'brain.example.com',
    failure: FIRST_SCREEN_COPY.failure,
} as const;

/** A Get the app link read back: the workspace's host only (`URL.host`, a port kept). */
export interface WorkspaceLink {
    readonly host: string;
}

/**
 * The Get the app link in `url`, or null when it isn't this build's: another link host, another
 * variant's path, another kind, a query or any fragment (a `w` link carries none).
 */
export function readWorkspaceLink(url: string, config: DeviceLinkConfig): WorkspaceLink | null {
    const link = parseAppLink(url, config.linkHost);
    if (link === null || link.kind !== 'w' || link.variant !== config.variant) {
        return null;
    }
    return { host: link.host };
}

/** Where a workspace link stands on the first screen: being checked, or refused with its line. */
export type LinkState =
    | { readonly step: 'checking'; readonly host: string }
    | { readonly step: 'refused'; readonly host: string; readonly line: string; readonly detail: string | null };

export interface FirstScreenInput {
    /** Adding another workspace: one is on the device to go back to (Cancel). */
    readonly adding: boolean;
    /** A development or preview build (Diagnostics, and the probe's details under a refusal). */
    readonly testBuild: boolean;
    readonly link: LinkState | null;
}

export interface FirstScreenWay {
    readonly id: FirstScreenWayId;
    readonly title: string;
    readonly detail: string;
    /** The QR code (the scanner) and the address are buttons: the invite happens outside the app. */
    readonly pressable: boolean;
    readonly testID: string;
}

export interface FirstScreenView {
    readonly title: string;
    readonly lead: string;
    readonly ways: readonly FirstScreenWay[];
    /** A workspace link's host (always shown through WorkspaceHost) with what is happening to it. */
    readonly link: {
        readonly host: string;
        readonly busy: boolean;
        readonly line: string;
        readonly detail: string | null;
    } | null;
    readonly cancel: boolean;
    readonly diagnostics: boolean;
}

/** What the first screen draws. Never a list of workspaces: there is none to show. */
export function firstScreenView({ adding, testBuild, link }: FirstScreenInput): FirstScreenView {
    return {
        title: FIRST_SCREEN_COPY.title,
        lead: FIRST_SCREEN_COPY.lead,
        ways: FIRST_SCREEN_COPY.ways.map((way) => ({
            ...way,
            pressable: way.id !== 'invite',
            testID: `first-screen-${way.id}`,
        })),
        link:
            link === null
                ? null
                : link.step === 'checking'
                  ? { host: link.host, busy: true, line: FIRST_SCREEN_COPY.checking, detail: null }
                  : { host: link.host, busy: false, line: link.line, detail: testBuild ? link.detail : null },
        cancel: adding,
        diagnostics: testBuild,
    };
}
