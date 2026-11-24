import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '../..');

/**
 * The source folder of each package that holds server code, relative to the
 * root. A guard that walks `src` walks these too, or code moved into a package
 * would drop out of it with the test still passing (tests/integration/package-boundaries.test.ts).
 */
/** The client's side holds no server code, and the server test bucket must not read it (tests/setup/no-client-reads.ts). */
const CLIENT_SIDE = new Set(['client', 'plugin-ui']);

export const PACKAGE_SOURCES = readdirSync(join(root, 'packages'))
    .filter((name) => !CLIENT_SIDE.has(name))
    .filter((name) => existsSync(join(root, 'packages', name, 'package.json')))
    .filter((name) => {
        const manifest = JSON.parse(readFileSync(join(root, 'packages', name, 'package.json'), 'utf8'));
        return manifest.exports?.['./*']?.default === './dist/*.js';
    })
    .map((name) => `packages/${name}/src`);
