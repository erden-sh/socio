/** The app's origins (APP_ORIGIN) as a list; unset stays unset. */
export const originList = (origin?: string | string[]) =>
    origin ? (Array.isArray(origin) ? origin : [origin]) : undefined;

/**
 * A request to a host this app answers on: loopback, or the hostname of
 * one of its origins. Shared by the API guard and the page guard.
 */
export function allowedHost(url: string, origins?: string[]) {
    const hostnames = (origins ?? []).flatMap((origin) => {
        try {
            return [new URL(origin).hostname].filter(Boolean);
        } catch {
            return [];
        }
    });
    return new Set(['localhost', '127.0.0.1', '[::1]', ...hostnames]).has(new URL(url).hostname);
}
