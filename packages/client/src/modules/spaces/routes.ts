import { index, layout, route } from '@react-router/dev/routes';

// Empty children: SpaceRoute reads the page id, so the Space stays mounted
// between its library and its pages.
export default layout('modules/spaces/gate.route.tsx', { id: 'module:spaces' }, [
    route('spaces', 'modules/spaces/SpacesIndex.route.tsx', {
        id: 'spaces:index',
    }),
    route('spaces/:spaceId', 'modules/spaces/SpaceRoute.route.tsx', { id: 'spaces:space' }, [
        index('views/Empty.route.tsx', { id: 'spaces:library' }),
        route('pages/:pageId', 'modules/pages/Page.route.tsx', { id: 'spaces:page' }),
        // The Space's shared memory (CB-181).
        route('memory', 'modules/spaces/SpaceMemory.route.tsx', {
            id: 'spaces:memory',
        }),
        // The Space's change radar (CB-282).
        route('radar', 'modules/spaces/SpaceRadar.route.tsx', {
            id: 'spaces:radar',
        }),
        // Who sees the Space, and its people (CB-181).
        route('settings', 'modules/spaces/SpaceSettings.route.tsx', {
            id: 'spaces:settings',
        }),
    ]),
]);
