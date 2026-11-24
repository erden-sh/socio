import { Hono, type MiddlewareHandler } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { requireAdmin } from '@socio/foundation/http/guards';
import type { ActorDenyReason } from '@socio/shared/actor-scopes';
import type { CodingRepositoriesView } from '@socio/shared/coding/coding-repos';
import { PUSH_CHECKLIST } from '@socio/shared/coding/coding-repos';

import type { AuditInput } from '../actors/contract.js';
import { GitProxyError, type GitGatewayShape } from '../coding/contract.js';
import { GitHubError, PACK_LIMIT } from '../github/contract.js';

import { gatewaySourcesOf, type GatewayHolder } from './adopted.js';
import { codeAccess } from './code-users.js';
import { CodingGitClient, codingGitSettingsFromEnv } from './coding-git-client.js';
import { Extractions } from './extract.js';
import { GitContext, grantBranch, grantRepository, isStandingGrant, sessionBranchAllowed } from './git-context.js';
import { checkPushCommands, parseGitPath, receiveAdvertisement, refusalReport } from './git-policy.js';
import { parseUploadAdvertisement, refreshMirror } from './mirror.js';
import { FLUSH, PktReader, PktError, pktLine } from './pkt.js';
import { GitRepositories, RepositorySettingError, gitLimitsFromEnv, socioCommitIdentity } from './repos.js';
import type { GatewayRequestContext, GatewayRoute } from './server.js';
import type { GatewaySources } from './sources.js';

/**
 * The Git proxy (CB-239), and CB-267's extraction: Git
 * smart HTTP for listed repositories on the gateway listener, backed by
 * the central GitHub App. Each request is the stamped sandbox's `cbgw_`
 * checked by `sources.actors.check` (audience `gateway:git`), then a
 * token minted for that one repository with only what the request needs,
 * forwarded in an Authorization header, revoked when the response ends.
 * No token ever reaches the sandbox. Pushes go only to the session's own
 * branch and only after `coding-git` inspected them. Dark: nothing is
 * delegable until the flags `socio-actor-access` and `coding-sessions`
 * (or `repo-extraction`) are on for the person, and the gateway listener
 * serves these routes.
 */

/** Everything the Git proxy keeps per platform: built once, at platform start (on its sources). */
export interface GitGateway extends GitGatewayShape {
    context: GitContext;
    repos: GitRepositories;
    extractions: Extractions;
    /** The socio's commit identity. */
    identity(socioId: string): { name: string; email: string } | undefined;
    /** Whether the person is on the code-access list in force (CB-124). */
    mayUseCode(personId: string): Promise<boolean>;
}

const gateways = new WeakMap<GatewaySources, GitGateway>();

/** The Git gateway of `holder`'s runtime (`adopted.ts`), for tests. */
export function gitGateway(holder: GatewayHolder): GitGateway {
    return gitGatewayOf(gatewaySourcesOf(holder));
}

/** The Git gateway on these sources (created on first use, once). */
export function gitGatewayOf(sources: GatewaySources): GitGateway {
    const existing = gateways.get(sources);
    if (existing) {
        return existing;
    }
    const { workspace, config } = sources;
    const secret = config.sessionSecret || 'socio-loopback-identity';
    const host =
        config.appsHost ||
        (() => {
            try {
                return new URL(config.appOrigin ?? '').hostname || 'socio.invalid';
            } catch {
                return 'socio.invalid';
            }
        })();
    const repos = new GitRepositories(workspace.db, {
        audit: sources.actors.audit,
        limitDefaults: gitLimitsFromEnv(process.env),
        personExists: (id) => workspace.hasUser(id),
        changed: (change, by) => endGrantsFor(sources, change, by),
    });
    const context = new GitContext({
        repos,
        github: () => sources.github.inForce(),
        clients: sources.githubClients,
        githubOptions: config.githubAccess,
    });
    const settings = codingGitSettingsFromEnv(process.env);
    if (settings) {
        context.codingGit = new CodingGitClient(settings);
    }
    const gateway: GitGateway = {
        context,
        repos,
        // The `code:run` permission (CB-376).
        mayUseCode: (personId) => codeAccess(sources, personId),
        identity: (socioId) => {
            const socio = workspace.dot(socioId);
            return socio && socioCommitIdentity(secret, socio, host);
        },
        extractions: undefined as unknown as Extractions,
    };
    gateways.set(sources, gateway);
    gateway.extractions = new Extractions(sources, gateway);
    return gateway;
}

