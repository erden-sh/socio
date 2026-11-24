import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = process.env.PLANNER_UI_OUT ?? 'src/server/plugins/planner/ui';

await build({
    configFile: false,
    root,
    publicDir: false,
    base: '/ui/',
    plugins: [tailwindcss(), react()],
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('../packages/client/src', import.meta.url)),
            '@socio/shared': fileURLToPath(new URL('../packages/shared/src', import.meta.url)),
        },
    },
    build: {
        outDir,
        emptyOutDir: true,
        cssCodeSplit: false,
        modulePreload: false,
        rollupOptions: {
            input: fileURLToPath(new URL('../packages/client/src/plugins/planner/index.html', import.meta.url)),
            output: {
                entryFileNames: 'planner.js',
                codeSplitting: false,
                assetFileNames: 'planner[extname]',
            },
        },
    },
});
// Vite writes the HTML under the input's own path; the planner renders its page itself.
rmSync(join(root, outDir, 'packages'), { recursive: true, force: true });
