import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { Data } from 'effect';
import { z } from 'zod';

import { transaction } from '@socio/data/open';
import { reportFailure, safeFailure } from '@socio/foundation/observability/failures';
import {
    anyMethod,
    ceilingViolations,
    normalizePolicy,
    policyChanges,
    savedAccessPolicySchema,
    sessionAllowed,
    signInInForce,
    stepUpProofSchema,
    type AccessPolicyAuditEntry,
    type AccessPolicyImpact,
    type AccessPolicySaved,
    type AccessPolicyView,
    type SavedAccessPolicy,
    type SignInCeiling,
    type SignInInForce,
    type StepUpChallenge,
} from '@socio/shared/access-policy';
import { normalizeRole } from '@socio/shared/roles';
import type { User } from '@socio/shared/types';

import { appendPolicyAudit, policyAudit, readStoredPolicy, writeStoredPolicy } from './access-policy-store.js';
import type { AuthProvider, StepUpSession } from './contract.js';

/**
 * The access policy service (CB-124):
 * admins narrow how people sign in, under the environment's ceiling, with a step-up for every change. Each
 * save checks, writes, audits and ends the sessions that no longer qualify
 * in one transaction; then it stops code runs that lost their access and
 * tells every admin.
 */
export interface AccessPolicyDependencies {
    /** The app's connection (the auth tables are in the same database). */
    db: DatabaseSync;
    provider: AuthProvider;
    /** App users, for names. */
    users(): User[];
    /**
     * Running code work by people without the `code:run` permission
     * (CB-376): how many runs that is, and stopping them after a save. None
     * is registered since dispatch was removed (CB-325); the counts are 0.
     */
    codeRuns?: {
        countOutside(mayRunCode: (personId: string) => Promise<boolean>): Promise<number>;
        stopOutside(by: string): Promise<number>;
    };
    notifyAdmins(notice: { trigger: string; title: string; message: string; path: string }): Promise<void>;
    log(line: string): void;
    /**
     * After a saved change: what follows a role it took away (data API
     * tokens of people no longer admins end for good).
     */
    afterSave?(): void;
}

export class AccessPolicyError extends Data.TaggedError('AccessPolicyError')<{
    readonly message: string;
    readonly status: 400 | 401 | 403 | 409 | 429;
    readonly impact?: AccessPolicyImpact;
}> {}

/** Where the page lives: notices link to it. */
export const ACCESS_POLICY_PATH = '/settings/access';

const changeInput = z
    .object({
        policy: savedAccessPolicySchema,
        version: z.number().int().min(0),
    })
    .strict();
const saveInput = changeInput.extend({ stepUp: stepUpProofSchema }).strict();

/** One step-up covers exactly one change: this policy over this version. */
export const changeDigest = (policy: SavedAccessPolicy, version: number) =>
    createHash('sha256')
        .update(JSON.stringify({ policy: normalizePolicy(policy), version }))
        .digest('base64url');

/** A sign-in account as the checks see it. */
export interface PolicyAccount {
    id: string;
    appUserId: string | null;
    name: string;
    email: string;
    role: string | null;
    deactivated: boolean;
    password: boolean;
    passkeys: number;
    providers: string[];
    /** A sign-in link can reach them now (their linked Telegram). */
    linkReachable: boolean;
    /** The workspace owner (CB-390). */
    owner?: boolean;
    /** Confirmed email: an admin email rule counts only then. */
    emailVerified?: boolean;
}

export interface PolicySession {
    id: string;
    accountId: string;
    method: string | null;
    expiresAt: number;
}

/** A way in this account has set up, among the methods in force. */
export const hasWayIn = (account: PolicyAccount, inForce: SignInInForce) =>
    (account.password && inForce.password) ||
    (account.passkeys > 0 && inForce.passkey) ||
    account.providers.some((id) => inForce.providers.includes(id)) ||
    (account.linkReachable && inForce.signInLink) ||
    // Every account has an email: email links reach everyone while on (CB-352).
    inForce.emailLinks;

