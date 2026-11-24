// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { NavUser } from '@/components/nav-user';
import { ThemeSegments } from '@/components/theme-toggle';
import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu';
import { SidebarProvider } from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/sonner';
import { THEME_STORAGE_KEY, ThemeProvider, useThemeChoice } from '@/shell/theme';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root;
let host: HTMLElement;
let systemDark = false;
let consoleError: ReturnType<typeof vi.spyOn>;
const html = document.documentElement;

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    systemDark = false;
    // jsdom has no matchMedia: answer the dark-scheme query from systemDark.
    window.matchMedia = (query: string) =>
        ({
            matches: query === '(prefers-color-scheme: dark)' && systemDark,
            media: query,
            addListener: () => {},
            removeListener: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
        }) as unknown as MediaQueryList;
    consoleError = vi.spyOn(console, 'error');
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
    // No React errors or warnings (next-themes' script tag among them).
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
    localStorage.clear();
    html.className = '';
    html.style.colorScheme = '';
});

let current: ReturnType<typeof useThemeChoice>;
function Probe() {
    current = useThemeChoice();
    return null;
}

const mount = (children: React.ReactNode = <Probe />) =>
    act(() => root.render(<ThemeProvider>{children}</ThemeProvider>));

const remount = (children?: React.ReactNode) => {
    act(() => root.unmount());
    root = createRoot(host);
    mount(children);
};

const keyDown = (element: Element, key: string) =>
    act(() => {
        element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });

const menuItem = (role: string, name: string) =>
    [...document.querySelectorAll<HTMLElement>(`[role="${role}"]`)].find((item) => item.textContent?.includes(name));

it('follows the system by default', () => {
    mount();
    expect(current.choice).toBe('system');
    expect(html.classList.contains('light')).toBe(true);
    expect(html.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();

    systemDark = true;
    remount();
    expect(current.choice).toBe('system');
    expect(current.resolved).toBe('dark');
    expect(html.classList.contains('dark')).toBe(true);
    expect(html.style.colorScheme).toBe('dark');
});

it('applies .dark for a dark choice and keeps the choice across a reload', () => {
    mount();
    act(() => current.setChoice('dark'));
    expect(html.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    html.className = '';
    remount();
    expect(current.choice).toBe('dark');
    expect(html.classList.contains('dark')).toBe(true);

    // Light wins over a dark system once chosen.
    systemDark = true;
    act(() => current.setChoice('light'));
    remount();
    expect(current.choice).toBe('light');
    expect(html.classList.contains('dark')).toBe(false);
    expect(html.classList.contains('light')).toBe(true);
});

it('switches from the Help menu’s segments and keeps the menu open (CB-308)', () => {
    mount(
        <>
            <DropdownMenu open>
                <DropdownMenuContent>
                    <ThemeSegments />
                </DropdownMenuContent>
            </DropdownMenu>
            <Probe />
        </>,
    );
    const group = document.querySelector('[data-slot="theme-segments"]')!;
    expect(group.getAttribute('role')).toBe('group');
    expect(document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent).toBe('Theme');
    expect(menuItem('menuitemradio', 'System')!.dataset.state).toBe('checked');
    act(() => menuItem('menuitemradio', 'Dark')!.click());
    expect(current.choice).toBe('dark');
    expect(html.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    // Still open, the new choice raised.
    expect(menuItem('menuitemradio', 'Dark')!.dataset.state).toBe('checked');
    keyDown(menuItem('menuitemradio', 'System')!, 'Enter');
    expect(current.choice).toBe('system');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');
    expect(html.classList.contains('dark')).toBe(false);
});

it('offers the theme in the account menu', () => {
    mount(
        <SidebarProvider>
            <NavUser user={{ id: 'alice', name: 'Alice', role: 'admin' }} onSwitchUser={() => {}} />
            <Probe />
        </SidebarProvider>,
    );
    keyDown(document.querySelector('[aria-label="Account: Alice"]')!, 'Enter');
    const theme = menuItem('menuitem', 'Theme')!;
    expect(theme.textContent).toContain('System');
    keyDown(theme, 'ArrowRight');
    act(() => menuItem('menuitemradio', 'Light')!.click());
    expect(current.choice).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
});

it('gives the toasts the theme', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    mount(<Toaster />);
    await act(async () => {
        toast('Saved');
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.querySelector('[data-sonner-toaster]')?.getAttribute('data-sonner-theme')).toBe('dark');
});

it('themes the first paint from the stored choice (public/theme-init.js)', () => {
    const source = readFileSync(join(import.meta.dirname, '../../../public/theme-init.js'), 'utf8');
    const run = (stored: string | null, dark: boolean) => {
        localStorage.clear();
        if (stored !== null) {
            localStorage.setItem(THEME_STORAGE_KEY, stored);
        }
        systemDark = dark;
        html.className = 'light dark';
        new Function(source)();
        return [...html.classList].join(' ') + ' ' + html.style.colorScheme;
    };
    expect(run(null, false)).toBe('light light');
    expect(run(null, true)).toBe('dark dark');
    expect(run('system', true)).toBe('dark dark');
    expect(run('light', true)).toBe('light light');
    expect(run('dark', false)).toBe('dark dark');
    expect(run('purple', false)).toBe('light light');
});
