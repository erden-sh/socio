import type { i18n as I18n, Resource } from 'i18next';
import HttpBackend, { type HttpBackendOptions } from 'i18next-http-backend';

import { hasLocale, MANIFEST_PATH, namespaceUrl, type I18nManifest } from '@socio/i18n/manifest';
import { LOCALE_COOKIE } from '@socio/i18n/negotiate';
import { createReactI18n } from '@socio/i18n/react';
import { localeDir } from '@socio/i18n/registry';
import type { PageI18n } from '@socio/shared/web/web';

/**
 * The page's i18next instance. On the server, one per render, from what
 * the loaders inlined. In the browser, one for the page (`I18nRoot` keeps
 * it), created at hydration from the same data; namespaces a later locale
 * needs come from this server (`/i18n/<locale>/<ns>.<hash>.json`,
 * immutable), named by the manifest, through i18next-http-backend.
 */

/** Each instance's manifest, and how many language changes it has started (the latest one wins). */
const manifests = new WeakMap<I18n, { manifest: I18nManifest; changes: number }>();

function create(page: PageI18n, inBrowser: boolean): I18n {
    const state = { manifest: page.manifest as I18nManifest, changes: 0 };
    const backendOptions: HttpBackendOptions = {
        // One language and one namespace a request (no multiloading): its
        // hashed file, or nothing when the build has none (a sparse locale).
        loadPath: (languages, namespaces) => namespaceUrl(state.manifest, languages[0]!, namespaces[0]!) ?? '',
        // Same origin, and the files are public: no credentials needed.
        requestOptions: { mode: 'same-origin', credentials: 'omit', cache: 'default' },
    };
    const instance = createReactI18n({
        locale: page.locale,
        resources: page.resources as Resource,
        namespaces: Object.keys(page.resources[page.locale] ?? {}),
        ...(inBrowser && { backend: HttpBackend, backendOptions, drivesActiveLocale: true }),
    });
    manifests.set(instance, state);
    return instance;
}

/** The browser's page instance, once the page has made it (one a page). */
let browserInstance: I18n | undefined;

/** A page's instance: in the browser it loads more and drives `@socio/shared/locale`; on the server it doesn't. */
export function pageInstance(page: PageI18n): I18n {
    const inBrowser = typeof document !== 'undefined';
    const instance = create(page, inBrowser);
    if (inBrowser) {
        browserInstance = instance;
    }
    return instance;
}

/**
 * Starts loading `namespaces` in the page's language, outside React: from a
 * route's `clientLoader`, so what its page loads on demand is on its way
 * together with the route's data, not after it. Resolves once they're in
 * (at once for those already in, or with no page instance yet).
 */
export function preloadNamespaces(namespaces: readonly string[]): Promise<void> {
    const instance = browserInstance;
    if (!instance) {
        return Promise.resolve();
    }
    return new Promise((resolve) => void instance.loadNamespaces([...namespaces], () => resolve()));
}

/** Adds what a route's loader inlined (only what isn't there yet); safe to call while rendering. */
export function addPageResources(instance: I18n, page: PageI18n | undefined) {
    if (!page) {
        return;
    }
    for (const [locale, namespaces] of Object.entries(page.resources)) {
        for (const [ns, resources] of Object.entries(namespaces)) {
            if (!instance.hasResourceBundle(locale, ns)) {
                instance.addResourceBundle(locale, ns, resources, true, true);
            }
        }
    }
    const state = manifests.get(instance);
    if (state) {
        state.manifest = {
            release: state.manifest.release || page.manifest.release,
            locales: { ...page.manifest.locales, ...state.manifest.locales },
        };
    }
}

/** The `socio_locale` cookie: kept for a year, for signed-out pages; cleared to follow the browser. */
function setLocaleCookie(locale: string | null) {
    document.cookie = locale
        ? `${LOCALE_COOKIE}=${encodeURIComponent(locale)}; Path=/; Max-Age=31536000; SameSite=Lax`
        : `${LOCALE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}

/**
 * Switches the page to `locale` without a reload: the manifest for it if
 * this page has none, then its namespaces, then `<html lang dir>`. `chosen`
 * (the saved preference, or null to follow the browser) goes into the
 * cookie; undefined leaves the cookie alone.
 *
 * Only the latest change applies: one started while another still waits
 * for its manifest makes the older one stop where it is, so a slow
 * Spanish can't land after a quick English. True when this one applied.
 */
export async function applyLocale(instance: I18n, locale: string, chosen?: string | null): Promise<boolean> {
    const state = manifests.get(instance);
    if (!state) {
        throw new Error('applyLocale takes the page’s own instance (usePageInstance), not a proxy of it.');
    }
    const change = ++state.changes;
    const current = () => change === state.changes;
    if (!hasLocale(state.manifest, locale)) {
        const response = await fetch(`${MANIFEST_PATH}?locales=${encodeURIComponent(locale)}`, {
            credentials: 'omit',
        });
        if (response.ok) {
            const fetched = (await response.json()) as I18nManifest;
            state.manifest = { release: fetched.release, locales: { ...state.manifest.locales, ...fetched.locales } };
        }
    }
    if (!current()) {
        return false;
    }
    // i18next itself switches to the last language asked for.
    await instance.changeLanguage(locale);
    if (!current()) {
        return false;
    }
    document.documentElement.lang = locale;
    document.documentElement.dir = localeDir(locale);
    if (chosen !== undefined) {
        setLocaleCookie(chosen);
    }
    return true;
}
