import type { RouterContextProvider } from 'react-router';

import { SOURCE_LOCALE } from '@socio/i18n/registry';
import ROUTES from '@socio/i18n/route-namespaces.json';
import type { PageI18n } from '@socio/shared/web/web';

import { webContext } from '../lib/web-context';

/**
 * The namespaces each route inlines into its page (route-namespaces.json,
 * by route id): the root's on every page, a route's only on its own. The
 * build reports each route's size against its budget
 * (scripts/i18n-build.mjs).
 */
export const ROUTE_NAMESPACES = ROUTES as unknown as Readonly<Record<string, readonly string[]>>;

/** A page with no dictionaries from the server (a test without them): en-US, by key. */
export const EN_US_PAGE: PageI18n = {
    locale: SOURCE_LOCALE,
    dir: 'ltr',
    manifest: { release: '', locales: {} },
    resources: {},
    offered: [SOURCE_LOCALE],
};

/** What a loader returns for its route's namespaces: `{ i18n }` beside its own data. */
export interface RouteI18n {
    i18n: PageI18n;
}

/**
 * In a loader: the page's locale and route `id`'s namespaces, from the
 * server (`WebServices.i18n`). The layout adds them to the page's i18next
 * instance before the route renders, on the server and in the browser
 * alike, so hydration sees the same strings.
 */
export async function routeI18n(context: Readonly<RouterContextProvider>, id: string): Promise<PageI18n> {
    const namespaces = ROUTE_NAMESPACES[id];
    if (!namespaces) {
        throw new Error(`Route ${id} has no entry in route-namespaces.json.`);
    }
    let services;
    try {
        services = context.get(webContext).services;
    } catch {
        return EN_US_PAGE;
    }
    return (await services.i18n?.(namespaces)) ?? EN_US_PAGE;
}

/** The page's i18n data in a route's loader data, if it has some. */
export const i18nOf = (data: unknown): PageI18n | undefined =>
    typeof data === 'object' && data !== null && 'i18n' in data ? (data as RouteI18n).i18n : undefined;
