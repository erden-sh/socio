import { useEffect } from 'react';

/**
 * The height the app can use: the visual viewport's (above an open iOS
 * keyboard), else the window's. Whole pixels, so a fractional viewport
 * doesn't leave a hairline that scrolls.
 */
export function visibleHeight(view: { innerHeight: number; visualViewport?: { height: number } | null }) {
    return Math.round(view.visualViewport?.height || view.innerHeight);
}

/** A field that brings up the on-screen keyboard when focused. */
export function typingIn(element: Element | null) {
    if (!element) {
        return false;
    }
    if (element instanceof HTMLTextAreaElement) {
        return !element.readOnly;
    }
    if (element instanceof HTMLInputElement) {
        return (
            !element.readOnly &&
            !/^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/.test(element.type)
        );
    }
    return element instanceof HTMLElement && element.isContentEditable === true;
}

/**
 * A touch screen, whose on-screen keyboard can cover the page. A mouse's
 * window keeps its height (the same test as the 16px fields in
 * globals.css).
 */
export function touchKeyboard() {
    return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

/**
 * Below these visible heights while typing in a chat's composer, it needs
 * the room of what is above it (CB-155): `short` hides the workspace's
 * header (an iPhone in portrait, with the keyboard and its accessory bar
 * up), `tight` the chat's header and most padding too (a phone in
 * landscape). Above them (`open`), the chat fits with the text box at its
 * tallest; a new chat's welcome still gives way.
 */
export const SHORT_HEIGHT = 400;
export const TIGHT_HEIGHT = 300;

/**
 * An on-screen keyboard takes at least this much of the page; less is a
 * tablet's bar for a hardware keyboard, or the browser's own.
 */
export const KEYBOARD_MIN = 120;

/**
 * Whether an on-screen keyboard is up: the visible height is well short of
 * the page's (iOS covers the page), or of the tallest the page has been at
 * this width (Android's keyboard resizes it). Zoomed in, the visual
 * viewport is shorter by its scale, not by a keyboard.
 */
export function keyboardUp(
    view: {
        innerHeight: number;
        visualViewport?: { height: number; scale?: number } | null;
    },
    tallest = view.innerHeight,
) {
    const visible = view.visualViewport
        ? view.visualViewport.height * (view.visualViewport.scale || 1)
        : view.innerHeight;
    return Math.max(tallest, view.innerHeight) - visible >= KEYBOARD_MIN;
}

/**
 * The shell while typing on a touch screen (`typing`): its height, the
 * visible one, and, in a chat's composer (`composing`) with an on-screen
 * keyboard up (`keyboard`), how short that leaves it (`data-keyboard-room`
 * on <html>, the `keyboard-short` and `keyboard-tight` variants).
 * Otherwise neither: CSS's 100dvh.
 */
export function keyboardRoom(
    view: Parameters<typeof visibleHeight>[0],
    typing: boolean,
    composing = true,
    keyboard = true,
) {
    if (!typing) {
        return { height: '', room: '' };
    }
    const height = visibleHeight(view);
    return {
        height: `${height}px`,
        room: !composing || !keyboard ? '' : height < TIGHT_HEIGHT ? 'tight' : height < SHORT_HEIGHT ? 'short' : 'open',
    };
}

/** In a chat's composer, a new chat's, or a room's (CB-219). */
export function composing(element: Element | null) {
    return !!element?.closest(
        '[data-slot="chat-composer"], [data-slot="new-chat-composer"], [data-slot="room-composer"]',
    );
}

/**
 * Keeps `--app-height` on <html> at the visible height while the keyboard
 * can be up (CB-102), for the shell's inset (AppShell). A CSS viewport
 * unit can't do it on an iPhone: the installed app's keyboard covers the
 * page without changing `svh` or `dvh`, and iOS scrolls the document to
 * show the focused field, so the header went off the top while the
 * keyboard was up and the page could be scrolled past the composer into
 * blank space after. Sized to the visible height, the shell fits, and any
 * scroll iOS gives the document is undone: the transcript is the only
 * thing that scrolls.
 *
 * Only while a field has focus: once the keyboard closes, the installed
 * app's visual viewport can keep reporting the keyboard-open height, and
 * the shell stayed half the screen with blank space below. With no field
 * focused the property is removed and `100dvh` applies.
 *
 * Only on a touch screen, and only when the height changes: the property
 * is on <html>, so each change restyles the whole page (10 ms on a page,
 * 40 ms on Home), and on a desktop focusing a field did that for nothing,
 * twice, before the editor got its click's caret (CB-98).
 *
 * Measured again as the text changes, and a second time after focus, not
 * only on the viewport's own events (CB-155): the bar above an iPhone's
 * keyboard (⌃ ⌄ ✓) can come after the keyboard, and the composer grew
 * behind it. A measure is a read; only a new height restyles.
 *
 * The room is only for a keyboard that is up (`keyboardUp`), and goes
 * when `path` changes: another page starts with all of its chrome.
 */
export function useVisibleHeight(path?: string) {
    useEffect(() => {
        const root = document.documentElement;
        const viewport = window.visualViewport;
        let frame = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        // The tallest the page has been, by width (Android's keyboard
        // shrinks it; turning the phone changes the width).
        const tallest = new Map<number, number>();
        const update = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                const field = document.activeElement;
                const touch = touchKeyboard();
                const typing = touch && typingIn(field);
                // Keep one final correction when blur clears the keyboard's height.
                // Ordinary view scrolling must not write the document's scroll offset.
                const correctingKeyboard = typing || (touch && root.style.getPropertyValue('--app-height') !== '');
                const top = Math.max(tallest.get(window.innerWidth) ?? 0, window.innerHeight);
                tallest.set(window.innerWidth, top);
                const { height, room } = keyboardRoom(window, typing, composing(field), keyboardUp(window, top));
                if (root.style.getPropertyValue('--app-height') !== height) {
                    if (height) {
                        root.style.setProperty('--app-height', height);
                    } else {
                        root.style.removeProperty('--app-height');
                    }
                }
                if ((root.getAttribute('data-keyboard-room') ?? '') !== room) {
                    if (room) {
                        root.setAttribute('data-keyboard-room', room);
                    } else {
                        root.removeAttribute('data-keyboard-room');
                    }
                }
                if (correctingKeyboard && (window.scrollY || window.scrollX)) {
                    window.scrollTo(0, 0);
                }
            });
        };
        // The keyboard opening and closing: iOS fires the viewport's resize
        // late, or not at all, and its accessory bar can come later still.
        const settle = () => {
            update();
            clearTimeout(timer);
            timer = setTimeout(() => {
                update();
                timer = setTimeout(update, 700);
            }, 300);
        };
        update();
        viewport?.addEventListener('resize', update);
        viewport?.addEventListener('scroll', update);
        window.addEventListener('resize', update);
        window.addEventListener('scroll', update);
        window.addEventListener('focusin', settle);
        window.addEventListener('focusout', settle);
        // Typing: only a touch screen's keyboard changes what is visible.
        const typed = () => {
            if (touchKeyboard()) {
                update();
            }
        };
        window.addEventListener('input', typed);
        return () => {
            cancelAnimationFrame(frame);
            clearTimeout(timer);
            viewport?.removeEventListener('resize', update);
            viewport?.removeEventListener('scroll', update);
            window.removeEventListener('resize', update);
            window.removeEventListener('scroll', update);
            window.removeEventListener('focusin', settle);
            window.removeEventListener('focusout', settle);
            window.removeEventListener('input', typed);
            root.style.removeProperty('--app-height');
            root.removeAttribute('data-keyboard-room');
        };
    }, []);
    useEffect(() => {
        document.documentElement.removeAttribute('data-keyboard-room');
    }, [path]);
}
