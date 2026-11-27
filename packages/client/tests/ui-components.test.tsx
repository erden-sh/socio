// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
    Sidebar,
    SidebarContent,
    SidebarInset,
    SidebarMenu,
    SidebarMenuAction,
    SidebarMenuBadge,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarMenuSub,
    SidebarMenuSubButton,
    SidebarMenuSubItem,
    SidebarProvider,
    SidebarTrigger,
} from '@/components/ui/sidebar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root;
let host: HTMLElement;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    // jsdom has no matchMedia; the sidebar's useIsMobile needs it.
    window.matchMedia = (query: string) =>
        ({
            matches: false,
            media: query,
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
    consoleError.mockRestore();
});

it('mounts shadcn components together without errors', () => {
    act(() =>
        root.render(
            <SidebarProvider>
                <Sidebar collapsible="icon">
                    <SidebarContent>
                        <SidebarMenu>
                            <SidebarMenuItem>
                                <SidebarMenuButton tooltip="New chat">New chat</SidebarMenuButton>
                            </SidebarMenuItem>
                        </SidebarMenu>
                    </SidebarContent>
                </Sidebar>
                <SidebarInset>
                    <SidebarTrigger />
                    <Button variant="outline">Save</Button>
                    <Input aria-label="Name" />
                    <Badge>New</Badge>
                    <Card>
                        <CardHeader>
                            <CardTitle>Card</CardTitle>
                        </CardHeader>
                        <CardContent>Body</CardContent>
                    </Card>
                    <Tabs defaultValue="one">
                        <TabsList>
                            <TabsTrigger value="one">One</TabsTrigger>
                        </TabsList>
                        <TabsContent value="one">First tab</TabsContent>
                    </Tabs>
                    <Dialog open>
                        <DialogContent>
                            <DialogTitle>Rename page</DialogTitle>
                            <DialogDescription>Pick a new title.</DialogDescription>
                        </DialogContent>
                    </Dialog>
                </SidebarInset>
            </SidebarProvider>,
        ),
    );
    expect(consoleError).not.toHaveBeenCalled();
    // Every element carries data-slot: legacy element rules skip them.
    for (const slot of [
        'sidebar-wrapper',
        'sidebar-menu-button',
        'sidebar-inset',
        'button',
        'input',
        'badge',
        'card-title',
        'tabs-content',
    ]) {
        expect(document.querySelector(`[data-slot="${slot}"]`)).not.toBeNull();
    }
    // The dialog renders in a portal on <body>, outside the app root.
    const dialog = document.querySelector('[data-slot="dialog-content"]');
    expect(dialog?.textContent).toContain('Rename page');
    expect(host.contains(dialog)).toBe(false);
});

it('toggles the sidebar with Ctrl+B', () => {
    act(() =>
        root.render(
            <SidebarProvider>
                <Sidebar collapsible="icon">
                    <SidebarContent />
                </Sidebar>
            </SidebarProvider>,
        ),
    );
    const state = () => document.querySelector('[data-slot="sidebar"]')?.getAttribute('data-state');
    expect(state()).toBe('expanded');
    act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true }));
    });
    expect(state()).toBe('collapsed');
});

it('makes every sidebar row 44 px on a touch screen, its ⋯ and badge centred, and leaves the mouse’s density', () => {
    act(() =>
        root.render(
            <SidebarProvider>
                <Sidebar>
                    <SidebarContent>
                        <SidebarMenu>
                            <SidebarMenuItem>
                                <SidebarMenuButton>A chat</SidebarMenuButton>
                                <SidebarMenuAction aria-label="Options" />
                                <SidebarMenuBadge>3</SidebarMenuBadge>
                                <SidebarMenuSub>
                                    <SidebarMenuSubItem>
                                        <SidebarMenuSubButton href="/p">A page</SidebarMenuSubButton>
                                    </SidebarMenuSubItem>
                                </SidebarMenuSub>
                            </SidebarMenuItem>
                            <SidebarMenuItem>
                                <SidebarMenuButton size="sm">Show all</SidebarMenuButton>
                            </SidebarMenuItem>
                        </SidebarMenu>
                    </SidebarContent>
                </Sidebar>
            </SidebarProvider>,
        ),
    );
    const classes = (selector: string) => [...document.querySelectorAll(selector)].map((el) => el.className);
    for (const row of classes('[data-sidebar="menu-button"], [data-sidebar="menu-sub-button"]')) {
        expect(row).toContain('pointer-coarse:min-h-11');
        // With a mouse, as compact as before.
        expect(row).toMatch(/\bh-[78]\b/);
    }
    for (const end of classes('[data-sidebar="menu-action"], [data-sidebar="menu-badge"]')) {
        expect(end).toContain('pointer-coarse:top-3!');
    }
    expect(classes('[data-sidebar="menu-action"]')[0]).toContain('pointer-coarse:after:-inset-3');
});

