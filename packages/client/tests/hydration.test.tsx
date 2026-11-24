// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { SidebarMenuSkeleton } from '../src/components/ui/sidebar';
import { ClientOnly, useHydrated } from '../src/lib/client-only';
import { LocalTime, utcTime } from '../src/lib/local-time';
import { defaultUiHints, paletteShortcut, uiHints } from '../src/shell/ui-hints';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let host: HTMLDivElement;
let root: Root | undefined;
let mismatches: unknown[];
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    mismatches = [];
    host = document.createElement('div');
    document.body.append(host);
});
afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    host.remove();
    vi.restoreAllMocks();
});

/**
 * Renders `ui` as the server would, then hydrates that markup in the
 * browser as entry.client.tsx does. Returns the server's HTML.
 */
async function serverThenHydrate(ui: ReactNode) {
    const html = renderToString(ui);
    host.innerHTML = html;
    await act(async () => {
        root = hydrateRoot(host, ui, {
            onRecoverableError: (error) => mismatches.push(error),
        });
    });
    return html;
}

function Probe() {
    return <span>{useHydrated() ? 'browser' : 'server'}</span>;
}

it('renders client-only parts after hydration, never on the server', async () => {
    const error = vi.spyOn(console, 'error');
    const html = await serverThenHydrate(
        <div>
            <Probe />
            <ClientOnly fallback={<p>Loading the chat…</p>}>{() => <p>The chat</p>}</ClientOnly>
        </div>,
    );
    expect(html).toContain('server');
    expect(html).toContain('Loading the chat…');
    expect(html).not.toContain('The chat<');
    // Hydration matched the server's markup, then the browser's part showed.
    expect(mismatches).toEqual([]);
    expect(error).not.toHaveBeenCalled();
    expect(host.textContent).toBe('browserThe chat');
});

it('shows times in UTC until hydrated, then in the reader’s own words', async () => {
    const value = Date.UTC(2026, 9, 9, 15, 4, 30);
    const html = await serverThenHydrate(<LocalTime value={value} format={() => '5m ago'} />);
    expect(utcTime(value)).toBe('2026-10-09 15:04 UTC');
    expect(html).toBe('<time dateTime="2026-10-09T15:04:30.000Z">2026-10-09 15:04 UTC</time>');
    expect(mismatches).toEqual([]);
    expect(host.textContent).toBe('5m ago');
});

it('renders the sidebar skeleton the same on the server and in the browser', async () => {
    const error = vi.spyOn(console, 'error');
    const skeletons = (
        <ul>
            <SidebarMenuSkeleton />
            <SidebarMenuSkeleton showIcon />
        </ul>
    );
    expect(renderToString(skeletons)).toBe(renderToString(skeletons));
    await serverThenHydrate(skeletons);
    expect(mismatches).toEqual([]);
    expect(error).not.toHaveBeenCalled();
});

it('reads the shortcut key and the sidebar state from the page request', () => {
    const mac = new Request('http://localhost/', {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            Cookie: 'theme=dark; sidebar_state=false',
        },
    });
    expect(uiHints(mac)).toEqual({ mac: true, sidebarOpen: false });
    expect(paletteShortcut(uiHints(mac))).toBe('⌘K');
    const linux = new Request('http://localhost/', {
        headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
        },
    });
    expect(uiHints(linux)).toEqual({ mac: false, sidebarOpen: true });
    expect(paletteShortcut(uiHints(linux))).toBe('Ctrl K');
    expect(uiHints(new Request('http://localhost/'))).toEqual(defaultUiHints);
});
