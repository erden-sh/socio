/**
 * The presence header a tab sends on each `/api/state` poll
 * (`PRESENCE_HEADER`, CB-114): `<tab id> <path>` while the tab is in use,
 * else `<tab id> -`. Pure, so the server's live poll and notifications'
 * routes read it the same way.
 */

const TAB_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** The tab and, while it's in use, its path, from the header; undefined when it isn't one. */
export function parsePresence(header: string | undefined) {
    const match = header?.trim().match(/^(\S+) (-|\/\S{0,500})$/);
    if (!match || !TAB_ID.test(match[1]!)) {
        return undefined;
    }
    return {
        tab: match[1]!,
        path: match[2] === '-' ? undefined : match[2]!,
    };
}
export const isTabId = (tab: unknown): tab is string => typeof tab === 'string' && TAB_ID.test(tab);