/** Ends the grants a repository change no longer allows. */
async function endGrantsFor(
    sources: GatewaySources,
    change: {
        repository: string;
        removed: boolean;
        pushOff: boolean;
        extractionOff: boolean;
        standingOff: boolean;
    },
    by: string,
) {
    const key = change.repository.toLowerCase();
    for (const grant of sources.actors.grants.unrevoked({
        audience: 'gateway:git',
    })) {
        if (grantRepository(grant)?.toLowerCase() !== key) {
            continue;
        }
        const ends =
            change.removed ||
            (change.pushOff && (grant.scopes.includes('git:push') || grant.scopes.includes('git:pr'))) ||
            (change.extractionOff && grant.scopes.includes('git:extract')) ||
            (change.standingOff && isStandingGrant(grant));
        if (ends) {
            await sources.actors.revoke({ grantId: grant.id }, by, 'access_changed');
        }
    }
    // Listed people narrowed: those no longer listed lose theirs.
    await sources.actors.reevaluate({ audience: 'gateway:git' }, by);
}

/**
 * Registers the `gateway:git` audience policy (every runtime, at platform
 * start), and with it the Git proxy's tables, extraction approvals and
 * sweep.
 */
export function registerGitAudience(sources: GatewaySources): void {
    const gateway = gitGatewayOf(sources);
    const { repos } = gateway;
    sources.actors.audiences.register('gateway:git', {
        policyVersion: () => '',
        personMay: async (personId, _audience, grant) => {
            const name = grantRepository(grant);
            const repository = name && repos.get(name);
            return !!repository && repos.personMay(personId, repository, await gateway.mayUseCode(personId));
        },
        resourceAllowed: ({ grant, scope, resource }) => {
            if (resource.kind !== 'repository') {
                return false;
            }
            const name = grantRepository(grant);
            if (!name || name.toLowerCase() !== resource.id.toLowerCase()) {
                return false;
            }
            const repository = repos.get(name);
            if (!repository) {
                return false;
            }
            // Only a session branch under the prefix.
            if (scope === 'git:push' || scope === 'git:pr') {
                return repository.push && sessionBranchAllowed(repository, grantBranch(grant));
            }
            if (scope === 'git:extract') {
                return repository.extraction && (!isStandingGrant(grant) || repository.standingExtraction);
            }
            return scope === 'git:read';
        },
    });
}

const plain = (status: number, text: string, headers: Record<string, string> = {}) =>
    new Response(`${text}\n`, {
        status,
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
            ...headers,
        },
    });

/**
 * The `cbgw_` a request carries: the credential helper's Basic auth with
 * an empty user name, or a bearer token.
 */
export function gitCredential(header: string | null) {
    if (!header) {
        return undefined;
    }
    const bearer = /^Bearer (\S+)$/.exec(header);
    if (bearer) {
        return bearer[1];
    }
    const basic = /^Basic ([A-Za-z0-9+/=]+)$/.exec(header);
    if (!basic) {
        return undefined;
    }
    const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    return colon >= 0 ? decoded.slice(colon + 1) : undefined;
}

/** A stream that errors past `limit` bytes. */
function limited(body: ReadableStream<Uint8Array>, limit: number) {
    let size = 0;
    return body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                size += chunk.length;
                if (size > limit) {
                    controller.error(new GitProxyError(413, 'request_too_large', 'The request is too large.'));
                } else {
                    controller.enqueue(chunk);
                }
            },
        }),
    );
}

