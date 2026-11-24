import { defineConfig } from 'vitest/config';

// The relay's tests, under Node with the root's Vitest (the root's suite leaves apps/ out), with
// fakes for D1 (node:sqlite), the rate limiter and the providers (tests/fakes).
export default defineConfig({
    test: {
        name: 'push-relay',
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        passWithNoTests: true,
    },
});
