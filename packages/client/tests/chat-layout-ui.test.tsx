import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import {
    composing,
    keyboardRoom,
    keyboardUp,
    SHORT_HEIGHT,
    TIGHT_HEIGHT,
    typingIn,
    useVisibleHeight,
    visibleHeight,
} from '../src/hooks/use-visible-height';
import {
    ChatFrame,
    ChatHeader,
    ChatScroller,
    ComposerRow,
    SendButton,
    type ChatPlacement,
} from '../src/modules/chat/chat-chrome';
import { composerText } from '../src/modules/chat/chat-chrome';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;
// Every root a test mounted: one left mounted renders after the environment
// is torn down ("window is not defined").
const mounted: { root: Root; host: HTMLElement }[] = [];
afterEach(() => {
    act(() => {
        for (const entry of mounted.splice(0)) {
            entry.root.unmount();
        }
    });
    for (const node of document.body.querySelectorAll(':scope > div')) {
        node.remove();
    }
    root = undefined;
    host = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

function mount(node: React.ReactNode) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    mounted.push({ root, host });
    act(() => root!.render(node));
    return host;
}

it('measures what is visible: the visual viewport, else the window', () => {
    expect(visibleHeight({ innerHeight: 844, visualViewport: null })).toBe(844);
    // An iPhone's keyboard covers the page without changing innerHeight.
    expect(visibleHeight({ innerHeight: 844, visualViewport: { height: 463.6 } })).toBe(464);
});

/** A touch screen (pointer: coarse), or a mouse's. */
const pointer = (coarse: boolean) =>
    vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query === '(pointer: coarse)' && coarse,
    }));

it('keeps --app-height at the visible height while typing, the document unscrolled (CB-102)', () => {
    vi.useFakeTimers();
    pointer(true);
    const viewport = Object.assign(new EventTarget(), { height: 844 });
    vi.stubGlobal('visualViewport', viewport);
    vi.stubGlobal('requestAnimationFrame', (run: () => void) => {
        run();
        return 0;
    });
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    function Shell() {
        useVisibleHeight();
        return <textarea aria-label="Message" />;
    }
    const field = mount(<Shell />).querySelector('textarea')!;
    const height = () => document.documentElement.style.getPropertyValue('--app-height');
    // Nothing focused: CSS's 100dvh.
    expect(height()).toBe('');
    // The keyboard opens, and iOS scrolls the page to show the field.
    act(() => field.focus());
    viewport.height = 464;
    vi.stubGlobal('scrollY', 380);
    act(() => viewport.dispatchEvent(new Event('resize')));
    expect(height()).toBe('464px');
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    // It closes, and the installed app's viewport still says 464.
    vi.stubGlobal('scrollY', 0);
    act(() => {
        field.blur();
        vi.advanceTimersByTime(300);
    });
    expect(height()).toBe('');
    act(() => viewport.dispatchEvent(new Event('resize')));
    expect(height()).toBe('');
    act(() => field.focus());
    expect(height()).toBe('464px');
    act(() => root!.unmount());
    root = undefined;
    expect(height()).toBe('');
});

it('leaves idle view scrolling alone, corrects active keyboard scrolling, and resets once on blur', () => {
    vi.useFakeTimers();
    pointer(true);
    const viewport = Object.assign(new EventTarget(), { height: 844 });
    vi.stubGlobal('visualViewport', viewport);
    vi.stubGlobal('requestAnimationFrame', (run: () => void) => {
        run();
        return 0;
    });
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    vi.stubGlobal('scrollY', 120);
    vi.stubGlobal('scrollX', 30);
    function Shell() {
        useVisibleHeight();
        return <textarea aria-label="Message" />;
    }
    const field = mount(<Shell />).querySelector('textarea')!;
    const html = document.documentElement;
    const idleEvents = () => {
        window.dispatchEvent(new Event('scroll'));
        viewport.dispatchEvent(new Event('scroll'));
        viewport.dispatchEvent(new Event('resize'));
    };
    // Even an offset visual viewport must not make a plain board gesture write
    // window.scrollTo. Repeat events to cover a momentum scroll's event stream.
    act(() => {
        for (let i = 0; i < 3; i++) {
            idleEvents();
        }
    });
    expect(scrollTo).not.toHaveBeenCalled();
    expect(html.style.getPropertyValue('--app-height')).toBe('');
    act(() => field.focus());
    viewport.height = 464;
    act(() => viewport.dispatchEvent(new Event('resize')));
    expect(html.style.getPropertyValue('--app-height')).toBe('464px');
    scrollTo.mockClear();
    act(() => window.dispatchEvent(new Event('scroll')));
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith(0, 0);
    // The old keyboard offset can remain during blur. Clear it once together
    // with --app-height, while later idle/settle events leave scrolling alone.
    scrollTo.mockClear();
    act(() => field.blur());
    expect(html.style.getPropertyValue('--app-height')).toBe('');
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith(0, 0);
    scrollTo.mockClear();
    act(() => {
        vi.advanceTimersByTime(1000);
        for (let i = 0; i < 3; i++) {
            idleEvents();
        }
    });
    expect(scrollTo).not.toHaveBeenCalled();
});

