import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * The element with the focus now, as what a dialog opening returns to: a
 * menu's item goes with its menu, so for one its menu's ⋯ (Radix gives
 * the open menu's trigger `aria-controls`).
 */
function opener(): HTMLElement | null {
    if (typeof document === 'undefined') {
        return null;
    }
    const active = document.activeElement;
    const menu = active?.closest('[role="menu"]');
    const trigger = menu?.id
        ? // Radix's ids: letters, digits, `_`, `-` and `:`, quoted here.
          document.querySelector<HTMLElement>(`[aria-controls="${menu.id}"]`)
        : null;
    if (trigger) {
        return trigger;
    }
    return active instanceof HTMLElement && active !== document.body ? active : null;
}

/** Inside a dialog's content: what had the focus as it opened. */
function OpenedFrom({ into }: { into: RefObject<HTMLElement | null> }) {
    // Read as it first renders, before the dialog (or a field's autoFocus)
    // takes the focus.
    const [from] = useState(opener);
    useEffect(() => {
        into.current = from;
    }, [into, from]);
    return null;
}

/**
 * Where focus goes back to as a room dialog closes (CB-219). Radix sends
 * it to the dialog's own trigger, and these dialogs open from a sidebar
 * button, a notice or a menu item, never a `DialogTrigger`: without this,
 * closing one left the focus on the page's body. `mark` goes inside the
 * dialog's content; `onCloseAutoFocus` on it gives the focus back to what
 * opened it, if that is still on the page.
 */
export function useFocusReturn() {
    const back = useRef<HTMLElement | null>(null);
    return {
        mark: <OpenedFrom into={back} />,
        onCloseAutoFocus: (event: Event) => {
            // Kept: a dialog of two steps (two Radix dialogs) closes twice.
            const target = back.current;
            if (!target?.isConnected) {
                return;
            }
            event.preventDefault();
            target.focus();
        },
    };
}
