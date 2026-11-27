import { useEffect, useState, type ReactNode } from 'react';
import { useMatches } from 'react-router';

import { I18nextProvider } from '@socio/i18n/react';

import { EN_US_PAGE, i18nOf } from './page-i18n';
import { addPageResources, applyLocale, pageInstance } from './page-instance';

/**
 * The page's translations for everything under it: the root loader's
 * locale and namespaces, and each matched route's own, added before the
 * route renders, so the server and the hydrating browser render the same
 * strings. An error page with no loader data renders en-US.
 */
export function I18nRoot({ children }: { children: ReactNode }) {
    const matches = useMatches();
    const page = i18nOf(matches[0]?.loaderData) ?? EN_US_PAGE;
    const [instance] = useState(() => pageInstance(page));
    for (const match of matches) {
        addPageResources(instance, i18nOf(match.loaderData));
    }
    // The root loader ran again (after signing in, or a preference saved
    // elsewhere) and resolved another locale: follow it.
    useEffect(() => {
        if (instance.language !== page.locale) {
            void applyLocale(instance, page.locale);
        }
    }, [instance, page.locale]);
    return <I18nextProvider i18n={instance}>{children}</I18nextProvider>;
}

/** The page's locale and direction, for `<html>`: the root loader's, en-US without one. */
export function usePageLocale() {
    const page = i18nOf(useMatches()[0]?.loaderData) ?? EN_US_PAGE;
    return { lang: page.locale, dir: page.dir, offered: page.offered };
}
