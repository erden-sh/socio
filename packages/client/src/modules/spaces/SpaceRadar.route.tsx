import type { LoaderFunctionArgs } from 'react-router';

import { routeI18n } from '../../i18n/page-i18n';
import { revalidateOn } from '../../lib/page-loader';
import type { RouteHandle } from '../../shell/shell-context';
import { spacePath } from '../pages/page-navigation';

/**
 * `/spaces/:spaceId/radar` (CB-282): the Space's route element shows its
 * Radar tab (`SpaceRoute`); this child names the crumb and
 * inlines the tab's words.
 */
export const handle: RouteHandle = {
    crumb: ({ workspace, params }) => {
        const found = workspace.spaces.find((item) => item.id === params.spaceId);
        return [found ? { label: found.name, to: spacePath(found.id) } : { label: 'Spaces' }, { label: 'Radar' }];
    },
};

/** Its namespaces (route-namespaces.json), inlined with the page; once a visit, as they don't change with the params. */
export async function loader({ context }: LoaderFunctionArgs) {
    return { i18n: await routeI18n(context, 'spaces:radar') };
}
export const shouldRevalidate = revalidateOn({ search: false });

export default function SpaceRadarRoute() {
    return null;
}
