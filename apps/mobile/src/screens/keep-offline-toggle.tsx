import { Alert, Pressable } from 'react-native';

import { useKeptSpaces } from '../live';
import { KEEP_FAILED, KEEP_NEEDS_UPDATE, KEEP_OFFLINE_TOGGLE } from '../shell/keep-offline';
import { AppSymbol } from '../ui';

// The Space header's "Keep offline" toggle, in the Space's bar (CB-420, a
// custom bar item): a 44 pt ghost icon button that is a switch for
// screen readers. Kept, every page of the Space stays on the phone
// (src/sync/keep-offline.ts). A read-only user.db takes no change and says why.

export function KeepOfflineToggle({ spaceId }: { spaceId: string }) {
    const { ids, kept } = useKeptSpaces();
    const on = ids.includes(spaceId);
    const toggle = () => {
        if (!kept.writable) {
            Alert.alert(KEEP_NEEDS_UPDATE);
            return;
        }
        kept.set(spaceId, !on).catch((error: unknown) => {
            console.warn('[keep-offline] could not keep the choice', error);
            Alert.alert(KEEP_FAILED);
        });
    };
    return (
        <Pressable
            testID="space-keep-offline"
            accessibilityRole="switch"
            accessibilityLabel={KEEP_OFFLINE_TOGGLE.label}
            accessibilityHint={KEEP_OFFLINE_TOGGLE.hint}
            accessibilityState={{ checked: on }}
            onPress={toggle}
            className="min-h-11 min-w-11 items-center justify-center rounded-md bg-transparent active:bg-accent dark:active:bg-accent/50"
        >
            <AppSymbol name={on ? 'cloud-check' : 'cloud-download'} color={on ? 'primary' : 'muted-foreground'} />
        </Pressable>
    );
}
