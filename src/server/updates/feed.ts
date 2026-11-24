import {
    compareVersions,
    securityRelease,
    UPDATE_TAG,
    upgradingSteps,
    versionOfTag,
    type FeedRelease,
    type UpdateFeed,
} from '@socio/shared/updates/updates';

/**
 * The one User-Agent every feed request carries: generic, so a check names
 * neither the workspace, its people nor its host (CB-259). GitHub requires
 * one; nothing else identifying is sent.
 */
export const UPDATE_CHECK_USER_AGENT = 'update-check/1.0';

/** How many releases a check keeps, newest first. */
export const FEED_LIMIT = 50;
const RESPONSE_LIMIT = 4_000_000;
const NOTES_LIMIT = 64_000;

export class UpdateFeedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UpdateFeedError';
    }
}

export interface FeedRequest {
    feed: UpdateFeed;
    /** The read token, sent only to the feed's own host. */
    token?: string;
    githubApiUrl: string;
    ghcrUrl: string;
    transport?: typeof fetch;
    timeoutMs?: number;
}

const NAMES = { github: 'GitHub', ghcr: 'GHCR' } as const;

/** Removes the token (and anything shaped like a credential) from text. */
function redact(text: string, token?: string) {
    let out = text;
    if (token && token.length >= 4) {
        out = out.split(token).join('[redacted]');
    }
    return out
        .replace(/(bearer|basic)\s+[\w.~+/=-]+/gi, '$1 [redacted]')
        .replace(/gh[pousr]_[A-Za-z0-9]{10,}/g, '[redacted]')
        .replace(/github_pat_[A-Za-z0-9_]{10,}/g, '[redacted]')
        .replace(/\s+/g, ' ')
        .slice(0, 300);
}

/**
 * One GET: no redirects (a token never follows one to another host), a
 * timeout and a capped body. The headers are the caller's and the generic
 * User-Agent; no cookies, nothing about the workspace.
 */
async function get(
    request: FeedRequest,
    url: string,
    headers: Record<string, string>,
): Promise<{ status: number; body: unknown; headers: Headers }> {
    const service = NAMES[request.feed.kind];
    const transport = request.transport ?? fetch;
    const timeoutMs = request.timeoutMs ?? 15_000;
    let response: Response;
    try {
        response = await transport(url, {
            method: 'GET',
            headers: { 'User-Agent': UPDATE_CHECK_USER_AGENT, ...headers },
            redirect: 'error',
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (error) {
        const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        throw new UpdateFeedError(
            timedOut
                ? `${service} did not answer within ${Math.round(timeoutMs / 1000)} s.`
                : `${service} is unreachable.`,
        );
    }
    const text = await response.text().catch(() => '');
    if (text.length > RESPONSE_LIMIT) {
        throw new UpdateFeedError(`${service}'s answer is too large.`);
    }
    let body: unknown;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        body = null;
    }
    if (!response.ok) {
        const message =
            body && typeof body === 'object' && 'message' in body
                ? String((body as { message: unknown }).message)
                : body && typeof body === 'object' && 'errors' in body
                  ? JSON.stringify((body as { errors: unknown }).errors)
                  : '';
        const hint =
            response.status === 401 || response.status === 403
                ? ' Check the read token and its access to the repository.'
                : response.status === 404
                  ? ' Check the repository name, and that the token can read it if it is private.'
                  : '';
        throw new UpdateFeedError(
            `${service} answered ${response.status}${message ? `: ${redact(message, request.token)}` : ''}.${hint}`,
        );
    }
    return { status: response.status, body, headers: response.headers };
}

const dateOf = (value: unknown) =>
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : undefined;

const githubPage = (value: unknown) =>
    typeof value === 'string' && /^https:\/\/github\.com\/[^\s"'<>]+$/.test(value) ? value : undefined;

/** A GitHub release as a feed release; undefined for drafts, pre-releases and other tags. */
export function githubRelease(raw: unknown): FeedRelease | undefined {
    if (!raw || typeof raw !== 'object') {
        return undefined;
    }
    const item = raw as Record<string, unknown>;
    if (item.draft === true || item.prerelease === true) {
        return undefined;
    }
    const tag = typeof item.tag_name === 'string' ? item.tag_name : '';
    const version = versionOfTag(tag);
    if (!version) {
        return undefined;
    }
    const notes =
        typeof item.body === 'string' && item.body.trim()
            ? item.body.replace(/\r\n?/g, '\n').slice(0, NOTES_LIMIT)
            : undefined;
    const title = typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 200) : undefined;
    const date = dateOf(item.published_at) ?? dateOf(item.created_at);
    const url = githubPage(item.html_url);
    return {
        version,
        tag,
        ...(date ? { date } : {}),
        ...(title ? { title } : {}),
        ...(notes ? { notesMarkdown: notes } : {}),
        upgrading: upgradingSteps(notes),
        ...(url ? { url } : {}),
        ...(securityRelease(notes, title) ? { security: true as const } : {}),
    };
}

async function githubReleases(request: FeedRequest): Promise<FeedRelease[]> {
    const url = `${request.githubApiUrl}/repos/${request.feed.repository}/releases?per_page=${FEED_LIMIT}`;
    const { body } = await get(request, url, {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(request.token ? { Authorization: `Bearer ${request.token}` } : {}),
    });
    if (!Array.isArray(body)) {
        throw new UpdateFeedError('GitHub answered with something other than a list of releases.');
    }
    return body.flatMap((item) => githubRelease(item) ?? []);
}

/**
 * GHCR's tags: a pull token for the image first (anonymous for a public
 * one; with the read token as the password for a private one), then the
 * tag list. Tags carry no notes, so their Upgrading steps are unknown.
 */
async function ghcrReleases(request: FeedRequest): Promise<FeedRelease[]> {
    const { repository } = request.feed;
    const scope = encodeURIComponent(`repository:${repository}:pull`);
    const auth = await get(
        request,
        `${request.ghcrUrl}/token?scope=${scope}&service=ghcr.io`,
        request.token
            ? {
                  Authorization: `Basic ${Buffer.from(`token:${request.token}`).toString('base64')}`,
              }
            : {},
    );
    const bearer =
        auth.body && typeof auth.body === 'object' && 'token' in auth.body
            ? String((auth.body as { token: unknown }).token)
            : '';
    if (!bearer) {
        throw new UpdateFeedError('GHCR gave no pull token.');
    }
    const { body } = await get(request, `${request.ghcrUrl}/v2/${repository}/tags/list?n=1000`, {
        Authorization: `Bearer ${bearer}`,
        Accept: 'application/json',
    });
    const tags = body && typeof body === 'object' && 'tags' in body ? (body as { tags: unknown }).tags : null;
    if (!Array.isArray(tags)) {
        throw new UpdateFeedError('GHCR answered without a tag list.');
    }
    return tags
        .filter((tag): tag is string => typeof tag === 'string' && UPDATE_TAG.test(tag))
        .map((tag) => ({ version: tag.slice(1), tag, upgrading: null }));
}

/** The feed's releases, newest first, at most FEED_LIMIT. */
export async function fetchReleases(request: FeedRequest): Promise<FeedRelease[]> {
    const releases = request.feed.kind === 'github' ? await githubReleases(request) : await ghcrReleases(request);
    return releases.sort((a, b) => compareVersions(b.version, a.version)).slice(0, FEED_LIMIT);
}
