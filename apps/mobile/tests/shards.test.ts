import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const app = join(import.meta.dirname, '..');

// CI runs every test task as four shards (.github/workflows/ci.yml, through
// scripts/turbo.mjs), and turbo forwards `--shard=N/4` to this package's
// `vitest run` too. Vitest fails a shard that gets no files unless
// passWithNoTests is on (vitest.config.mts). This file checks that failure mode
// directly and cheaply: a shard whose filter matches no file must pass. It used
// to run the whole suite again in four child processes, which doubled the
// suite's work and timed out whenever the machine was busy; the suite itself,
// run sharded in CI, is what proves each shard's tests pass.
describe("CI's test shards", () => {
    it('turn passWithNoTests on in the config', () => {
        const config = readFileSync(join(app, 'vitest.config.mts'), 'utf8');
        expect(config).toMatch(/passWithNoTests:\s*true/);
    });

    it('pass a shard that gets no files', { timeout: 60_000 }, () => {
        const run = spawnSync(
            join(app, 'node_modules/.bin/vitest'),
            ['run', '--shard=4/4', 'no-test-file-matches-this-filter'],
            { cwd: app, encoding: 'utf8', env: { ...process.env, DO_NOT_TRACK: '1' } },
        );
        expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    });
});
