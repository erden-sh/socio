import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

import { useTranslation } from '@socio/i18n/react';
import { threadRunning } from '@socio/shared/chat/thread-running';

/**
 * A computer (Windows, macOS, Linux, ChromeOS) rather than a phone or
 * tablet. Many Windows laptops and monitors have a touch screen and some
 * browsers there report a coarse, hover-less pointer (CB-115), so the
 * pointer media query alone can't tell them from a phone. An iPad that
 * asks for the desktop site calls itself a Mac; it has touch points.
 */
function desktopSystem() {
    if (typeof navigator === 'undefined') {
        return false;
    }
    const { userAgent, maxTouchPoints } = navigator;
    if (/Android|iPhone|iPad|iPod/.test(userAgent)) {
        return false;
    }
    if (/Macintosh/.test(userAgent)) {
        return !(maxTouchPoints > 1);
    }
    return /Windows NT|X11|CrOS/.test(userAgent);
}

/**
 * A touch screen with no mouse: a phone's on-screen keyboard, where Enter
 * is the only way to start a new line, so it doesn't send; the send button
 * does. A computer never counts, whatever its screen reports (CB-115).
 */
export function touchTyping() {
    return (
        typeof matchMedia === 'function' &&
        matchMedia('(hover: none) and (pointer: coarse)').matches &&
        !desktopSystem()
    );
}

/**
 * Enter and Ctrl+Enter (Cmd+Enter on a Mac) send; Shift+Enter adds a line.
 * On a phone's keyboard plain Enter adds a line too, but Ctrl+Enter still
 * sends, as it is only ever typed on a hardware keyboard. Never while an
 * IME is composing: its Enter picks a candidate.
 */
export function shouldSubmitComposerOnKeyDown(
    event: {
        key: string;
        shiftKey: boolean;
        ctrlKey?: boolean;
        metaKey?: boolean;
        nativeEvent: {
            isComposing?: boolean;
            keyCode?: number;
        };
    },
    touch = touchTyping(),
) {
    const chord = !!(event.ctrlKey || event.metaKey);
    return (
        event.key === 'Enter' &&
        !event.shiftKey &&
        (chord || !touch) &&
        !event.nativeEvent.isComposing &&
        event.nativeEvent.keyCode !== 229
    );
}

/**
 * Focuses a composer's text box once, when `ready`, so a new chat can be
 * typed in at once (CB-116). Not on a phone or tablet, where it would raise
 * the on-screen keyboard over the chat; not over an open dialog, and not
 * when the person is already typing in another field.
 */
export function useFocusOnOpen(ref: RefObject<HTMLTextAreaElement | null>, ready: boolean) {
    const done = useRef(false);
    useEffect(() => {
        const box = ref.current;
        if (!ready || done.current || !box) {
            return;
        }
        done.current = true;
        if (touchTyping() || blockedFocus(box)) {
            return;
        }
        box.focus({ preventScroll: true });
    }, [ready, ref]);
}

function blockedFocus(box: HTMLElement) {
    const { activeElement } = box.ownerDocument;
    return (
        !!box.ownerDocument.querySelector(
            '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
        ) ||
        (activeElement instanceof HTMLElement &&
            activeElement !== box &&
            activeElement.matches('input, textarea, select, [contenteditable]'))
    );
}

/**
 * A message the server never took for its size (CB-156): a run's 413. A
 * chat's request carries only what is new in it, so this is the message
 * itself: its text goes back in the box. Its key (chat.composer).
 */
export const UNSENT_TOO_LONG = 'chat.composer:unsent.too-long';

/** Whether the server refused a request for its size (413). */
export function refusedForSize(error: unknown): boolean {
    return !!error && typeof error === 'object' && (error as { status?: unknown }).status === 413;
}

/** The chat's own words for a failed run (`runErrorMessage`), in the person's language. */
export interface RunErrorWords {
    /**
     * A run the server refused because the conversation's turn was still
     * running (CB-357: 409 `thread_running`, started in another tab or
     * channel): it took nothing, so the message shows as not sent, to send
     * again.
     */
    threadRunning: string;
    /** A refusal for size that isn't a run's (a connect's): it offers Reconnect. */
    couldNotConnect: string;
}

/**
 * A failed run's message for the chat. A refused request (e.g. 503 while the
 * server updates) carries the server's own sentence in its JSON `error`; the
 * runtime client would otherwise show "HTTP 503: {...}". A busy conversation
 * is read from its `code`, never its text.
 */
export function runErrorMessage(error: Error, words: RunErrorWords) {
    if (threadRunning(error)) {
        return words.threadRunning;
    }
    // Never "Request is too large." (CB-156): a run's 413 is the chat's to
    // explain (UNSENT_TOO_LONG); any other, such as a connect's, offers
    // Reconnect.
    if (refusedForSize(error)) {
        return words.couldNotConnect;
    }
    const payload = (error as Error & { payload?: unknown }).payload;
    const message = payload && typeof payload === 'object' ? (payload as { error?: unknown }).error : undefined;
    return typeof message === 'string' && message ? message : error.message;
}

/** `runErrorMessage` with the chat's words (chat.composer). */
export function useRunErrorMessage() {
    const { t } = useTranslation(['chat.composer']);
    return useCallback(
        (error: Error) =>
            runErrorMessage(error, {
                threadRunning: t('chat.composer:unsent.thread-running'),
                couldNotConnect: t('chat.composer:errors.could-not-connect'),
            }),
        [t],
    );
}

/**
 * Sizes a composer's text box to its text (CB-97). Its CSS max-height
 * (composerText) stops the growth; past it the box scrolls inside itself,
 * kept at the end while the cursor is there so the line being typed shows,
 * and marked `data-scrolled` while lines are hidden above (the box fades
 * at its top edge).
 */
export function fitComposer(box: HTMLTextAreaElement) {
    const top = box.scrollTop;
    const atEnd = box.selectionEnd === box.value.length;
    box.style.height = 'auto';
    const border = box.offsetHeight - box.clientHeight;
    box.style.height = `${box.scrollHeight + border}px`;
    const overflowing = box.scrollHeight > box.clientHeight + 1;
    box.scrollTop = overflowing && atEnd ? box.scrollHeight : top;
    markScrolled(box);
}

function markScrolled(box: HTMLTextAreaElement) {
    box.toggleAttribute('data-scrolled', box.scrollTop > 0);
}

/**
 * A ref for a composer's text box that fits it to `value` (fitComposer),
 * and again when the box changes size: a new width wraps the text again,
 * and its max-height is a share of the visible height, which an iPhone's
 * keyboard changes.
 */
export function useFitComposer(value: string) {
    const ref = useRef<HTMLTextAreaElement>(null);
    useLayoutEffect(() => {
        if (ref.current) {
            fitComposer(ref.current);
        }
    }, [value]);
    useEffect(() => {
        const box = ref.current;
        if (!box) {
            return;
        }
        const scrolled = () => markScrolled(box);
        box.addEventListener('scroll', scrolled);
        // Fitting again sets the same size, so this settles at once.
        const resized = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => fitComposer(box));
        resized?.observe(box);
        return () => {
            box.removeEventListener('scroll', scrolled);
            resized?.disconnect();
        };
    }, []);
    return ref;
}