/**
 * `body`, calling `onEnd` once when it ends, fails or is canceled; an
 * aborted `signal` (the client gone, or the grant revoked) fails it.
 */
function ending(body: ReadableStream<Uint8Array>, onEnd: () => unknown, signal?: AbortSignal) {
    const reader = body.getReader();
    let ended = false;
    let downstream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const end = () => {
        if (ended) {
            return;
        }
        ended = true;
        void Promise.resolve(onEnd()).catch(() => undefined);
    };
    const abort = () => {
        end();
        // A cut-off relay must fail, not end cleanly.
        downstream?.error(new Error('The Git request was ended.'));
        void reader.cancel().catch(() => undefined);
    };
    if (signal?.aborted) {
        queueMicrotask(abort);
    } else {
        signal?.addEventListener('abort', abort, { once: true });
    }
    return new ReadableStream<Uint8Array>({
        start(controller) {
            downstream = controller;
        },
        async pull(controller) {
            try {
                const chunk = await reader.read();
                if (chunk.done) {
                    end();
                    controller.close();
                } else {
                    controller.enqueue(chunk.value);
                }
            } catch (error) {
                end();
                controller.error(error);
            }
        },
        async cancel(reason) {
            end();
            await reader.cancel(reason).catch(() => undefined);
        },
    });
}

/** `head`, then `rest`, as one stream. */
function prefixed(head: Buffer, rest: ReadableStream<Uint8Array>) {
    const reader = rest.getReader();
    let sent = false;
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            if (!sent) {
                sent = true;
                controller.enqueue(head);
                return;
            }
            const chunk = await reader.read();
            if (chunk.done) {
                controller.close();
            } else {
                controller.enqueue(chunk.value);
            }
        },
        cancel(reason) {
            return reader.cancel(reason);
        },
    });
}

async function readBounded(body: ReadableStream<Uint8Array> | null, limit: number) {
    const reader = body?.getReader();
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
            throw new GitProxyError(502, 'github_answer', 'GitHub’s answer was too large.');
        }
        chunks.push(chunk.value);
    }
    return Buffer.concat(chunks);
}

/** Protocol v2 for fetches only, when the client asks; nothing else passes. */
const protocolHeader = (request: Request): Record<string, string> =>
    request.headers.get('git-protocol') === 'version=2' ? { 'Git-Protocol': 'version=2' } : {};

/**
 * One Git request as the proxy handles it: the gateway listener's context
 * with a signal that also aborts when the grant is revoked here, signaled
 * from elsewhere or fails its 5-s re-check, and the end of that tracking,
 * once the request (or the relay it streams) is over.
 */
interface GitRequest extends GatewayRequestContext {
    grantId: string;
    /** Aborted by the grant's revocation or failed re-check only. */
    revoked: AbortSignal;
    /** The presented `cbgw_`, re-resolved before a write token. */
    credential: string | undefined;
    untrack: () => void;
    /** A relay streams on after `handle` returns, and untracks at its end. */
    streaming?: boolean;
}

const UPLOAD_REQUEST_LIMIT = 16 * 1024 * 1024;
const COMMANDS_LIMIT = 1024 * 1024;
const REPORT_LIMIT = 8 * 1024 * 1024;

class GitProxy {
    constructor(
        private sources: GatewaySources,
        private gateway: GitGateway,
    ) {}

    private get context() {
        return this.gateway.context;
    }

