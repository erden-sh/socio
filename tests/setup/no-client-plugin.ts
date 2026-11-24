import type { Plugin } from 'vite';

import { isClientSide, reachMessage } from './no-client-paths.ts';

/** Fails any module the server bucket loads from the client side (imports, mocks, globs, the `@/` alias). */
export const noClientPlugin = (): Plugin => ({
    name: 'socio:no-client-in-server-bucket',
    enforce: 'pre',
    load(id) {
        const path = id.split('?')[0];
        if (path.startsWith('/') && isClientSide(path)) {
            throw new Error(reachMessage(path));
        }
        return null;
    },
});
