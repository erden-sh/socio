import type { StaticScreenProps } from '@react-navigation/native';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useRef, useState } from 'react';
import { Alert, Linking, type TextInputInstance, View } from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';

import type { WorkspaceManifest } from '@socio/shared/device-sign-in';
import { characterFor } from '@socio/shared/mascot';

import type { SheetStart } from '../data/sheet-sign-ins';
import type { SignInOutcome } from '../data/sign-in-flow';
import { routeInVariant } from '../navigation/routes';
import { AbortedError } from '../net/errors';
import { signInManifest, signInWays } from '../net/sheet-sign-in';
import type { SignInProblem } from '../net/sign-in';
import { codeButtonLabel, codeChannel } from '../net/sign-in-codes';
import {
    otherPersonCopy,
    signInCopy,
    signInFooter,
    UNFINISHED,
    WELCOME_HEADLINE,
    welcomeLine,
} from '../net/sign-in-copy';
import { readWorkspaceManifest } from '../platform/add-workspace';
import { HAS_SHEET, sheetSignIns } from '../platform/sheet-sign-in';
import { signIn } from '../platform/sign-in';
import { BUILD_VARIANT } from '../platform/variant';
import { Banner, Button, Field, LOCAL_ART_MAX, LocalAvatar, Screen, Text } from '../ui';

import type { ConfirmWorkspaceParams } from './confirm-workspace';
import { PrivacyLink } from './legal-links';
import { WorkspaceHost } from './workspace-host';

// Signing in with an email and a password, after Confirm. The
// workspace's host from the URL stays in view. Every refusal is worded from the
// copy table (net/sign-in-copy.ts), never the server's text; test builds add the
// status and code under it. "Forgot password?" shows only when the workspace's
// `methods.emailReset` is on, and opens the workspace's web sign-in page, which has
// the reset form. No sign-up is offered, whatever `methods.signUp` says: accounts
// come only from an admin's invite (owner decision 2026-11-16; Google Play's
// account-deletion rule), so a newcomer is pointed at their invite link. Someone
// else's copy of the workspace on the phone asks first (Cancel is the default). A
// commit refreshes the root gate, which shows the shell.
//
// The ways in come from the manifest (`signInWays`): Continue opens the
// system sign-in sheet (passkeys, SSO, whatever the web offers) when the
// workspace has it and this build has a sheet, then the password form unless
// the workspace turned passwords off. A callback the sheet brings back opens
// SheetSignIn, which redeems and commits it; Cancel in the sheet changes nothing.
// With neither, the screen sends the person to the web. A sign-in code by the manifest's
// channel, "Email me a code" or "Send a code to my Telegram", opens SignInCode.
//
// Its header is the web's (the owner, 2026-11-18): the web's default Local, as the empty
// state draws it (ui/empty-state.tsx) at the largest size its art is drawn
// (LOCAL_ART_MAX, so it stays sharp), "Welcome back." in the web's h1, and "Sign in
// to <workspace>." under it. The Local steps aside while the keyboard is up, so the
// form fits a small phone (an iPhone SE) above it.

export type SignInParams = ConfirmWorkspaceParams;

/** This build is a test build (development or preview). */
const TEST_BUILD = routeInVariant('Diagnostics', BUILD_VARIANT);

export const COMMIT_FAILED = "Couldn't finish signing in on this phone. Try again.";

/** The sheet couldn't open or come back (the sheet's `failed`). */
export const SHEET_FAILED = "Socio couldn't open the sign-in window. Try again.";
/** The sheet came back, but its sign-in was no longer waiting (expired, or not this sign-in's). */
export const SHEET_NOT_FINISHED = "That sign-in didn't finish. Choose Continue to try again.";

/** This build has no sheet after all (a Personal Team build). */
export const SHEET_UNAVAILABLE =
    "This version of Socio can't open the sign-in window. Use the web for now: the button opens it in your browser.";
/** The workspace offers nothing this build can carry out. */
export const NO_WAY_IN =
    "This workspace's sign-in isn't available in this version of Socio. Use it on the web for now: the button opens it in your browser.";

export interface Shown {
    readonly line: string;
    readonly detail: string | null;
    readonly openWeb: boolean;
}

/** Asks before another person's copy is removed; resolves true on confirm. Cancel, back and a tap outside are Cancel. */
function confirmOtherPerson(unsent: number | null): Promise<boolean> {
    const copy = otherPersonCopy(unsent);
    return new Promise((resolve) => {
        Alert.alert(
            copy.title,
            copy.message,
            [
                { text: copy.cancel, style: 'cancel', onPress: () => resolve(false) },
                { text: copy.confirm, style: 'destructive', onPress: () => resolve(true) },
            ],
            { cancelable: true, onDismiss: () => resolve(false) },
        );
    });
}

