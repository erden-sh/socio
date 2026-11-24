import { driver } from 'driver.js';
import { useEffect, useRef, useState } from 'react';
import 'driver.js/dist/driver.css';

import './onboarding.css';
import type { Guide } from './guides';
import { visibleTarget, waitForTarget } from './targets';

/** Driver owns only a transient overlay. All navigation and persistence stay in React. */
export function TourLayer({
    guide,
    index,
    routeKey,
    pathname,
    move,
    dismiss,
    complete,
    openPage,
}: {
    guide: Guide;
    index: number;
    routeKey: string;
    pathname: string;
    move: (index: number) => void;
    dismiss: () => void;
    complete: () => void;
    openPage: (path: string) => void;
}) {
    const [targetEpoch, setTargetEpoch] = useState(0);
    const actions = useRef({ move, dismiss, complete, openPage });
    useEffect(() => {
        actions.current = { move, dismiss, complete, openPage };
    });
    useEffect(() => {
        const abort = new AbortController();
        let tour: ReturnType<typeof driver> | undefined;
        let tearingDown = false;
        let monitor: MutationObserver | undefined;
        const step = guide.steps[index];
        const originFocus = document.activeElement;
        void waitForTarget(!step.path || step.path === pathname ? step.target : undefined, abort.signal).then(
            (element) => {
                if (abort.signal.aborted) {
                    return;
                }
                const descriptions = guide.steps.map((s, n) => ({
                    ...(n === index && element ? { element } : {}),
                    popover: {
                        title: s.title,
                        description:
                            s.text +
                            (n === index && s.target && !element
                                ? ' This control is not visible right now. Continue, or close the guide to open the relevant page, then return through Help. No action will be performed for you.'
                                : ''),
                    },
                }));
                tour = driver({
                    steps: descriptions,
                    animate: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
                    smoothScroll: false,
                    allowClose: true,
                    allowKeyboardControl: true,
                    overlayClickBehavior: 'close',
                    popoverClass: 'socio-tour',
                    showProgress: true,
                    showButtons: ['previous', 'next', 'close'],
                    closeBtnLabel: 'Close guide',
                    nextBtnText: 'Next',
                    prevBtnText: 'Previous',
                    doneBtnText: 'Done',
                    onNextClick: () => actions.current.move(index + 1),
                    onPrevClick: () => actions.current.move(index - 1),
                    onDoneClick: () => actions.current.complete(),
                    onDestroyed: () => {
                        if (!tearingDown) {
                            actions.current.dismiss();
                        }
                    },
                    onPopoverRender: (popover) => {
                        const links = document.createElement('div');
                        links.className = 'socio-tour-links';
                        const link = document.createElement('a');
                        link.href = step.article;
                        link.target = '_blank';
                        link.rel = 'noopener';
                        link.textContent = 'Read More';
                        link.setAttribute('aria-label', `Read More about ${step.title} (opens in a new tab)`);
                        links.append(link);
                        if (!element && step.path) {
                            const open = document.createElement('button');
                            open.type = 'button';
                            open.textContent = 'Open this page';
                            open.addEventListener('click', () => actions.current.openPage(step.path!));
                            links.append(open);
                        }
                        popover.description.after(links);
                        // An actionable footer, not the page's message input, receives focus.
                        queueMicrotask(() => {
                            if (!abort.signal.aborted) {
                                popover.nextButton.focus();
                            }
                        });
                    },
                });
                tour.drive(index);
                if (element) {
                    monitor = new MutationObserver(() => {
                        if (visibleTarget(step.target) !== element) {
                            monitor?.disconnect();
                            if (!abort.signal.aborted) {
                                setTargetEpoch((value) => value + 1);
                            }
                        }
                    });
                    monitor.observe(document.body, {
                        childList: true,
                        subtree: true,
                        attributes: true,
                    });
                }
            },
        );
        return () => {
            tearingDown = true;
            monitor?.disconnect();
            abort.abort();
            tour?.destroy();
            if (originFocus instanceof HTMLElement && originFocus.isConnected) {
                originFocus.focus({ preventScroll: true });
            } else {
                const fallback = document.querySelector<HTMLElement>('[data-tour="workspace-view"]');
                if (fallback) {
                    const previous = fallback.getAttribute('tabindex');
                    fallback.tabIndex = -1;
                    fallback.focus({ preventScroll: true });
                    if (previous === null) {
                        fallback.removeAttribute('tabindex');
                    } else {
                        fallback.setAttribute('tabindex', previous);
                    }
                }
            }
        };
    }, [guide, index, routeKey, pathname, targetEpoch]);
    return null;
}
