// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { DEFAULT_BRANDING, type Branding } from '@socio/shared/branding';

import { useBrandingDocument } from '../src/lib/branding-meta';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

// CB-305: the browser tab identifies the current page and the app, as
// `<page> • <app>` (e.g. "Issues • Socio"). The hook is a progressive
// enhancement over the server-rendered fallback, so these exercise the
// client effect in jsdom.

let root: Root;
let host: HTMLElement;

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    document.title = '';
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

/** Renders the hook with live props so a test can flip them. */
function Harness({ branding, pageTitle }: { branding?: Branding | null; pageTitle?: string }) {
    useBrandingDocument(branding, pageTitle);
    return null;
}

it('shows only the app title when no page title is given (sign-in / fallback)', () => {
    act(() => root.render(<Harness branding={{ name: 'Socio', logo: '/favicon.svg' }} />));
    expect(document.title).toBe('Socio');
    expect(document.querySelector<HTMLLinkElement>('link[rel~=icon]')?.href).toContain('/favicon.svg');
});

it('prefixes the page title with the app title for an in-app page', () => {
    act(() => root.render(<Harness branding={{ name: 'Socio', logo: '/favicon.svg' }} pageTitle="Issues" />));
    expect(document.title).toBe('Issues • Socio');
});

it('updates the tab when the page changes', () => {
    function Changing({ page }: { page: string }) {
        useBrandingDocument({ name: 'Socio', logo: '/x.svg' }, page);
        return null;
    }
    act(() => root.render(<Changing page="Issues" />));
    expect(document.title).toBe('Issues • Socio');
    act(() => root.render(<Changing page="CB-12" />));
    expect(document.title).toBe('CB-12 • Socio');
});

it('falls back to the default brand name and logo when branding is absent', () => {
    act(() => root.render(<Harness pageTitle="Home" />));
    expect(document.title).toBe(`Home • ${DEFAULT_BRANDING.name}`);
    expect(document.querySelector<HTMLLinkElement>('link[rel~=icon]')?.href).toContain(DEFAULT_BRANDING.logo);
});

it('drops back to the app title alone when the page leaves', () => {
    function Optional({ page }: { page?: string }) {
        useBrandingDocument({ name: 'Acme Brain', logo: '/l.svg' }, page);
        return null;
    }
    act(() => root.render(<Optional page="Data" />));
    expect(document.title).toBe('Data • Acme Brain');
    act(() => root.render(<Optional />));
    expect(document.title).toBe('Acme Brain');
});
