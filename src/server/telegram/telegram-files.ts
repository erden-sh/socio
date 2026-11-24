/**
 * Inbound Telegram files on another Bot API (CB-8). channels-telegram 0.11.0
 * downloads a message's files from a fixed
 * `https://api.telegram.org/file/bot<token>/<path>` (its download-files.js),
 * whatever API root the bot uses, and has no option for it; the repo replaces
 * packages (vendor/) but never edits their files. So while a channel runs on
 * another root (a fake Bot API in tests, a self-hosted Bot API server), its
 * file downloads are sent there instead. Only URLs starting with that
 * channel's own file prefix change; every other fetch passes through.
 */
const TELEGRAM_ROOT = 'https://api.telegram.org';

/** File URL prefix on api.telegram.org → the same prefix on the channel's root. */
const routes = new Map<string, string>();
let routed: typeof fetch | undefined;
let previous: typeof fetch | undefined;

/**
 * Sends the bot's file downloads to `apiRoot` until the returned function is
 * called. Does nothing for api.telegram.org itself.
 */
export function routeFileDownloads(token: string, apiRoot?: string) {
    const root = apiRoot?.trim().replace(/\/+$/, '');
    if (!root || root === TELEGRAM_ROOT) {
        return () => {};
    }
    const from = `${TELEGRAM_ROOT}/file/bot${token}/`;
    const to = `${root}/file/bot${token}/`;
    routes.set(from, to);
    // Installed again if something replaced it since (a test's fetch stub).
    if (globalThis.fetch !== routed) {
        const next = (previous = globalThis.fetch);
        routed = (input, init) => {
            if (typeof input === 'string') {
                for (const [prefix, target] of routes) {
                    if (input.startsWith(prefix)) {
                        return next(target + input.slice(prefix.length), init);
                    }
                }
            }
            return next(input, init);
        };
        globalThis.fetch = routed;
    }
    return () => {
        if (routes.get(from) !== to) {
            return;
        }
        routes.delete(from);
        if (!routes.size && globalThis.fetch === routed && previous) {
            globalThis.fetch = previous;
            routed = previous = undefined;
        }
    };
}
