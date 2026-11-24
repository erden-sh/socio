#!/usr/bin/env node
// Every package the pages' server build loads at run time must be in the root's
// `dependencies`. Images install those alone, and dist/web/server resolves
// packages from /app/node_modules; the image's own check loads only the entry,
// so a lazily loaded route's chunk would fail only when someone opens that page.
// Run by `pnpm run build`, on the build's output. esbuild follows the real
// imports, static and dynamic: chunks hold code samples that look like imports.
import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const packageOf = (specifier) =>
    specifier
        .split('/')
        .slice(0, specifier.startsWith('@') ? 2 : 1)
        .join('/');

/** Each package the entry reaches, with the file that imports it first. */
export async function packagesLoadedBy(entry) {
    const { metafile } = await build({
        entryPoints: [entry],
        bundle: true,
        packages: 'external',
        platform: 'node',
        format: 'esm',
        write: false,
        outdir: 'unused',
        metafile: true,
        logLevel: 'silent',
        loader: { '.css': 'empty' },
    });
    const found = new Map();
    for (const [file, { imports }] of Object.entries(metafile.inputs)) {
        for (const { path, external } of imports) {
            if (external && !path.startsWith('node:') && !builtinModules.includes(packageOf(path))) {
                found.set(packageOf(path), found.get(packageOf(path)) ?? file);
            }
        }
    }
    return found;
}

/** Each package the build loads that the root's `dependencies` don't hold. */
export async function ssrDepsProblems(root) {
    const entry = resolve(root, 'dist/web/server/index.js');
    if (!existsSync(entry)) {
        return [`no server build at ${entry}: this check runs after react-router build`];
    }
    const { dependencies = {} } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    const loaded = await packagesLoadedBy(entry);
    return [...loaded]
        .filter(([name]) => !(name in dependencies))
        .map(([name, file]) => `${relative(root, resolve(file))}: ${name} is not in the root's dependencies`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const problems = await ssrDepsProblems(process.cwd());
    if (problems.length) {
        console.error(problems.join('\n'));
        process.exit(1);
    }
    console.log('Server build dependencies passed');
}
