/**
 * Connected agents' OAuth clients (CB-90): what a client id and a redirect
 * URI say about the client. Moved from `src/server/agents/grants.ts` and
 * `src/server/agents/cimd.ts`, which re-export them.
 */

/** Loopback hosts a native app's http redirect may use. */
export const LOOPBACK_HOSTS = ['127.0.0.1', '[::1]', 'localhost'];

/** The host of a client id (its metadata document's URL). */
export const clientHost = (clientId: string) => {
    try {
        return new URL(clientId).hostname;
    } catch {
        return '';
    }
};

/**
 * Whether the redirect goes back to this computer (a loopback http URL) or
 * to an app's own scheme: the client can't be verified, since any local
 * program can claim to be it ("unverified local app").
 */
export function isLocalRedirect(uri: string) {
    try {
        const url = new URL(uri);
        if (url.protocol === 'https:') {
            return false;
        }
        if (url.protocol === 'http:') {
            return LOOPBACK_HOSTS.includes(url.hostname);
        }
        return true;
    } catch {
        return false;
    }
}
