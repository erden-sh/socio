// pnpm's readPackage hook for Socio's lockfile. Not loaded by a plain
// `pnpm install`: run `pnpm deps` (scripts/deps.mjs) whenever a dependency
// changes, and it loads this file with --pnpmfile.
//
// One AG-UI client for the whole app. @ag-ui/* (client, core, encoder,
// proto, the middlewares) declare zod as a peer (^3.25 || ^4). CopilotKit
// 1.90 depends on zod 3 itself while Socio uses zod 4, so pnpm resolves that
// peer twice and installs two copies of each @ag-ui package: one beside
// CopilotKit (zod 3) and one beside Socio (zod 4). The agent classes then
// stop matching (`instanceof` fails across the copies, so the runtime and
// CopilotKit's client no longer recognize Socio's agents). This hook turns
// the zod peer into a plain dependency on the zod Socio's root package.json
// names, so every consumer shares a single copy of @ag-ui/*. CopilotKit keeps
// its own zod 3 for its own code. pnpm's `overrides` and `packageExtensions`
// cannot do this: they add or pin dependencies but leave the peer in place.
//
// Why not .pnpmfile.cjs: CI installs with --ignore-pnpmfile (CB-183, no
// branch code runs in the networked install container), and a lockfile made
// with a hook carries a pnpmfileChecksum that such an install refuses. So the
// hook's result lives in pnpm-lock.yaml alone: scripts/deps.mjs drops the
// checksum after resolving, every install that only reads the lockfile (CI,
// the images, a plain `pnpm install` with nothing to resolve) gets the single
// copy, and tests/ag-ui-single-copy.test.ts fails if a resolution without the
// hook brought the second copy back.
//
// Remove this file, scripts/deps.mjs and the test once CopilotKit depends on
// zod 4.
'use strict';

// oxlint-disable-next-line typescript/no-require-imports -- pnpm loads hooks as CommonJS
const zod = require('../package.json').dependencies.zod;

function readPackage(pkg) {
    if (pkg.name && pkg.name.startsWith('@ag-ui/') && pkg.peerDependencies && pkg.peerDependencies.zod) {
        delete pkg.peerDependencies.zod;
        if (pkg.peerDependenciesMeta) {
            delete pkg.peerDependenciesMeta.zod;
        }
        pkg.dependencies = { ...pkg.dependencies, zod };
    }
    return pkg;
}

module.exports = { hooks: { readPackage } };