it('greys a disabled primary button on the theme’s shade rather than fading it', () => {
    act(() =>
        root.render(
            <>
                <Button>Save</Button>
                <Button disabled>Saving</Button>
            </>,
        ),
    );
    const [save, saving] = [...document.querySelectorAll('button')];
    for (const button of [save!, saving!]) {
        expect(button.className).toContain('hover:bg-primary-hover');
        expect(button.className).toContain('active:bg-primary-hover');
        expect(button.className).toContain('disabled:bg-primary-disabled');
        expect(button.className).toContain('disabled:opacity-100');
        expect(button.className).not.toContain('disabled:opacity-50');
        expect(button.className).not.toMatch(/bg-primary\/\d/);
    }
});

it('rings a menu item that has the keyboard’s focus', () => {
    act(() =>
        root.render(
            <DropdownMenu open>
                <DropdownMenuTrigger>Open</DropdownMenuTrigger>
                <DropdownMenuContent>
                    <DropdownMenuItem>Rename</DropdownMenuItem>
                    <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>,
        ),
    );
    const items = document.querySelectorAll('[data-slot="dropdown-menu-item"]');
    expect(items).toHaveLength(2);
    for (const item of items) {
        expect(item.className).toContain('focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset');
    }
});

it('merges conflicting Tailwind classes in cn', () => {
    const collapsed = false;
    expect(cn('px-2 py-1', collapsed && 'hidden', 'px-4')).toBe('py-1 px-4');
});

it('keeps the stylesheets free of external URLs and layers the legacy CSS', () => {
    const read = (path: string) => readFileSync(join(import.meta.dirname, '../src', path), 'utf8');
    const globals = read('globals.css');
    expect(globals).toMatch(/^@layer theme, base, legacy, editor, components, utilities;$/m);
    for (const file of ['style.css', 'styles/legacy-reset.css']) {
        expect(globals).toContain(`@import './${file}' layer(legacy);`);
    }
    // A page's prose, on the tokens, above the legacy rules (CB-95).
    expect(globals).toContain(`@import './modules/pages/editor.css' layer(editor);`);
    for (const file of ['globals.css', 'style.css', 'modules/pages/editor.css', 'styles/legacy-reset.css']) {
        const css = read(file);
        expect(css).not.toMatch(/url\(\s*['"]?(https?:)?\/\//i);
        expect(css).not.toMatch(/@import\s+(url\()?\s*['"]?(https?:)?\/\//i);
    }
});

it('spaces every page frame and heading by the page chrome tokens (CB-91)', () => {
    const read = (path: string) => readFileSync(join(import.meta.dirname, '../src', path), 'utf8');
    const tokens = readFileSync(new URL(import.meta.resolve('@socio/ui/tokens.css')), 'utf8');
    expect(tokens).toMatch(/--page-top: [\d.]+rem;/);
    expect(tokens).toMatch(/--page-gap: [\d.]+rem;/);
    // Each rule of a frame (at every width) starts at --page-top, and each
    // heading's space below is --page-gap: no literal pixels creep back.
    const rules = (css: string, selector: string) =>
        [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)]
            .filter(([, head]) => head.split(',').some((s) => s.trim() === selector))
            .map(([, , body]) => body);
    const frames: [string, string][] = [['style.css', '.main-content']];
    for (const [file, selector] of frames) {
        const padding = rules(read(file), selector).flatMap((body) => body.match(/padding(-top)?:[^;]*/g) ?? []);
        expect(padding.length, selector).toBeGreaterThan(0);
        for (const value of padding) {
            expect(value, selector).toMatch(/^padding: var\(--page-top\) /);
        }
    }
    // The pages on Tailwind headings use the same top: Home, and every
    // workspace page's header (PageHeader, CB-220).
    for (const file of ['shell/Home.tsx', 'views/WorkspacePage.tsx']) {
        expect(read(file), file).toContain('pt-(--page-top)');
    }
    // A workspace page's content, below its header.
    expect(read('views/WorkspacePage.tsx')).toContain('var(--page-gap)');
});

// jsdom has no layout: scripts/card-header-layout-smoke.mjs checks the
// geometry in Chromium and WebKit. This keeps a regenerated shadcn card
// from bringing back the side-by-side action on phones.
it('stacks a card header action under the description on narrow cards (CB-262)', () => {
    act(() =>
        root.render(
            <Card>
                <CardHeader>
                    <CardTitle>Datasets</CardTitle>
                    <CardDescription>Each socio has a scratch dataset.</CardDescription>
                    <CardAction>
                        <Button>Create</Button>
                    </CardAction>
                </CardHeader>
            </Card>,
        ),
    );
    const classes = (slot: string) => host.querySelector(`[data-slot="${slot}"]`)!.className.split(' ');
    // Title and description stay in the first column...
    expect(classes('card-header')).toContain('[&>:not([data-slot=card-action])]:col-start-1');
    expect(classes('card-header')).not.toContain('gap-2');
    // ...and the action takes the second only on a wide header.
    const action = classes('card-action');
    expect(action).toContain('col-span-full');
    expect(action).toContain('@md/card-header:col-[2]');
    expect(action).not.toContain('col-start-2');
    expect(consoleError).not.toHaveBeenCalled();
});