/** What the screen shows for an outcome that didn't sign in; null once signed in. `line` words a refusal (the sign-in codes' own words). */
export async function settle(
    outcome: SignInOutcome,
    line: (problem: SignInProblem) => string = (problem) => signInCopy(problem).message,
): Promise<Shown | null> {
    switch (outcome.kind) {
        case 'committed':
            return null;
        case 'problem': {
            const copy = signInCopy(outcome.problem);
            const words = line(outcome.problem);
            const detail = [
                outcome.problem.status === null ? null : `HTTP ${outcome.problem.status}`,
                outcome.problem.code,
            ]
                .filter((part) => part !== null)
                .join(' · ');
            return {
                line: words,
                detail: TEST_BUILD && detail !== '' ? detail : null,
                openWeb: copy.action === 'open-web',
            };
        }
        case 'other-person':
            if (await confirmOtherPerson(outcome.unsent)) {
                return settle(await outcome.confirm(), line);
            }
            await outcome.cancel();
            return { line: '', detail: null, openWeb: false };
        case 'unfinished':
            return { line: UNFINISHED, detail: null, openWeb: false };
        case 'commit-failed':
            console.warn('[sign-in] commit failed', outcome.error.step, outcome.error.rolledBack);
            return { line: COMMIT_FAILED, detail: TEST_BUILD ? `step ${outcome.error.step}` : null, openWeb: false };
    }
}

/** What the screen shows after the sheet, or null for nothing (a callback, Cancel). */
function sheetShown(start: SheetStart): Shown | null {
    switch (start.kind) {
        case 'callback':
        case 'cancelled':
            return null;
        case 'refused':
            // The reason's kind only (expired, host, state…), never a value.
            return { line: SHEET_NOT_FINISHED, detail: TEST_BUILD ? start.reason : null, openWeb: false };
        case 'unavailable':
            return { line: SHEET_UNAVAILABLE, detail: null, openWeb: true };
        case 'failed':
            return {
                line: SHEET_FAILED,
                detail: TEST_BUILD ? [start.reason, start.detail].filter(Boolean).join(' · ') : null,
                openWeb: false,
            };
    }
}

