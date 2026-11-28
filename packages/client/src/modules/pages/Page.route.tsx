import type { ClientLoaderFunctionArgs, LoaderFunctionArgs } from 'react-router';

import { routeI18n } from '../../i18n/page-i18n';
import { preloadNamespaces } from '../../i18n/page-instance';
import { revalidateOn } from '../../lib/page-loader';

/**
 * `/spaces/:spaceId/pages/:pageId`: the Space's route element shows the
 * page (`SpaceRoute`, which reads the page id); this child inlines the
 * page view's words. The page's own data is the Space's loader's.
 */

/** Its namespaces (route-namespaces.json), inlined with the page; once a visit, as they don't change with the params. */
export async function loader({ context }: LoaderFunctionArgs) {
    return { i18n: await routeI18n(context, 'spaces:page') };
}

/**
 * What the page loads on demand that the route doesn't inline: the
 * editor's words (pages.editor). The editor runs in the browser only, so
 * the server never shows them.
 */
const ON_DEMAND = ['pages.editor'];

/**
 * A navigation in the browser: the route's words, and at the same time the
 * editor's (`ON_DEMAND`), so they don't wait for each other. The navigation
 * doesn't wait for the editor's: it shows its loading line until they're
 * in. The first page load uses the server's data.
 */
export function clientLoader({ serverLoader }: ClientLoaderFunctionArgs) {
    void preloadNamespaces(ON_DEMAND);
    return serverLoader<typeof loader>();
}
export const shouldRevalidate = revalidateOn({ search: false });

/** The page itself is the Space's route element's. */
export default function PageRoute() {
    return null;
}
