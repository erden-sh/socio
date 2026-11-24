import { createContext, type RouterContextProvider } from 'react-router';

import type { WebContext } from '@socio/shared/web/web';

/**
 * The router context key for what the server passes a page request. A key
 * is matched by identity, so there is exactly one: this module, bundled
 * into the server build. `entry.server.tsx` exports it and the Hono server
 * reads it from the build (src/server/web/context.ts). No default: a
 * missing value is a bug.
 */
export const webContext = createContext<WebContext>();

/** The page request's context, in a loader, middleware or the entry. */
export const web = (context: Readonly<RouterContextProvider>) => context.get(webContext);
