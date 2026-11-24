/** Where a link goes: an app route, or an external URL. */
export type LinkTarget = { kind: 'page'; path: string } | { kind: 'external'; url: string };

/**
 * App paths a link in a page or a chat message may open in the app: a Space
 * and a page (also in the old hash form).
 */
const linkablePath = /^\/spaces\/[^/?#]+(?:\/pages\/[^/?#]+)?$/;
/** Linkable as paths only (they never had a hash form): an issue, a chat. */
const pathOnlyLink = /^\/(?:issues\/CB-[1-9]\d{0,8}|chats\/[^/?#]+)$/;

/**
 * The path form of an old hash route: `#/spaces/s1/pages/p1` becomes
 * `/spaces/s1/pages/p1`. Stored pages, chat history and Telegram messages
 * hold these links, so they must keep working forever. Anything else
 * (`#section`, unknown routes) is undefined.
 */
export function legacyHashPath(hash: string): string | undefined {
    if (!hash.startsWith('#/')) {
        return undefined;
    }
    const path = hash.slice(1);
    return linkablePath.test(path) ? path : undefined;
}

/**
 * Where an address bar showing an old hash route (`/#/spaces/…`) should be
 * instead, or undefined when it's already fine.
 */
export function legacyLocationPath(location: { pathname: string; search: string; hash: string }): string | undefined {
    if (location.pathname !== '/' || location.search) {
        return undefined;
    }
    return legacyHashPath(location.hash);
}

const appOrigin = () => globalThis.location?.origin ?? 'http://app.invalid';

/**
 * Resolves a link's href. App routes stay in the app, in either form: the
 * path (`/spaces/…/pages/…`) and the old hash route (`/#/spaces/…`,
 * `#/spaces/…`), also on this app's origin; both resolve to the path.
 * Absolute http(s) and mailto URLs are external. Anything else
 * (javascript:, data:, relative paths, protocol-relative URLs, other app
 * paths) returns null and is never followed.
 */
export function resolveLink(href: string | null | undefined, origin = appOrigin()): LinkTarget | null {
    const value = href?.trim();
    if (!value) {
        return null;
    }
    let url: URL;
    try {
        url = new URL(value, origin);
    } catch {
        return null;
    }
    if (url.origin === origin && !url.search && !value.startsWith('//')) {
        const legacy = legacyLocationPath(url);
        if (legacy) {
            return { kind: 'page', path: legacy };
        }
        if (!url.hash && (linkablePath.test(url.pathname) || pathOnlyLink.test(url.pathname))) {
            return { kind: 'page', path: url.pathname };
        }
    }
    if (
        ((url.protocol === 'http:' || url.protocol === 'https:') && /^https?:\/\//i.test(value)) ||
        url.protocol === 'mailto:'
    ) {
        return { kind: 'external', url: url.href };
    }
    return null;
}

// `state` rides with the navigation, as the router's `navigate` takes it.
type Navigate = (path: string, state?: unknown) => void;
/** Until the router mounts (and in tests without one), a full page load. */
const loadPage: Navigate = (path) => globalThis.location.assign(path);
let navigator: Navigate = loadPage;

/**
 * The shell registers the router's navigate here, so code outside React
 * (the editor's click handler) navigates in the app, through the
 * unsaved-draft guard. Returns the unregister function.
 */
export function setAppNavigator(next: Navigate) {
    navigator = next;
    return () => {
        if (navigator === next) {
            navigator = loadPage;
        }
    };
}

/**
 * Opens an app path in this tab, through the router, with the navigation
 * state the page there reads (an issue opened from a chat: CB-119).
 */
export function openAppPath(path: string, state?: unknown) {
    if (state === undefined) {
        navigator(path);
    } else {
        navigator(path, state);
    }
}

/**
 * Follows a link: an app route in this tab (or a new one with `newTab`), an
 * external URL always in a new tab without an opener. Returns false, doing
 * nothing, for a link that isn't safe to follow.
 */
export function followLink(href: string | null | undefined, { newTab = false }: { newTab?: boolean } = {}): boolean {
    const target = resolveLink(href);
    if (!target) {
        return false;
    }
    if (target.kind === 'page' && !newTab) {
        openAppPath(target.path);
    } else {
        window.open(
            target.kind === 'page' ? `${location.origin}${target.path}` : target.url,
            '_blank',
            'noopener,noreferrer',
        );
    }
    return true;
}

/** The app path of a Space, or of one of its pages. */
export const spacePath = (spaceId: string, pageId?: string) =>
    `/spaces/${encodeURIComponent(spaceId)}${pageId ? `/pages/${encodeURIComponent(pageId)}` : ''}`;
