import { useEffect } from 'react';

import type { Branding } from '@socio/shared/branding';
import { DEFAULT_BRANDING } from '@socio/shared/branding';

/**
 * Keep the browser tab's identity in sync with the workspace brand.
 * Updates document.title and the favicon link whenever the active brand
 * (or the current page) changes. The root layout already provides a
 * static fallback, so this is a progressive enhancement for
 * signed-in/signed-out shell views.
 *
 * With a `pageTitle` (the current page, e.g. "Issues" or a chat's title),
 * the tab reads `<page> • <app>` so it identifies both the page and the
 * app (CB-305); without one it falls back to the app title alone, as the
 * sign-in page and the server-rendered fallback do.
 */
export function useBrandingDocument(branding?: Branding | null, pageTitle?: string) {
    const brand = branding ?? DEFAULT_BRANDING;
    const appTitle = brand.name || DEFAULT_BRANDING.name;
    const icon = brand.logo || DEFAULT_BRANDING.logo;
    const title = pageTitle ? `${pageTitle} • ${appTitle}` : appTitle;

    useEffect(() => {
        if (typeof document === 'undefined') {
            return;
        }
        document.title = title;

        let link = document.querySelector<HTMLLinkElement>('link[rel~=icon]');
        if (!link) {
            link = document.createElement('link');
            link.rel = 'icon';
            document.head.appendChild(link);
        }
        // A data-url logo works as a favicon in modern browsers; same-origin
        // paths are unchanged. The server validates brand.logo to be one of these.
        link.href = icon;
    }, [title, icon]);
}
