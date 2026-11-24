import { useNavigation } from '@react-navigation/native';
import type { StaticScreenProps } from '@react-navigation/native';
import { Image } from 'expo-image';
import { useEffect } from 'react';

import type { SignInMethods } from '@socio/shared/auth';
import type { WorkspaceManifest } from '@socio/shared/device-sign-in';

import MASCOT from '../../assets/icon-512.png';
import type { StagedLogo } from '../data/logo';
import { discardStaged } from '../platform/add-workspace';
import { fileUri } from '../platform/file-system';
import { Button, Screen, Text } from '../ui';

import { WorkspaceHost } from './workspace-host';

// The workspace the address led to, before signing in:
// its logo, its name, and its host from
// the URL with the registrable domain emphasized. The logo is the staged file
// (data/logo.ts), shown from memory only, or the bundled mascot. Leaving the
// screen deletes the staged logo; the sign-in commit moves it into
// the workspace's directory first. Continue goes to SignIn, with this screen
// under it, so the staged logo stays until the sign-in commits or Back.

export type ConfirmWorkspaceParams = {
    readonly origin: string;
    readonly host: string;
    readonly name: string;
    readonly logo: StagedLogo;
    /** Its sign-in methods from the probe; null when the answer had none (mock auth). */
    readonly methods: SignInMethods | null;
    /** Its manifest from the probe, kept at the commit; null or absent on a server with none. */
    readonly manifest?: WorkspaceManifest | null;
};

export function ConfirmWorkspaceScreen({ route }: StaticScreenProps<ConfirmWorkspaceParams>) {
    const navigation = useNavigation();
    const { host, name, logo } = route.params;

    useEffect(
        () => () => {
            discardStaged().catch((error: unknown) => console.warn('[add-workspace] staging not cleared', error));
        },
        [],
    );

    return (
        <Screen testID="confirm-workspace-screen" centered edges={['right', 'bottom', 'left']}>
            <Image
                testID="workspace-logo"
                source={logo.kind === 'file' ? { uri: fileUri(logo.path) } : MASCOT}
                cachePolicy="memory"
                contentFit="contain"
                accessibilityIgnoresInvertColors
                style={{ width: 96, height: 96, borderRadius: 20 }}
            />
            <Text accessibilityRole="header" variant="heading" className="text-center">
                {name}
            </Text>
            <WorkspaceHost host={host} testID="workspace-host" />
            <Button
                label="Continue"
                onPress={() => navigation.navigate('SignIn', route.params)}
                testID="confirm-workspace-continue"
            />
            <Button variant="ghost" label="Back" onPress={() => navigation.goBack()} testID="confirm-workspace-back" />
        </Screen>
    );
}
