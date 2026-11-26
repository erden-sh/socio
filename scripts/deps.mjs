#!/usr/bin/env node
// Runs pnpm with Socio's install hook (scripts/pnpm-hooks.cjs), then drops
// the pnpmfileChecksum pnpm writes into pnpm-lock.yaml, so CI's
// --ignore-pnpmfile install still accepts the lockfile. Use it instead of a
// bare pnpm command whenever the lockfile changes:
//
//   pnpm deps                     # pnpm install
//   pnpm deps add -w some-pkg     # pnpm add -w some-pkg
//   pnpm deps update '@ag-ui/*'   # pnpm update '@ag-ui/*'
//
// The hook's reason is in scripts/pnpm-hooks.cjs.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const command = args.length > 0 ? args : ['install'];
const pnpm = spawnSync('pnpm', [...command, '--pnpmfile', join(root, 'scripts/pnpm-hooks.cjs')], {
    cwd: root,
    stdio: 'inherit',
});
const lockfile = join(root, 'pnpm-lock.yaml');
const text = readFileSync(lockfile, 'utf8');
const stripped = text.replace(/^pnpmfileChecksum: .*\n\n?/m, '');
if (stripped !== text) {
    writeFileSync(lockfile, stripped);
}
process.exit(pnpm.status ?? 1);