it('does not correct document scrolling for a mouse-focused field', () => {
    pointer(false);
    vi.stubGlobal('requestAnimationFrame', (run: () => void) => {
        run();
        return 0;
    });
    vi.stubGlobal('scrollY', 120);
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    function Shell() {
        useVisibleHeight();
        return <textarea aria-label="Message" />;
    }
    const field = mount(<Shell />).querySelector('textarea')!;
    act(() => {
        field.focus();
        window.dispatchEvent(new Event('scroll'));
    });
    expect(scrollTo).not.toHaveBeenCalled();
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('');
});

it('leaves --app-height alone with a mouse, and writes it only when it changes (CB-98)', () => {
    vi.useFakeTimers();
    const viewport = Object.assign(new EventTarget(), { height: 844 });
    vi.stubGlobal('visualViewport', viewport);
    vi.stubGlobal('requestAnimationFrame', (run: () => void) => {
        run();
        return 0;
    });
    vi.stubGlobal('scrollTo', vi.fn());
    const style = document.documentElement.style;
    const writes = vi.spyOn(style, 'setProperty');
    function Shell() {
        useVisibleHeight();
        return <textarea aria-label="Message" />;
    }
    pointer(false);
    const field = mount(<Shell />).querySelector('textarea')!;
    // A desktop: the window is what is visible, so nothing restyles the page.
    act(() => field.focus());
    act(() => vi.advanceTimersByTime(300));
    expect(style.getPropertyValue('--app-height')).toBe('');
    expect(writes).not.toHaveBeenCalled();
    act(() => field.blur());
    // A touch screen: set once, however many events say the same height.
    pointer(true);
    act(() => field.focus());
    act(() => {
        viewport.dispatchEvent(new Event('resize'));
        viewport.dispatchEvent(new Event('scroll'));
        vi.advanceTimersByTime(300);
    });
    expect(style.getPropertyValue('--app-height')).toBe('844px');
    expect(writes).toHaveBeenCalledTimes(1);
    act(() => root!.unmount());
    root = undefined;
});

/**
 * CB-155: an iPhone's visual viewport, the keyboard and the accessory bar
 * above it (⌃ ⌄ ✓) covering the page without changing innerHeight.
 */
function iPhone() {
    vi.useFakeTimers();
    pointer(true);
    const viewport = Object.assign(new EventTarget(), { height: 797 });
    vi.stubGlobal('visualViewport', viewport);
    vi.stubGlobal('innerHeight', 797);
    vi.stubGlobal('requestAnimationFrame', (run: () => void) => {
        run();
        return 0;
    });
    vi.stubGlobal('scrollTo', vi.fn());
    function Shell() {
        useVisibleHeight();
        return (
            <>
                <form data-slot="chat-composer">
                    <textarea aria-label="Message" />
                </form>
                <input aria-label="Search" />
            </>
        );
    }
    const view = mount(<Shell />);
    const field = view.querySelector('textarea')!;
    const html = document.documentElement;
    return {
        search: view.querySelector('input')!,
        viewport,
        field,
        height: () => html.style.getPropertyValue('--app-height'),
        room: () => html.getAttribute('data-keyboard-room'),
        /** A line typed: the text box grows. */
        type: () =>
            act(() => {
                field.value += 'a line\n';
                field.dispatchEvent(new Event('input', { bubbles: true }));
            }),
    };
}

