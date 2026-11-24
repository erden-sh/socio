import { ActivityIndicator } from 'react-native';

import { signOut, type SignOutStatus } from '../platform/sign-out';
import { Banner, Button, Screen, Text } from '../ui';

// Signing out (src/platform/sign-out.ts): drawn in place of the root
// stack while the workspace is wiped, so nothing of it draws and nothing
// navigates until the wipe is verified. If it didn't finish, the workspace is
// already marked: Try again finishes it, and so does the next launch.

export function SigningOut({ status }: { status: Exclude<SignOutStatus, { kind: 'idle' }> }) {
    if (status.kind === 'signing-out') {
        return (
            <Screen testID="signing-out-screen" centered>
                <ActivityIndicator accessibilityLabel="Signing out" />
                <Text variant="subheadline" tone="muted" className="text-center">
                    Signing out and removing this workspace from your phone…
                </Text>
            </Screen>
        );
    }
    return (
        <Screen testID="sign-out-failed-screen" centered>
            <Text accessibilityRole="header" variant="heading" className="text-center">
                Signing out didn’t finish
            </Text>
            <Banner tone="error">
                Some of this workspace’s data is still on your phone. Try again to remove it; Socio also finishes this
                the next time it opens.
            </Banner>
            <Button
                label="Try again"
                icon="rotate-ccw"
                onPress={() => void signOut(status.workspaceId)}
                testID="sign-out-try-again"
            />
        </Screen>
    );
}