export function SignInScreen({ route }: StaticScreenProps<SignInParams>) {
    const { origin, host, name, logo, methods } = route.params;
    const navigation = useNavigation();
    const [manifest, setManifest] = useState<WorkspaceManifest | null>(route.params.manifest ?? null);
    const ways = signInWays(manifest, HAS_SHEET);
    const sheet = ways.includes('sheet');
    const password = ways.includes('password');
    const channel = ways.includes('code') ? codeChannel(manifest) : null;
    const footer = signInFooter(methods, password);
    const [email, setEmail] = useState('');
    const [secret, setSecret] = useState('');
    const passwordField = useRef<TextInputInstance>(null);
    const [busy, setBusy] = useState(false);
    const [shown, setShown] = useState<Shown | null>(null);
    const controller = useRef<AbortController | null>(null);
    const keyboard = useKeyboardState((state) => state.isVisible);

    useEffect(() => () => controller.current?.abort(), []);

    // Signing in again comes with no manifest: read it, so the sheet is offered there too. Until it
    // comes, or when it can't be read, the password form shows as before.
    useEffect(() => {
        if (route.params.manifest != null) {
            return;
        }
        const reading = new AbortController();
        signInManifest(null, () => readWorkspaceManifest(origin, reading.signal)).then(
            (read) => {
                if (!reading.signal.aborted) {
                    setManifest(read);
                }
            },
            () => undefined,
        );
        return () => reading.abort();
    }, [origin, route.params.manifest]);

    const openWeb = () => {
        Linking.openURL(`${origin}/`).catch((error: unknown) => console.warn('[sign-in] browser not opened', error));
    };

    const submit = async () => {
        if (busy || email.trim() === '' || secret === '') {
            return;
        }
        const own = new AbortController();
        controller.current = own;
        setBusy(true);
        setShown(null);
        let next: Shown | null;
        try {
            next = await settle(await signIn({ origin, email, password: secret, logo, manifest, signal: own.signal }));
        } catch (error) {
            if (error instanceof AbortedError || own.signal.aborted) {
                return;
            }
            console.warn('[sign-in] failed', error instanceof Error ? error.name : 'unknown');
            next = { line: COMMIT_FAILED, detail: null, openWeb: false };
        }
        if (own.signal.aborted) {
            return;
        }
        setBusy(false);
        setShown(next !== null && next.line === '' ? null : next);
    };

    const continueInSheet = async () => {
        if (busy) {
            return;
        }
        setBusy(true);
        setShown(null);
        let start: SheetStart;
        try {
            start = await sheetSignIns.start({ origin, name, logo, manifest });
        } catch (error) {
            console.warn('[sign-in] sheet failed', error instanceof Error ? error.name : 'unknown');
            start = { kind: 'failed', reason: 'error', detail: null };
        }
        setBusy(false);
        if (start.kind === 'callback' && start.taken) {
            navigation.navigate('SheetSignIn');
            return;
        }
        setShown(sheetShown(start));
    };

    return (
        <Screen testID="sign-in-screen" centered edges={['right', 'bottom', 'left']}>
            <View className="items-center gap-2" testID="sign-in-welcome">
                {keyboard ? null : (
                    <LocalAvatar character={characterFor()} size={LOCAL_ART_MAX} testID="sign-in-local" />
                )}
                <Text accessibilityRole="header" variant="heading" className="text-center">
                    {WELCOME_HEADLINE}
                </Text>
                <Text variant="subheadline" tone="muted" className="text-center" testID="sign-in-welcome-line">
                    {welcomeLine(name)}
                </Text>
            </View>
            <WorkspaceHost host={host} testID="sign-in-host" />
            {sheet ? (
                <>
                    <Button
                        variant={password ? 'secondary' : 'primary'}
                        label="Continue"
                        onPress={() => void continueInSheet()}
                        busy={busy}
                        testID="sign-in-continue"
                    />
                    <Text variant="footnote" tone="muted" className="text-center" testID="sign-in-continue-hint">
                        {`Opens ${name}'s sign-in in a secure window: a passkey or your company's sign-in.`}
                    </Text>
                </>
            ) : null}
            {channel === null ? null : (
                <Button
                    variant={password || sheet ? 'secondary' : 'primary'}
                    label={codeButtonLabel(channel)}
                    onPress={() =>
                        navigation.navigate('SignInCode', { origin, host, name, logo, methods, manifest, channel })
                    }
                    disabled={busy}
                    testID="sign-in-code"
                />
            )}
            {(sheet || channel !== null) && password ? (
                <Text variant="subheadline" tone="muted" className="text-center" testID="sign-in-or">
                    or sign in with your password
                </Text>
            ) : null}
            {password ? (
                <>
                    <Field
                        label="Email"
                        value={email}
                        onChangeText={setEmail}
                        keyboardType="email-address"
                        autoCapitalize="none"
                        autoCorrect={false}
                        autoComplete="email"
                        textContentType="username"
                        returnKeyType="next"
                        submitBehavior="submit"
                        onSubmitEditing={() => passwordField.current?.focus()}
                        editable={!busy}
                        testID="sign-in-email"
                    />
                    <Field
                        ref={passwordField}
                        label="Password"
                        value={secret}
                        onChangeText={setSecret}
                        secureTextEntry
                        autoCapitalize="none"
                        autoCorrect={false}
                        autoComplete="current-password"
                        textContentType="password"
                        returnKeyType="go"
                        onSubmitEditing={() => void submit()}
                        editable={!busy}
                        testID="sign-in-password"
                    />
                </>
            ) : null}
            {ways.length === 0 ? (
                <Banner tone="error" testID="sign-in-no-way" action={{ label: 'Open in browser', onPress: openWeb }}>
                    {NO_WAY_IN}
                </Banner>
            ) : null}
            {shown === null ? null : (
                <Banner
                    tone="error"
                    testID="sign-in-problem"
                    action={shown.openWeb ? { label: 'Open in browser', onPress: openWeb } : undefined}
                >
                    {shown.line}
                </Banner>
            )}
            {shown?.detail == null ? null : (
                <Text variant="footnote" tone="muted" className="self-stretch" testID="sign-in-detail">
                    {shown.detail}
                </Text>
            )}
            {password ? (
                <Button
                    label="Sign in"
                    onPress={() => void submit()}
                    busy={busy}
                    disabled={email.trim() === '' || secret === ''}
                    testID="sign-in-submit"
                />
            ) : null}
            {footer.forgot ? (
                <Button variant="ghost" label="Forgot password?" onPress={openWeb} testID="sign-in-forgot" />
            ) : null}
            <Text variant="footnote" tone="muted" className="text-center" testID="sign-in-invite">
                {footer.newcomer}
            </Text>
            <PrivacyLink testID="sign-in-privacy" />
        </Screen>
    );
}