it('fits the shell above the accessory bar that comes after the keyboard, measuring again as the text grows (CB-155)', () => {
    const phone = iPhone();
    act(() => phone.field.focus());
    // The keyboard: the viewport says so.
    phone.viewport.height = 461;
    act(() => phone.viewport.dispatchEvent(new Event('resize')));
    expect(phone.height()).toBe('461px');
    // Its accessory bar comes after it, and no resize says so.
    act(() => vi.advanceTimersByTime(400));
    phone.viewport.height = 411;
    // A second look after focus finds it...
    act(() => vi.advanceTimersByTime(700));
    expect(phone.height()).toBe('411px');
    // ...and so does the next line typed, at any time.
    phone.viewport.height = 380;
    phone.type();
    expect(phone.height()).toBe('380px');
    // Short of room: the workspace's header gives way to the composer.
    expect(phone.room()).toBe('short');
    // Not for another field: the page keeps its header.
    act(() => phone.search.focus());
    expect(phone.height()).toBe('380px');
    expect(phone.room()).toBeNull();
    act(() => phone.field.focus());
    expect(phone.room()).toBe('short');
    // The text grows on: one write per change, none for the same height.
    const writes = vi.spyOn(document.documentElement.style, 'setProperty');
    phone.type();
    phone.type();
    expect(writes).not.toHaveBeenCalled();
    // The keyboard closes: CSS's 100dvh, nothing hidden.
    act(() => {
        phone.field.blur();
        vi.advanceTimersByTime(1000);
    });
    expect(phone.height()).toBe('');
    expect(phone.room()).toBeNull();
});

it('gives the composer the room in landscape and takes it back on rotating (CB-155)', () => {
    const phone = iPhone();
    act(() => phone.field.focus());
    phone.viewport.height = 411;
    act(() => phone.viewport.dispatchEvent(new Event('resize')));
    expect(phone.room()).toBe('open');
    // Turned to landscape: a sliver above the keyboard and its bar.
    vi.stubGlobal('innerHeight', 390);
    phone.viewport.height = 146;
    act(() => window.dispatchEvent(new Event('resize')));
    expect(phone.height()).toBe('146px');
    // Both headers give way, and most of the padding.
    expect(phone.room()).toBe('tight');
    // Back to portrait.
    vi.stubGlobal('innerHeight', 797);
    phone.viewport.height = 411;
    act(() => phone.viewport.dispatchEvent(new Event('resize')));
    expect(phone.height()).toBe('411px');
    expect(phone.room()).toBe('open');
    act(() => root!.unmount());
    root = undefined;
    expect(phone.height()).toBe('');
    expect(phone.room()).toBeNull();
});

it('measures nothing as you type with a mouse (CB-155, CB-98)', () => {
    const phone = iPhone();
    pointer(false);
    const html = document.documentElement;
    const writes = vi.spyOn(html.style, 'setProperty');
    const attributes = vi.spyOn(html, 'setAttribute');
    act(() => phone.field.focus());
    phone.viewport.height = 300;
    phone.type();
    act(() => vi.advanceTimersByTime(1000));
    expect(phone.height()).toBe('');
    expect(phone.room()).toBeNull();
    expect(writes).not.toHaveBeenCalled();
    expect(attributes).not.toHaveBeenCalled();
});

it('gives no room without an on-screen keyboard, finds Android’s, and drops the room on another page (CB-155)', () => {
    const phone = iPhone();
    // A tablet with a hardware keyboard: only its shortcut bar covers it.
    act(() => phone.field.focus());
    phone.viewport.height = 740;
    act(() => phone.viewport.dispatchEvent(new Event('resize')));
    expect(phone.height()).toBe('740px');
    expect(phone.room()).toBeNull();
    // Android: its keyboard shrinks the page too (resizes-content).
    vi.stubGlobal('innerHeight', 380);
    phone.viewport.height = 380;
    act(() => window.dispatchEvent(new Event('resize')));
    expect(phone.room()).toBe('short');
    // Zoomed in, not a keyboard.
    expect(keyboardUp({ innerHeight: 797, visualViewport: { height: 398, scale: 2 } })).toBe(false);
    expect(keyboardUp({ innerHeight: 797, visualViewport: { height: 411 } })).toBe(true);
});

it('drops the room when the page changes (CB-155)', () => {
    vi.useFakeTimers();
    pointer(true);
    const viewport = Object.assign(new EventTarget(), { height: 380 });
    vi.stubGlobal('visualViewport', viewport);
    vi.stubGlobal('innerHeight', 797);
    vi.stubGlobal('requestAnimationFrame', (run: () => void) => {
        run();
        return 0;
    });
    vi.stubGlobal('scrollTo', vi.fn());
    function Shell({ path }: { path: string }) {
        useVisibleHeight(path);
        return (
            <form data-slot="chat-composer">
                <textarea aria-label="Message" />
            </form>
        );
    }
    const view = mount(<Shell path="/chats/c1" />);
    act(() => view.querySelector('textarea')!.focus());
    const html = document.documentElement;
    expect(html.getAttribute('data-keyboard-room')).toBe('short');
    act(() => root!.render(<Shell path="/spaces/s1" />));
    expect(html.getAttribute('data-keyboard-room')).toBeNull();
});

