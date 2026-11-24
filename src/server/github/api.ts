import { createSign } from 'node:crypto';

import { pktLine, readPktLines } from '@socio/foundation/github/pkt-lines';

import {
    GITHUB_HOSTS,
    GitHubError,
    INSTALLATION_PERMISSIONS,
    type ConvertedApp,
    type GitHubAppShape,
    type GitHubClientsShape,
    type GitHubOptions,
    type GitHubRepositoryOptions,
    type GitHubRepositoryShape,
    type InstallationPermissions,
} from './contract.js';

/**
 * Socio's GitHub App (CB-32, CB-239), in the app's own process (never the
 * coding agent's): the App, made from a manifest, mints a short-lived
 * installation token for one repository with no more than contents and
 * pull requests; the coding gateway's Git proxy pushes over git's smart
 * HTTP protocol with it and opens draft pull requests with the REST API;
 * then the token is revoked. Credentials travel
 * only in Authorization headers: never in a URL, argv, git config or a
 * log line, and every message that may hold GitHub's text has them removed.
 */

const PERMISSION_KEYS = ['contents', 'pull_requests'];

const ZERO = '0'.repeat(40);
const SHA = /^[0-9a-f]{40}$/;
const USER_AGENT = 'socio';
const ANSWER_LIMIT = 8 * 1024 * 1024;
const MESSAGE_LIMIT = 300;

const FLUSH = Buffer.from('0000', 'ascii');

/** A response body as bytes, up to `limit`. */
async function readBody(response: Response, limit: number) {
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const chunk = await reader?.read();
        if (!chunk || chunk.done) {
            break;
        }
        size += chunk.value.length;
        if (size > limit) {
            await reader!.cancel();
            throw new GitHubError('GitHub’s answer was too large.');
        }
        chunks.push(chunk.value);
    }
    return Buffer.concat(chunks);
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/**
 * The App's own token: a JWT signed with its private key (RS256), valid
 * for nine minutes (GitHub allows ten), issued a minute early for clock
 * drift. It only lists installations and mints their tokens.
 */
export function appJwt(appId: string, privateKey: string, now = Date.now()) {
    const seconds = Math.floor(now / 1000);
    const data = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(
        JSON.stringify({
            iat: seconds - 60,
            exp: seconds + 540,
            iss: /^\d+$/.test(appId) ? Number(appId) : appId,
        }),
    )}`;
    const signature = createSign('RSA-SHA256').update(data).sign(privateKey);
    return `${data}.${base64url(signature)}`;
}

/**
 * Requests to GitHub with one set of secrets: each is taken out of every
 * message, and no request follows a redirect.
 */
class GitHubHttp {
    constructor(
        private options: GitHubOptions,
        private secrets: string[],
    ) {}

    get hosts() {
        return this.options.hosts ?? GITHUB_HOSTS;
    }

    /** Text with the secrets taken out, cut short. */
    clean(text: string) {
        let clean = text;
        for (const secret of this.secrets) {
            if (secret) {
                clean = clean.split(secret).join('[redacted]');
            }
        }
        clean = clean.trim();
        return clean.length > MESSAGE_LIMIT ? `${clean.slice(0, MESSAGE_LIMIT - 1)}…` : clean;
    }

    async send(
        url: string,
        init: {
            method?: string;
            headers: Record<string, string>;
            body?: Uint8Array<ArrayBuffer> | string;
            timeoutMs?: number;
        },
    ) {
        const timeout = AbortSignal.timeout(init.timeoutMs ?? this.options.timeoutMs ?? 30_000);
        const signal = this.options.signal ? AbortSignal.any([this.options.signal, timeout]) : timeout;
        let response: Response;
        try {
            response = await (this.options.transport ?? fetch)(url, {
                method: init.method ?? 'GET',
                headers: { 'User-Agent': USER_AGENT, ...init.headers },
                body: init.body,
                // Never followed: the Authorization header stays with GitHub.
                redirect: 'manual',
                signal,
            });
        } catch {
            throw new GitHubError(
                this.options.signal?.aborted
                    ? 'The request was stopped before GitHub answered.'
                    : timeout.aborted
                      ? 'GitHub did not answer in time.'
                      : 'GitHub could not be reached.',
            );
        }
        if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
            await response.body?.cancel();
            throw new GitHubError(
                `GitHub answered with a redirect${response.status ? ` (${response.status})` : ''}, which is not followed: the repository was probably renamed or moved. Check the repository in Settings.`,
                response.status || undefined,
            );
        }
        return response;
    }

    /**
     * The REST API, as JSON; GitHub's own message on failure, with `hint`'s
     * advice for the status.
     */
    async json<T>(
        path: string,
        init: {
            method?: string;
            body?: unknown;
            /** The Authorization header; none for public endpoints. */
            auth?: string;
            hint?: (status: number) => string | undefined;
        } = {},
    ): Promise<{ status: number; data: T }> {
        const response = await this.send(`${this.hosts.api}${path}`, {
            method: init.method,
            headers: {
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                ...(init.auth ? { Authorization: init.auth } : {}),
                ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
        });
        const text = (await readBody(response, ANSWER_LIMIT)).toString('utf8');
        let data: unknown;
        try {
            data = text ? JSON.parse(text) : {};
        } catch {
            data = {};
        }
        if (response.ok) {
            return { status: response.status, data: data as T };
        }
        const answer = (data ?? {}) as {
            message?: unknown;
            errors?: Array<{ message?: unknown } | string>;
        };
        const detail = [
            typeof answer.message === 'string' ? answer.message : '',
            ...(Array.isArray(answer.errors) ? answer.errors : []).map((entry) =>
                typeof entry === 'string' ? entry : typeof entry?.message === 'string' ? entry.message : '',
            ),
        ]
            .filter(Boolean)
            .join(': ')
            .replace(/\.$/, '');
        const hint = init.hint?.(response.status);
        throw new GitHubError(
            this.clean(`GitHub answered ${response.status}${detail ? `: ${detail}` : ''}${hint ? ` (${hint})` : ''}.`),
            response.status,
        );
    }
}

const repoPath = (repository: string, rest = '') => {
    const [owner, name] = repository.split('/');
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${rest}`;
};

