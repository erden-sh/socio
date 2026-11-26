import { fileURLToPath } from 'node:url';

import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// The browser and server builds of the pages (react-router.config.ts).
// Vite's root is the repository, and the source is packages/client/src
// (packages/client/README.md has why). Tests use vitest.shared.ts instead,
// without the React Router plugin.
export default defineConfig({
    plugins: [
        {
            name: 'server-only-docs',
            enforce: 'pre',
            load(id, options) {
                if (!options?.ssr && /[\\/]content[\\/]docs[\\/]|[\\/]src[\\/]server[\\/]docs[\\/]/.test(id)) {
                    throw new Error('Docs content cannot enter the client build');
                }
            },
        },
        tailwindcss(),
        reactRouter(),
    ],
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./packages/client/src', import.meta.url)),
            // The packages' source: tsc and Node read their builds instead
            // (packages/shared/README.md).
            '@socio/shared': fileURLToPath(new URL('./packages/shared/src', import.meta.url)),
            '@socio/foundation': fileURLToPath(new URL('./packages/foundation/src', import.meta.url)),
            '@socio/data': fileURLToPath(new URL('./packages/data/src', import.meta.url)),
            // CopilotKit's web inspector reports to telemetry.copilotkit.ai. It is
            // off (copilotkit-options.ts); the stub keeps its code out of every
            // build, dev included. SECURITY.md, "Vendor telemetry".
            '@copilotkit/web-inspector': fileURLToPath(
                new URL('./packages/client/src/no-web-inspector.ts', import.meta.url),
            ),
        },
    },
    // CopilotKit's v2 entry imports its own stylesheet, which Node can't load;
    // bundled into the server build, the import is Vite's to handle. Only that
    // package: a bundled dependency resolves its own imports from the app's
    // top level, which may hold another version or only a dev dependency.
    // That's why `@a2ui/web_core` (CopilotKit's, on zod 3) is a direct
    // dependency at CopilotKit's exact version: Vite keeps it external only
    // when it resolves from the top level. Bundled, its `import "zod"` got
    // Socio's zod 4 and the built server crashed at startup.
    ssr: { noExternal: ['@copilotkit/react-core'] },
    // Development: find the browser's dependencies up front, from the entry and
    // every route (there's no index.html to start from). Otherwise each first
    // visit to a module finds new ones and Vite reloads the page.
    // CopilotKit's own dependencies are found only when its bundle first loads
    // in the browser, so they are listed: without them, the first page after
    // `pnpm install` answers 504 (Outdated Optimize Dep) and Vite reloads it.
    optimizeDeps: {
        entries: ['packages/client/src/entry.client.tsx', 'packages/client/src/**/*.route.tsx'],
        include: [
            '@ag-ui/client',
            '@copilotkit/a2ui-renderer',
            '@copilotkit/core',
            '@copilotkit/mcp-apps-renderer/activity',
            '@copilotkit/shared',
            '@copilotkit/web-components/threads-drawer',
            '@radix-ui/react-dropdown-menu',
            '@radix-ui/react-slot',
            '@radix-ui/react-tooltip',
            '@tanstack/react-virtual',
            'streamdown',
            'use-stick-to-bottom',
            'zod-to-json-schema',
        ].map((name) => `@copilotkit/react-core > ${name}`),
    },
});
