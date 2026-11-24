// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Sidebar, SidebarProvider, SidebarTrigger, useSidebar } from '@/components/ui/sidebar';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

// Inside the provider: reads the mobile open state and exposes a way to
// simulate the Sheet's own close (overlay / ⨉ / Esc), which calls
// `setOpenMobile(false)` directly — the path the trigger guard must NOT block.
function Probe() {
    const { openMobile, setOpenMobile } = useSidebar();
    return (
        <>
            <span data-testid="open-mobile">{String(openMobile)}</span>
            <button data-testid="sheet-close" type="button" onClick={() => setOpenMobile(false)}>
                close
            </button>
        </>
    );
}

let host: HTMLDivElement;
let root: Root;
let now: number;
let nowSpy: ReturnType<typeof vi.spyOn>;

function render() {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() =>
        root.render(
            <SidebarProvider>
                <SidebarTrigger data-testid="trigger" />
                <Probe />
                <Sidebar>
                    <span>nav</span>
                </Sidebar>
            </SidebarProvider>,
        ),
    );
}

const trigger = () => document.querySelector<HTMLButtonElement>('[data-testid="trigger"]')!;
const sheetClose = () => document.querySelector<HTMLButtonElement>('[data-testid="sheet-close"]')!;
const openMobileText = () => document.querySelector<HTMLSpanElement>('[data-testid="open-mobile"]')!.textContent;
const mobileSheet = () => document.querySelector<HTMLElement>('[data-mobile="true"][data-slot="sidebar"]');

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    // Mobile viewport: the sidebar renders its Sheet, not the desktop rail.
    // `useIsMobile` reads `window.innerWidth < 768` in its effect (jsdom defaults
    // to 1024), so set the viewport as well as matchMedia.
    window.innerWidth = 375;
    window.matchMedia = (query: string) =>
        ({
            matches: true,
            media: query,
            addEventListener: () => {},
            removeEventListener: () => {},
        }) as unknown as MediaQueryList;
    // CB-332's guard is time-based: drive `Date.now()` from a controllable
    // clock so the second-tap-within-the-opening-window case is deterministic.
    now = 1_000_000;
    nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    render();
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
    nowSpy.mockRestore();
    document.cookie = 'sidebar_state=; max-age=0; path=/';
});

const advance = (ms: number) => {
    now += ms;
};

describe('mobile sidebar toggle (CB-332)', () => {
    it('opens on the first tap and slides in over 200ms, not 500ms', () => {
        expect(openMobileText()).toBe('false');
        act(() => trigger().click());
        expect(openMobileText()).toBe('true');

        const sheet = mobileSheet();
        expect(sheet).not.toBeNull();
        expect(sheet!.className).toContain('data-[state=open]:duration-200');
        // The base Sheet's 500ms open duration is overridden for the sidebar.
        expect(sheet!.className).not.toContain('duration-500');
    });

    it('ignores a second tap on the trigger within the opening window', () => {
        act(() => trigger().click());
        expect(openMobileText()).toBe('true');
        // A frustrated double-tap ~100ms into the slide-in must not close it.
        advance(100);
        act(() => trigger().click());
        expect(openMobileText()).toBe('true');
    });

    it('closes on a later tap once the opening window has passed', () => {
        act(() => trigger().click());
        expect(openMobileText()).toBe('true');
        advance(400); // past the 300ms guard
        act(() => trigger().click());
        expect(openMobileText()).toBe('false');
    });

    it('still closes immediately from the Sheet itself (overlay / ⨉ / Esc)', () => {
        act(() => trigger().click());
        expect(openMobileText()).toBe('true');
        advance(50); // within the trigger guard window
        act(() => sheetClose().click());
        // The Sheet's onOpenChange(false) is not guarded — only the trigger is.
        expect(openMobileText()).toBe('false');
    });
});
