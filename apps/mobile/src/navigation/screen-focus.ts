import { NavigationContext } from '@react-navigation/native';
import { useContext, useEffect, useState } from 'react';

// Whether the screen around a component is the one shown (CB-461): its
// navigator's focus, which leaves as soon as a page is pushed over it or
// another tab is chosen, before that page's keyboard shows. Unlike
// `useIsFocused`, it works outside a navigator (the sign-in and lock screens),
// where the screen is always the one shown.

/** Whether the surrounding screen is focused; true outside a navigator. */
export function useScreenFocused(): boolean {
    const navigation = useContext(NavigationContext);
    const [focused, setFocused] = useState(() => navigation?.isFocused() ?? true);
    useEffect(() => {
        if (navigation === undefined) {
            setFocused(true);
            return undefined;
        }
        setFocused(navigation.isFocused());
        const offFocus = navigation.addListener('focus', () => setFocused(true));
        const offBlur = navigation.addListener('blur', () => setFocused(false));
        return () => {
            offFocus();
            offBlur();
        };
    }, [navigation]);
    return focused;
}
