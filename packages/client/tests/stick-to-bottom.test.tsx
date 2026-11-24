// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { useStickToBottom } from '../src/hooks/use-stick-to-bottom';
import { ScrollToEnd } from '../src/modules/chat/ScrollToEnd';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** jsdom has no observers: stand-ins the test drives by hand. */
let intersection: {
    callback: IntersectionObserverCallback;
    options?: IntersectionObserverInit;
    targets: Element[];
};
let resize: { callback: ResizeObserverCallback; targets: Element[] };
beforeEach(() => {
    vi.stubGlobal(
        'IntersectionObserver',
        class {
            constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
                intersection = { callback, options, targets: [] };
            }
            observe(target: Element) {
                intersection.targets.push(target);
            }
            disconnect() {}
        },
    );
    vi.stubGlobal(
        'ResizeObserver',
        class {
            constructor(callback: ResizeObserverCallback) {
                resize = { callback, targets: [] };
            }
            observe(target: Element) {
                resize.targets.push(target);
            }
            disconnect() {}
        },
    );
});

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = host = undefined;
    vi.unstubAllGlobals();
});

/** A scroller with a 500 px window over `height` px of content. */
const box = { height: 2_000, top: 0 };
const smooth: boolean[] = [];
function Transcript() {
    const scroll = useStickToBottom();
    return (
        <>
            <div
                data-testid="scroller"
                ref={(element) => {
                    scroll.scroller.current = element;
                    if (!element || 'fake' in element) {
                        return;
                    }
                    Object.assign(element, { fake: true });
                    Object.defineProperties(element, {
                        scrollHeight: { get: () => box.height },
                        clientHeight: { get: () => 500 },
                        scrollTop: {
                            get: () => box.top,
                            set: (value: number) => {
                                box.top = Math.max(0, Math.min(value, box.height - 500));
                            },
                        },
                    });
                    element.scrollTo = ((options: ScrollToOptions) => {
                        smooth.push(options.behavior === 'smooth');
                        element.scrollTop = options.top ?? 0;
                    }) as typeof element.scrollTo;
                }}
            >
                <div data-testid="content" ref={scroll.content} />
                <div data-testid="end" ref={scroll.end} />
            </div>
            <ScrollToEnd scroll={scroll} />
            <button data-testid="send" onClick={() => scroll.toEnd()} />
            <button
                data-testid="jump"
                onClick={() =>
                    scroll.toElement({
                        // A message 600 px down: the browser scrolls, then says so.
                        scrollIntoView: () => {
                            box.top = 600;
                            scroller().dispatchEvent(new Event('scroll'));
                        },
                    } as unknown as HTMLElement)
                }
            />
        </>
    );
}

function mount() {
    box.height = 2_000;
    box.top = 0;
    near = true;
    smooth.length = 0;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<Transcript />));
    return host;
}
const scroller = () => host!.querySelector('[data-testid="scroller"]')!;
const button = () => host!.querySelector<HTMLButtonElement>('[aria-label="Scroll to end"]');
/**
 * The reader at `top`: the browser fires scroll, then (like a real
 * IntersectionObserver, only when it changes) whether the end is in view.
 */
let near = true;
const readerAt = (top: number) =>
    act(() => {
        box.top = top;
        scroller().dispatchEvent(new Event('scroll'));
        const now = box.height - 500 - top <= 80;
        if (now !== near) {
            intersection.callback([{ isIntersecting: now } as IntersectionObserverEntry], {} as IntersectionObserver);
        }
        near = now;
    });
/** The content grows (streaming text): the ResizeObserver fires. */
const grow = (by: number) =>
    act(() => {
        box.height += by;
        resize.callback([], {} as ResizeObserver);
    });

it('opens at the end and watches the end with an 80 px margin', () => {
    mount();
    expect(box.top).toBe(1_500);
    expect(intersection.options?.root).toBe(scroller());
    expect(intersection.options?.rootMargin).toBe('0px 0px 80px 0px');
    expect(intersection.targets).toEqual([host!.querySelector('[data-testid="end"]')]);
    // The content as it grows, and the scroller as the composer grows.
    expect(resize.targets).toEqual([host!.querySelector('[data-testid="content"]'), scroller()]);
    expect(button()).toBeNull();
});

it('follows growing text at the end', () => {
    mount();
    grow(300);
    expect(box.top).toBe(1_800);
    grow(50);
    expect(box.top).toBe(1_850);
});

it('counts within 80 px of the end as the end', () => {
    mount();
    // A little up: following stops, but the reader is still at the end.
    readerAt(1_450);
    expect(button()).toBeNull();
    grow(20);
    expect(box.top).toBe(1_450);
    // Back down while there: following again.
    readerAt(1_480);
    grow(200);
    expect(box.top).toBe(1_720);
});

it('stops following when the reader scrolls up, and shows the button', () => {
    mount();
    readerAt(900);
    expect(button()).not.toBeNull();
    grow(400);
    // Left where the reader is.
    expect(box.top).toBe(900);
    expect(button()).not.toBeNull();
});

it('scrolls to the end smoothly from the button and follows again', () => {
    mount();
    readerAt(900);
    act(() => button()!.click());
    expect(smooth).toEqual([true]);
    expect(box.top).toBe(1_500);
    readerAt(1_500);
    expect(button()).toBeNull();
    grow(250);
    expect(box.top).toBe(1_750);
});

it('resumes following when the reader reaches the end again', () => {
    mount();
    readerAt(600);
    readerAt(1_480);
    expect(button()).toBeNull();
    grow(100);
    expect(box.top).toBe(1_600);
});

it('jumps to the end on send, wherever the reader was', () => {
    mount();
    readerAt(300);
    act(() => host!.querySelector<HTMLButtonElement>('[data-testid="send"]')!.click());
    // At once, not smoothly.
    expect(smooth).toEqual([]);
    expect(box.top).toBe(1_500);
    grow(120);
    expect(box.top).toBe(1_620);
});

it('keeps following when the content shrinks under the reader', () => {
    mount();
    // The browser clamps the position: a scroll up the reader didn't make.
    act(() => {
        box.height = 1_200;
        resize.callback([], {} as ResizeObserver);
        box.top = 700;
        scroller().dispatchEvent(new Event('scroll'));
    });
    grow(300);
    expect(box.top).toBe(1_000);
});

it('stays on a linked message as the transcript loads under it (CB-88)', () => {
    mount();
    // Opened empty, at the top; then the conversation arrives.
    act(() => {
        box.height = 500;
        box.top = 0;
        scroller().dispatchEvent(new Event('scroll'));
    });
    act(() => {
        box.height = 2_000;
    });
    act(() => host!.querySelector<HTMLButtonElement>('[data-testid="jump"]')!.click());
    expect(box.top).toBe(600);
    // Still loading (a reply's Markdown, the composer): left where it is.
    grow(200);
    expect(box.top).toBe(600);
    // Reaching the end follows again.
    readerAt(box.height - 500);
    grow(100);
    expect(box.top).toBe(box.height - 500);
});
