import { Hono } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';

import { mountApp, type AppOptions } from './composition/http/index.js';

// The middleware and routes moved into composition/http/, in the same
// order; these names stay here for their importers.
export { CHAT_REQUEST_BYTES, type AppOptions } from './composition/http/index.js';

/** The app's middleware and routes (composition/http/index.ts has their order). */
export function createApp(options: AppOptions) {
    const app = new Hono<AppEnv>();
    mountApp(app, options);
    return app;
}
