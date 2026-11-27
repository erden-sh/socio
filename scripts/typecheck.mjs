#!/usr/bin/env node
// Typechecks each TypeScript project at once: none needs another's output, so
// the slowest sets the time. Each part's time is printed when it ends, and its
// output with it, so logs never interleave; the exit status is the first
// failure's. Keep a new project's tsconfig in PARTS, or nothing checks it.
//
//   root        the server, services, server tests, and each package's source
//               again; no client file
//   mixed       tests/integration, and the client files they reach through `@/`
//   client      packages/client: source and tests (Bundler resolution)
//   shared      packages/shared (NodeNext)
//   i18n        packages/i18n (NodeNext), its source and tests
//   foundation  packages/foundation (NodeNext)
//   data        packages/data (NodeNext)
//   plugin-ui   packages/plugin-ui, and the client components it imports
//   app-sdk     packages/app-sdk
//   mobile      apps/mobile, the native app, and the packages/shared source it
//               maps (Bundler resolution)
//   push-relay  apps/push-relay, the push relay's Worker, with the Workers
//               runtime's types
//   link        apps/link, the link domain's Worker, with the Workers runtime's
//               types and the packages/shared source it maps
//   site        apps/site's Worker, with the Workers runtime's types
//   site-build  apps/site's build (the pages, under Node), its browser script
//               (DOM) and its tests
//
//   node scripts/typecheck.mjs            # all of them
//   node scripts/typecheck.mjs client     # some of them
import { spawn } from 'node:child_process';

const cached = (name) => ['--incremental', '--tsBuildInfoFile', `node_modules/.cache/tsc/${name}.tsbuildinfo`];
const PARTS = {
    root: ['--noEmit', ...cached('tsconfig')],
    client: ['-p', 'packages/client/tsconfig.json', '--noEmit', ...cached('client')],
    shared: ['-p', 'packages/shared/tsconfig.json', '--noEmit'],
    i18n: ['-p', 'packages/i18n/tsconfig.json', '--noEmit'],
    foundation: ['-p', 'packages/foundation/tsconfig.json', '--noEmit', ...cached('foundation')],
    data: ['-p', 'packages/data/tsconfig.json', '--noEmit', ...cached('data')],
    mixed: ['-p', 'tests/integration/tsconfig.json', '--noEmit', ...cached('mixed')],
    'plugin-ui': ['-p', 'packages/plugin-ui/tsconfig.json', '--noEmit'],
    'app-sdk': ['-p', 'packages/app-sdk/tsconfig.json', '--noEmit'],
    mobile: ['-p', 'apps/mobile/tsconfig.json', '--noEmit', ...cached('mobile')],
    'push-relay': ['-p', 'apps/push-relay/tsconfig.json', '--noEmit'],
    link: ['-p', 'apps/link/tsconfig.json', '--noEmit'],
    site: ['-p', 'apps/site/tsconfig.json', '--noEmit'],
    'site-build': ['-p', 'apps/site/tsconfig.build.json', '--noEmit'],
};

const wanted = process.argv.slice(2);
for (const name of wanted) {
    if (!(name in PARTS)) {
        console.error(`Unknown part: ${name} (${Object.keys(PARTS).join(', ')})`);
        process.exit(2);
    }
}
const names = wanted.length ? wanted : Object.keys(PARTS);

const run = (name) =>
    new Promise((resolve) => {
        const started = performance.now();
        const child = spawn('pnpm', ['exec', 'tsc', ...PARTS[name]], { stdio: ['ignore', 'pipe', 'pipe'] });
        const chunks = [];
        child.stdout.on('data', (chunk) => chunks.push(chunk));
        child.stderr.on('data', (chunk) => chunks.push(chunk));
        child.on('error', (error) => chunks.push(Buffer.from(`${error}\n`)));
        child.on('close', (code) => {
            const seconds = ((performance.now() - started) / 1000).toFixed(1);
            console.log(`── tsc ${name}: ${code === 0 ? 'ok' : `failed (${code})`} in ${seconds} s`);
            const output = Buffer.concat(chunks).toString().trimEnd();
            if (output) {
                console.log(output);
            }
            resolve(code ?? 1);
        });
    });

const started = performance.now();
const codes = await Promise.all(names.map(run));
console.log(`── typecheck: ${((performance.now() - started) / 1000).toFixed(1)} s`);
process.exit(codes.find((code) => code !== 0) ?? 0);
