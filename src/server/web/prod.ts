import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ServerBuild } from 'react-router';

import { webContextKey } from './context.js';
import type { WebBuild } from './mount.js';

/**
 * The pages' production build (`react-router build`, dist/web by default).
 * Fails at startup when it is missing or has no context key. The mode must
 * be production: in development mode React Router sends error messages to
 * the browser.
 */
export async function productionWeb(dir = process.env.WEB_BUILD_DIR?.trim() || 'dist/web'): Promise<WebBuild> {
    const file = resolve(dir, 'server/index.js');
    if (!existsSync(file)) {
        throw new Error(`No page build at ${file}: run pnpm run build.`);
    }
    const build = (await import(pathToFileURL(file).href)) as ServerBuild;
    webContextKey(build);
    return { build, mode: 'production', clientDir: resolve(dir, 'client') };
}
