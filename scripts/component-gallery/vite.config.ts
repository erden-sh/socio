import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
    publicDir: false,
    plugins: [tailwindcss(), react()],
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('../../packages/client/src', import.meta.url)),
            '@socio/shared': fileURLToPath(new URL('../../packages/shared/src', import.meta.url)),
        },
    },
});
