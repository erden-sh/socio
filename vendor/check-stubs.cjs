// Fails unless the installed @scarf/scarf and @segment/analytics-node are
// the do-nothing stand-ins in vendor/. Runs as the root postinstall (so
// pnpm install fails instead of leaving a dangling link when vendor/ was not
// copied) and in the image stages that copy node_modules instead.
'use strict';

for (const name of ['@scarf/scarf', '@segment/analytics-node']) {
    let pkg;
    try {
        pkg = require(`${name}/package.json`);
    } catch (error) {
        throw new Error(`${name} is missing; copy vendor/ before pnpm install.`, {
            cause: error,
        });
    }
    if (pkg.socioNoop !== true || pkg.scripts) throw new Error(`${name} is not the stand-in from vendor/.`);
}