/**
 * The App, by its id and private key: its installations, and tokens for
 * them. The key is used to sign JWTs here, and nowhere else.
 */
export class GitHubApp implements GitHubAppShape {
    private http: GitHubHttp;

    constructor(
        private credentials: { id: string; privateKey: string },
        private options: GitHubOptions = {},
    ) {
        this.http = new GitHubHttp(options, [credentials.privateKey]);
    }

    /**
     * Finishes the manifest flow: GitHub made the App when the admin
     * confirmed it, and this one-time `code` (valid for an hour) gets its id
     * and private key. No credentials are needed for the call.
     */
    static async convertManifest(code: string, options: GitHubOptions = {}): Promise<ConvertedApp> {
        const http = new GitHubHttp(options, [code]);
        const { data } = await http.json<{
            id?: unknown;
            slug?: unknown;
            pem?: unknown;
            owner?: { login?: unknown };
        }>(`/app-manifests/${encodeURIComponent(code)}/conversions`, {
            method: 'POST',
            hint: (status) =>
                status === 404 || status === 422
                    ? 'the code was used already or is more than an hour old; connect again'
                    : undefined,
        });
        if (
            (typeof data.id !== 'number' && typeof data.id !== 'string') ||
            typeof data.slug !== 'string' ||
            !/^[a-z0-9-]{1,100}$/.test(data.slug) ||
            typeof data.pem !== 'string' ||
            !data.pem.includes('PRIVATE KEY') ||
            typeof data.owner?.login !== 'string'
        ) {
            throw new GitHubError('GitHub’s answer had no App in it.');
        }
        return {
            id: String(data.id),
            slug: data.slug,
            owner: data.owner.login,
            privateKey: data.pem,
        };
    }

    /**
     * Whether `owner` is an organization or a person: Apps are made under
     * `/organizations/<owner>/settings/apps/new` or `/settings/apps/new`.
     * Public information; no credentials.
     */
    static async accountType(owner: string, options: GitHubOptions = {}) {
        const http = new GitHubHttp(options, []);
        const { data } = await http.json<{ type?: unknown }>(`/users/${encodeURIComponent(owner)}`, {
            hint: (status) => (status === 404 ? 'no such account; check the repository' : undefined),
        });
        return data.type === 'Organization' ? 'Organization' : 'User';
    }

    private auth() {
        return `Bearer ${appJwt(this.credentials.id, this.credentials.privateKey)}`;
    }

    private hint = (status: number) =>
        status === 401 ? 'the GitHub App’s id or key is wrong; connect GitHub again' : undefined;

