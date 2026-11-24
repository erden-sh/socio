// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

import { composerText } from '../src/modules/chat/chat-chrome';
import {
    fitComposer,
    runErrorMessage,
    shouldSubmitComposerOnKeyDown,
    touchTyping,
    UNSENT_THREAD_RUNNING,
} from '../src/modules/chat/chat-composer';

function keyEvent({
    key = 'Enter',
    shiftKey = false,
    ctrlKey = false,
    metaKey = false,
    isComposing = false,
    keyCode,
}: {
    key?: string;
    shiftKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    isComposing?: boolean;
    keyCode?: number;
} = {}) {
    return {
        key,
        shiftKey,
        ctrlKey,
        metaKey,
        nativeEvent: {
            isComposing,
            keyCode,
        },
    };
}

it('does not submit Enter while IME composition is active', () => {
    expect(shouldSubmitComposerOnKeyDown(keyEvent({ isComposing: true }))).toBe(false);
});

it('does not submit legacy IME composition Enter events', () => {
    expect(shouldSubmitComposerOnKeyDown(keyEvent({ keyCode: 229 }))).toBe(false);
});

it('submits Enter after composition completes', () => {
    expect(shouldSubmitComposerOnKeyDown(keyEvent())).toBe(true);
});

it('leaves Enter for new lines on a touch screen', () => {
    expect(shouldSubmitComposerOnKeyDown(keyEvent(), true)).toBe(false);
    expect(shouldSubmitComposerOnKeyDown(keyEvent(), false)).toBe(true);
});

it('keeps Shift+Enter available for multiline drafts', () => {
    expect(shouldSubmitComposerOnKeyDown(keyEvent({ shiftKey: true }))).toBe(false);
});

/** Who is typing: the pointer media query and the browser's own account of itself. */
function device({
    coarse,
    userAgent,
    maxTouchPoints = 0,
}: {
    coarse: boolean;
    userAgent: string;
    maxTouchPoints?: number;
}) {
    vi.stubGlobal('matchMedia', (query: string) => ({
        matches: coarse && query === '(hover: none) and (pointer: coarse)',
    }));
    vi.stubGlobal('navigator', { userAgent, maxTouchPoints });
}
const WINDOWS =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const MAC =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const IPHONE =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
afterEach(() => vi.unstubAllGlobals());

/** What each key does in the composer, on the device in effect. */
function keys() {
    const plain = keyEvent();
    return {
        enter: shouldSubmitComposerOnKeyDown(plain),
        ctrlEnter: shouldSubmitComposerOnKeyDown(keyEvent({ ctrlKey: true })),
        metaEnter: shouldSubmitComposerOnKeyDown(keyEvent({ metaKey: true })),
        shiftEnter: shouldSubmitComposerOnKeyDown(keyEvent({ shiftKey: true })),
        composing: shouldSubmitComposerOnKeyDown(keyEvent({ ctrlKey: true, isComposing: true })),
        imeKeyCode: shouldSubmitComposerOnKeyDown(keyEvent({ keyCode: 229 })),
    };
}
const sends = {
    enter: true,
    ctrlEnter: true,
    metaEnter: true,
    shiftEnter: false,
    composing: false,
    imeKeyCode: false,
};

it('sends on Enter and Ctrl+Enter on a plain desktop', () => {
    device({ coarse: false, userAgent: WINDOWS });
    expect(touchTyping()).toBe(false);
    expect(keys()).toEqual(sends);
});

it('treats a Windows or Mac computer with a touch screen as a desktop (CB-115)', () => {
    // Some browsers there report a coarse pointer with no hover.
    device({ coarse: true, userAgent: WINDOWS, maxTouchPoints: 10 });
    expect(touchTyping()).toBe(false);
    expect(keys()).toEqual(sends);
    device({ coarse: true, userAgent: MAC });
    expect(touchTyping()).toBe(false);
    expect(keys()).toEqual(sends);
});

it('keeps Enter for new lines on a phone, where Ctrl+Enter still sends', () => {
    for (const userAgent of [IPHONE, ANDROID]) {
        device({ coarse: true, userAgent, maxTouchPoints: 5 });
        expect(touchTyping()).toBe(true);
        expect(keys()).toEqual({
            ...sends,
            enter: false,
        });
    }
    // An iPad asking for the desktop site calls itself a Mac.
    device({ coarse: true, userAgent: MAC, maxTouchPoints: 5 });
    expect(touchTyping()).toBe(true);
    expect(keys().enter).toBe(false);
});

