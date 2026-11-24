import { join } from 'node:path';

import { defineConfig } from 'vitest/config';

// @socio/shared from its source, as tsconfig.json's paths and wrangler's bundle take it: shared's
// exports point at dist/, which only `pnpm run build:packages` makes.
const sharedSrc = join(import.meta.dirname, '../../packages/shared/src');

// The link Worker's tests, under Node with the root's Vitest (the root's suite leaves apps/ out).
export default defineConfig({
    resolve: {
        alias: [{ find: /^@socio\/shared\/(.*)$/, replacement: `${sharedSrc}/$1.ts` }],
    },
    test: {
        name: 'link',
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        passWithNoTests: true,
    },
});