    async handle(request: Request, ctx: GatewayRequestContext): Promise<Response> {
        const url = new URL(request.url, 'http://gateway.socio.internal');
        const route = parseGitPath(request.method, url.pathname, url.searchParams);
        const drop = () => request.body?.cancel().catch(() => undefined);
        if (!route) {
            await drop();
            return plain(404, 'Not found.');
        }
        const listed = this.gateway.repos.get(route.repository);
        const repository = listed?.repository ?? route.repository;
        const scope = route.service === 'git-receive-pack' ? 'git:push' : 'git:read';
        const credential = gitCredential(request.headers.get('authorization'));
        const check = await this.sources.actors.check(
            credential,
            {
                kind: 'cbgw',
                audience: 'gateway:git',
                scope,
                resource: { kind: 'repository', id: repository.toLowerCase() },
                correlationId: ctx.correlationId,
            },
            // The stamp's sandbox must be the credential's (CB-239).
            (credential) => credential.contextId === ctx.sandboxId,
        );
        if (!check.ok) {
            await drop();
            return check.status === 401
                ? plain(401, 'Sign in through Socio.', {
                      'WWW-Authenticate': 'Basic realm="Socio"',
                  })
                : plain(403, 'This access was revoked or doesn’t cover this.');
        }
        const audit = (input: Omit<AuditInput, 'correlationId'>) =>
            this.sources.actors.audit.recordSoon({
                correlationId: ctx.correlationId,
                personId: check.grant.personId,
                socioId: check.grant.socioId,
                grantId: check.grant.id,
                audience: 'gateway:git',
                action: scope,
                resourceKind: 'repository',
                resourceId: repository.toLowerCase(),
                ...input,
            });
        if (!this.context.rate.take(ctx.sandboxId, this.gateway.repos.limits().gitRequestsPerMinute)) {
            await drop();
            audit({ phase: 'decision', decision: 'deny', reason: 'rate_limited' });
            return plain(429, 'Too many Git requests; wait a minute.', {
                'Retry-After': '60',
            });
        }
        // Every Git request is held open for its grant, so a revocation (or
        // a failed re-check) aborts what it is doing.
        const revoked = new AbortController();
        const untrack = this.sources.actors.revocations.track(check.grant.id, {
            close: () => revoked.abort(),
        });
        let untracked = false;
        const tracked: GitRequest = {
            ...ctx,
            signal: AbortSignal.any([ctx.signal, revoked.signal]),
            revoked: revoked.signal,
            grantId: check.grant.id,
            credential,
            untrack: () => {
                if (untracked) {
                    return;
                }
                untracked = true;
                untrack();
            },
        };
        try {
            if (route.service === 'git-upload-pack') {
                return route.kind === 'advertise'
                    ? await this.advertiseUpload(request, repository, tracked)
                    : await this.uploadPack(request, repository, tracked);
            }
            const branch = grantBranch(check.grant);
            if (!branch) {
                throw new GitProxyError(403, 'ref_outside_session', 'This session has no branch to push to.');
            }
            if (route.kind === 'advertise') {
                return await this.advertiseReceive(repository, tracked);
            }
            return await this.receivePack(request, repository, branch, tracked, {
                socioId: check.grant.socioId,
                audit,
            });
        } catch (error) {
            await drop();
            if (error instanceof GitProxyError) {
                audit({ phase: 'decision', decision: 'deny', reason: error.reason });
                return plain(error.status, error.message, error.status === 429 ? { 'Retry-After': '60' } : {});
            }
            console.log(`Git proxy: ${route.service} failed: ${error instanceof Error ? error.name : 'error'}`);
            return plain(502, 'The Git proxy failed.');
        } finally {
            if (!tracked.streaming) {
                tracked.untrack();
            }
        }
    }

    /**
     * The push's grant and credential checked afresh, no cache: the reason
     * it may no longer push, or undefined.
     */
    private async pushStillAllowed(repository: string, ctx: GitRequest): Promise<ActorDenyReason | undefined> {
        const { actors } = this.sources;
        const decision = await actors.authorizer.authorize(
            ctx.grantId,
            {
                audience: 'gateway:git',
                scope: 'git:push',
                resource: { kind: 'repository', id: repository.toLowerCase() },
            },
            { fresh: true },
        );
        if (!decision.allowed) {
            return decision.reason;
        }
        const resolved = actors.credentials.resolve(ctx.credential, {
            kind: 'cbgw',
            audience: 'gateway:git',
        });
        if (!resolved.ok) {
            return resolved.reason;
        }
        if (resolved.grant.id !== ctx.grantId || resolved.credential.contextId !== ctx.sandboxId) {
            return 'credential_invalid';
        }
        if (!resolved.credential.scopes.includes('git:push')) {
            return 'scope_insufficient';
        }
        // Closed by a revocation or re-check that a fresh look no longer sees.
        if (ctx.revoked.aborted) {
            return 'grant_revoked';
        }
        return undefined;
    }

