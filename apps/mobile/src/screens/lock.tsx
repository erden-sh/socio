import { useEffect, useState } from 'react';

import type { WorkspaceRow } from '../data/registry';
import { useRootState } from '../navigation/root-gate';
import { readWorkspace } from '../platform/active-scope';
import { signInAgain } from '../platform/session';
import { lockCopy, SIGN_IN_AGAIN } from '../shell/session';
import { Banner, Button, Screen, Text, ToneTile } from '../ui';

import { Switcher } from './account';

// What the app shows first when the active workspace's copy is locked (the
// root gate): Ended, or its lease ran out. Nothing of the workspace
// shows, its outbox is kept, and "Sign in to see <workspace>" signs the same
// person in again, which brings everything back. Under a lease lock it says
// when the copy is erased. The switcher and Add a workspace stay, so the
// person is never stuck on a locked copy.

/** The active workspace's row, read from the registry when the lock screen shows it. */
function useLockedWorkspace(): WorkspaceRow | null {
    const id = useRootState().active?.id ?? null;
    const [row, setRow] = useState<WorkspaceRow | null>(null);
    useEffect(() => {
        let current = true;
        if (id !== null) {
            readWorkspace(id).then(
                (read) => {
                    if (current) {
                        setRow(read);
                    }
                },
                (error: unknown) => console.warn('[lock] the workspace could not be read', error),
            );
        }
        return () => {
            current = false;
        };
    }, [id]);
    return row !== null && row.id === id ? row : null;
}

export function LockScreen() {
    const row = useLockedWorkspace();
    if (row === null) {
        return <Screen testID="lock-screen">{null}</Screen>;
    }
    const copy = lockCopy(row);
    return (
        <Screen testID="lock-screen">
            <ToneTile tone="slate" icon="lock-keyhole" />
            <Text accessibilityRole="header" variant="heading">
                {copy.title}
            </Text>
            {copy.wipeAt === null ? (
                <Text variant="subheadline" tone="muted">
                    {copy.body}
                </Text>
            ) : (
                <Banner tone="warning" testID="lease-deadline">
                    {copy.body}
                </Banner>
            )}
            <Button label={SIGN_IN_AGAIN} icon="log-in" onPress={() => signInAgain(row)} testID="lock-sign-in" />
            <Switcher openId={row.id} onOpen={() => signInAgain(row)} />
        </Screen>
    );
}
