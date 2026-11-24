// A stand-in for GitHub on loopback (CB-32): the App manifest conversion,
// App JWTs (checked against the App's public key), installations and their
// tokens, git's smart HTTP through the real `git http-backend` over bare
// repositories, and the REST calls publishing makes. It records every
// request, so tests can check where each credential went. No network.
import { spawn, execFileSync } from 'node:child_process';
import { createPublicKey, createVerify, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

export interface SeenRequest {
    method: string;
    url: string;
    headers: IncomingMessage['headers'];
    body: Buffer;
}

export interface FakePull {
    number: number;
    html_url: string;
    title: string;
    head: string;
    base: string;
    body: string;
    draft: boolean;
}

export interface FakeApp {
    id: number;
    slug: string;
    owner: string;
    pem: string;
}

export interface MintedToken {
    token: string;
    installationId: number;
    repositories: string[];
    permissions: Record<string, string>;
    revoked: boolean;
}

const read = (request: IncomingMessage) =>
    new Promise<Buffer>((resolve) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => resolve(Buffer.concat(chunks)));
    });

/** One RSA key for every fake App: making one takes a while. */
let sharedKey: string | undefined;
const appKey = () =>
    (sharedKey ??= generateKeyPairSync('rsa', { modulusLength: 2048 })
        .privateKey.export({ type: 'pkcs1', format: 'pem' })
        .toString());

/**
 * `root/<owner>/<name>.git` are the repositories. `fail` makes a path (by
 * prefix) answer that status instead. `organizations` are owners that are
 * organizations; the rest are people.
 */