    /**
     * GitHub's answer streamed back; the token revoked and the request's
     * tracking ended when it ends, and cut off if the grant is revoked.
     */
    private relay(response: Response, revoke: () => Promise<void>, contentType: string, ctx: GitRequest) {
        if (!response.ok || !response.body) {
            void response.body?.cancel();
            void revoke();
            throw new GitProxyError(
                response.status === 404 ? 404 : 502,
                'github_refused',
                `GitHub refused the request (${response.status}).`,
            );
        }
        const body = ending(
            response.body,
            () => {
                ctx.untrack();
                return revoke();
            },
            ctx.signal,
        );
        ctx.streaming = true;
        return new Response(body, {
            status: 200,
            headers: { 'Content-Type': contentType, 'Cache-Control': 'no-cache' },
        });
    }

    private async advertiseUpload(request: Request, repository: string, ctx: GitRequest) {
        const minted = await this.context.mint(repository, { contents: 'read' }, ctx.signal, ctx.sandboxId);
        let response: Response;
        try {
            response = await minted.repo.smartHttp('/info/refs?service=git-upload-pack', {
                method: 'GET',
                headers: protocolHeader(request),
                signal: ctx.signal,
            });
        } catch (error) {
            await minted.revoke();
            throw new GitProxyError(
                502,
                'github_unreachable',
                error instanceof GitHubError ? error.message : 'GitHub could not be reached.',
            );
        }
        return this.relay(response, minted.revoke, 'application/x-git-upload-pack-advertisement', ctx);
    }