    /** An installation of this App, by id: which account it is on. */
    async installation(id: string) {
        const { data } = await this.http.json<{
            id?: unknown;
            account?: { login?: unknown };
        }>(`/app/installations/${encodeURIComponent(id)}`, {
            auth: this.auth(),
            hint: (status) =>
                status === 404
                    ? 'not an installation of this App: it was uninstalled or the id is wrong; connect GitHub again from Settings'
                    : this.hint(status),
        });
        if (typeof data.id !== 'number' || typeof data.account?.login !== 'string') {
            throw new GitHubError('GitHub’s answer had no installation in it.');
        }
        return { id: String(data.id), account: data.account.login };
    }

    /** The id of this App's installation that covers `repository`. */
    async repositoryInstallation(repository: string) {
        const { data } = await this.http.json<{ id?: unknown }>(repoPath(repository, '/installation'), {
            auth: this.auth(),
            hint: (status) =>
                status === 404
                    ? `the GitHub App is not installed on ${repository}; install it from Settings`
                    : this.hint(status),
        });
        if (typeof data.id !== 'number') {
            throw new GitHubError('GitHub’s answer had no installation in it.');
        }
        return String(data.id);
    }

    /**
     * The installation of this App that covers `repository` and is on its
     * owner's account (CB-239): a same-named repository elsewhere never
     * gets a token.
     */
    async ownedInstallation(repository: string) {
        const id = await this.repositoryInstallation(repository);
        const owner = repository.split('/')[0];
        const installation = await this.installation(id);
        if (installation.account.toLowerCase() !== owner.toLowerCase()) {
            throw new GitHubError(
                `The GitHub App is installed on ${installation.account}, not on ${owner}, the repository’s owner; install it on ${repository}.`,
            );
        }
        return id;
    }

