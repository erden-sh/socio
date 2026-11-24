import {
    createPathConfigForStaticNavigation,
    createStaticNavigation,
    getActionFromState,
    getStateFromPath,
    type Theme,
} from '@react-navigation/native';
import { useEffect } from 'react';
import { Linking, Platform } from 'react-native';

import { isDeviceLinkUrl, onDeviceLink, setDeviceScreenOpener } from '../platform/add-device';
import { isCodeLinkUrl, onCodeLink, setCodeScreenOpener, sweepCodeFlow } from '../platform/code-sign-in';
import { inviteLinks, setInviteScreenOpener } from '../platform/invite';
import { isSheetCallbackUrl, setSheetScreenOpener, sheetSignIns, sweepSheetFlow } from '../platform/sheet-sign-in';
import { BUILD_VARIANT } from '../platform/variant';
import { setWorkspaceScreenOpener, workspaceLinks } from '../platform/workspace-link';

import { setInAppOpener } from './in-app';
import { linkPrefix, pathFromUrl } from './linking';
import { createExternalLinks, type LinkNavigator, linkResolver } from './links';
import { type PresenceNavState, presencePath, screenPath } from './presence-path';
import { RootStack } from './root-stack';
import { redirectSteps, type ShellNavState, tabPageRedirect } from './shell-actions';

// The root stack's container, with its links. The variant, so the scheme its links use, comes from
// the config embedded in the build.

const variant = BUILD_VARIANT;

const pathConfig = { screens: createPathConfigForStaticNavigation(RootStack) ?? {} };

/** Taps from outside the app wait here until the root stack has the screen they open (links.ts). */
export const externalLinks = createExternalLinks({
    resolve: linkResolver(pathConfig, getStateFromPath, getActionFromState),
});

// A link in a message that names one of the app's screens opens it there (CB-413), never waiting.
setInAppOpener((path) => externalLinks.openNow(path));
// A sheet callback a link brought opens SheetSignIn through the queue, once the gate shows it.
setSheetScreenOpener(() => externalLinks.openRoute('SheetSignIn'));
// A sign-in code's link opens SignInCode the same way, when it isn't showing.
setCodeScreenOpener(() => externalLinks.openRoute('SignInCode'));
// Add a device's QR link opens AddDevice the same way, held until the gate shows it.
setDeviceScreenOpener(() => externalLinks.openRoute('AddDevice'));
// A Get the app link opens Add workspace's first screen the same way, which probes its host:
// back to the gate's root (over Confirm or the address), never a second copy of it.
setWorkspaceScreenOpener(() => externalLinks.openRoute('AddWorkspace', 'popTo'));
// An invite link opens Invite the same way, its token in memory only: back to the one copy
// of it when it shows, else pushed over the gate's root.
setInviteScreenOpener(() => externalLinks.openRoute('Invite', 'popTo'));

/**
 * Opens a URL from outside the app, if it's one of this variant's links. This build's sign-in
 * sheet callback (after Android killed the app, or the Custom Tab's App Link) is taken
 * only when it is the pending flow's, then opens SheetSignIn over the gate; any other does nothing.
 * A sign-in code's link fills the pending request's code in, or only shows the code.
 * Add a device's QR link opens AddDevice with it, which claims nothing until Continue.
 * A Get the app link opens Add workspace's first screen, which lands on Confirm.
 * An invite link opens Invite, which asks to join and sets the password.
 */
export function openExternalUrl(url: string | null | undefined) {
    if (url && isSheetCallbackUrl(url)) {
        void sheetSignIns.onLink(url);
        return;
    }
    if (url && isCodeLinkUrl(url)) {
        void onCodeLink(url);
        return;
    }
    if (url && isDeviceLinkUrl(url)) {
        onDeviceLink(url);
        return;
    }
    if (url && inviteLinks.receive(url)) {
        return;
    }
    if (url && workspaceLinks.receive(url)) {
        return;
    }
    const path = url ? pathFromUrl(url, variant) : null;
    if (path !== null) {
        externalLinks.open(path);
    }
}

// React Navigation gets the scheme and the paths (from the route table), so
// Link and useLinkTo work in screens, but not the URLs the OS opens the app
// with: those go through externalLinks, so none opens past the lock screen
// and one that comes while it shows opens once the gate does.
const linking = {
    prefixes: [linkPrefix(variant)],
    getInitialURL: () => null,
    subscribe: () => () => {},
};

const Navigation = createStaticNavigation(RootStack);

// The same two functions, taken out of externalLinks: the React Compiler reads
// `ref={externalLinks.attach}` as a ref read during render and leaves
// RootNavigation uncompiled (tests/react-compiler.test.ts).
const { attach, flush } = externalLinks;

/** The container, for the path the presence header names (presence-path.ts). */
let container: LinkNavigator | null = null;
const attachContainer = (navigator: LinkNavigator | null) => {
    container = navigator;
    return attach(navigator);
};
/** A waiting link may open, and the presence header follows the screen shown. */
const settled = () => {
    flush();
    screenPath.set(presencePath(container?.getRootState() as PresenceNavState | undefined));
};

/**
 * An action no navigator took: one naming a tab's page, dispatched from a sheet or a compose
 * page sheet on the root stack, opens it in the tabs (shell-actions.ts); anything else is a mistake.
 */
const unhandled = (action: { type: string; payload?: object }) => {
    const steps = tabPageRedirect(action, container?.getRootState() as ShellNavState | undefined);
    if (steps.length === 0 || container === null) {
        console.warn(`[navigation] no screen took ${action.type}`, action.payload);
        return;
    }
    const { now, later } = redirectSteps(steps, Platform.OS);
    for (const step of now) {
        container.dispatch(step);
    }
    if (later.length > 0) {
        // Android: the page goes once the sheet's removal has mounted (redirectSteps).
        requestAnimationFrame(() => {
            for (const step of later) {
                container?.dispatch(step);
            }
        });
    }
};

/** The launch URL is taken once per process, not again when the root remounts. */
let launchUrlTaken = false;

export function RootNavigation(props: { theme: Theme }) {
    useEffect(() => {
        if (!launchUrlTaken) {
            launchUrlTaken = true;
            // A sign-in sheet's flow past its 10 minutes goes first; one still live waits for its callback.
            sweepSheetFlow();
            sweepCodeFlow();
            Linking.getInitialURL().then(openExternalUrl, (error: unknown) =>
                console.warn('[links] reading the launch URL failed', error),
            );
        }
        const subscription = Linking.addEventListener('url', ({ url }) => openExternalUrl(url));
        return () => subscription.remove();
    }, []);
    return (
        <Navigation
            ref={attachContainer}
            theme={props.theme}
            linking={linking}
            onReady={settled}
            onStateChange={settled}
            onUnhandledAction={unhandled}
        />
    );
}
