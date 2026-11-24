import { RouterContextProvider, type RouterContext, type ServerBuild } from 'react-router';

import type { WebContext } from '@socio/shared/web/web';

/**
 * The router context key, from the build itself: `entry.server.tsx`
 * exports it. A key is matched by identity, so this server can't make its
 * own; in development, the current build may hold a newer one.
 */
export function webContextKey(build: ServerBuild): RouterContext<WebContext> {
    const key = (build.entry.module as { webContext?: RouterContext<WebContext> }).webContext;
    if (!key) {
        throw new Error('entry.server.tsx must export webContext.');
    }
    return key;
}

/** The router context for one page request. */
export function requestContext(build: ServerBuild, value: WebContext) {
    return new RouterContextProvider(new Map([[webContextKey(build), value]]));
}
