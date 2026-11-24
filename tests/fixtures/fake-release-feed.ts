import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One request a fake saw, headers included, for what-was-sent checks. */
export interface FeedRequest {
    method: string;
    path: string;
    headers: IncomingMessage['headers'];
}

export interface FakeGitHubRelease {
    tag_name: string;
    name?: string;
    body?: string;
    draft?: boolean;
    prerelease?: boolean;
    published_at?: string;
    html_url?: string;
}

/**
 * GitHub's releases API and GHCR's token and tag-list endpoints on
 * loopback (CB-259): `GET /repos/:owner/:repo/releases` (private when a
 * token is set: 404 without it, like GitHub), `GET /token` and
 * `GET /v2/:name/tags/list` under `/ghcr`.
 */
export async function startFakeReleaseFeed(
    options: {
        repository?: string;
        token?: string;
        releases?: FakeGitHubRelease[];
        tags?: string[];
    } = {},
) {
    const repository = options.repository ?? 'acme/socio';
    const state = {
        releases: options.releases ?? [],
        tags: options.tags ?? [],
        requests: [] as FeedRequest[],
        /** Answer every call with this status, for failure tests. */
        failWith: undefined as number | undefined,
    };
    const registryToken = 'registry-bearer-0123456789';
    const send = (res: ServerResponse, status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
    };
    const handle = (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? '/', 'http://feed.test');
        state.requests.push({
            method: req.method ?? 'GET',
            path: url.pathname + url.search,
            headers: req.headers,
        });
        if (state.failWith) {
            return send(res, state.failWith, { message: 'Server Error' });
        }
        if (url.pathname === `/repos/${repository}/releases`) {
            if (options.token && req.headers.authorization !== `Bearer ${options.token}`) {
                return send(res, 404, { message: 'Not Found' });
            }
            return send(res, 200, state.releases);
        }
        if (url.pathname === '/ghcr/token') {
            const scope = url.searchParams.get('scope');
            if (scope !== `repository:${repository}:pull`) {
                return send(res, 400, { errors: [{ code: 'DENIED' }] });
            }
            if (options.token) {
                const expected = `Basic ${Buffer.from(`token:${options.token}`).toString('base64')}`;
                if (req.headers.authorization !== expected) {
                    return send(res, 401, { errors: [{ code: 'UNAUTHORIZED' }] });
                }
            }
            return send(res, 200, { token: registryToken });
        }
        if (url.pathname === `/ghcr/v2/${repository}/tags/list`) {
            if (req.headers.authorization !== `Bearer ${registryToken}`) {
                return send(res, 401, { errors: [{ code: 'UNAUTHORIZED' }] });
            }
            return send(res, 200, { name: repository, tags: state.tags });
        }
        send(res, 404, { message: 'Not Found' });
    };
    const server = createServer(handle);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;
    return {
        state,
        repository,
        githubApiUrl: url,
        ghcrUrl: `${url}/ghcr`,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}
