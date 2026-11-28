import { type ReactNode, useEffect } from 'react';
import { BackHandler, Keyboard, Platform, StyleSheet, View } from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';

// Update Socio over the workspace (CB-553): the workspace's screens stay
// mounted underneath, so a form being filled in (New Space, New room, an
// issue's edits) keeps what was typed while the gate is up, and is as it was
// once the server takes this app again. While `closed`:
// - the gate covers everything: on iOS in a FullWindowOverlay (react-native-
//   screens), added to the window above anything the navigator presents
//   natively (page sheets, form sheets, modals), which a plain view would sit
//   under; on Android a view over the root, which holds those too;
// - the cover is opaque edge to edge, in the screen color: the safe areas (the
//   home indicator's strip, Android's edge-to-edge system bars) are painted by
//   the cover itself, never left to the gate's content, so nothing of the
//   workspace shows through below it;
// - nothing underneath takes a touch or a screen reader's focus
//   (`pointerEvents`, `importantForAccessibility`, `accessibilityElementsHidden`),
//   and the gate is the accessibility modal;
// - the keyboard goes down as the gate closes, and Android's back is the
//   gate's, so it never navigates the hidden stack (the newest listener runs
//   first, and this one is added as the gate closes).
// The tree's shape doesn't depend on `closed`, so closing and opening the gate
// never mounts the screens again.

export function UpdateGateLayer({ closed, gate, children }: { closed: boolean; gate: ReactNode; children: ReactNode }) {
    useEffect(() => {
        if (!closed) {
            return undefined;
        }
        Keyboard.dismiss();
        const subscription = BackHandler.addEventListener('hardwareBackPress', () => true);
        return () => subscription.remove();
    }, [closed]);
    return (
        <View style={styles.fill}>
            <View
                style={[styles.fill, { pointerEvents: closed ? 'none' : 'auto' }]}
                importantForAccessibility={closed ? 'no-hide-descendants' : 'auto'}
                accessibilityElementsHidden={closed}
                testID="update-gate-underneath"
            >
                {children}
            </View>
            {closed ? <Cover>{gate}</Cover> : null}
        </View>
    );
}

function Cover({ children }: { children: ReactNode }) {
    const cover = (
        <View style={StyleSheet.absoluteFill} className="bg-screen" accessibilityViewIsModal testID="update-gate-cover">
            {children}
        </View>
    );
    return Platform.OS === 'ios' ? <FullWindowOverlay>{cover}</FullWindowOverlay> : cover;
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
