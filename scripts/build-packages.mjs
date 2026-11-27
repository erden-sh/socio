#!/usr/bin/env node
// Builds the workspace packages (scripts/workspace-packages.mjs), lowest first,
// and ships them with the server build. Run by `pnpm run build`, before the
// server's tsc, which reads their declarations.
//
//   packages/<name>/dist                      what `exports` names; scripts and
//                                             tsc reach it through the workspace
//                                             link in the root node_modules
//   dist/server/node_modules/@socio/<name>    its package.json and JavaScript,
//                                             what `node dist/server/...` finds
//
// The second is why an image needs nothing beyond dist/server: Node looks in
// the nearest node_modules first, and every image stage copies dist/server,
// including the two that hold no dependencies at all (coding-git and
// coding-egress). Third-party imports walk on up to /app/node_modules, which is
// the root manifest's install: a package's dependencies stay in the root's too
// (scripts/check-package-boundary.mjs). packages/shared/README.md has the design.
//
// Then the dictionaries: scripts/i18n-build.mjs checks @socio/i18n's locales
// and writes dist/i18n, which the server serves (docs/I18N.md).
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { builtPackages } from './workspace-packages.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

for (const { name, dir, build } of builtPackages(root)) {
    const pkg = join(root, dir);
    const shipped = join(root, 'dist/server/node_modules', name);
    // `exports` is a wildcard: a stale file would stay importable.
    rmSync(join(pkg, 'dist'), { recursive: true, force: true });
    rmSync(shipped, { recursive: true, force: true });
    execFileSync('pnpm', ['exec', 'tsc', '-p', build], { cwd: root, stdio: 'inherit' });

    mkdirSync(shipped, { recursive: true });
    cpSync(join(pkg, 'package.json'), join(shipped, 'package.json'));
    cpSync(join(pkg, 'dist'), join(shipped, 'dist'), { recursive: true, filter: (file) => !file.endsWith('.d.ts') });
}

execFileSync(process.execPath, ['--import', 'tsx', 'scripts/i18n-build.mjs'], { cwd: root, stdio: 'inherit' });
