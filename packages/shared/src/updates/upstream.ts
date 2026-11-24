/**
 * Socio's own product board (CB-381): the upstream instance where the "CB-n"
 * issues that release notes, What's New and early-access flags name live.
 * Every other instance has a board of its own, whose CB-157 is a different
 * issue, so those references link here instead of to the local board.
 */
export const UPSTREAM_BOARD_URL = 'https://brain.ingenioventures.com';

/** An upstream issue key, "CB-157". */
export const UPSTREAM_ISSUE_KEY = /^CB-[1-9]\d{0,8}$/;

const UPSTREAM_ORIGIN = new URL(UPSTREAM_BOARD_URL).origin;

/** Whether `origin` (an app's `location.origin`) is the upstream instance itself. */
export const isUpstreamOrigin = (origin: string | undefined) => {
    if (!origin) {
        return false;
    }
    try {
        return new URL(origin).origin === UPSTREAM_ORIGIN;
    } catch {
        return false;
    }
};

/**
 * Where an upstream issue key such as "CB-157" opens, seen from an app at
 * `origin`: the local `/issues/CB-157` on the upstream instance itself, and
 * the upstream board's absolute URL, opened as an external link, anywhere
 * else. Null when `key` isn't an issue key.
 */
export function upstreamIssueLink(key: string, origin: string | undefined) {
    if (!UPSTREAM_ISSUE_KEY.test(key)) {
        return null;
    }
    const path = `/issues/${key}`;
    return isUpstreamOrigin(origin)
        ? { href: path, external: false as const }
        : { href: `${UPSTREAM_ORIGIN}${path}`, external: true as const };
}
