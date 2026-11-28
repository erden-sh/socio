import { useLoaderData, type LoaderFunctionArgs } from 'react-router';

import { routeI18n } from '../../i18n/page-i18n';
import { revalidateOn } from '../../lib/page-loader';
import { web } from '../../lib/web-context';
import { SpaceRoute } from '../../views/SpaceRoute';

import type { SpaceRouteData } from './handle';

export { spaceHandle as handle } from './handle';

/**
 * The library's first screen: the most recently edited pages without
 * their bodies, and the open page's title for the heading and crumb.
 * Every page's summary stays the page's own poll, and the open page's
 * body its own read. Null signed out or for a Space that isn't there.
 * The page's namespaces come inlined with it.
 */
export async function loader({ context, params }: LoaderFunctionArgs) {
    const { services } = web(context);
    // Its namespaces (route-namespaces.json) and the library, together.
    const [i18n, library] = await Promise.all([
        routeI18n(context, 'spaces:space'),
        (async () =>
            params.spaceId && (await services.user()) ? services.spaceLibrary(params.spaceId, params.pageId) : null)(),
    ]);
    return { i18n, library: library ?? null } satisfies SpaceRouteData;
}
// Moving between the Space's pages keeps it: the page polls.
export const shouldRevalidate = revalidateOn({
    params: ['spaceId'],
    polled: true,
});

export default function SpaceRouteModule() {
    const { library } = useLoaderData<typeof loader>();
    return <SpaceRoute library={library ?? undefined} />;
}
