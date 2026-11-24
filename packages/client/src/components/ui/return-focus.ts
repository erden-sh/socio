import { createContext, useContext } from 'react';

/**
 * Where a dialog gives the focus back on closing when nothing opened it
 * by its own trigger: a menu item that has gone with its menu, such as
 * the phone header's ⋯ (shell/header-menu.tsx). Radix would otherwise
 * focus the missing trigger and leave the focus on the body. Null (no
 * provider): Radix's own behavior.
 */
const ReturnFocusContext = createContext<HTMLElement | null>(null);

export const DialogReturnFocus = ReturnFocusContext.Provider;

/**
 * An `onCloseAutoFocus` that runs `own` first and then, unless it took
 * care of the focus, sends it to the context's element.
 */
export function useReturnFocus<E extends Event>(own?: (event: E) => void) {
    const target = useContext(ReturnFocusContext);
    return (event: E) => {
        own?.(event);
        if (event.defaultPrevented || !target?.isConnected) {
            return;
        }
        event.preventDefault();
        target.focus();
    };
}
