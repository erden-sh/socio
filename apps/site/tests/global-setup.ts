import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { build } from 'vite';
import type { TestProject } from 'vitest/node';

// Builds the site once per run, as production and as staging, each into its own temporary
// directory, with the same vite.config.ts the build task uses. The tests read the results.

declare module 'vitest' {
    export interface ProvidedContext {
        dist: string;
        distStaging: string;
    }
}

const root = join(import.meta.dirname, '..');

async function buildInto(env: 'production' | 'staging'): Promise<string> {
    const outDir = mkdtempSync(join(tmpdir(), `socio-site-${env}-`));
    const previous = process.env.SITE_ENV;
    process.env.SITE_ENV = env;
    try {
        await build({
            root,
            configFile: join(root, 'vite.config.ts'),
            logLevel: 'silent',
            build: { outDir, emptyOutDir: true },
        });
    } finally {
        if (previous === undefined) {
            delete process.env.SITE_ENV;
        } else {
            process.env.SITE_ENV = previous;
        }
    }
    return outDir;
}

export default async function setup(project: TestProject) {
    const dist = await buildInto('production');
    const distStaging = await buildInto('staging');
    project.provide('dist', dist);
    project.provide('distStaging', distStaging);
    return () => {
        rmSync(dist, { recursive: true, force: true });
        rmSync(distStaging, { recursive: true, force: true });
    };
}
