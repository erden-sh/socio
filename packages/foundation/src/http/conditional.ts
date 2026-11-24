import { createHash, randomBytes } from 'node:crypto';

import type { Context } from 'hono';

/**
 * Conditional polls: a polled
 * `GET` answers with an `ETag`, and `304 Not Modified` with no body when the
 * client's `If-None-Match` says it already has this answer.
 *
 * The tag is `"<version>.<body>"`. `body` is a hash of the JSON (step 1a):
 * correct by construction, it saves the bytes but not the build. `version`
 * (step 1b) is a hash of what the view read, taken before building: the
 * process's boot id, the path and query, and what the route's version
 * function returns (the user, the change counters the view reads for them,
 * `statusEpoch`; src/server/live/view-versions.ts and each feature's views
 * tag, such as `WorkspaceViews.workspaceVersion`). When it matches, the
 * answer is `304` without building. When it doesn't, the view is built, and
 * a body hash that matches still answers `304` (with the new tag).
 *
 * Moved here from src/server/live/conditional.ts; that file is gone,
 * so every caller imports it from here.
 *
 * Only for polled JSON views: never streams, downloads or media. The
 * route runs after every check (host, origin, session, the module's
 * access), so a signed-out tab still gets `401`, and a member `403`.
 *
 * Responses stay `Cache-Control: no-store` (src/server/app.ts): the browser
 * keeps nothing, and the client sends `If-None-Match` itself (packages/client/src/lib/api.ts).
 * The app's gzip (compression.ts) makes the tag weak (`W/"…"`); tags are
 * compared weakly, as `If-None-Match` is. A `304` has no body and no
 * `Content-Type`, so it is never compressed.
 */

/** New on every start: no version outlives the process that gave it. */
const BOOT = randomBytes(12).toString('base64url');

/** SHA-256 cut to 16 bytes, base64url. */
const digest = (text: string) => createHash('sha256').update(text).digest().subarray(0, 16).toString('base64url');

/** No version: the tag is the body hash alone (step 1a). */
const NO_VERSION = '0';

/**
 * The audit mode (`LIVE_VERSION_AUDIT=1`, on in tests and the smoke): a
 * matching version builds the body anyway and fails if it differs from
 * the body the tag was given for, so a missing dependency can't hide.
 */
export const auditing = () => process.env.LIVE_VERSION_AUDIT === '1';

export class VersionAuditError extends Error {
    constructor(path: string) {
        super(
            `Version audit: ${path} matched its version, but its body changed. A change counter is missing for something this view reads.`,
        );
        this.name = 'VersionAuditError';
    }
}

interface Tag {
    version: string;
    body: string;
}
const TAG = /^(?:W\/)?"([\w-]+)\.([\w-]+)"$/;

/** The tags of `If-None-Match` this server could have given out. */
export function parseIfNoneMatch(header: string | undefined): Tag[] {
    if (!header) {
        return [];
    }
    return header
        .split(',')
        .map((item) => TAG.exec(item.trim()))
        .filter((match): match is RegExpExecArray => !!match)
        .map(([, version, body]) => ({ version: version!, body: body! }));
}

const tagOf = ({ version, body }: Tag) => `"${version}.${body}"`;

function notModified(c: Context, tag: Tag) {
    c.header('ETag', tagOf(tag));
    // What the 200 would carry (RFC 9110, 15.4.5): gzip varies by it.
    c.header('Vary', 'Accept-Encoding');
    return c.body(null, 304);
}

/** The version part of the tag: the boot id, the request and `version`. */
const versionOf = (c: Context, version: string) =>
    digest(`${BOOT}\n${c.req.path}${new URL(c.req.url).search}\n${version}`);

/** The answer once the body is built: `304` or the JSON, with the tag. */
function answer(c: Context, sent: Tag[], current: string, text: string) {
    const body = digest(text);
    if (sent.some((tag) => tag.body === body)) {
        return notModified(c, { version: current, body });
    }
    c.header('ETag', tagOf({ version: current, body }));
    c.header('Vary', 'Accept-Encoding');
    return c.body(text, 200, { 'Content-Type': 'application/json' });
}

function audited(c: Context, known: Tag, body: string) {
    if (known.body === body) {
        return;
    }
    const error = new VersionAuditError(c.req.path);
    console.error(error.message);
    throw error;
}

/**
 * Answers a polled view: `304` when the client has it, else the JSON with
 * its tag. `version` must read everything `build` depends on for this
 * user, and is read first; both run in one synchronous step, so no write
 * from this process falls between them.
 */
export function conditionalJson(c: Context, build: () => unknown, version?: () => string): Response {
    const sent = parseIfNoneMatch(c.req.header('If-None-Match'));
    const current = version ? versionOf(c, version()) : NO_VERSION;
    const known = version && sent.find((tag) => tag.version === current);
    if (known && !auditing()) {
        return notModified(c, known);
    }
    const text = JSON.stringify(build());
    if (known) {
        audited(c, known, digest(text));
        return notModified(c, { version: current, body: digest(text) });
    }
    return answer(c, sent, current, text);
}

/**
 * `conditionalJson` for a view built from async repositories (CB-110). The
 * version is still read first, so a write that lands while the body is
 * built makes the tag's version older than its body: the next poll then
 * builds once more, and nothing is ever missed. For the same reason the
 * audit only counts a changed body when the version still matches after
 * the build.
 */
export async function conditionalJsonAsync(
    c: Context,
    build: () => Promise<unknown>,
    version?: () => string | Promise<string>,
): Promise<Response> {
    const sent = parseIfNoneMatch(c.req.header('If-None-Match'));
    const current = version ? versionOf(c, await version()) : NO_VERSION;
    const known = version && sent.find((tag) => tag.version === current);
    if (known && !auditing()) {
        return notModified(c, known);
    }
    const text = JSON.stringify(await build());
    if (known) {
        const body = digest(text);
        if (known.body !== body && versionOf(c, await version!()) !== current) {
            return answer(c, sent, current, text);
        }
        audited(c, known, body);
        return notModified(c, { version: current, body });
    }
    return answer(c, sent, current, text);
}