/** The account could confirm a change (password or passkey, in force). */
export const canStepUp = (account: PolicyAccount, inForce: SignInInForce) =>
    (account.password && inForce.password) || (account.passkeys > 0 && inForce.passkey);

/**
 * What a sign-in change does (pure, for the routes and the tests): whether
 * it locks people out (refusal), which sessions end, who loses their last
 * way in, and whether the admin making it is signed out.
 */
/**
 * An admin of the company's own, for "an admin could still confirm a
 * change" (CB-390): support accounts will never
 * count here; until they exist, every admin does.
 */
const companyAdmin = (account: PolicyAccount, inForce: SignInInForce) =>
    normalizeRole(account.role) === 'admin' ||
    (!!account.emailVerified && inForce.adminEmails.includes(account.email.trim().toLowerCase()));

export function assessSignIn(input: {
    before: SignInInForce;
    after: SignInInForce;
    /** What is saved after the change: it decides which sessions go on. */
    saved: SavedAccessPolicy;
    accounts: PolicyAccount[];
    sessions: PolicySession[];
    actor: StepUpSession | null;
    now?: number;
}): {
    refusal: string | null;
    revoke: string[];
    withoutWayIn: PolicyAccount[];
    signsYouOut: boolean;
} {
    const { before, after, accounts, actor } = input;
    const now = input.now ?? Date.now();
    const active = accounts.filter((account) => !account.deactivated);
    const me = actor ? active.find((account) => account.id === actor.accountId) : undefined;
    let refusal: string | null = null;
    if (!anyMethod(after)) {
        refusal = 'Keep at least one way to sign in on.';
    } else if (me && !hasWayIn(me, after)) {
        refusal =
            'This would leave you without a way to sign in. Keep on a method you have set up, or add one first (Settings → Profile).';
    } else if (!active.some((account) => companyAdmin(account, after) && canStepUp(account, after))) {
        refusal =
            'After this, no admin could confirm a change: keep passwords or passkeys on for an admin who has one.';
    } else if (active.some((account) => account.owner && account.id !== me?.id && !hasWayIn(account, after))) {
        // CB-390: another admin can't take the workspace owner's way in.
        refusal =
            'This would leave the workspace owner without a way to sign in. Keep on a method they have set up, or ask them to add one first.';
    }
    // Only those this change takes the way in from: an invite not yet
    // accepted had none before, and loses nothing.
    const withoutWayIn = active.filter((account) => hasWayIn(account, before) && !hasWayIn(account, after));
    const stranded = new Set(withoutWayIn.map((account) => account.id));
    const revoke = input.sessions
        .filter(
            (session) =>
                session.expiresAt > now &&
                (!sessionAllowed(session.method, input.saved) || stranded.has(session.accountId)),
        )
        .map((session) => session.id);
    return {
        refusal,
        revoke,
        withoutWayIn,
        signsYouOut: !!actor && revoke.includes(actor.sessionId),
    };
}

/** A stored date (Better Auth writes ISO strings; numbers are ms). */
const timeOf = (value: unknown) =>
    typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? /^\d+$/.test(value)
              ? Number(value)
              : Date.parse(value)
          : 0;

export class AccessPolicyService {
    constructor(private deps: AccessPolicyDependencies) {}

    private get db() {
        return this.deps.db;
    }

    /** The environment's values: what nothing in the app can go beyond. */
    ceiling(): { signIn: SignInCeiling | null } {
        return { signIn: this.deps.provider.signInCeiling?.() ?? null };
    }

    private inForce(saved: SavedAccessPolicy) {
        const { signIn } = this.ceiling();
        return { signIn: signIn ? signInInForce(signIn, saved) : null };
    }

    private name(id: string) {
        if (id === 'cli') {
            return 'the server command line';
        }
        return this.deps.users().find((user) => user.id === id)?.name ?? id;
    }

