import { defineConfig, mergeConfig } from 'vitest/config';

import shared from '../../vitest.shared.ts';

// The client's tests: `pnpm test` in this directory, and a project of the
// root's vitest.config.ts. The settings are the root's (vitest.shared.ts),
// plus an en-US i18next instance for components rendered on their own
// (tests/setup/en-us-i18n.ts).
export default mergeConfig(
    shared,
    defineConfig({
        test: {
            name: 'client',
            root: import.meta.dirname,
            setupFiles: [`${import.meta.dirname}/tests/setup/en-us-i18n.ts`],
        },
    }),
);