    /**
     * A token for one repository, with contents and pull requests write and
     * nothing more (GitHub adds metadata read), valid for an hour at most:
     * use it once, then `revoke` it. Refused when GitHub grants anything else.
     */
    async installationToken(
        installationId: string,
        repository: string,
        permissions: InstallationPermissions = INSTALLATION_PERMISSIONS,
    ) {
        const asked = Object.entries(permissions);
        if (
            !asked.length ||
            asked.some(([key, value]) => !PERMISSION_KEYS.includes(key) || (value !== 'read' && value !== 'write'))
        ) {
            throw new GitHubError('An installation token may ask only for contents and pull requests.');
        }
        const { data } = await this.http.json<{
            token?: unknown;
            permissions?: Record<string, unknown>;
        }>(`/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
            method: 'POST',
            auth: this.auth(),
            body: {
                repositories: [repository.split('/')[1]],
                permissions,
            },
            hint: (status) =>
                status === 404 || status === 422
                    ? `the GitHub App’s installation does not cover ${repository}, or lacks ${asked.map(([key, value]) => `${key.replace('_', ' ')} ${value}`).join(' and ')}; install it on the repository from Settings`
                    : this.hint(status),
        });
        if (typeof data.token !== 'string' || !data.token) {
            throw new GitHubError('GitHub’s answer had no token in it.');
        }
        const token = data.token;
        // Exactly what was asked, and the metadata read GitHub always adds
        // (the allowed permission set keeps allowing it).
        const allowed: Record<string, string> = {
            ...permissions,
            metadata: 'read',
        };
        const granted = Object.entries(data.permissions ?? {});
        if (granted.some(([key, value]) => allowed[key] !== value)) {
            await this.revoke(token);
            throw new GitHubError(
                permissions === INSTALLATION_PERMISSIONS
                    ? 'GitHub granted the token more than it needs, so it was not used.'
                    : 'GitHub granted the token more than was asked for, so it was not used.',
            );
        }
        return { token, revoke: () => this.revoke(token) };
    }

    /**
     * Ends an installation token early; failures don't matter (it expires
     * within the hour). Not stopped by the caller's signal: a canceled or
     * timed-out request still revokes, within ten seconds of its own.
     */
    private async revoke(token: string) {
        await new GitHubHttp({ ...this.options, signal: undefined, timeoutMs: 10_000 }, [token])
            .json('/installation/token', {
                method: 'DELETE',
                auth: `Bearer ${token}`,
            })
            .catch(() => undefined);
    }
}

/**
 * One repository on GitHub, with an installation token. `signal` stops
 * every request (the caller was canceled or reached its time limit).
 */
export class GitHubRepository implements GitHubRepositoryShape {
    private readonly owner: string;
    private http: GitHubHttp;

    constructor(private options: GitHubRepositoryOptions) {
        this.owner = options.repository.split('/')[0];
        this.http = new GitHubHttp(options, [options.token]);
    }

    private hint = (status: number) =>
        status === 401
            ? 'the token was refused'
            : status === 403 || status === 404
              ? 'check the repository, and that the GitHub App is installed on it with contents and pull requests write'
              : undefined;

    private api<T>(path: string, init: { method?: string; body?: unknown } = {}) {
        return this.http.json<T>(path, {
            ...init,
            auth: `Bearer ${this.options.token}`,
            hint: this.hint,
        });
    }

    /** Whether `commit` is on `branch` already (or is its head). */
    async branchContains(branch: string, commit: string) {
        try {
            const { data } = await this.api<{ status?: string }>(
                repoPath(
                    this.options.repository,
                    `/compare/${encodeURIComponent(branch)}...${encodeURIComponent(commit)}`,
                ),
            );
            return data.status === 'identical' || data.status === 'behind';
        } catch (error) {
            if (error instanceof GitHubError && error.status === 404) {
                return false;
            }
            throw error;
        }
    }

    /**
     * The commit a branch, tag or commit id names now (CB-267: the person
     * approves an immutable commit, not whatever the branch points to later).
     */
    async resolveCommit(ref: string) {
        const { data } = await this.api<{ sha?: unknown }>(
            repoPath(this.options.repository, `/commits/${encodeURIComponent(ref)}`),
        );
        if (typeof data.sha !== 'string' || !SHA.test(data.sha)) {
            throw new GitHubError('GitHub’s answer had no commit in it.');
        }
        return data.sha;
    }

    /**
     * One request of git's smart HTTP for the coding gateway's proxy
     * (CB-239): `<git>/<repository>.git<path>`, the token as basic
     * auth, the body streamed through, the answer returned unread so the
     * caller can stream it. Never follows a redirect: the token stays with
     * GitHub. Only the headers given are sent, with a generic User-Agent.
     */
    async smartHttp(
        path: string,
        init: {
            method: 'GET' | 'POST';
            headers?: Record<string, string>;
            body?: ReadableStream<Uint8Array> | Uint8Array<ArrayBuffer>;
            signal?: AbortSignal;
        },
    ) {
        const auth = Buffer.from(`x-access-token:${this.options.token}`).toString('base64');
        const signals = [init.signal, this.options.signal].filter((signal): signal is AbortSignal => !!signal);
        let response: Response;
        try {
            response = await (this.options.transport ?? fetch)(
                `${this.http.hosts.git}/${this.options.repository}.git${path}`,
                {
                    method: init.method,
                    headers: {
                        'User-Agent': USER_AGENT,
                        ...init.headers,
                        Authorization: `Basic ${auth}`,
                    },
                    body: init.body,
                    redirect: 'manual',
                    signal: signals.length ? AbortSignal.any(signals) : undefined,
                    ...(init.body instanceof ReadableStream ? { duplex: 'half' } : {}),
                } as RequestInit,
            );
        } catch {
            throw new GitHubError('GitHub could not be reached.');
        }
        if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
            await response.body?.cancel();
            throw new GitHubError(
                'GitHub answered with a redirect, which is not followed: the repository was probably renamed or moved.',
                response.status || undefined,
            );
        }
        return response;
    }

    /** Git's smart HTTP, with the token as basic auth (as GitHub asks). */
    private git(path: string, init: { method?: string; body?: Uint8Array<ArrayBuffer> }) {
        const auth = Buffer.from(`x-access-token:${this.options.token}`).toString('base64');
        return this.http.send(`${this.http.hosts.git}/${this.options.repository}.git${path}`, {
            method: init.method,
            headers: {
                Authorization: `Basic ${auth}`,
                ...(init.body
                    ? {
                          'Content-Type': 'application/x-git-receive-pack-request',
                          Accept: 'application/x-git-receive-pack-result',
                      }
                    : {}),
            },
            body: init.body,
            timeoutMs: init.body ? 120_000 : undefined,
        });
    }

    /**
     * Creates `refs/heads/<branch>` at `head` from `pack` (which holds the
     * commits GitHub lacks). Never moves a branch that exists: one already at
     * `head` is left as it is (`present`); one elsewhere is refused.
     */
    async pushBranch(branch: string, head: string, pack: Uint8Array) {
        const ref = `refs/heads/${branch}`;
        const advertised = await this.git('/info/refs?service=git-receive-pack', {
            method: 'GET',
        });
        if (!advertised.ok) {
            await advertised.body?.cancel();
            throw new GitHubError(
                `GitHub refused the push (${advertised.status})${[401, 403, 404].includes(advertised.status) ? ': check the repository, and that the GitHub App is installed on it with contents write' : ''}.`,
                advertised.status,
            );
        }
        const lines = readPktLines(await readBody(advertised, ANSWER_LIMIT));
        if (lines[0] !== '# service=git-receive-pack\n') {
            throw new GitHubError('GitHub’s answer to the push was not git’s.');
        }
        const refs = new Map<string, string>();
        const capabilities = new Set<string>();
        for (const line of lines.slice(1)) {
            if (line === null) {
                continue;
            }
            const [entry, caps] = line.replace(/\n$/, '').split('\0');
            if (caps !== undefined) {
                for (const cap of caps.split(' ')) {
                    capabilities.add(cap);
                }
            }
            const [sha, name] = entry.split(' ');
            if (SHA.test(sha) && name) {
                refs.set(name, sha);
            }
        }
        const existing = refs.get(ref);
        if (existing === head) {
            return 'present' as const;
        }
        if (existing) {
            throw new GitHubError(`${branch} is already on GitHub with other commits, so it was not overwritten.`);
        }
        if (!capabilities.has('report-status')) {
            throw new GitHubError('GitHub did not offer to report the push.');
        }
        // Creating a ref (old id all zeros): never an update, never forced.
        const response = await this.git('/git-receive-pack', {
            method: 'POST',
            body: Buffer.concat([pktLine(`${ZERO} ${head} ${ref}\0report-status agent=${USER_AGENT}\n`), FLUSH, pack]),
        });
        if (!response.ok) {
            await response.body?.cancel();
            throw new GitHubError(`GitHub refused the push (${response.status}).`, response.status);
        }
        const report = readPktLines(await readBody(response, ANSWER_LIMIT))
            .filter((line): line is string => line !== null)
            .map((line) => line.replace(/\n$/, ''));
        const unpack = report.find((line) => line.startsWith('unpack '));
        if (unpack !== 'unpack ok') {
            throw new GitHubError(
                this.http.clean(`GitHub could not take the commits: ${unpack?.slice(7) || 'no report'}.`),
            );
        }
        if (report.includes(`ok ${ref}`)) {
            return 'pushed' as const;
        }
        const refused = report.find((line) => line.startsWith(`ng ${ref} `));
        throw new GitHubError(
            this.http.clean(`GitHub refused the branch: ${refused?.slice(ref.length + 4) || 'no report'}.`),
        );
    }

    /**
     * A draft pull request from `head` into `base`; the one already open (or
     * closed) for `head` when there is one, so a retry never opens two. Where
     * GitHub has no drafts (private repositories on free plans), a ready one
     * titled "[draft] …"; `draft` says which.
     */
    async draftPullRequest(input: {
        head: string;
        base: string;
        title: string;
        body: string;
        /**
         * Never a ready one (CB-239: coding sessions open drafts only):
         * where GitHub has no drafts, fail instead.
         */
        draftOnly?: boolean;
    }) {
        type Pull = { number?: number; html_url?: string; draft?: boolean };
        const { data: found } = await this.api<Pull[]>(
            repoPath(
                this.options.repository,
                `/pulls?state=all&per_page=1&head=${encodeURIComponent(`${this.owner}:${input.head}`)}`,
            ),
        );
        const open = (draft: boolean) =>
            this.api<Pull>(repoPath(this.options.repository, '/pulls'), {
                method: 'POST',
                body: {
                    title: draft ? input.title : `[draft] ${input.title}`.slice(0, 256),
                    head: input.head,
                    base: input.base,
                    body: input.body,
                    draft,
                    maintainer_can_modify: false,
                },
            });
        let data = Array.isArray(found) ? found[0] : undefined;
        if (!data) {
            try {
                ({ data } = await open(true));
            } catch (error) {
                if (
                    input.draftOnly ||
                    !(error instanceof GitHubError) ||
                    error.status !== 422 ||
                    !/draft/i.test(error.message)
                ) {
                    throw error;
                }
                ({ data } = await open(false));
            }
        }
        if (
            typeof data.number !== 'number' ||
            typeof data.html_url !== 'string' ||
            !data.html_url.startsWith('https://')
        ) {
            throw new GitHubError('GitHub’s answer had no pull request.');
        }
        return {
            number: data.number,
            url: data.html_url,
            draft: data.draft === true,
        };
    }
}

/**
 * The `GitHubClients` tag's implementation (contract.ts): an App and a
 * repository, made as the coding gateway makes them today.
 */
export const gitHubClients: GitHubClientsShape = {
    app: (credentials, options) => new GitHubApp(credentials, options),
    repository: (options) => new GitHubRepository(options),
};
