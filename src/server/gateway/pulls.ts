import { randomUUID } from 'node:crypto';

import { fenced, inert } from '@socio/shared/text/untrusted-text';

import { GitProxyError, type SessionPullRequest, type SessionPullRequestInput } from '../coding/contract.js';
import { GitHubError } from '../github/contract.js';

import { gatewaySourcesOf, type GatewayHolder } from './adopted.js';
import { grantBase, grantBranch, grantRepository } from './git-context.js';
import { gitGatewayOf } from './git.js';
import type { GatewaySources } from './sources.js';

/**
 * Draft pull requests from a coding session (CB-239): only from the
 * session's branch into its base, opened server-side by the socio's tool
 * (the `coding_open_pr` tool calls this), never from the sandbox:
 * the gateway has no pull request endpoint. Title and body are made inert
 * (no mentions, closing keywords or emails), the agent's text is a fenced block, and the body
 * links the Socio session, never the person. Never a ready PR: where
 * GitHub has no drafts it fails. Needs `git:pr`.
 */

const SUMMARY_LIMIT = 30_000;

/** `openPullRequest` with the gateways of `holder`'s runtime (`adopted.ts`), for tests. */
export async function openSessionPullRequest(
    holder: GatewayHolder,
    input: SessionPullRequestInput,
): Promise<SessionPullRequest> {
    return openPullRequest(gatewaySourcesOf(holder), input);
}

export async function openPullRequest(
    sources: GatewaySources,
    input: SessionPullRequestInput,
): Promise<SessionPullRequest> {
    const gateway = gitGatewayOf(sources);
    const grant = sources.actors.grants.get(input.grantId);
    const repository = grant && grantRepository(grant);
    const branch = grant && grantBranch(grant);
    const base = grant && grantBase(grant);
    if (
        !grant ||
        grant.personId !== input.personId ||
        grant.socioId !== input.socioId ||
        !repository ||
        !branch ||
        !base
    ) {
        throw new GitProxyError(403, 'grant_missing', 'This session can’t open pull requests.');
    }
    const correlationId = `pr-${randomUUID()}`;
    const audit = (decision: 'allow' | 'deny', extra: Record<string, string>) =>
        sources.actors.audit.recordSoon({
            correlationId,
            phase: decision === 'allow' ? 'outcome' : 'decision',
            decision,
            personId: grant.personId,
            socioId: grant.socioId,
            grantId: grant.id,
            audience: 'gateway:git',
            action: 'git:pr',
            resourceKind: 'repository',
            resourceId: repository.toLowerCase(),
            ...extra,
        });
    const decision = await sources.actors.authorizer.authorize(
        grant.id,
        {
            audience: 'gateway:git',
            scope: 'git:pr',
            resource: { kind: 'repository', id: repository.toLowerCase() },
        },
        { fresh: true },
    );
    if (!decision.allowed) {
        audit('deny', { reason: decision.reason });
        throw new GitProxyError(403, decision.reason, 'This access was revoked or doesn’t allow pull requests.');
    }
    const listed = gateway.repos.get(repository);
    const bases = listed?.baseBranches.length ? listed.baseBranches : ['main'];
    if (!listed || !bases.includes(base) || branch === base) {
        audit('deny', { reason: 'ref_outside_session' });
        throw new GitProxyError(
            403,
            'ref_outside_session',
            'Pull requests go only from the session branch into its base.',
        );
    }
    const summary = inert(input.summary.trim()).slice(0, SUMMARY_LIMIT);
    const title = inert(input.title.trim()).slice(0, 256) || `Socio session ${branch}`;
    const link = input.sessionLink && /^https:\/\/\S+$/.test(input.sessionLink) ? input.sessionLink : undefined;
    const body = [
        link ? `From a Socio coding session: ${link}` : 'From a Socio coding session.',
        '## Summary',
        '_The coding agent’s own account, unverified, as plain text._',
        summary ? fenced(summary) : '_The agent gave no summary._',
        '---',
        '_A draft: review it before merging; nothing is merged automatically._',
    ].join('\n\n');
    const minted = await gateway.context.mint(repository, { contents: 'read', pull_requests: 'write' }, input.signal);
    try {
        const pull = await minted.repo.draftPullRequest({
            head: branch,
            base,
            title,
            body,
            draftOnly: true,
        });
        audit('allow', { status: String(pull.number) });
        return pull;
    } catch (error) {
        audit('deny', { reason: 'github_refused' });
        throw new GitProxyError(
            502,
            'github_refused',
            error instanceof GitHubError ? error.message : 'GitHub refused the pull request.',
        );
    } finally {
        await minted.revoke();
    }
}
