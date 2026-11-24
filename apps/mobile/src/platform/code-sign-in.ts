import Constants from 'expo-constants';
import { Alert, Platform } from 'react-native';

import { formatCode } from '@socio/shared/device-sign-in';

import { type CodeFlow, createCodeFlow } from '../data/code-flow';
import { signInAndCommit } from '../data/sign-in-flow';
import { rootState } from '../navigation/root-gate';
import { deviceLabel } from '../net/sheet-sign-in';
import { redeemSignInCode } from '../net/sign-in';
import { codeLinkConfig, readCodeLink, requestSignInCode } from '../net/sign-in-codes';

import { randomBytes, sha256Base64, sha256Hex } from './crypto';
import { launchedStore } from './device-store';
import { appFetch } from './fetch';
import { finish } from './sign-in';
import { APP_USER_AGENT } from './user-agent';
import { BUILD_VARIANT } from './variant';

// Sign-in codes by email or Telegram, bound: src/data/code-flow.ts on the store's keys, the server's
// request and redeem through the app's fetch, `signInAndCommit` with the email (the install id and
// the person check), then the logo and the gate. A code link (root-navigation.ts) fills the pending
// request's code in on the SignInCode screen, opening it over the gate when it isn't showing;
// any other code link only shows its code.

const os = Platform.OS === 'ios' ? 'ios' : 'android';
const label = deviceLabel(os, Platform.OS === 'ios' && Platform.isPad);
const LINKS = codeLinkConfig(Constants.expoConfig?.extra, BUILD_VARIANT);

function store() {
    const launched = launchedStore();
    if (launched === null) {
        throw new Error('The store is not open.');
    }
    return launched.opened.store;
}

let flow: CodeFlow | null = null;

/** The pending code request on the open store; throws before the store opens. */
export function codeFlow(): CodeFlow {
    flow ??= createCodeFlow({
        keys: store().keys,
        randomBytes,
        sha256: sha256Base64,
        platform: os,
        variant: BUILD_VARIANT,
        links: LINKS,
        request: (input) => requestSignInCode({ ...input, fetch: appFetch, userAgent: APP_USER_AGENT }),
        redeem: (job, installId) =>
            redeemSignInCode({ ...job, installId, label, fetch: appFetch, userAgent: APP_USER_AGENT }),
        signIn: async ({ origin, email, logo, stage }) =>
            finish(
                await signInAndCommit(
                    {
                        origin,
                        email,
                        logo: logo.kind === 'file' ? `logo.${logo.extension}` : null,
                        stage,
                    },
                    { store: store(), hash: sha256Hex, fetch: appFetch, userAgent: APP_USER_AGENT, randomBytes },
                ),
                logo,
            ),
    });
    return flow;
}

/** A code a link filled in, waiting for the SignInCode screen; and who is listening for one. */
let filled: string | null = null;
const listeners = new Set<() => void>();
/** Whether the SignInCode screen is showing (it takes a filled code itself then). */
let screenShown = 0;

/** The SignInCode screen takes the code a link filled in, once. */
export function takeFilledCode(): string | null {
    const code = filled;
    filled = null;
    return code;
}

/** The SignInCode screen listens while it shows; resolves the stop. */
export function listenForFilledCode(listener: () => void): () => void {
    listeners.add(listener);
    screenShown += 1;
    return () => {
        listeners.delete(listener);
        screenShown -= 1;
    };
}

let openScreen: () => void = () => undefined;

/** root-navigation.ts hands over how SignInCode opens (links.ts's `openRoute`). */
export function setCodeScreenOpener(open: () => void): void {
    openScreen = open;
}

/** Whether `url` is shaped as this build's code link. */
export function isCodeLinkUrl(url: string): boolean {
    return LINKS !== null && readCodeLink(url, LINKS) !== null;
}

/** A code link from outside: fills the pending request's code in, or only shows the code. */
export async function onCodeLink(url: string): Promise<void> {
    let result: Awaited<ReturnType<CodeFlow['readLink']>>;
    try {
        result = await codeFlow().readLink(url);
    } catch (error) {
        console.warn('[code] the pending sign-in could not be read', error instanceof Error ? error.name : 'unknown');
        return;
    }
    if (result.kind === 'not-code-link') {
        return;
    }
    if (result.kind === 'show') {
        Alert.alert(
            'Your sign-in code',
            `${formatCode(result.code)}\n\nType it where you asked for it: Socio on that device, or your browser.`,
        );
        return;
    }
    filled = result.code;
    for (const listener of listeners) {
        listener();
    }
    if (screenShown === 0) {
        // Over the gate: after a kill the shell or the lock screen may show.
        if (rootState.get().active !== null) {
            rootState.setAdding(true);
        }
        openScreen();
    }
}

/** Deletes a pending request past its 15 minutes (launch). Best effort. */
export function sweepCodeFlow(): void {
    if (launchedStore() === null) {
        return;
    }
    codeFlow()
        .sweep()
        .catch((error: unknown) =>
            console.warn('[code] the pending sign-in was not swept', error instanceof Error ? error.name : 'unknown'),
        );
}
