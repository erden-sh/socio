import { transaction } from '@socio/data/open';
import { CODING_BRANCH_PREFIX, type CodingRepositoryView } from '@socio/shared/coding/coding-repos';

import type { GrantRecord } from '../actors/contract.js';
import { GitProxyError } from '../coding/contract.js';
import {
    GitHubError,
    type GitHubAppConfig,
    type GitHubClientsShape,
    type GitHubOptions,
    type GitHubRepositoryShape,
    type InstallationPermissions,
} from '../github/contract.js';

import type { CodingGitClient } from './coding-git-client.js';
import type { GitRepositories } from './repos.js';

/**
 * What the Git proxy, the extraction and the pull requests share
 * (CB-239): the repository settings, the coding-git client, and minting of
 * per-request installation tokens under the instance ceiling. Tokens live
 * in this process only, in an Authorization header, and are revoked when
 * the request ends.
 */

export interface MintedToken {
    repo: GitHubRepositoryShape;
    /** Ends the token; safe to call more than once. */
    revoke: () => Promise<void>;
}

export interface GitContextOptions {
    repos: GitRepositories;
    /** The central App and its settings (CB-32), read per use. */
    github: () => Promise<GitHubAppConfig>;
    /** How an App and a repository are reached (`GitHubClients`). */
    clients: GitHubClientsShape;
    githubOptions?: GitHubOptions;
    now?: () => number;
}

const INSTALLATION_CACHE_MS = 10 * 60_000;
const HOUR = 3_600_000;

/** Requests per session in the last minute, in this runtime only. */
export class SessionRate {
    private hits = new Map<string, number[]>();
    constructor(private now: () => number = Date.now) {}
    take(key: string, perMinute: number) {
        const now = this.now();
        const recent = (this.hits.get(key) ?? []).filter((at) => now - at < 60_000);
        if (recent.length >= perMinute) {
            this.hits.set(key, recent);
            return false;
        }
        recent.push(now);
        this.hits.set(key, recent);
        if (this.hits.size > 10_000) {
            for (const [entry, times] of this.hits) {
                if (!times.some((at) => now - at < 60_000)) {
                    this.hits.delete(entry);
                }
            }
        }
        return true;
    }
}

/**
 * Installation tokens minted per session in the current hour, in this
 * runtime: so one session can't spend the instance's hourly ceiling.
 * Taken in the same transaction as the ceiling's count.
 */
export class SessionMints {
    private counts = new Map<string, { hour: number; count: number }>();
    /** Whether `session` may mint another in `hour`. */
    available(session: string, hour: number, cap: number) {
        const entry = this.counts.get(session);
        return !entry || entry.hour !== hour || entry.count < cap;
    }
    add(session: string, hour: number) {
        const entry = this.counts.get(session);
        if (entry && entry.hour === hour) {
            entry.count += 1;
        } else {
            this.counts.set(session, { hour, count: 1 });
        }
        if (this.counts.size > 10_000) {
            for (const [key, value] of this.counts) {
                if (value.hour !== hour) {
                    this.counts.delete(key);
                }
            }
        }
    }
}

export class GitContext {
    /** coding-git; unset, pushes and extractions are refused (fail closed). */
    codingGit?: CodingGitClient;
    readonly rate: SessionRate;
    readonly sessionMints = new SessionMints();
    /** A cache only: an installation id per App and repository. */
    private installations = new Map<string, { id: string; at: number }>();
    private now: () => number;
    constructor(private options: GitContextOptions) {
        this.now = options.now ?? Date.now;
        this.rate = new SessionRate(this.now);
    }

    get repos() {
        return this.options.repos;
    }
    get githubOptions() {
        return this.options.githubOptions ?? {};
    }