it('says how short the keyboard leaves the shell (CB-155)', () => {
    const at = (height: number, typing = true) =>
        keyboardRoom({ innerHeight: 900, visualViewport: { height } }, typing);
    expect(at(600, false)).toEqual({ height: '', room: '' });
    expect(at(SHORT_HEIGHT)).toEqual({
        height: `${SHORT_HEIGHT}px`,
        room: 'open',
    });
    expect(at(SHORT_HEIGHT - 1).room).toBe('short');
    expect(at(TIGHT_HEIGHT).room).toBe('short');
    expect(at(TIGHT_HEIGHT - 1).room).toBe('tight');
    // Typing elsewhere: the height only.
    expect(keyboardRoom({ innerHeight: 900, visualViewport: { height: 200 } }, true, false)).toEqual({
        height: '200px',
        room: '',
    });
});

it('lets what is above the composer give way when the keyboard leaves little room (CB-155)', () => {
    const transcript = mount(
        <ChatScroller scroller={null} content={null} end={null}>
            <p>Hello</p>
        </ChatScroller>,
    ).querySelector<HTMLElement>('[data-chat-transcript]')!;
    // The transcript shrinks to nothing before the composer is cut off.
    expect(transcript.className).toContain('min-h-0');
    expect(transcript.className).not.toContain('min-h-[100px]');
    expect(transcript.className).toContain('keyboard-tight:py-0');
    expect(header('column').className).toContain('keyboard-tight:hidden');
    expect(mount(<ChatFrame />).firstElementChild!.className).toContain('keyboard-tight:py-1');
    // A line and the buttons fit in a phone's landscape.
    expect(composerText).toContain('keyboard-tight:min-h-0');
    expect(composerText).toContain('keyboard-tight:max-h-[calc(var(--app-height,100dvh)*0.4)]');
    const source = (path: string) => readFileSync(join(import.meta.dirname, '../src', path), 'utf8');
    expect(source('shell/AppHeader.tsx')).toMatch(/data-slot="app-header"\s+className="[^"]*keyboard-short:hidden/);
    const css = source('globals.css');
    expect(css).toContain(
        "@custom-variant keyboard-short (&:where([data-keyboard-room='short'] *, [data-keyboard-room='tight'] *));",
    );
    expect(css).toContain("@custom-variant keyboard-tight (&:where([data-keyboard-room='tight'] *));");
});

it('gives a room’s composer, like a chat’s, the room the keyboard leaves (CB-219)', () => {
    const box = document.createElement('div');
    box.innerHTML = `
    <form data-slot="room-composer"><textarea id="room"></textarea></form>
    <form data-slot="chat-composer"><textarea id="chat"></textarea></form>
    <form data-slot="new-chat-composer"><textarea id="new"></textarea></form>
    <form data-slot="room-pins"><textarea id="pin"></textarea></form>`;
    const at = (id: string) => box.querySelector(`#${id}`);
    expect(composing(at('room'))).toBe(true);
    expect(composing(at('chat'))).toBe(true);
    expect(composing(at('new'))).toBe(true);
    expect(composing(at('pin'))).toBe(false);
    expect(composing(null)).toBe(false);
});

it('counts only fields that bring up a keyboard', () => {
    const make = (html: string) => {
        const box = document.createElement('div');
        box.innerHTML = html;
        return box.firstElementChild;
    };
    expect(typingIn(make('<textarea></textarea>'))).toBe(true);
    expect(typingIn(make('<input type="text">'))).toBe(true);
    expect(typingIn(make('<input type="search">'))).toBe(true);
    expect(typingIn(make('<input type="checkbox">'))).toBe(false);
    expect(typingIn(make('<input readonly>'))).toBe(false);
    expect(typingIn(make('<button>Send</button>'))).toBe(false);
    expect(typingIn(null)).toBe(false);
});

const header = (placement: ChatPlacement) =>
    mount(
        <div className="@container/chat">
            <ChatHeader
                placement={placement}
                identity="dot-1"
                mascotName="Issue Collector"
                title="Issue Collector"
                status="Here with you"
                actions={<button type="button">Save</button>}
            />
        </div>,
    ).querySelector<HTMLElement>('[data-slot="chat-header"]')!;

