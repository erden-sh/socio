import { useNavigation } from '@react-navigation/native';
import { useEffect, useRef, useState } from 'react';

import { addByLink } from '../data/first-screen';
import { useRootState } from '../navigation/root-gate';
import { routeInVariant } from '../navigation/routes';
import { FIRST_SCREEN_COPY, firstScreenView, type LinkState } from '../net/first-screen';
import { cancelAdding } from '../platform/active-scope';
import { discardStaged, openKnown, probe, stage } from '../platform/add-workspace';
import { useHardwareBack } from '../platform/hardware-back';
import { takeSignInAgain } from '../platform/session';
import { BUILD_VARIANT } from '../platform/variant';
import { workspaceLinks } from '../platform/workspace-link';
import { Button, Screen, Text, ToneTile } from '../ui';

import { FirstScreenWays, LinkCard } from './first-screen-parts';
import { PrivacyLink } from './legal-links';

// Add workspace's first screen, where the app
// opens with no workspace on the device (the root gate). With no directory it can't find a
// workspace from an email, so it says the ways in, in order (net/first-screen.ts's words): the
// invite link, the QR code from Socio on a computer (a button: the app's own scanner, CB-566), and
// the address, which opens the address screen. It never lists workspaces.
//
// A Get the app link (platform/workspace-link.ts, held until the gate shows this screen, a cold
// start included) is taken here: its host shows through WorkspaceHost while it is checked and
// probed, then Confirm opens with the workspace filled in, one already on the device opens, or the
// refusal shows under the host. Opened from the drawer's "Add a workspace", it has Cancel
// (and Android's back), which goes back to the open workspace. Sign in again opens it with
// SignIn over it.

/** This build is a test build (development or preview), which has Diagnostics. */
const TEST_BUILD = routeInVariant('Diagnostics', BUILD_VARIANT);

export function AddWorkspaceScreen() {
    const navigation = useNavigation();
    const [link, setLink] = useState<LinkState | null>(null);
    const controller = useRef<AbortController | null>(null);
    // Adding another: a workspace is on the device to go back to.
    const adding = useRootState().active !== null;
    useHardwareBack(adding ? cancelAdding : null);
    const view = firstScreenView({ adding, testBuild: TEST_BUILD, link });

    useEffect(() => {
        // What a kill left staged, before anything new is.
        discardStaged().catch((error: unknown) => console.warn('[add-workspace] staging not cleared', error));
        return () => controller.current?.abort();
    }, []);

    useEffect(() => {
        // Sign in again (the Expired banner, the lock screen): straight on to SignIn, with this screen under it.
        const again = takeSignInAgain();
        if (again !== null) {
            navigation.navigate('SignIn', again);
        }
    }, [navigation]);

    useEffect(() => {
        // A Get the app link: the one waiting at mount (a cold start), then each that comes while this shows.
        const check = async () => {
            const taken = workspaceLinks.take();
            if (taken === null) {
                return;
            }
            controller.current?.abort();
            const own = new AbortController();
            controller.current = own;
            setLink({ step: 'checking', host: taken.host });
            const outcome = await addByLink(taken, BUILD_VARIANT, own.signal, {
                probe,
                stage,
                openKnown,
                testBuild: TEST_BUILD,
            });
            if (controller.current !== own) {
                return;
            }
            if (outcome.kind === 'found') {
                setLink(null);
                navigation.navigate('ConfirmWorkspace', outcome.workspace);
            } else if (outcome.kind === 'problem') {
                setLink({ step: 'refused', host: taken.host, ...outcome.problem });
            } else if (outcome.kind === 'failure') {
                setLink({ step: 'refused', host: taken.host, line: FIRST_SCREEN_COPY.failure, detail: null });
            } else {
                setLink(null);
            }
        };
        void check();
        return workspaceLinks.listen(() => void check());
    }, [navigation]);

    return (
        <Screen testID="add-workspace-screen" centered>
            <ToneTile tone="mint" icon="building-2" />
            <Text accessibilityRole="header" variant="heading" className="text-center">
                {view.title}
            </Text>
            <Text variant="subheadline" tone="muted" className="text-center">
                {view.lead}
            </Text>
            {view.link === null ? null : <LinkCard link={view.link} />}
            <FirstScreenWays
                ways={view.ways}
                onScan={() => navigation.navigate('ScanQr')}
                onAddress={() => navigation.navigate('WorkspaceAddress')}
            />
            {view.cancel ? (
                <Button variant="ghost" label="Cancel" onPress={cancelAdding} testID="add-workspace-cancel" />
            ) : null}
            {view.diagnostics ? (
                <Button
                    variant="ghost"
                    label="Diagnostics"
                    icon="stethoscope"
                    onPress={() => navigation.navigate('Diagnostics')}
                    testID="open-diagnostics"
                />
            ) : null}
            <PrivacyLink testID="add-workspace-privacy" />
        </Screen>
    );
}
