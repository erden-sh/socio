import { defineConfig } from 'vitest/config';

// The site's tests, under Node with the root's Vitest (the root's suite leaves apps/ out). The
// global setup builds the site once, into a temporary directory, for the tests that read it.
export default defineConfig({
    test: {
        name: 'site',
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        globalSetup: ['tests/global-setup.ts'],
        testTimeout: 30_000,
        hookTimeout: 120_000,
    },
});