it('lays the chat view’s header across the workspace frame, one row (CB-120, CB-103)', () => {
    const element = header('column');
    const [mascot, text, actions] = [...element.children];
    // Like Issues' header: not in the centered reading column, the Dot at
    // the start and the actions at the end, at any width.
    expect(element.className).not.toContain('max-w-3xl');
    expect(element.className).not.toContain('mx-auto');
    expect(element.className).not.toContain('flex-wrap');
    expect(element.className).not.toContain('justify-center');
    expect(element.className).toContain('w-full');
    expect(mascot.getAttribute('class')).toContain('size-9');
    expect(actions.className).toContain('ml-auto');
    expect(actions.className).not.toContain('absolute');
    // Narrow: the name and status are cut short past 45%, so the model
    // picker goes first.
    expect(text.className).toContain('@max-[47.5rem]/chat:max-w-[45%]');
    expect(text.querySelector('strong')!.className).toContain('truncate');
});

it('gives the chat view’s frame the page chrome’s edges (CB-120)', () => {
    const frame = mount(<ChatFrame />).firstElementChild!;
    expect(frame.className).toContain('pt-(--page-top)');
    expect(frame.className).toContain('md:px-6');
    const panel = mount(<ChatFrame placement="page" />).firstElementChild!;
    expect(panel.className).toContain('px-[35px]');
});

it('keeps the page panel’s actions on a row above the Dot', () => {
    const element = header('page');
    const actions = element.querySelector('[data-slot="chat-header-actions"]')!;
    expect(element.className).toContain('@max-[47.5rem]/chat:pt-12.5');
    expect(element.className).not.toContain('flex-nowrap');
    expect(actions.className).not.toContain('chat:static');
});

it('keeps what a message positions inside the transcript (CB-102)', () => {
    const element = mount(
        <ChatScroller scroller={null} content={null} end={null}>
            <span className="sr-only">Label</span>
        </ChatScroller>,
    ).querySelector<HTMLElement>('[data-chat-transcript]')!;
    // A containing block that scrolls: an absolute child can't stretch the
    // view around the chat.
    expect(element.className).toMatch(/\brelative\b/);
    expect(element.className).toContain('overflow-auto');
});

it('lets nothing in a message widen the transcript (CB-107)', () => {
    const element = mount(
        <ChatScroller scroller={null} content={null} end={null}>
            <p>https://example.test/a/very/long/url</p>
        </ChatScroller>,
    ).querySelector<HTMLElement>('[data-chat-transcript]')!;
    const column = element.firstElementChild!;
    // Its messages may shrink below their content, and a long word breaks.
    expect(column.className).toContain('min-w-0');
    expect(column.className).toContain('*:min-w-0');
    expect(column.className).toContain('[overflow-wrap:anywhere]');
});

it('keeps the full-width draft above grouped actions in every shared composer (CB-238)', () => {
    const row = mount(
        <ComposerRow
            tools={
                <>
                    <button type="button" aria-label="Add source page link" />
                    <button type="button" aria-label="Attach files" />
                    <button type="button" aria-label="Dictate" />
                </>
            }
            text={<textarea aria-label="Message your socio" rows={1} />}
            send={
                <>
                    <SendButton aria-label="Stop response" />
                    <SendButton type="submit" aria-label="Queue message" />
                </>
            }
        />,
    ).querySelector<HTMLElement>('[data-slot="composer-row"]')!;
    const text = row.querySelector<HTMLElement>('[data-slot="composer-text"]')!;
    const toolbar = row.querySelector<HTMLElement>('[data-slot="composer-toolbar"]')!;
    const tools = toolbar.querySelector<HTMLElement>('[data-slot="composer-tools"]')!;
    const send = toolbar.querySelector<HTMLElement>('[data-slot="composer-send"]')!;
    // DOM reading/tab order follows the visual order, including stop+queue.
    expect([...row.querySelectorAll('textarea,button')].map((e) => e.getAttribute('aria-label'))).toEqual([
        'Message your socio',
        'Add source page link',
        'Attach files',
        'Dictate',
        'Stop response',
        'Queue message',
    ]);
    expect(text.parentElement).toBe(row);
    expect(toolbar.previousElementSibling).toBe(text);
    expect(row.className).toContain('flex-col');
    expect(text.className).toContain('w-full');
    expect(text.className).toContain('min-w-0');
    expect(tools.getAttribute('role')).toBe('group');
    expect(tools.className).toContain('gap-0');
    expect(tools.className).toContain('[&_button]:size-11');
    expect(send.className).toContain('ml-auto');
    expect(toolbar.className).toContain('flex-wrap');
    const [stop, queue] = [...send.querySelectorAll('button')];
    expect(stop!.type).toBe('button');
    expect(queue!.type).toBe('submit');
    expect(queue!.className).toContain('min-w-11');
});
