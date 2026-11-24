import type { RouteHandle } from '../../shell/shell-context';
import { spacePath } from '../pages/page-navigation';

/**
 * `/spaces/:spaceId/memory` (CB-181): the Space's route element shows its
 * Memory tab (`SpaceRoute`); this child only names the crumb.
 */
export const handle: RouteHandle = {
    crumb: ({ workspace, params }) => {
        const found = workspace.spaces.find((item) => item.id === params.spaceId);
        return [found ? { label: found.name, to: spacePath(found.id) } : { label: 'Spaces' }, { label: 'Memory' }];
    },
};

export default function SpaceMemoryRoute() {
    return null;
}
