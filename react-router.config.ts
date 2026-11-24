import type { Config } from '@react-router/dev/config';

/**
 * React Router framework mode: pages render on the server, inside the Hono
 * app (src/server/web). The build goes to dist/web, next to tsc's
 * dist/server. Routes are discovered lazily through /__manifest, which also
 * tells a tab on an older build to load the page again.
 */
export default {
    appDirectory: 'packages/client/src',
    buildDirectory: 'dist/web',
    ssr: true,
    routeDiscovery: { mode: 'lazy', manifestPath: '/__manifest' },
} satisfies Config;
