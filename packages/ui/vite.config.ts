import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
    plugins: [tailwindcss()],
    build: {
        rollupOptions: {
            input: fileURLToPath(new URL('./src/styles/standalone.css', import.meta.url)),
            output: { assetFileNames: 'styles[extname]' },
        },
    },
});