export async function fakeGitHub(
    root: string,
    cleanup: Array<() => unknown>,
    options: { organizations?: string[] } = {},
) {
    const seen: SeenRequest[] = [];
    const pulls: FakePull[] = [];
    const apps: FakeApp[] = [];
    /** Manifest codes, once each: the owner the App is made under. */
    const codes = new Map<string, string>();
    const installations = new Map<number, { appId: number; account: string; repositories: string[] }>();
    const tokens: MintedToken[] = [];
    const fail = new Map<string, { status: number; body?: unknown }>();
    /** Permissions GitHub grants on top of those asked for (a test's misbehaving GitHub). */
    const extraPermissions: Record<string, string> = {};
    /** A private repository on a free plan: no draft pull requests. */
    const settings = { drafts: true };

    /** The App a JWT is signed by, when it is valid now. */
    const jwtApp = (header: string | undefined) => {
        const jwt = header?.match(/^Bearer (.+\..+\..+)$/)?.[1];
        if (!jwt) {
            return undefined;
        }
        const [head, payload, signature] = jwt.split('.');
        let claims: { iss?: number | string; exp?: number; iat?: number };
        try {
            claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
        } catch {
            return undefined;
        }
        const app = apps.find((entry) => String(entry.id) === String(claims.iss));
        if (!app) {
            return undefined;
        }
        const ok = createVerify('RSA-SHA256')
            .update(`${head}.${payload}`)
            .verify(createPublicKey(app.pem), Buffer.from(signature, 'base64url'));
        const now = Date.now() / 1000;
        if (!ok || !claims.exp || claims.exp < now || claims.exp - now > 600) {
            return undefined;
        }
        return app;
    };
    const tokenFor = (secret: string | undefined, repository: string) =>
        tokens.find(
            (entry) =>
                entry.token === secret && !entry.revoked && entry.repositories.includes(repository.split('/')[1]),
        );

    const server = createServer(async (request, response) => {
        // A client may hang up mid-request (a push refused or cut short):
        // ECONNRESET or EPIPE on its socket is no fault of the fake's.
        request.on('error', () => {});
        response.on('error', () => {});
        const body = await read(request);
        const url = request.url ?? '/';
        seen.push({
            method: request.method ?? 'GET',
            url,
            headers: request.headers,
            body,
        });
        const json = (status: number, data?: unknown) => {
            response.writeHead(status, {
                'Content-Type': 'application/json',
                ...(status >= 300 && status < 400 ? { Location: `https://elsewhere.example${url}` } : {}),
            });
            response.end(data === undefined ? '' : JSON.stringify(data));
        };
        for (const [prefix, answer] of fail) {
            if (url.startsWith(prefix)) {
                return json(answer.status, answer.body ?? { message: 'Failing on purpose' });
            }
        }
        const bearer = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
        if (url.startsWith('/api/')) {
            const path = url.slice(4).split('?')[0];
            let match: RegExpExecArray | null;
            if ((match = /^\/app-manifests\/([^/]+)\/conversions$/.exec(path))) {
                const owner = codes.get(match[1]);
                if (request.method !== 'POST' || !owner) {
                    return json(404, { message: 'Not Found' });
                }
                codes.delete(match[1]);
                const id = 1000 + apps.length;
                const app = { id, slug: `socio-${id}`, owner, pem: appKey() };
                apps.push(app);
                return json(201, {
                    id,
                    slug: app.slug,
                    owner: { login: owner },
                    pem: app.pem,
                    client_secret: 'secret-not-kept',
                    webhook_secret: null,
                });
            }
            if ((match = /^\/users\/([^/]+)$/.exec(path))) {
                return json(200, {
                    login: match[1],
                    type: options.organizations?.includes(match[1]) ? 'Organization' : 'User',
                });
            }
            if ((match = /^\/app\/installations\/(\d+)$/.exec(path))) {
                const app = jwtApp(request.headers.authorization);
                if (!app) {
                    return json(401, {
                        message: 'A JSON web token could not be decoded',
                    });
                }
                const installation = installations.get(Number(match[1]));
                if (!installation || installation.appId !== app.id) {
                    return json(404, { message: 'Not Found' });
                }
                return json(200, {
                    id: Number(match[1]),
                    account: { login: installation.account },
                });
            }
            if ((match = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path))) {
                const app = jwtApp(request.headers.authorization);
                if (!app) {
                    return json(401, {
                        message: 'A JSON web token could not be decoded',
                    });
                }
                const id = Number(match[1]);
                const installation = installations.get(id);
                if (!installation || installation.appId !== app.id) {
                    return json(404, { message: 'Not Found' });
                }
                const input = JSON.parse(body.toString() || '{}') as {
                    repositories?: string[];
                    permissions?: Record<string, string>;
                };
                const repositories = input.repositories ?? installation.repositories;
                if (repositories.some((name) => !installation.repositories.includes(name))) {
                    return json(422, {
                        message:
                            'There is at least one repository that does not exist or is not accessible to the parent installation.',
                    });
                }
                const permissions = {
                    metadata: 'read',
                    ...(input.permissions ?? {
                        contents: 'write',
                        pull_requests: 'write',
                        issues: 'write',
                    }),
                    ...extraPermissions,
                };
                const minted: MintedToken = {
                    token: `ghs_${randomBytes(18).toString('hex')}`,
                    installationId: id,
                    repositories,
                    permissions,
                    revoked: false,
                };
                tokens.push(minted);
                return json(201, {
                    token: minted.token,
                    expires_at: new Date(Date.now() + 3600_000).toISOString(),
                    permissions,
                    repositories: repositories.map((name) => ({ name })),
                });
            }
            if (path === '/installation/token' && request.method === 'DELETE') {
                const minted = tokens.find((entry) => entry.token === bearer);
                if (!minted) {
                    return json(401, { message: 'Bad credentials' });
                }
                minted.revoked = true;
                return json(204);
            }
            match = /^\/repos\/([^/]+)\/([^/]+)(\/.*)$/.exec(path);
            if (!match) {
                return json(404, { message: 'Not Found' });
            }
            const [, owner, name, rest] = match;
            const repository = `${owner}/${name}`;
            if (rest === '/installation') {
                const app = jwtApp(request.headers.authorization);
                if (!app) {
                    return json(401, {
                        message: 'A JSON web token could not be decoded',
                    });
                }
                const found = [...installations].find(
                    ([, entry]) =>
                        entry.appId === app.id && entry.account === owner && entry.repositories.includes(name),
                );
                return found ? json(200, { id: found[0] }) : json(404, { message: 'Not Found' });
            }
            const minted = tokenFor(bearer, repository);
            if (!minted) {
                return json(401, { message: 'Bad credentials' });
            }
            const dir = join(root, owner, `${name}.git`);
            const compare = /^\/compare\/(.+)\.\.\.([0-9a-f]{40})$/.exec(rest);
            if (compare) {
                const base = decodeURIComponent(compare[1]);
                const git = (...args: string[]) => {
                    try {
                        execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
                        return true;
                    } catch {
                        return false;
                    }
                };
                if (
                    !git('rev-parse', '--verify', '--quiet', `refs/heads/${base}`) ||
                    !git('cat-file', '-e', `${compare[2]}^{commit}`)
                ) {
                    return json(404, { message: 'Not Found' });
                }
                const head = execFileSync('git', ['-C', dir, 'rev-parse', `refs/heads/${base}`])
                    .toString()
                    .trim();
                if (head === compare[2]) {
                    return json(200, { status: 'identical' });
                }
                return json(200, {
                    status: git('merge-base', '--is-ancestor', compare[2], head) ? 'behind' : 'diverged',
                });
            }
            // A commit by branch, tag or id (CB-267 resolves refs before a card).
            const commitRef = /^\/commits\/([^/]+)$/.exec(rest);
            if (commitRef && request.method === 'GET') {
                if (!minted.permissions.contents) {
                    return json(403, {
                        message: 'Resource not accessible by integration',
                    });
                }
                try {
                    const sha = execFileSync('git', [
                        '-C',
                        dir,
                        'rev-parse',
                        '--verify',
                        '--quiet',
                        `${decodeURIComponent(commitRef[1])}^{commit}`,
                    ])
                        .toString()
                        .trim();
                    return json(200, { sha });
                } catch {
                    return json(404, { message: 'Not Found' });
                }
            }
            if (rest === '/pulls' && request.method === 'GET') {
                const head = new URL(url, 'http://x').searchParams.get('head');
                return json(
                    200,
                    pulls.filter((pull) => `${owner}:${pull.head}` === head),
                );
            }
            if (rest === '/pulls' && request.method === 'POST') {
                if (minted.permissions.pull_requests !== 'write') {
                    return json(403, {
                        message: 'Resource not accessible by integration',
                    });
                }
                if (!settings.drafts && (JSON.parse(body.toString()) as { draft?: boolean }).draft) {
                    return json(422, {
                        message: 'Validation Failed',
                        errors: [
                            {
                                resource: 'PullRequest',
                                code: 'custom',
                                message: 'Draft pull requests are not supported in this repository.',
                            },
                        ],
                    });
                }
                const input = JSON.parse(body.toString()) as Omit<FakePull, 'number' | 'html_url'>;
                const exists = execFileSync('git', ['-C', dir, 'for-each-ref', `refs/heads/${input.head}`]).toString();
                if (!exists) {
                    return json(422, {
                        message: 'Validation Failed',
                        errors: [{ message: 'head is invalid' }],
                    });
                }
                const pull = {
                    ...input,
                    number: pulls.length + 1,
                    html_url: `https://github.com/${owner}/${name}/pull/${pulls.length + 1}`,
                };
                pulls.push(pull);
                return json(201, pull);
            }
            return json(404, { message: 'Not Found' });
        }
        // Git: only with an installation token as basic auth, as GitHub asks.
        const [path, query = ''] = url.split('?');
        const repository = /^\/([^/]+)\/([^/]+)\.git\//.exec(path);
        const basic = request.headers.authorization?.match(/^Basic (.+)$/)?.[1];
        const [user, secret] = basic ? Buffer.from(basic, 'base64').toString().split(':') : [];
        const minted =
            repository && user === 'x-access-token' ? tokenFor(secret, `${repository[1]}/${repository[2]}`) : undefined;
        // Fetching needs contents read (or write); pushing needs write (CB-239).
        const pushing =
            path.endsWith('/git-receive-pack') || new URLSearchParams(query).get('service') === 'git-receive-pack';
        if (!minted || !minted.permissions.contents || (pushing && minted.permissions.contents !== 'write')) {
            response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="GitHub"' });
            response.end();
            return;
        }
        const cgi = spawn('git', ['http-backend'], {
            env: {
                PATH: process.env.PATH,
                GIT_PROJECT_ROOT: root,
                GIT_HTTP_EXPORT_ALL: '1',
                PATH_INFO: path,
                QUERY_STRING: query,
                REQUEST_METHOD: request.method ?? 'GET',
                CONTENT_TYPE: request.headers['content-type'] ?? '',
                CONTENT_LENGTH: String(body.length),
                REMOTE_USER: 'x-access-token',
                REMOTE_ADDR: '127.0.0.1',
                GIT_CONFIG_COUNT: '2',
                GIT_CONFIG_KEY_0: 'http.receivepack',
                GIT_CONFIG_VALUE_0: 'true',
                // As GitHub: a commit reachable from a ref may be fetched by id.
                GIT_CONFIG_KEY_1: 'uploadpack.allowReachableSHA1InWant',
                GIT_CONFIG_VALUE_1: 'true',
                GIT_CONFIG_NOSYSTEM: '1',
                HOME: root,
            },
        });
        // http-backend may exit before it has read the whole body (a refused
        // or failed request); writing the rest then fails with EPIPE, an
        // error event no one would handle. Its output is the answer anyway.
        cgi.stdin.on('error', () => {});
        cgi.stdin.end(body);
        const out: Buffer[] = [];
        cgi.stdout.on('data', (chunk: Buffer) => out.push(chunk));
        cgi.on('error', () => {
            if (!response.headersSent) {
                response.writeHead(500);
            }
            response.end();
        });
        cgi.on('close', () => {
            if (response.writableEnded) {
                return;
            }
            const raw = Buffer.concat(out);
            const split = raw.indexOf('\r\n\r\n');
            const headers: Record<string, string> = {};
            let status = 200;
            for (const line of raw.subarray(0, split).toString().split('\r\n')) {
                const [key, ...value] = line.split(': ');
                if (key.toLowerCase() === 'status') {
                    status = Number(value.join(': ').split(' ')[0]);
                } else {
                    headers[key] = value.join(': ');
                }
            }
            response.writeHead(status, headers);
            response.end(raw.subarray(split + 4));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
        hosts: { web: `${base}/web`, git: base, api: `${base}/api` },
        seen,
        pulls,
        apps,
        tokens,
        installations,
        fail,
        extraPermissions,
        settings,
        /** The admin selected Create on GitHub: the code GitHub sends back. */
        createApp(owner: string) {
            const code = `code${randomBytes(6).toString('hex')}`;
            codes.set(code, owner);
            return code;
        },
        /** The admin selected Install on `repositories` of the App's owner. */
        install(app: FakeApp | number, repositories: string[], account?: string) {
            const found = typeof app === 'number' ? apps.find((entry) => entry.id === app)! : app;
            const id = 5000 + installations.size;
            installations.set(id, {
                appId: found.id,
                account: account ?? found.owner,
                repositories,
            });
            return id;
        },
        /** A bare repository at `owner/name`, with `source`'s main pushed. */
        repository(owner: string, name: string, source?: string) {
            const dir = join(root, owner, `${name}.git`);
            mkdirSync(dir, { recursive: true });
            execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', dir]);
            if (source) {
                execFileSync('git', ['-C', source, 'push', '--quiet', dir, 'main:main']);
            }
            return dir;
        },
    };
}