    view(): AccessPolicyView {
        const stored = readStoredPolicy(this.db);
        const ceiling = this.ceiling();
        const inForce = this.inForce(stored.saved);
        return {
            version: stored.version,
            updatedAt: stored.updatedAt,
            updatedBy: stored.updatedBy,
            unreadable: stored.unreadable,
            saved: stored.saved,
            signIn: ceiling.signIn ? { ceiling: ceiling.signIn, inForce: inForce.signIn! } : null,
            audit: policyAudit(this.db).map((row): AccessPolicyAuditEntry => ({
                ...row,
                actorName: this.name(row.actor),
            })),
        };
    }

    /** The body of a preview, step-up or save, checked against the ceiling. */
    private parse<T extends typeof changeInput | typeof saveInput>(schema: T, body: unknown): z.infer<T> {
        const parsed = schema.safeParse(body);
        if (!parsed.success) {
            throw new AccessPolicyError({ message: 'That is not an access policy change.', status: 400 });
        }
        const policy = normalizePolicy(parsed.data.policy);
        const problems = ceilingViolations(policy, this.ceiling());
        if (problems.length) {
            throw new AccessPolicyError({ message: problems.join(' '), status: 400 });
        }
        return { ...parsed.data, policy } as z.infer<T>;
    }

    /** The sign-in accounts and sessions, as they are now (sync: in a transaction). */
    private snapshot(reachable: ReadonlySet<string>) {
        const accounts = (
            this.db
                .prepare(
                    `SELECT u.id, u.appUserId, u.name, u.email, u.emailVerified, u.role, coalesce(u.banned, 0) AS banned,
            EXISTS(SELECT 1 FROM auth_account a WHERE a.userId=u.id AND a.providerId='credential' AND a.password IS NOT NULL) AS password,
            (SELECT COUNT(*) FROM auth_passkey p WHERE p.userId=u.id) AS passkeys,
            (SELECT group_concat(a.providerId) FROM auth_account a WHERE a.userId=u.id AND a.providerId<>'credential') AS providers
            , u.id = (SELECT accountId FROM auth_workspace_owner WHERE id = 1) AS owner
          FROM auth_user u`,
                )
                .all() as {
                id: string;
                appUserId: string | null;
                name: string;
                email: string;
                emailVerified: number | null;
                role: string | null;
                banned: number;
                password: number;
                passkeys: number;
                providers: string | null;
                owner: number | null;
            }[]
        ).map((row): PolicyAccount => ({
            id: row.id,
            appUserId: row.appUserId,
            name: row.name,
            email: row.email,
            role: row.role,
            deactivated: !!row.banned,
            password: !!row.password,
            passkeys: Number(row.passkeys),
            providers: row.providers ? row.providers.split(',') : [],
            linkReachable: !!row.appUserId && reachable.has(row.appUserId),
            owner: !!row.owner,
            emailVerified: !!row.emailVerified,
        }));
        const sessions = (
            this.db.prepare('SELECT id, userId, signInMethod, expiresAt FROM auth_session').all() as {
                id: string;
                userId: string;
                signInMethod: string | null;
                expiresAt: unknown;
            }[]
        ).map((row): PolicySession => ({
            id: row.id,
            accountId: row.userId,
            method: row.signInMethod,
            expiresAt: timeOf(row.expiresAt),
        }));
        return { accounts, sessions };
    }

    /** App users a sign-in link can reach now (async, so before a transaction). */
    private async reachable() {
        if (!this.deps.provider.signInCeiling || !this.deps.provider.linkReachable) {
            return new Set<string>();
        }
        const ids = (
            this.db
                .prepare('SELECT appUserId FROM auth_user WHERE appUserId IS NOT NULL AND NOT coalesce(banned, 0)')
                .all() as { appUserId: string }[]
        ).map((row) => row.appUserId);
        return this.deps.provider.linkReachable(ids);
    }

