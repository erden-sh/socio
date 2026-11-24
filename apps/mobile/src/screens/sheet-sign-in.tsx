import { useNavigation } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import { ActivityIndicator } from 'react-native';

import { sheetSignIns } from '../platform/sheet-sign-in';
import { Banner, Button, Screen, Text } from '../ui';

import { COMMIT_FAILED, settle, type Shown } from './sign-in';
import { WorkspaceHost } from './workspace-host';

// Finishing a sign-in through the system sheet: the sheet's callback was taken
// (src/platform/sheet-sign-in.ts), from the sheet's own answer or, after Android killed the app,
// from its link (root-navigation.ts opens this screen over the gate). It redeems the code and
// commits as the password form does: the same words for each outcome, the same another-person
// question. Once it commits, the root gate shows the workspace. Back on a problem goes to where
// the person started (SignIn, or Add workspace after a kill), where Continue starts again.

const NOTHING_WAITING = 'This sign-in has already finished or expired. Go back and choose Continue to start again.';

/** The host to show from the workspace's origin. */
const hostOf = (origin: string) => {
    try {
        return new URL(origin).host;
    } catch {
        return origin;
    }
};

export function SheetSignInScreen() {
    const navigation = useNavigation();
    const [workspace] = useState(() => sheetSignIns.ready());
    const [shown, setShown] = useState<Shown | null>(null);
    const [done, setDone] = useState(workspace === null);

    useEffect(() => {
        let live = true;
        if (workspace === null) {
            return;
        }
        // This screen's own callback, by its ticket: one run however often the effect runs, and no
        // other screen's outcome. Never aborted: a sign-in the person approved finishes even when
        // they leave this screen.
        sheetSignIns
            .finish(workspace.ticket)
            .then(async (outcome) => (outcome === null ? null : settle(outcome)))
            .catch((error: unknown) => {
                console.warn('[sheet] sign-in failed', error instanceof Error ? error.name : 'unknown');
                return { line: COMMIT_FAILED, detail: null, openWeb: false } satisfies Shown;
            })
            .then((next) => {
                if (live) {
                    setShown(next);
                    setDone(true);
                }
            });
        return () => {
            live = false;
        };
    }, [workspace]);

    const host = workspace === null ? null : hostOf(workspace.origin);
    return (
        <Screen testID="sheet-sign-in-screen" centered edges={['right', 'bottom', 'left']}>
            <Text accessibilityRole="header" variant="heading" className="text-center">
                {workspace === null ? 'Signing in' : `Signing in to ${workspace.name}`}
            </Text>
            {host === null ? null : <WorkspaceHost host={host} testID="sheet-sign-in-host" />}
            {done ? null : <ActivityIndicator accessibilityLabel="Signing in" testID="sheet-sign-in-busy" />}
            {workspace === null ? (
                <Banner tone="error" testID="sheet-sign-in-problem">
                    {NOTHING_WAITING}
                </Banner>
            ) : shown === null || shown.line === '' ? null : (
                <Banner tone="error" testID="sheet-sign-in-problem">
                    {shown.line}
                </Banner>
            )}
            {shown?.detail == null ? null : (
                <Text variant="footnote" tone="muted" className="self-stretch" testID="sheet-sign-in-detail">
                    {shown.detail}
                </Text>
            )}
            {done && (workspace === null || shown !== null) ? (
                <Button
                    label="Back"
                    variant="secondary"
                    onPress={() => navigation.goBack()}
                    testID="sheet-sign-in-back"
                />
            ) : null}
        </Screen>
    );
}
