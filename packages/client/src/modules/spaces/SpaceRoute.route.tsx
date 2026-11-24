import { useLoaderData, type LoaderFunctionArgs } from 'react-router';

import { revalidateOn } from '../../lib/page-loader';
import { web } from '../../lib/web-context';
import { SpaceRoute } from '../../views/SpaceRoute';

export { spaceHandle as handle } from './handle';

/**
 * The library's first screen: the most recently edited pages without
 * their bodies, and the open page's title for the heading and crumb.
 * Every page's summary stays the page's own poll, and the open page's
 * body its own read. Null signed out or for a Space that isn't there.
 */
export async function loader({ context, params }: LoaderFunctionArgs) {
    const { services } = web(context);
    if (!params.spaceId || !(await services.user())) {
        return null;
    }
    return services.spaceLibrary(params.spaceId, params.pageId);
}
// Moving between the Space's pages keeps it: the page polls.
export const shouldRevalidate = revalidateOn({
    params: ['spaceId'],
    polled: true,
});

export default function SpaceRouteModule() {
    const library = useLoaderData<typeof loader>();
    return <SpaceRoute library={library ?? undefined} />;
}