    private async uploadPack(request: Request, repository: string, ctx: GitRequest) {
        if (request.headers.get('content-type') !== 'application/x-git-upload-pack-request') {
            throw new GitProxyError(415, 'request_malformed', 'Not a Git fetch.');
        }
        const encoding = request.headers.get('content-encoding');
        if (encoding && encoding !== 'gzip') {
            throw new GitProxyError(415, 'request_malformed', 'Unsupported encoding.');
        }
        if (!request.body) {
            throw new GitProxyError(400, 'request_malformed', 'Not a Git fetch.');
        }
        const minted = await this.context.mint(repository, { contents: 'read' }, ctx.signal, ctx.sandboxId);
        let response: Response;
        try {
            response = await minted.repo.smartHttp('/git-upload-pack', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-git-upload-pack-request',
                    Accept: 'application/x-git-upload-pack-result',
                    ...(encoding ? { 'Content-Encoding': 'gzip' } : {}),
                    ...protocolHeader(request),
                },
                body: limited(request.body, UPLOAD_REQUEST_LIMIT),
                signal: ctx.signal,
            });
        } catch (error) {
            await minted.revoke();
            throw new GitProxyError(
                502,
                'github_unreachable',
                error instanceof GitHubError ? error.message : 'GitHub could not be reached.',
            );
        }
        return this.relay(response, minted.revoke, 'application/x-git-upload-pack-result', ctx);
    }

    /**
     * The push advertisement, made here from GitHub's refs (read with a
     * read token): no write token exists until a push passed its checks.
     */
    private async advertiseReceive(repository: string, ctx: GitRequest) {
        const minted = await this.context.mint(repository, { contents: 'read' }, ctx.signal, ctx.sandboxId);
        try {
            const response = await minted.repo.smartHttp('/info/refs?service=git-upload-pack', {
                method: 'GET',
                signal: ctx.signal,
            });
            if (!response.ok) {
                throw new GitProxyError(
                    response.status === 404 ? 404 : 502,
                    'github_refused',
                    `GitHub refused the request (${response.status}).`,
                );
            }
            const refs = parseUploadAdvertisement(await readBounded(response.body, 32 * 1024 * 1024));
            return new Response(receiveAdvertisement(refs), {
                status: 200,
                headers: {
                    'Content-Type': 'application/x-git-receive-pack-advertisement',
                    'Cache-Control': 'no-cache',
                },
            });
        } finally {
            await minted.revoke();
        }
    }

    /**
     * A push: its commands checked against the session's branch and
     * the capability list before anything else; the mirror refreshed; the
     * pack streamed to `coding-git` and inspected; only then a write token,
     * the push forwarded with the pack read back from coding-git's spool,
     * and the token revoked. Every push is audited with its ref and ids.
     */
    private async receivePack(
        request: Request,
        repository: string,
        branch: string,
        ctx: GitRequest,
        session: {
            socioId: string;
            audit: (input: Omit<AuditInput, 'correlationId'>) => void;
        },
    ): Promise<Response> {
        if (request.headers.get('content-type') !== 'application/x-git-receive-pack-request' || !request.body) {
            throw new GitProxyError(415, 'request_malformed', 'Not a Git push.');
        }
        const encoding = request.headers.get('content-encoding');
        if (encoding && encoding !== 'gzip') {
            throw new GitProxyError(415, 'request_malformed', 'Unsupported encoding.');
        }
        let body: ReadableStream<Uint8Array> = request.body;
        if (encoding === 'gzip') {
            body = body.pipeThrough(
                new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>,
            );
        }
        body = limited(body, PACK_LIMIT + COMMANDS_LIMIT);
        const reader = new PktReader(body.getReader(), COMMANDS_LIMIT);
        const lines: string[] = [];
        try {
            for (;;) {
                const line = await reader.next();
                if (line === null) {
                    break;
                }
                if (!(line instanceof Buffer) || lines.length >= 64) {
                    throw new PktError('Not a push.');
                }
                lines.push(line.toString('utf8'));
            }
        } catch (error) {
            await reader.cancel();
            if (error instanceof GitProxyError) {
                throw error;
            }
            throw new GitProxyError(400, 'commands_malformed', 'Not a Git push.');
        }
        const check = checkPushCommands(lines, branch);
        const refuse = async (reason: string, message: string, capabilities: string[]) => {
            await reader.cancel();
            session.audit({ phase: 'decision', decision: 'deny', reason });
            // Each ref the client pushed, so `git push` shows the reason on it.
            const pushed = lines
                .map((line) => line.split('\0')[0].trim().split(' ')[2])
                .filter((ref): ref is string => !!ref);
            return new Response(refusalReport(pushed, message, capabilities), {
                status: 200,
                headers: {
                    'Content-Type': 'application/x-git-receive-pack-result',
                    'Cache-Control': 'no-cache',
                },
            });
        };
        const offered = (lines[0] ?? '').split('\0')[1]?.trim().split(' ') ?? [];
        if (!check.ok) {
            return refuse(check.reason, check.detail, offered.includes('report-status') ? offered : []);
        }
        if (!check.capabilities.includes('report-status')) {
            await reader.cancel();
            throw new GitProxyError(400, 'capability_refused', 'Pushes must ask for report-status.');
        }
        const client = this.context.codingGit;
        if (!client) {
            await reader.cancel();
            throw new GitProxyError(
                503,
                'coding_git_unavailable',
                'Pushes need the coding-git service, which isn’t configured.',
            );
        }
        const identity = this.gateway.identity(session.socioId);
        if (!identity) {
            await reader.cancel();
            throw new GitProxyError(403, 'socio_unavailable', 'The socio is gone.');
        }
        // A push whose grant ended while it waited is refused on its ref, as
        // any refusal, and never forwarded.
        const revokedRefusal = async () => {
            if (!ctx.revoked.aborted) {
                return undefined;
            }
            return refuse(
                (await this.pushStillAllowed(repository, ctx)) ?? 'grant_revoked',
                'this access was revoked or no longer covers this push',
                check.capabilities,
            );
        };
        // The mirror first: commits pushed to the base since the last refresh
        // must not look new.
        try {
            await refreshMirror(this.context, repository, [], ctx.signal, ctx.sandboxId);
        } catch (error) {
            const refused = await revokedRefusal();
            if (refused) {
                return refused;
            }
            await reader.cancel();
            throw error;
        }
        let verdict;
        try {
            verdict = await client.inspect(
                { repository, commands: check.commands, identity },
                reader.rest(),
                ctx.signal,
            );
        } catch {
            const refused = await revokedRefusal();
            if (refused) {
                return refused;
            }
            await reader.cancel();
            throw new GitProxyError(503, 'coding_git_unavailable', 'The push could not be inspected.');
        }
        if (!verdict.ok) {
            return refuse(verdict.reason, verdict.detail, check.capabilities);
        }
        // The inspection may have waited behind others; the credential and
        // grant are checked afresh before a write token.
        const denied = await this.pushStillAllowed(repository, ctx);
        if (denied) {
            await client.dropSpool(verdict.spool);
            return refuse(denied, 'this access was revoked or no longer covers this push', check.capabilities);
        }
        const command = check.commands[0];
        let minted;
        try {
            minted = await this.context.mint(repository, { contents: 'write' }, ctx.signal, ctx.sandboxId);
        } catch (error) {
            await client.dropSpool(verdict.spool);
            throw error;
        }
        try {
            const pack = await client.spool(verdict.spool);
            const head = Buffer.concat([...lines.map((line) => pktLine(line)), FLUSH]);
            const forwarded = prefixed(head, pack);
            const response = await minted.repo.smartHttp('/git-receive-pack', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-git-receive-pack-request',
                    Accept: 'application/x-git-receive-pack-result',
                },
                body: forwarded,
                signal: ctx.signal,
            });
            const report = await readBounded(response.body, REPORT_LIMIT);
            const accepted = response.ok && report.includes(Buffer.from(`ok ${command.ref}`));
            session.audit({
                phase: 'outcome',
                decision: accepted ? 'allow' : 'deny',
                ...(accepted ? {} : { reason: 'github_refused' }),
                status: String(response.status),
                detail: `${command.ref} ${command.old}..${command.new}`,
            });
            if (!response.ok) {
                throw new GitProxyError(502, 'github_refused', `GitHub refused the push (${response.status}).`);
            }
            return new Response(report, {
                status: 200,
                headers: {
                    'Content-Type': 'application/x-git-receive-pack-result',
                    'Cache-Control': 'no-cache',
                },
            });
        } finally {
            await minted.revoke();
            await client.dropSpool(verdict.spool);
        }
    }
}