    /**
     * Everything a change would do, against the stored policy (sync: inside
     * the save's transaction, or on its own for a preview).
     */
    private assess(
        policy: SavedAccessPolicy,
        version: number,
        actor: StepUpSession | null,
        reachable: ReadonlySet<string>,
        codeRuns: number,
    ) {
        const stored = readStoredPolicy(this.db);
        const before = this.inForce(stored.saved);
        const after = this.inForce(policy);
        const changes = policyChanges(before, after);
        const counted = policyChanges(before, after, { counts: true });
        let refusal: string | null = null;
        let signIn: ReturnType<typeof assessSignIn> | undefined;
        if (before.signIn && after.signIn) {
            const { accounts, sessions } = this.snapshot(reachable);
            signIn = assessSignIn({
                before: before.signIn,
                after: after.signIn,
                saved: normalizePolicy(policy),
                accounts,
                sessions,
                actor,
            });
            refusal = signIn.refusal;
        }
        if (stored.version !== version) {
            refusal = 'Someone saved a change since you opened this page. Reload it, then try again.';
        } else if (!stored.unreadable && JSON.stringify(stored.saved) === JSON.stringify(normalizePolicy(policy))) {
            refusal = 'Nothing to save: this is the policy in force.';
        }
        const impact: AccessPolicyImpact = {
            changes,
            refusal,
            sessionsEnded: signIn?.revoke.length ?? 0,
            withoutWayIn: (signIn?.withoutWayIn ?? []).map(({ name, email }) => ({
                name,
                email,
            })),
            signsYouOut: signIn?.signsYouOut ?? false,
            codeRunsStopped: codeRuns,
        };
        return { stored, impact, revoke: signIn?.revoke ?? [], counted };
    }

    /** Runs by people without the `code:run` permission now (CB-376): what a save stops. */
    private async codeRunsOutside() {
        if (!this.deps.codeRuns) {
            return 0;
        }
        const { provider } = this.deps;
        return this.deps.codeRuns.countOutside(async (personId) => (await provider.mayRunCode?.(personId)) ?? false);
    }

    /** `POST /api/access-policy/preview`: what saving would do; changes nothing. */
    async preview(request: Request, body: unknown): Promise<AccessPolicyImpact> {
        const { policy, version } = this.parse(changeInput, body);
        const actor = (await this.deps.provider.sessionOf?.(request)) ?? null;
        const reachable = await this.reachable();
        const codeRuns = await this.codeRunsOutside();
        return this.assess(policy, version, actor, reachable, codeRuns).impact;
    }

    /**
     * `POST /api/access-policy/step-up`: a one-time challenge for exactly
     * this change, in this session. Refused when the change itself is.
     */
    async stepUp(user: User, request: Request, body: unknown): Promise<StepUpChallenge> {
        const { policy, version } = this.parse(changeInput, body);
        const verifier = this.deps.provider.stepUp;
        if (!verifier) {
            throw new AccessPolicyError({ message: 'This server has no way to confirm a change.', status: 403 });
        }
        const challenge = await verifier.begin(request, user, changeDigest(policy, version));
        if (!challenge) {
            throw new AccessPolicyError({
                message: 'Confirming a change needs your own signed-in session.',
                status: 401,
            });
        }
        return challenge;
    }

