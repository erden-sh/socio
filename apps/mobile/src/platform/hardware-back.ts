import { useFocusEffect } from '@react-navigation/native';
import { useCallback } from 'react';
import { BackHandler } from 'react-native';

// Android's back button for a screen at the root of its gate, where React
// Navigation has nothing to go back to and would leave the app.

/** While the screen is in view and `onBack` is set, Android's back calls it instead of leaving the app. */
export function useHardwareBack(onBack: (() => void) | null): void {
    useFocusEffect(
        useCallback(() => {
            if (onBack === null) {
                return undefined;
            }
            const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
                onBack();
                return true;
            });
            return () => subscription.remove();
        }, [onBack]),
    );
}
