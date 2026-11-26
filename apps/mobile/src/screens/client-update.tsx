import Constants from 'expo-constants';
import { type ReactNode, useState } from 'react';
import { Linking, Platform } from 'react-native';

import { useClientCompat, useHasWorkspaceScope, useWorkspaceScope } from '../live';
import { UPDATE_CHECK_LABEL, UPDATE_OPEN_LABEL, updateGateCopy } from '../shell/client-update';
import { workspaceTitle } from '../shell/session';
import { Banner, Button, Screen, Text, ToneTile } from '../ui';

import { Switcher } from './account';

// Update Socio (CB-553): the open workspace's server needs a newer app than
// this one (src/sync/client-compat.ts). It draws in place of the workspace's
// screens, as a workspace that didn't open does (workspace-failed.tsx), and only
// for that workspace: the switcher opens another one on the phone, which works
// as before, and Add a workspace signs in to a new one. Nothing is signed out
// or deleted: drafts, the outbox and the cache wait for the update. On iOS
// Open TestFlight opens TestFlight's app; Android only says where to look.
// Check again reads the server's numbers now; a return to the foreground does too.

const PLATFORM: 'ios' | 'android' = Platform.OS === 'ios' ? 'ios' : 'android';
const APP_NAME = Constants.expoConfig?.name ?? 'Socio';

/** The open workspace's screens, or Update Socio while its server needs a newer app. */
export function ClientUpdateGate({ children }: { children: ReactNode }) {
    return useHasWorkspaceScope() ? <Gate>{children}</Gate> : children;
}

function Gate({ children }: { children: ReactNode }) {
    return useClientCompat().required ? <UpdateRequired /> : children;
}

function openLink(link: string) {
    Linking.openURL(link).catch((error: unknown) => console.warn('[update] TestFlight not opened', error));
}

function UpdateRequired() {
    const scope = useWorkspaceScope();
    const state = useClientCompat();
    const [checking, setChecking] = useState(false);
    const copy = updateGateCopy(state, workspaceTitle(scope.workspace), PLATFORM, APP_NAME);
    const check = () => {
        setChecking(true);
        void scope.compat.check().finally(() => setChecking(false));
    };
    const link = copy.link;
    return (
        <Screen testID="update-required-screen">
            <ToneTile tone="mint" icon="cloud-download" />
            <Text accessibilityRole="header" variant="heading">
                {copy.title}
            </Text>
            <Text testID="update-required-body">{copy.body}</Text>
            <Text variant="subheadline" tone="muted">
                {copy.where}
            </Text>
            <Banner tone="info" testID="update-required-kept">
                {copy.kept}
            </Banner>
            {link === null ? null : (
                <Button
                    label={UPDATE_OPEN_LABEL}
                    icon="external-link"
                    onPress={() => openLink(link)}
                    testID="update-open-testflight"
                />
            )}
            <Button
                variant={link === null ? 'primary' : 'secondary'}
                label={UPDATE_CHECK_LABEL}
                icon="refresh-cw"
                busy={checking}
                onPress={check}
                testID="update-check-again"
            />
            <Switcher openId={scope.workspace.id} onOpen={check} />
        </Screen>
    );
}