    /**
     * `PUT /api/access-policy`: the step-up proof first (its challenge is
     * used up whatever happens), then the checks, the write, the audit and
     * the session ends in one transaction; then code runs stop and every
     * admin hears of it.
     */
    async save(user: User, request: Request, body: unknown): Promise<AccessPolicySaved> {
        const { policy, version, stepUp } = this.parse(saveInput, body);
        const verifier = this.deps.provider.stepUp;
        if (!verifier) {
            throw new AccessPolicyError({ message: 'This server has no way to confirm a change.', status: 403 });
        }
        const proof = await verifier.finish(request, user, changeDigest(policy, version), stepUp);
        if (!proof.ok) {
            if (proof.counted) {
                await this.failedStepUp(user, proof.locked);
            }
            throw new AccessPolicyError({ message: proof.error, status: proof.status });
        }
        const reachable = await this.reachable();
        const codeRuns = await this.codeRunsOutside();
        const outcome = await transaction(this.db, 'access policy', () => {
            const { stored, impact, revoke, counted } = this.assess(
                policy,
                version,
                proof.session,
                reachable,
                codeRuns,
            );
            if (impact.refusal) {
                return { impact, counted, saved: false as const };
            }
            if (writeStoredPolicy(this.db, version, policy, user.id) === null) {
                return {
                    impact: {
                        ...impact,
                        refusal: 'Someone saved a change since you opened this page. Reload it, then try again.',
                    },
                    counted,
                    saved: false as const,
                };
            }
            const end = this.db.prepare('DELETE FROM auth_session WHERE id = ?');
            for (const id of revoke) {
                end.run(id);
            }
            appendPolicyAudit(this.db, {
                actor: user.id,
                action: 'change',
                stepUp: proof.method,
                detail: impact.changes.join('; ') || 'No change in force.',
                before: stored.saved,
                after: policy,
                sessionsEnded: revoke.length,
                codeRunsStopped: impact.codeRunsStopped,
            });
            // The devices whose sessions just ended keep no push subscription
            // (CB-352): after this transaction, in the background.
            if (revoke.length) {
                void this.deps.provider.sweepDevicePush?.().catch((error) => {
                    reportFailure('Push subscription cleanup failed', [safeFailure(error)]);
                });
            }
            return { impact, counted, saved: true as const };
        });
        const { impact } = outcome;
        if (!outcome.saved) {
            throw new AccessPolicyError({
                message: impact.refusal!,
                status: impact.refusal!.startsWith('Someone saved') ? 409 : 400,
                impact,
            });
        }
        try {
            this.deps.afterSave?.();
        } catch (error) {
            reportFailure('Access policy follow-up failed', [safeFailure(error)]);
        }
        if (this.deps.codeRuns) {
            await this.deps.codeRuns
                .stopOutside(user.id)
                .catch((error: unknown) =>
                    this.deps.log(
                        `Access policy: stopping code runs failed: ${error instanceof Error ? error.message : 'unknown'}`,
                    ),
                );
        }
        // Counts, not emails or ids: notices may travel by Telegram or push.
        const summary = outcome.counted.join('; ') || 'no change in force';
        this.deps.log(
            `Access policy: changed by user=${user.id} (step-up ${proof.method}): ${summary}; ${impact.sessionsEnded} session(s) ended, ${impact.codeRunsStopped} code run(s) stopped.`,
        );
        await this.deps
            .notifyAdmins({
                trigger: 'access_policy',
                title: 'Access policy changed',
                message: `${user.name} changed sign-in: ${summary}.${impact.sessionsEnded ? ` ${impact.sessionsEnded} session(s) ended.` : ''}${impact.codeRunsStopped ? ` ${impact.codeRunsStopped} code run(s) stopped.` : ''}`,
                path: ACCESS_POLICY_PATH,
            })
            .catch(() => undefined);
        return { view: this.view(), impact };
    }

    /** A wrong password or passkey: audited; the one that locks tells every admin. */
    private async failedStepUp(user: User, locked: boolean) {
        await transaction(this.db, 'access policy step-up', () =>
            appendPolicyAudit(this.db, {
                actor: user.id,
                action: locked ? 'step_up_locked' : 'step_up_failed',
                detail: locked
                    ? 'Too many failed confirmations: step-up is locked for 15 minutes.'
                    : 'A confirmation failed (wrong password or passkey).',
            }),
        );
        if (!locked) {
            return;
        }
        this.deps.log(`Access policy: step-up locked for user=${user.id} after repeated failures.`);
        await this.deps
            .notifyAdmins({
                trigger: 'access_policy',
                title: 'Access policy: confirmations failing',
                message: `Changes to sign-in were confirmed wrongly several times in a row as ${user.name}. Confirming is locked for 15 minutes. If that wasn't them, sign them out everywhere (People).`,
                path: ACCESS_POLICY_PATH,
            })
            .catch(() => undefined);
    }
}