    /**
     * One installation token for one repository with exactly `permissions`
     * (never `workflows`), counted against the instance's hourly ceiling
     * first, in a transaction, so both runtimes of a deploy share it; and,
     * for a `session` (its sandbox), against that session's own hourly cap.
     */
    async mint(
        repository: string,
        permissions: InstallationPermissions,
        signal?: AbortSignal,
        session?: string,
    ): Promise<MintedToken> {
        const db = this.options.repos.mints;
        const limits = this.options.repos.limits();
        const hour = Math.floor(this.now() / HOUR);
        const counted = await transaction(this.options.repos.database, 'count installation token', () => {
            // The session's cap first, so a session at its cap doesn't spend
            // the instance's ceiling either.
            if (session && !this.sessionMints.available(session, hour, limits.tokensPerSessionHour)) {
                return 'session';
            }
            if (!db.take(hour, limits.tokensPerHour)) {
                return 'instance';
            }
            if (session) {
                this.sessionMints.add(session, hour);
            }
            return 'counted';
        });
        if (counted === 'session') {
            throw new GitProxyError(
                429,
                'token_ceiling',
                'This session has used its hourly allowance of GitHub tokens; try again later.',
            );
        }
        if (counted !== 'counted') {
            throw new GitProxyError(
                429,
                'token_ceiling',
                'Socio has used its hourly allowance of GitHub tokens; try again later.',
            );
        }
        const config = await this.options.github();
        if (!config.app) {
            throw new GitProxyError(503, 'github_unavailable', 'GitHub is not connected in Settings.');
        }
        const options = { ...this.githubOptions, signal };
        const app = this.options.clients.app(config.app, options);
        const cacheKey = `${config.app.id}|${repository.toLowerCase()}`;
        let installationId = this.installations.get(cacheKey);
        if (!installationId || this.now() - installationId.at > INSTALLATION_CACHE_MS) {
            try {
                installationId = {
                    id: await app.ownedInstallation(repository),
                    at: this.now(),
                };
            } catch (error) {
                throw new GitProxyError(
                    502,
                    'installation_refused',
                    error instanceof GitHubError ? error.message : 'GitHub could not be asked for a token.',
                );
            }
            this.installations.set(cacheKey, installationId);
        }
        let minted: { token: string; revoke: () => Promise<void> };
        try {
            minted = await app.installationToken(installationId.id, repository, permissions);
        } catch (error) {
            this.installations.delete(cacheKey);
            throw new GitProxyError(
                502,
                'token_refused',
                error instanceof GitHubError ? error.message : 'GitHub could not be asked for a token.',
            );
        }
        let revoked: Promise<void> | undefined;
        return {
            repo: this.options.clients.repository({
                ...this.githubOptions,
                repository,
                token: minted.token,
            }),
            revoke: () => (revoked ??= minted.revoke().catch(() => undefined)),
        };
    }
}

/** The repository a coding or extraction grant is for (CB-239). */
export function grantRepository(grant: Pick<GrantRecord, 'resources'>) {
    const value = grant.resources?.repository;
    return typeof value === 'string' ? value : undefined;
}

/** A coding session's branch, as the session records it on the grant. */
export function grantBranch(grant: Pick<GrantRecord, 'resources'>) {
    const value = grant.resources?.branch;
    return typeof value === 'string' && value ? value : undefined;
}

/**
 * Whether a grant's branch is a session branch of this repository:
 * exactly `<branchPrefix>/<socio slug>/<short id>`, as coding sessions
 * make it, and never one of the repository's base branches, so a grant
 * recording `main` or a name off the prefix can't push or open pull
 * requests there.
 */
export function sessionBranchAllowed(
    repository: Pick<CodingRepositoryView, 'branchPrefix' | 'baseBranches'>,
    branch: string | undefined,
) {
    if (!branch || !CODING_BRANCH_PREFIX.test(repository.branchPrefix)) {
        return false;
    }
    const shape = new RegExp(`^${repository.branchPrefix}/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?/[a-z0-9]{6,16}$`);
    const bases = repository.baseBranches.length ? repository.baseBranches : ['main'];
    return shape.test(branch) && !bases.includes(branch);
}

/** A coding session's base branch (draft PRs go only into it). */
export function grantBase(grant: Pick<GrantRecord, 'resources'>) {
    const value = grant.resources?.base;
    return typeof value === 'string' && value ? value : undefined;
}

/** A standing extraction grant (CB-267): resources carry `standing`. */
export const isStandingGrant = (grant: Pick<GrantRecord, 'resources' | 'scopes'>) =>
    grant.resources?.standing === true && grant.scopes.includes('git:extract');
