import { globSync } from 'node:fs';
import { join } from 'node:path';

import { defineConfig } from 'vitest/config';

const TESTS = 'tests/**/*.test.ts';

// @socio/shared from its source, as metro.config.js gives it to the bundle:
// shared's exports point at dist/, which only `pnpm run build:packages` makes,
// so a test importing a runtime value from shared would fail in CI. Vite then
// resolves a relative `.js` import inside that TypeScript source to its `.ts`
// file, the rewrite Metro's rule does (tests/shared-alias.test.ts).
const sharedSrc = join(import.meta.dirname, '../../packages/shared/src');

// CI splits every test task into four shards (`-- --shard=N/4`), and the app has
// fewer files than shards, so a shard may get none of them: passWithNoTests lets
// it pass. It would also pass a suite with no tests at all, so the config fails
// first when tests/ holds none.
if (globSync(TESTS, { cwd: import.meta.dirname }).length === 0) {
    throw new Error(`apps/mobile has no test files (${TESTS}).`);
}

// The app's tests. One Node project for now, for logic with no React Native
// in it; components get a jsdom project when they come.
// The root's suite leaves apps/ out.
export default defineConfig({
    test: {
        passWithNoTests: true,
        projects: [
            {
                resolve: {
                    alias: [{ find: /^@socio\/shared\/(.*)$/, replacement: `${sharedSrc}/$1` }],
                },
                test: {
                    name: 'node',
                    environment: 'node',
                    include: [TESTS],
                    // The checks that walk the whole app (the dependency graph, no Effect, the
                    // platform bindings, Diagnostics' route) take 3 s or more alone, and run beside
                    // shards.test.ts's four runs of the suite: 5 s timed out on a loaded machine.
                    testTimeout: 20_000,
                },
            },
        ],
    },
});