/** The Git routes on the gateway listener (CB-239). */
export function gitRoutes(sources: GatewaySources): GatewayRoute[] {
    const proxy = new GitProxy(sources, gitGatewayOf(sources));
    const handle = (request: Request, ctx: GatewayRequestContext) => proxy.handle(request, ctx);
    return [
        {
            method: 'GET',
            match: (path) => path.startsWith('/git/') && path.endsWith('/info/refs'),
            handle,
        },
        {
            method: 'POST',
            match: (path) =>
                path.startsWith('/git/') && (path.endsWith('/git-upload-pack') || path.endsWith('/git-receive-pack')),
            handle,
        },
    ];
}

/** Admins only, and only while a coding flag is on for them (dark). */
const guard =
    (sources: GatewaySources): MiddlewareHandler<AppEnv> =>
    async (c, next) => {
        const user = c.get('user');
        if (!sources.flags.enabled('coding-sessions', user.id) && !sources.flags.enabled('repo-extraction', user.id)) {
            return c.json({ error: 'This feature isn’t available to you.' }, 404);
        }
        return requireAdmin(c, next);
    };

/**
 * Settings → Coding → Repositories and the Git limits, under
 * `/api/gateway`: list, save, remove, check the App's installation.
 */
export function gitSettingsRoutes(sources: GatewaySources): Hono<AppEnv> | undefined {
    const app = new Hono<AppEnv>();
    const gate = guard(sources);
    for (const path of ['/repositories', '/repositories/*', '/git-limits']) {
        app.use(path, gate);
    }
    const view = (): CodingRepositoriesView => {
        const { repos } = gitGatewayOf(sources);
        return {
            repositories: repos.list(),
            limits: repos.limits(),
            limitDefaults: repos.limitDefaults,
            checklist: PUSH_CHECKLIST,
        };
    };
    const failed = (error: unknown) => {
        if (error instanceof RepositorySettingError) {
            return { status: error.status, error: error.message };
        }
        throw error;
    };
    app.get('/repositories', (c) => c.json(view()));
    app.put('/repositories/:owner/:name', async (c) => {
        const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return c.json({ error: 'Send the repository’s settings as JSON.' }, 400);
        }
        const allowed = [
            'baseBranches',
            'branchPrefix',
            'push',
            'pushChecklistConfirmed',
            'users',
            'extraction',
            'standingExtraction',
        ];
        if (Object.keys(body).some((key) => !allowed.includes(key))) {
            return c.json({ error: 'Unknown setting.' }, 400);
        }
        for (const key of ['push', 'pushChecklistConfirmed', 'extraction', 'standingExtraction']) {
            if (body[key] !== undefined && typeof body[key] !== 'boolean') {
                return c.json({ error: `${key} is true or false.` }, 400);
            }
        }
        if (body.branchPrefix !== undefined && typeof body.branchPrefix !== 'string') {
            return c.json({ error: 'Check the branch prefix.' }, 400);
        }
        try {
            await gitGatewayOf(sources).repos.save(
                `${c.req.param('owner')}/${c.req.param('name')}`,
                body,
                c.get('user').id,
            );
        } catch (error) {
            const { status, error: message } = failed(error)!;
            return c.json({ error: message }, status);
        }
        return c.json(view());
    });
    app.delete('/repositories/:owner/:name', async (c) => {
        try {
            await gitGatewayOf(sources).repos.remove(
                `${c.req.param('owner')}/${c.req.param('name')}`,
                c.get('user').id,
            );
        } catch (error) {
            const { status, error: message } = failed(error)!;
            return c.json({ error: message }, status);
        }
        return c.json(view());
    });
    // Whether the central App is installed on the repository's owner: the
    // App's own JWT only, no installation token is minted.
    app.get('/repositories/:owner/:name/check', async (c) => {
        const repository = `${c.req.param('owner')}/${c.req.param('name')}`;
        if (!gitGatewayOf(sources).repos.get(repository)) {
            return c.json({ error: 'That repository isn’t listed.' }, 404);
        }
        const config = await sources.github.inForce().catch(() => undefined);
        if (!config?.app) {
            return c.json({
                installed: false,
                message: 'GitHub isn’t connected: connect it under Settings → General → GitHub App.',
            });
        }
        try {
            await sources.githubClients.app(config.app, sources.config.githubAccess).ownedInstallation(repository);
            return c.json({
                installed: true,
                message: `The GitHub App is installed on ${repository.split('/')[0]}.`,
            });
        } catch (error) {
            return c.json({
                installed: false,
                message: error instanceof GitHubError ? error.message : 'GitHub could not be asked.',
            });
        }
    });
    app.put('/git-limits', async (c) => {
        const body = (await c.req.json().catch(() => null)) as Record<string, number | null> | null;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return c.json({ error: 'Send the limits as JSON.' }, 400);
        }
        try {
            await gitGatewayOf(sources).repos.saveLimits(body, c.get('user').id);
        } catch (error) {
            const { status, error: message } = failed(error)!;
            return c.json({ error: message }, status);
        }
        return c.json(view());
    });
    return app;
}
