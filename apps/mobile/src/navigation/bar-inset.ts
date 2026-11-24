import { useAnimatedHeaderHeight } from '@react-navigation/native-stack';
import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { hasLiquidGlass } from '../ui/glass';

import { iosCompactBar, nativeBarOverlays } from './presets';

// How far a page's native bar (CB-417, CB-420) reaches over the page: its
// height on iOS, where it lies over the page, and 0 on Android, where it sits
// above. A page whose content UIKit can't inset for it (a WebView, a list that
// keeps its end in view, a page that doesn't scroll) pads by it, so its first
// line starts below the bar and the rest scrolls under it. The system's
// height comes through native-stack's animated header height, which on Fabric
// often never reports a screen's first height (native-stack says so), so the
// seed is the bar's real height: iOS 26's is 54 pt (`iosCompactBar`, CB-456).

/** How far the native bar lies over the page: its height on iOS, 0 on Android, where it sits above. */
export function useBarInset(): number {
    const insets = useSafeAreaInsets();
    const animated = useAnimatedHeaderHeight();
    const overlays = nativeBarOverlays(Platform.OS);
    const [height, setHeight] = useState(() => insets.top + iosCompactBar(hasLiquidGlass()));
    const last = useRef(height);
    useEffect(() => {
        const id = animated.addListener(({ value }) => {
            // Whole points: a fraction would send the WebView a new inset on every frame of a push.
            const next = Math.round(value);
            if (next > 0 && next !== last.current) {
                last.current = next;
                setHeight(next);
            }
        });
        return () => animated.removeListener(id);
    }, [animated]);
    return overlays ? height : 0;
}
