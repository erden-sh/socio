import { activeScope } from '../platform/active-scope';
import { Banner, Button, Screen, Text } from '../ui';

import { Switcher } from './account';

// The active workspace's scope didn't open (src/sync/active-scope.ts): its
// cache key is gone, or its database couldn't be read. Nothing was deleted.
// Try again opens it again; the switcher opens another workspace on the phone,
// and Add a workspace signs in to a new one, so the person is never stuck on
// one that can't open.

function retry() {
    void activeScope.retry();
}

export function WorkspaceFailed({ workspaceId }: { workspaceId: string }) {
    return (
        <Screen testID="workspace-failed-screen">
            <Text accessibilityRole="header" variant="heading">
                This workspace couldn’t open
            </Text>
            <Banner tone="error">Its data on this phone couldn’t be read. Nothing was deleted.</Banner>
            <Button label="Try again" icon="rotate-ccw" onPress={retry} testID="workspace-try-again" />
            <Switcher openId={workspaceId} onOpen={retry} failed />
        </Screen>
    );
}
