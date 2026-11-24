import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';

import { renderSite } from './src/build/site.ts';
import type { SiteEnv } from './src/worker/headers.ts';

// The site's build: Vite bundles the one script (src/client/main.ts) and the stylesheet it imports
// (Tailwind 4), with hashed names under assets/; the plugin below then renders every page around
// those names and emits the rest of the site (src/build/site.ts). No React, no framework: the
// pages are HTML strings rendered at build time. public/ holds the committed images (og, icon).

const SITE_ENVS: readonly SiteEnv[] = ['local', 'staging', 'production'];

function siteEnv(): SiteEnv {
    const env = (process.env.SITE_ENV ?? 'local') as SiteEnv;
    if (!SITE_ENVS.includes(env)) {
        throw new Error(`SITE_ENV must be one of ${SITE_ENVS.join(', ')}`);
    }
    return env;
}

function site(): Plugin {
    return {
        name: 'socio-site',
        apply: 'build',
        generateBundle(_, bundle) {
            const entry = Object.values(bundle).find((chunk) => chunk.type === 'chunk' && chunk.isEntry);
            if (!entry || entry.type !== 'chunk') {
                throw new Error('no entry chunk');
            }
            const css = [...(entry.viteMetadata?.importedCss ?? [])];
            if (css.length !== 1) {
                throw new Error(`expected one stylesheet, got ${css.length}`);
            }
            const files = renderSite({
                assets: { css: `/${css[0]}`, js: `/${entry.fileName}` },
                env: siteEnv(),
                built: new Date().toISOString().slice(0, 10),
            });
            for (const [fileName, source] of files) {
                this.emitFile({ type: 'asset', fileName, source });
            }
        },
    };
}

export default defineConfig({
    root: import.meta.dirname,
    publicDir: 'public',
    plugins: [tailwindcss(), site()],
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        assetsDir: 'assets',
        // The browsers of the Web Platform Baseline (the owner's rule), as Vite's default targets.
        modulePreload: false,
        rollupOptions: {
            input: 'src/client/main.ts',
        },
    },
});
