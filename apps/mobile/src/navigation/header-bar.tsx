import { Pressable } from 'react-native';

import { AppSymbol } from '../ui';

import { BACK_ICON_SIZE, backButtonLayout } from './header-layout';

// The app's own Back, for the one screen that draws its own top row
// (New chat, the first run's screen, whose socio picker is its heading). Every
// other page has the system's bar and Back (CB-420, presets.ts): the drawn
// HeaderBar is retired. Its edges are the page's: the
// chevron's stroke starts at the content's 16 pt edge and what follows it at
// BACK.titleStart (header-layout.ts has the numbers); hitSlop makes its target 44 pt.

const BACK = backButtonLayout();

/**
 * Back, for a row that pads the content's 16 pt at its start (New chat's): the chevron's stroke on that edge, what follows
 * it at BACK.titleStart, and a 44 pt target.
 */
export function BackButton({ onPress }: { onPress: () => void }) {
    return (
        <Pressable
            testID="header-back"
            accessibilityRole="button"
            accessibilityLabel="Back"
            onPress={onPress}
            hitSlop={BACK.hitSlop}
            className="justify-center rounded-md active:bg-accent dark:active:bg-accent/50"
            style={{
                marginLeft: BACK.marginLeft,
                paddingLeft: BACK.paddingLeft,
                width: BACK.width,
                height: BACK.height,
            }}
        >
            <AppSymbol name="chevron-left" size={BACK_ICON_SIZE} />
        </Pressable>
    );
}
