import { index, layout, route, type RouteConfig } from '@react-router/dev/routes';

import { moduleRoutes } from './modules/routes';

/**
 * The app's routes. The shell (`App`: sign-in, the workspace poll, the
 * sidebar and header) is a pathless layout around every page: the home
 * launcher at `/`, each module's pages behind its gate, and NotFound.
 *
 * Files are relative to `packages/client/src`. Every route has a fixed id: ids name
 * routes in the browser (and, with server rendering, in data requests from
 * tabs on an older build), so they stay the same when files move.
 */
export default [
    route('docs/*', 'modules/docs/Docs.route.tsx', { id: 'docs' }),
    layout('shell/Shell.route.tsx', { id: 'shell' }, [
        index('shell/Home.route.tsx', { id: 'home' }),
        // The shell shows the sign-in screen for these when they carry a token.
        route('reset-password', 'views/OneTimeLink.route.tsx', {
            id: 'reset-password',
        }),
        route('sign-in-link', 'views/OneTimeLink.route.tsx', {
            id: 'sign-in-link',
        }),
        // Connected agents (CB-90): the consent screen, and the way back to it
        // after signing in.
        route('connect', 'views/Connect.route.tsx', { id: 'connect' }),
        route('connect/continue', 'views/ConnectContinue.route.tsx', {
            id: 'connect-continue',
        }),
        // The Socio app's sign-in sheet (CB-352, WC): "Sign in to the Socio
        // app?", after the shell's sign-in when signed out.
        route('device/continue', 'views/DeviceContinue.route.tsx', { id: 'device-continue' }),
        // Socio's release notes (CB-168), for everyone signed in.
        route('releases/:tag?', 'views/Releases.route.tsx', { id: 'releases' }),
        ...moduleRoutes,
        // An installed plugin's page: outside the admin-only Plugins gate, as
        // its audience may include members (the page checks the launcher list).
        // The whole address is the plugin's (CB-446): `/plugins/:id` and every
        // `/plugins/:id/<path>` are this one route, the splat (with the query
        // and fragment) being the app's own route, so moving inside the plugin
        // never remounts its frame. The platform keeps no page under it: a
        // plugin's settings are `/settings/plugins/:id`, and a tab plugin opens
        // from `/plugins/:id` itself.
        route('plugins/:pluginId/*', 'modules/plugins/PluginFrame.route.tsx', {
            id: 'plugins:frame',
        }),
        route('*', 'views/NotFound.route.tsx', { id: 'not-found' }),
    ]),
] satisfies RouteConfig;
