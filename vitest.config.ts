import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';

import { noClientPlugin } from './tests/setup/no-client-plugin.ts';
import shared from './vitest.shared.ts';

// Every test: `pnpm test` here, and each bucket alone through `--project`
// (scripts/turbo.mjs runs them as separate cached tasks). Each file belongs to
// exactly one project:
//
//   server   tests/, except tests/integration: can't reach the client
//            (scripts/check-test-buckets.mjs, tests/setup/no-client-*.ts)
//   mixed    tests/integration: reach both sides, in imports or by reading files
//   client   packages/client/tests: its own config, the client alone
//
// Agent worktrees under .claude hold other branches' copies of the tests; they
// are not this checkout's. apps/ holds the native app and its push relay,
// which run their own tests (apps/mobile's are its package task, @socio/mobile#test).
export default mergeConfig(
    shared,
    defineConfig({
        test: {
            projects: [
                {
                    extends: true,
                    plugins: [noClientPlugin()],
                    test: {
                        name: 'server',
                        exclude: [
                            ...configDefaults.exclude,
                            '.claude/**',
                            'apps/**',
                            'packages/client/**',
                            'tests/integration/**',
                        ],
                        setupFiles: ['./tests/setup/no-client-reads.ts'],
                        // The migrated database every testDatabase() copies, made once per run.
                        globalSetup: ['tests/setup/test-template.ts'],
                    },
                },
                {
                    extends: true,
                    test: {
                        name: 'mixed',
                        include: ['tests/integration/**/*.test.?(c|m)[jt]s?(x)'],
                        exclude: [...configDefaults.exclude, '.claude/**'],
                        globalSetup: ['tests/setup/test-template.ts'],
                    },
                },
                'packages/client',
            ],
        },
    }),
);
