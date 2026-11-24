import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/** "At the end" means within this many pixels of it. */
export const AT_END_PX = 80;

/**
 * Keeps a transcript at its end while the reader is there (T3 Code and
 * ChatGPT): new messages and streaming text are followed only when
 * following. Observers, not polling or measuring on render:
 *
 * - an IntersectionObserver on `end` (a sentinel after the content, with an
 *   80 px margin) says whether the reader is at the end; reaching it again
 *   resumes following, and `atEnd` drives the "Scroll to end" button;
 * - a ResizeObserver on `content` and on the scroller keeps the end in view
 *   while following, as text streams in or the composer grows;
 * - scrolling up (the reader, not the browser clamping after the content
 *   shrank) stops following at once, so a growing reply never pulls the
 *   reader back down mid-gesture.
 *
 * `toEnd` jumps (or scrolls smoothly) to the end and follows again: on
 * send, and from the button. Opening starts at the end, before the first
 * paint. `toElement` scrolls to one message and stops following.
 */
export function useStickToBottom() {
    const scroller = useRef<HTMLDivElement>(null);
    const content = useRef<HTMLDivElement>(null);
    const end = useRef<HTMLDivElement>(null);
    const following = useRef(true);
    const [atEnd, setAtEnd] = useState(true);
    const toEnd = useCallback((smooth = false) => {
        following.current = true;
        const element = scroller.current;
        if (!element) {
            return;
        }
        if (smooth && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
            element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
        } else {
            element.scrollTop = element.scrollHeight;
        }
    }, []);
    // A link to one message (CB-88): there, and no longer following. Its own
    // scroll event is not the reader's, so it doesn't resume following.
    const jumped = useRef(false);
    const toElement = useCallback((target: HTMLElement) => {
        following.current = false;
        jumped.current = true;
        target.scrollIntoView({ block: 'start' });
    }, []);
    useLayoutEffect(() => {
        const element = scroller.current;
        const inner = content.current;
        const sentinel = end.current;
        // jsdom (the tests) has neither observer; every Baseline browser has both.
        if (
            !element ||
            !inner ||
            !sentinel ||
            typeof IntersectionObserver === 'undefined' ||
            typeof ResizeObserver === 'undefined'
        ) {
            return;
        }
        element.scrollTop = element.scrollHeight;
        let near = true;
        let lastTop = element.scrollTop;
        let lastHeight = element.scrollHeight;
        const onScroll = () => {
            const top = element.scrollTop;
            const height = element.scrollHeight;
            if (jumped.current) {
                jumped.current = false;
            } else if (top < lastTop - 1 && height >= lastHeight) {
                following.current = false;
            } else if (top > lastTop && near) {
                following.current = true;
            }
            lastTop = top;
            lastHeight = height;
        };
        element.addEventListener('scroll', onScroll, { passive: true });
        const intersection = new IntersectionObserver(
            ([entry]) => {
                near = entry.isIntersecting;
                if (near) {
                    following.current = true;
                }
                setAtEnd(near);
            },
            { root: element, rootMargin: `0px 0px ${AT_END_PX}px 0px` },
        );
        intersection.observe(sentinel);
        const resize = new ResizeObserver(() => {
            if (following.current) {
                element.scrollTop = element.scrollHeight;
            }
            lastTop = element.scrollTop;
            lastHeight = element.scrollHeight;
        });
        resize.observe(inner);
        resize.observe(element);
        return () => {
            element.removeEventListener('scroll', onScroll);
            intersection.disconnect();
            resize.disconnect();
        };
    }, []);
    return { scroller, content, end, atEnd, toEnd, toElement };
}
