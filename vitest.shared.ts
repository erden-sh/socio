import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// What every test run shares, whichever directory it starts from: the root's
// vitest.config.ts (all tests) and packages/client/vitest.config.ts (the
// client's alone). Paths are absolute for that reason. Tests render components
// and routes in jsdom with the plain React plugin; the React Router plugin
// (vite.config.ts) is for the app's builds.
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            '@': at('./packages/client/src'),
            // The same as vite.config.ts: tests need no build of the packages.
            '@socio/shared': at('./packages/shared/src'),
            '@socio/i18n/locales': at('./packages/i18n/locales'),
            '@socio/i18n': at('./packages/i18n/src'),
            '@socio/foundation': at('./packages/foundation/src'),
            '@socio/data': at('./packages/data/src'),
            // The same stub as vite.config.ts.
            '@copilotkit/web-inspector': at('./packages/client/src/no-web-inspector.ts'),
        },
    },
    // 15 s per test: the gate runs on a shared Docker host where load
    // spikes make 5 s timeouts flaky.
    test: {
        // React Core runs through Vite, not plain Node: its v2 entry imports a
        // stylesheet, and its import of the web inspector must meet the alias
        // above (packages/client/tests/copilotkit-inspector.test.tsx).
        server: { deps: { inline: ['@copilotkit/react-core'] } },
        setupFiles: [at('./tests/setup/egress-guard.ts'), at('./tests/setup/jsdom-localstorage.ts')],
        env: {
            // Every 304 a version decides is checked against a rebuilt body
            // (packages/foundation/src/http/conditional.ts).
            LIVE_VERSION_AUDIT: '1',
            // Runners replay threads inline here (CB-318): the suite's timings
            // assume a replay finishes at once. tests/replay-worker.test.ts
            // runs the worker itself.
            SOCIO_REPLAY: 'inline',
        },
        // The suite is 578 files / ~4700 tests, many heavy integration tests
        // (migrations, auth, gateway, telegram, coding sessions). The default
        // pool on a 2-core runner ran nearly serially — 17 min of test work
        // in 27 min of wall clock, 345/578 files never completed before the
        // 30-min CI timeout. Forks over-subscribed (4 workers on 2 cores)
        // parallelises I/O-bound tests that spend most of their time waiting
        // on in-process databases and timers, not on CPU. Vitest 4 moved
        // maxWorkers/minWorkers to the top level (poolOptions was removed).
        // CI shards the suite across 4 parallel jobs (ci.yml matrix), each
        // passing --shard N/4 on the CLI. The cap is for those 2-core runners:
        // elsewhere Vitest sizes the pool from the machine's cores.
        pool: 'forks',
        maxWorkers: process.env.CI ? 4 : undefined,
        testTimeout: 15_000,
    },
});