it('sends on Enter on a phone with a mouse or trackpad', () => {
    device({ coarse: false, userAgent: ANDROID, maxTouchPoints: 5 });
    expect(touchTyping()).toBe(false);
    expect(keys()).toEqual(sends);
});

it("shows a refused run's own message instead of the raw HTTP error", () => {
    const refused = Object.assign(new Error('HTTP 503: {"error":"Socio is updating."}'), {
        status: 503,
        payload: { error: 'Socio is updating.' },
    });
    expect(runErrorMessage(refused)).toBe('Socio is updating.');
    expect(runErrorMessage(new Error('Network down'))).toBe('Network down');
    expect(runErrorMessage(Object.assign(new Error('HTTP 500: x'), { payload: 'x' }))).toBe('HTTP 500: x');
    // A size refusal never shows as "Request is too large." (CB-156); a
    // run's is the chat's to explain, any other offers Reconnect.
    const tooBig = Object.assign(new Error('HTTP 413: {"error":"Request is too large."}'), {
        status: 413,
        payload: { error: 'Request is too large.' },
    });
    expect(runErrorMessage(tooBig)).toBe('Conversation could not connect.');
});

it('reads a busy conversation from its code, never its text (CB-357)', () => {
    const busy = Object.assign(new Error('HTTP 409: {"error":"Thread already running","code":"thread_running"}'), {
        status: 409,
        payload: { error: 'Thread already running', code: 'thread_running' },
    });
    expect(runErrorMessage(busy)).toBe(UNSENT_THREAD_RUNNING);
    // The same words with another code, or none, are not it.
    const other = Object.assign(new Error('HTTP 409'), {
        status: 409,
        payload: { error: 'Thread already running', code: 'delivered' },
    });
    expect(runErrorMessage(other)).toBe('Thread already running');
    expect(runErrorMessage(new Error('Thread already running'))).toBe('Thread already running');
});

/**
 * A text box as a browser lays it out (jsdom has no layout): `lines` of
 * 26 px, 22 px of padding, and a max-height of `max` px that clamps the
 * height it is given.
 */
function box(lines: number, max: number) {
    const element = document.createElement('textarea');
    element.value = Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n');
    const content = lines * 26 + 22;
    const height = () => (element.style.height === 'auto' ? 43 : Math.min(parseFloat(element.style.height), max));
    Object.defineProperties(element, {
        scrollHeight: { get: () => Math.max(content, height()) },
        clientHeight: { get: height },
        offsetHeight: { get: height },
    });
    return element;
}

it('grows the composer with its text, up to its max height (CB-97)', () => {
    const short = box(3, 300);
    fitComposer(short);
    expect(short.style.height).toBe(`${3 * 26 + 22}px`);
    expect(short.scrollTop).toBe(0);
    expect(short.hasAttribute('data-scrolled')).toBe(false);
});

it('scrolls past its max height, keeping the line being typed in view', () => {
    const long = box(20, 200);
    long.setSelectionRange(long.value.length, long.value.length);
    fitComposer(long);
    // Asked for all of it; the max-height holds it at 200, and it scrolls
    // to the end, with the fade above.
    expect(long.style.height).toBe(`${20 * 26 + 22}px`);
    expect(long.clientHeight).toBe(200);
    expect(long.scrollTop).toBeGreaterThan(0);
    expect(long.hasAttribute('data-scrolled')).toBe(true);
});

it('leaves the scroll where it was while editing above the end', () => {
    const long = box(20, 200);
    long.setSelectionRange(5, 5);
    long.scrollTop = 0;
    fitComposer(long);
    expect(long.scrollTop).toBe(0);
    expect(long.hasAttribute('data-scrolled')).toBe(false);
});

it('caps the composer at a share of the visible height, more on wide screens', () => {
    expect(composerText).toContain('max-h-[calc(var(--app-height,100dvh)*0.4)]');
    expect(composerText).toContain('md:max-h-[calc(var(--app-height,100dvh)*0.5)]');
    expect(composerText).toContain('overflow-y-auto');
    expect(composerText).not.toContain('max-h-[120px]');
});
