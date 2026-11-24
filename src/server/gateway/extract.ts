import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

import { transaction } from '@socio/data/open';
import { deriveKey, sha256Hex } from '@socio/foundation/actors/keys';
import type { DotTurn } from '@socio/foundation/turns/turn';
import { ACTOR_DENY_REASONS, type ActorDenyReason, type Audience } from '@socio/shared/actor-scopes';
import { cardLabel, cardTask } from '@socio/shared/actors/card-text';
import { canonicalJson } from '@socio/shared/jcs';
import { inertText } from '@socio/shared/text/inert-text';

import { MAX_SCOPE_PATHS, scopePathProblem, scopeWithin } from '../../coding-git/rules.js';
import { STANDING_EXTRACTION_MAX_MINUTES, type GrantRecord } from '../actors/contract.js';
import type { ApprovalDecisionEvent, ApprovalRecord } from '../approvals/contract.js';
import type { AppRecord, ExtractionAwarePolicy, ExtractionDelivery } from '../apps/contract.js';
import { GitProxyError } from '../coding/contract.js';

import { isStandingGrant } from './git-context.js';
import type { GitGateway } from './git.js';
import { ExtractionRows, appSessionByHash, type ExtractionRecord } from './infra/git-rows.js';
import { refreshMirror } from './mirror.js';
import type { GatewaySources } from './sources.js';

/**
 * Approval-gated extraction for workspace apps (CB-267, CB-239). A
 * socio asks to give one app a read-only copy of part of a listed
 * repository at one commit. The person approves each extraction
 * (`repo_extract`, manual only), unless they made a separate standing
 * grant (`repo_extract_standing`, manual only, at most 7 days, one
 * repository, path scope and app). Socio resolves the ref to a commit
 * before the card, fetches through the Git proxy's code with a
 * `contents: read` token (revoked after), has `coding-git` read the files
 * (hostile input stays out of the app process), and keeps the result as a
 * sealed file in the person's data space that only the named app can
 * read, once (with retries for 10 minutes), through the person's `cbob_`.
 * Every step is audited, with counts only.
 */

export const REPO_EXTRACT_CAPABILITY = 'repo_extract';
export const REPO_EXTRACT_STANDING_CAPABILITY = 'repo_extract_standing';
/** A card waits this long: 15 minutes (CB-232). */
export const EXTRACT_APPROVAL_MS = 15 * 60_000;
/** Reads after the first are allowed this long (retries), then refused. */
export const EXTRACT_READ_WINDOW_MS = 10 * 60_000;
export const STANDING_MAX_DAYS = STANDING_EXTRACTION_MAX_MINUTES / 1440;
/** What the socio is told when coding-git refuses an extraction. */
const EXTRACT_FAILURES = new Map<string, string>([
    ['commit_missing', 'The extraction failed: the commit isn’t in the mirror. Ask again in a moment.'],
    ['paths_invalid', 'The extraction failed: coding-git refused the paths. Check them and ask again.'],
    ['too_large', 'The paths hold more than the extraction limit.'],
]);
const MB = 1024 * 1024;
const HOUR = 3_600_000;
const SWEEP_MS = 15 * 60_000;
/** How long a running extraction has before the sweep may end it. */
const RUN_MS = 60 * 60_000;
const SHA = /^[0-9a-f]{40}$/;
const REF = /^(?!.*\.\.)(?!\/)[A-Za-z0-9._/-]{1,200}$/;
const FOLDER = 'socio-extractions';

export interface ExtractPayload {
    extraction: string;
    repository: string;
    commit: string;
    paths: string[];
    app: string;
}

export interface StandingPayload {
    repository: string;
    paths: string[];
    app: string;
    days: number;
    conversationId: string;
    conversationKind: 'private' | 'room';
    task: string;
}

export interface ExtractInput {
    repository: string;
    ref: string;
    paths: string[];
    app: string;
    task: string;
    /** Ask for standing access instead (1–7 days), a separate card. */
    standing_days?: number;
}

class ExtractionRefused extends Error {
    constructor(
        readonly reason: string,
        message: string,
    ) {
        super(message);
    }
}

/**
 * A path on a card or in a refusal: one inert line (CB-232). Names
 * (the app, its owner, the socio, the room) go through `cardLabel`, the
 * socio's words through `cardTask`.
 */
const inertPath = (path: string, max = 200) => inertText(path, { max, lines: false });

/**
 * Why an extraction failed, as `actor_audit.reason` (a closed list, the
 * table's CHECK): anything else, such as an unexpected code from
 * coding-git, is recorded as `coding_git_unavailable`.
 */
const failureReason = (reason: string): ActorDenyReason =>
    (ACTOR_DENY_REASONS as readonly string[]).includes(reason) ? (reason as ActorDenyReason) : 'coding_git_unavailable';

export class Extractions {
    private rows: ExtractionRows;
    constructor(
        private sources: GatewaySources,
        private gateway: GitGateway,
    ) {
        this.rows = new ExtractionRows(sources.workspace.db);
        // Each extraction is its own approval: manual only, never auto or
        // bypass.
        sources.approvals.register<ExtractPayload>({
            capability: REPO_EXTRACT_CAPABILITY,
            label: 'Repository extraction for apps',
            description:
                'Give a workspace app a read-only copy of part of a listed repository, at one commit. Every extraction needs your decision.',
            manualOnly: true,
            auto: { allowed: false },
            // A card waits 15 minutes, not the service's 7 days; `execute`
            // checks the age again.
            ttlMs: EXTRACT_APPROVAL_MS,
            // The decision's own row, in the deciding unit.
            onDecision: (request, event) => this.auditDecision(request, event, `extract-${request.payload.extraction}`),
            execute: (record) => this.execute(record),
        });
        sources.approvals.register<StandingPayload>({
            capability: REPO_EXTRACT_STANDING_CAPABILITY,
            label: 'Standing repository extraction',
            description:
                'Let a socio give one app copies of one repository’s paths, at any commit, for up to 7 days without asking each time. Every extraction is still recorded.',
            manualOnly: true,
            auto: { allowed: false },
            // A 7-day-old card must not still make a 7-day grant.
            ttlMs: EXTRACT_APPROVAL_MS,
            onDecision: (request, event) => this.auditDecision(request, event, `standing-${request.id}`),
            execute: (record) => this.approveStanding(record),
        });
        // Expired extractions' files go; every runtime may (idempotent). A
        // weak reference: a stopped platform's timer ends itself.
        const ref = new WeakRef(this);
        const timer = setInterval(() => {
            const self = ref.deref();
            if (!self || !self.sources.workspace.db.isOpen) {
                return clearInterval(timer);
            }
            void self.prune().catch(() => undefined);
        }, SWEEP_MS);
        timer.unref();
    }

    get(id: string) {
        return this.rows.get(id);
    }

    private get db() {
        return this.sources.workspace.db;
    }

    private sealKey(id: string) {
        return deriveKey(this.sources.config.sessionSecret || 'socio-loopback-extraction', 'repo-extraction-seal', id);
    }

    private aad(row: Pick<ExtractionRecord, 'id' | 'personId' | 'appId'>) {
        return Buffer.from(`cbx1\u0000${row.id}\u0000${row.personId}\u0000${row.appId}`);
    }

    /** Sealed for this extraction, its person and its app only. */
    seal(row: Pick<ExtractionRecord, 'id' | 'personId' | 'appId'>, data: Buffer) {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.sealKey(row.id), iv);
        cipher.setAAD(this.aad(row));
        const body = Buffer.concat([cipher.update(data), cipher.final()]);
        return Buffer.concat([Buffer.from('CBX1'), iv, cipher.getAuthTag(), body]);
    }

    open(row: Pick<ExtractionRecord, 'id' | 'personId' | 'appId'>, sealed: Buffer) {
        if (sealed.toString('ascii', 0, 4) !== 'CBX1') {
            throw new Error('Not a sealed extraction.');
        }
        const decipher = createDecipheriv('aes-256-gcm', this.sealKey(row.id), sealed.subarray(4, 16));
        decipher.setAAD(this.aad(row));
        decipher.setAuthTag(sealed.subarray(16, 32));
        return Buffer.concat([decipher.update(sealed.subarray(32)), decipher.final()]);
    }

    /** Where the turn's conversation stands: private, room, or refused. */
    private conversation(turn: DotTurn): 'private' | 'room' {
        if (turn.cause || turn.purpose !== 'chat') {
            throw new ExtractionRefused(
                'conversation_shared',
                'Ask for this in a chat with the person, not from a scheduled run.',
            );
        }
        const thread = this.sources.workspace.thread(turn.threadId);
        if (!thread || thread.archivedAt) {
            throw new ExtractionRefused('conversation_gone', 'This conversation is gone.');
        }
        if (thread.kind === 'room') {
            return 'room';
        }
        if (thread.team) {
            throw new ExtractionRefused(
                'conversation_shared',
                'Ask me in a private chat: extractions aren’t available in group chats yet.',
            );
        }
        return 'private';
    }

    private async telegramGroup(threadId: string) {
        const info = await this.sources.workspace.telegram.threadInfo(threadId);
        return !!info && info.kind !== 'dm';
    }

    /** The features this needs, for the person. */
    private featuresOn(personId: string) {
        const { flags } = this.sources;
        return flags.enabled('socio-actor-access', personId) && flags.enabled('repo-extraction', personId);
    }

    /** A listed repository with extraction allowed that the person may use. */
    private async repository(personId: string, name: string) {
        const listed = this.gateway.repos.get(name);
        if (!listed || !listed.extraction) {
            throw new ExtractionRefused(
                'extraction_off',
                `${name} isn’t open to extraction; an admin can allow it under Settings → Coding → Repositories.`,
            );
        }
        if (!this.gateway.repos.personMay(personId, listed, await this.gateway.mayUseCode(personId))) {
            throw new ExtractionRefused(
                'person_no_access',
                `You aren’t among the people who may use ${listed.repository}.`,
            );
        }
        return listed;
    }

    /**
     * An app the person may open that can take extractions: a
     * promoted app (development apps never), delegable now under its
     * audience policy, that declares it accepts `repo-extract`.
     */
    async eligibleApp(personId: string, ref: string): Promise<AppRecord> {
        const wanted = ref.trim().toLowerCase();
        const apps = this.sources.apps.all().filter((app) => this.sources.apps.access(personId, app));
        const app =
            apps.find((item) => item.id === wanted) ??
            apps.find((item) => item.slug === wanted) ??
            apps.find((item) => item.name.toLowerCase() === wanted);
        if (!app) {
            throw new ExtractionRefused('app_ineligible', `No app "${ref}" that you can open.`);
        }
        if (app.status !== 'promoted') {
            throw new ExtractionRefused(
                'app_ineligible',
                `${app.name} isn’t a promoted app; only promoted apps can take extractions.`,
            );
        }
        const audience = `app:${app.id}` as Audience;
        const policy = this.sources.actors.audiences.for(audience) as
            | (ExtractionAwarePolicy & {
                  policyVersion(audience: Audience): unknown;
              })
            | undefined;
        const delegable = !!policy && (await policy.policyVersion(audience)) !== undefined;
        if (!delegable || (await policy?.accepts?.(audience, 'repo-extract')) !== true) {
            throw new ExtractionRefused(
                'app_ineligible',
                `${app.name} doesn’t accept repository extractions; its owner can add "accepts": ["repo-extract"] to its manifest’s delegation block.`,
            );
        }
        return app;
    }

    private appFacts(app: AppRecord) {
        let origin = 'its own address';
        try {
            origin = this.sources.apps.url(app);
        } catch {
            // Apps are off here; the card still names the app and its owner.
        }
        const name = this.sources.workspace.users().find((user) => user.id === app.ownerUserId)?.name;
        return { origin, owner: name ? cardLabel(name) : 'someone' };
    }

    private async resolveCommit(repository: string, ref: string) {
        const minted = await this.gateway.context.mint(repository, {
            contents: 'read',
        });
        try {
            return await minted.repo.resolveCommit(ref);
        } catch {
            throw new ExtractionRefused('ref_unknown', `GitHub doesn’t know ${ref} in ${repository}.`);
        } finally {
            await minted.revoke();
        }
    }

    /** A live standing grant that covers this request, if any. */
    private async standingGrant(
        personId: string,
        socioId: string,
        repository: string,
        paths: readonly string[],
        appId: string,
    ): Promise<GrantRecord | undefined> {
        for (const grant of this.sources.actors.grants.unrevoked({
            personId,
            socioId,
            audience: 'gateway:git',
        })) {
            if (!isStandingGrant(grant)) {
                continue;
            }
            const resources = grant.resources ?? {};
            if (
                String(resources.repository).toLowerCase() !== repository.toLowerCase() ||
                resources.app !== appId ||
                !Array.isArray(resources.paths) ||
                !scopeWithin(paths, resources.paths as string[])
            ) {
                continue;
            }
            const decision = await this.sources.actors.authorizer.authorize(
                grant.id,
                {
                    audience: 'gateway:git',
                    scope: 'git:extract',
                    resource: { kind: 'repository', id: repository.toLowerCase() },
                },
                { fresh: true },
            );
            if (decision.allowed) {
                return grant;
            }
        }
        return undefined;
    }

    private audit(
        row: Pick<ExtractionRecord, 'personId' | 'socioId' | 'repository'>,
        input: {
            correlationId: string;
            phase: 'approval' | 'outcome' | 'decision';
            decision?: 'allow' | 'deny';
            reason?: string;
            action: string;
            grantId?: string;
            status?: string;
            digest?: string;
            detail?: string;
        },
        inTransaction = false,
    ) {
        const entry = {
            ...input,
            personId: row.personId,
            socioId: row.socioId,
            audience: 'gateway:git',
            resourceKind: 'repository',
            resourceId: row.repository.toLowerCase(),
        };
        if (inTransaction) {
            this.sources.actors.audit.recordIn(entry);
        } else {
            this.sources.actors.audit.recordSoon(entry);
        }
    }

    /**
     * A card's decision as an `actor_audit` `approval` row, inside the unit
     * of work that decides it (CB-232; as actors/approvals.ts's
     * `auditDecision`): approved, denied or expired, by whom, with the
     * payload's digest and never its contents.
     */
    private auditDecision(
        request: ApprovalRecord<ExtractPayload | StandingPayload>,
        event: ApprovalDecisionEvent,
        correlationId: string,
    ) {
        this.sources.actors.audit.recordIn({
            at: event.at,
            correlationId,
            phase: 'approval',
            ...(event.status === 'approved'
                ? { decision: 'allow' as const }
                : event.status === 'denied'
                  ? { decision: 'deny' as const }
                  : {}),
            status: event.status,
            personId: request.userId,
            socioId: request.dotId,
            actorBy: event.by,
            audience: 'gateway:git',
            action: request.capability,
            resourceKind: 'approval',
            resourceId: request.id,
            digest: sha256Hex(canonicalJson(request.payload)),
        });
    }

    /**
     * `repo_extract` (the tool): checks, the commit resolved, then either
     * the extraction at once under a standing grant, or a card.
     */
    async request(turn: DotTurn, input: ExtractInput): Promise<Record<string, unknown>> {
        const correlationId = `extract-${randomUUID()}`;
        const personId = turn.userId;
        const socioId = turn.dot.id;
        const base = { personId, socioId, repository: input.repository };
        try {
            if (!this.featuresOn(personId)) {
                throw new ExtractionRefused('feature_off', 'Repository extraction isn’t on for you.');
            }
            if (!this.sources.workspace.canUseDot(personId, socioId)) {
                throw new ExtractionRefused('socio_unavailable', 'This socio isn’t available to you.');
            }
            const kind = this.conversation(turn);
            if (kind === 'private' && (await this.telegramGroup(turn.threadId))) {
                throw new ExtractionRefused(
                    'conversation_shared',
                    'Ask me in a private chat: extractions aren’t available in group chats yet.',
                );
            }
            const repository = await this.repository(personId, input.repository);
            const paths = [...new Set(input.paths.map((path) => path.normalize('NFC')))];
            if (!input.paths.length || input.paths.length > MAX_SCOPE_PATHS) {
                throw new ExtractionRefused('paths_invalid', `Give 1 to ${MAX_SCOPE_PATHS} paths.`);
            }
            for (const path of paths) {
                const problem = scopePathProblem(path);
                if (problem) {
                    throw new ExtractionRefused('paths_invalid', `The path "${inertPath(path, 80)}" ${problem}.`);
                }
            }
            const app = await this.eligibleApp(personId, input.app);
            const facts = this.appFacts(app);
            // Every name and path on the card is inert.
            const appName = cardLabel(app.name);
            const socioName = cardLabel(turn.dot.name);
            const shownPaths = paths.map((path) => inertPath(path)).join(', ');
            const room = this.sources.workspace.thread(turn.threadId)?.title;
            const roomNote =
                kind === 'room'
                    ? [
                          `${socioName}’s answers here are visible to everyone in ${room ? cardLabel(room) : 'this room'}.`,
                      ]
                    : [];
            if (input.standing_days !== undefined) {
                const days = Math.round(input.standing_days);
                if (days < 1 || days > STANDING_MAX_DAYS) {
                    throw new ExtractionRefused(
                        'standing_invalid',
                        `Standing access lasts 1 to ${STANDING_MAX_DAYS} days.`,
                    );
                }
                if (!repository.standingExtraction) {
                    throw new ExtractionRefused(
                        'standing_off',
                        `Standing extraction isn’t allowed for ${repository.repository}; ask for each extraction instead.`,
                    );
                }
                const payload: StandingPayload = {
                    repository: repository.repository,
                    paths,
                    app: app.id,
                    days,
                    conversationId: turn.threadId,
                    conversationKind: kind,
                    task: input.task.trim().slice(0, 500),
                };
                const outcome = await this.sources.approvals.request({
                    userId: personId,
                    dotId: socioId,
                    threadId: turn.threadId,
                    capability: REPO_EXTRACT_STANDING_CAPABILITY,
                    summary: `${socioName} wants standing access to give ${appName} copies of ${repository.repository} for ${days} day${days === 1 ? '' : 's'}`,
                    details: [
                        `App: ${appName}, at ${facts.origin}, owned by ${facts.owner}.`,
                        `Repository: ${repository.repository}, any commit. Paths: ${shownPaths}`,
                        `For ${days} day${days === 1 ? '' : 's'}, ${socioName} may give ${appName} copies of these paths without asking you each time. Each one is recorded, and you can end this under Account → Socio access.`,
                        `${appName} gets those files’ contents. It doesn’t get access to GitHub or to the rest of the repository, and can’t push.`,
                        ...roomNote,
                        `${socioName} says: "${cardTask(input.task)}"`,
                    ],
                    payload,
                });
                // Filed, not decided: no decision yet; the decision's own row
                // comes from `onDecision`.
                this.audit(base, {
                    correlationId,
                    phase: 'approval',
                    action: REPO_EXTRACT_STANDING_CAPABILITY,
                    status: 'requested',
                    digest: sha256Hex(canonicalJson(payload)),
                });
                return { ...outcome, standing: true };
            }
            const ref = input.ref.trim();
            if (!REF.test(ref)) {
                throw new ExtractionRefused('ref_unknown', 'Give a branch, tag or commit id.');
            }
            const commit = await this.resolveCommit(repository.repository, ref);
            const now = Date.now();
            const id = randomUUID();
            const row: ExtractionRecord = {
                id,
                personId,
                socioId,
                appId: app.id,
                repository: repository.repository,
                ref,
                commitId: commit,
                paths,
                threadId: turn.threadId,
                status: 'requested',
                approvalId: null,
                standingGrantId: null,
                filePath: null,
                files: null,
                bytes: null,
                failure: null,
                createdAt: now,
                readyAt: null,
                expiresAt: now + EXTRACT_APPROVAL_MS,
                firstReadAt: null,
                removedAt: null,
            };
            const standing = await this.standingGrant(personId, socioId, repository.repository, paths, app.id);
            if (standing) {
                row.standingGrantId = standing.id;
                await transaction(this.db, 'record extraction', () => {
                    this.rows.insert(row);
                    this.rows.claim(id, Date.now() + RUN_MS);
                    this.audit(
                        row,
                        {
                            correlationId,
                            phase: 'approval',
                            decision: 'allow',
                            action: 'git:extract',
                            grantId: standing.id,
                            status: 'standing',
                        },
                        true,
                    );
                });
                this.sources.actors.grants.touch(standing.id);
                const done = await this.run({ ...row, status: 'running' }, correlationId);
                return {
                    status: 'done',
                    extraction_id: id,
                    commit,
                    files: done.files,
                    bytes: done.bytes,
                    note: `${appName} can read it once through Socio (GET /api/apps/actor/extractions/${id} with the person’s request); it is kept ${this.gateway.repos.limits().extractRetentionHours} hours. Under your standing access, so no card was shown.`,
                };
            }
            const payload: ExtractPayload = {
                extraction: id,
                repository: repository.repository,
                commit,
                paths,
                app: app.id,
            };
            await transaction(this.db, 'record extraction', () => this.rows.insert(row));
            const outcome = await this.sources.approvals.request({
                userId: personId,
                dotId: socioId,
                threadId: turn.threadId,
                capability: REPO_EXTRACT_CAPABILITY,
                summary: `${socioName} wants to give ${appName} a copy of ${repository.repository} at ${ref === commit ? '' : `${ref}, `}commit ${commit.slice(0, 7)}`,
                details: [
                    `App: ${appName}, at ${facts.origin}, owned by ${facts.owner}.`,
                    `Repository: ${repository.repository} at ${ref === commit ? '' : `${ref}, `}commit ${commit}.`,
                    `Paths: ${shownPaths}`,
                    `${appName} gets these files’ contents, for you. It doesn’t get access to GitHub or to the rest of the repository, and can’t push.`,
                    ...roomNote,
                    `${socioName} says: "${cardTask(input.task)}"`,
                ],
                payload,
            });
            await transaction(this.db, 'bind extraction approval', () => this.rows.setApproval(id, outcome.id));
            // Filed, not decided.
            this.audit(row, {
                correlationId,
                phase: 'approval',
                action: 'git:extract',
                status: 'requested',
                digest: sha256Hex(canonicalJson(payload)),
            });
            return { ...outcome, extraction_id: id, commit };
        } catch (error) {
            if (error instanceof ExtractionRefused || error instanceof GitProxyError) {
                this.audit(base, {
                    correlationId,
                    phase: 'decision',
                    decision: 'deny',
                    reason: error.reason,
                    action: 'git:extract',
                });
                return { status: 'refused', error: error.message };
            }
            throw error;
        }
    }

    /** The approval's handler: exactly the approved payload, once. */
    private async execute(record: ApprovalRecord<ExtractPayload>) {
        const { payload } = record;
        const row = this.rows.get(payload.extraction);
        const correlationId = `extract-${payload.extraction}`;
        if (
            !row ||
            row.personId !== record.userId ||
            row.socioId !== record.dotId ||
            row.repository !== payload.repository ||
            row.commitId !== payload.commit ||
            row.appId !== payload.app ||
            canonicalJson(row.paths) !== canonicalJson(payload.paths) ||
            !SHA.test(payload.commit)
        ) {
            throw new Error('This extraction no longer matches what was approved.');
        }
        if (Date.now() - row.createdAt > EXTRACT_APPROVAL_MS) {
            await transaction(this.db, 'extraction expired', () =>
                this.rows.fail(row.id, 'The approval came after 15 minutes.'),
            );
            throw new Error('This request expired; ask the socio to ask again.');
        }
        // The approval's row was written as it was decided (`onDecision`).
        const claimed = await transaction(this.db, 'claim extraction', () =>
            this.rows.claim(row.id, Date.now() + RUN_MS),
        );
        if (!claimed) {
            throw new Error('This extraction ran already.');
        }
        const done = await this.run({ ...row, status: 'running' }, correlationId);
        return `Extraction ${row.id} is ready: ${done.files} file(s), ${Math.ceil(done.bytes / 1024)} KB of ${row.repository} at ${row.commitId.slice(0, 7)} for the app. It can read it through Socio for ${this.gateway.repos.limits().extractRetentionHours} hours.`;
    }

    /** The standing card's handler: a grant, never an extraction. */
    private async approveStanding(record: ApprovalRecord<StandingPayload>) {
        const { payload } = record;
        const personId = record.userId;
        if (!this.featuresOn(personId)) {
            throw new Error('Repository extraction isn’t on for you.');
        }
        const repository = await this.repository(personId, payload.repository);
        if (!repository.standingExtraction) {
            throw new Error('Standing extraction isn’t allowed for this repository now.');
        }
        await this.eligibleApp(personId, payload.app);
        const days = Math.min(Math.max(1, Math.round(payload.days)), STANDING_MAX_DAYS);
        const grant = await this.sources.actors.grants.create({
            personId,
            socioId: record.dotId,
            audiences: ['gateway:git'],
            scopes: ['git:extract'],
            resources: {
                repository: repository.repository,
                paths: payload.paths,
                app: payload.app,
                standing: true,
            },
            conversationId: payload.conversationId,
            conversationKind: payload.conversationKind,
            task: payload.task,
            approvalId: record.id,
            minutes: days * 1440,
            idleMinutes: days * 1440,
            approvedBy: personId,
            correlationId: `standing-${record.id}`,
        });
        return `Standing extraction access is on until ${new Date(grant.expiresAt).toISOString()} (grant ${grant.id}).`;
    }

    /**
     * One extraction: the mirror refreshed (with the commit), the files read
     * in coding-git, the result sealed into the person's data space.
     */
    private async run(row: ExtractionRecord, correlationId: string) {
        const limits = this.gateway.repos.limits();
        const fail = async (reason: string, message: string): Promise<never> => {
            await transaction(this.db, 'extraction failed', () => {
                this.rows.fail(row.id, message);
                this.audit(
                    row,
                    {
                        correlationId,
                        phase: 'outcome',
                        decision: 'deny',
                        // Through the closed list, so the CHECK can't roll `fail` back
                        // and leave the extraction running.
                        reason: failureReason(reason),
                        action: 'git:extract',
                        grantId: row.standingGrantId ?? undefined,
                    },
                    true,
                );
            });
            throw new Error(message);
        };
        // The approval may be old: everything is checked again.
        try {
            if (!this.featuresOn(row.personId)) {
                throw new ExtractionRefused('feature_off', 'Repository extraction isn’t on for you.');
            }
            if (!this.sources.workspace.canUseDot(row.personId, row.socioId)) {
                throw new ExtractionRefused('socio_unavailable', 'This socio isn’t available to you.');
            }
            await this.repository(row.personId, row.repository);
            await this.eligibleApp(row.personId, row.appId);
        } catch (error) {
            if (error instanceof ExtractionRefused) {
                return fail(error.reason, error.message);
            }
            throw error;
        }
        const client = this.gateway.context.codingGit;
        if (!client) {
            return fail('coding_git_unavailable', 'Extractions need the coding-git service, which isn’t configured.');
        }
        try {
            await refreshMirror(this.gateway.context, row.repository, [row.commitId]);
        } catch (error) {
            return fail(
                error instanceof GitProxyError ? error.reason : 'github_unreachable',
                error instanceof GitProxyError ? error.message : 'GitHub could not be reached.',
            );
        }
        let result;
        try {
            result = await client.extract(row.repository, {
                commit: row.commitId,
                paths: row.paths,
                maxBytes: limits.extractMaxMb * MB,
                maxFiles: limits.extractMaxFiles,
            });
        } catch {
            return fail('coding_git_unavailable', 'coding-git could not read the files.');
        }
        if (!result.ok) {
            // coding-git's words never reach the socio, and only its known codes
            // the audit: it reads hostile repositories.
            const known = EXTRACT_FAILURES.get(String(result.reason));
            return fail(
                known ? String(result.reason) : 'coding_git_unavailable',
                result.reason === 'too_large'
                    ? `The paths hold more than the extraction limit (${limits.extractMaxFiles} files or ${limits.extractMaxMb} MB); nothing was given to the app. Ask for narrower paths.`
                    : (known ?? 'coding-git could not read the files.'),
            );
        }
        const files = result.files.map((file) => {
            const data = Buffer.from(file.content, 'base64');
            const text = data.toString('utf8');
            const utf8 = Buffer.from(text, 'utf8').equals(data);
            return {
                path: file.path,
                executable: file.executable,
                size: file.size,
                encoding: utf8 ? 'utf8' : 'base64',
                content: utf8 ? text : file.content,
            };
        });
        const document = Buffer.from(
            JSON.stringify({
                format: 'socio-repo-extract/1',
                repository: row.repository,
                commit: row.commitId,
                paths: row.paths,
                files,
            }),
        );
        const path = `${FOLDER}/${row.id}.sealed`;
        try {
            await this.sources.data.putFile(
                { kind: 'user', userId: row.personId },
                path,
                this.seal(row, gzipSync(document)),
                'application/octet-stream',
                {
                    name: `${row.repository} at ${row.commitId.slice(0, 7)} for an app`.slice(0, 80),
                    create: true,
                },
            );
        } catch (error) {
            return fail(
                'storage_refused',
                `The extraction couldn’t be stored: ${error instanceof Error ? error.message : 'storage failed'}`,
            );
        }
        const now = Date.now();
        await transaction(this.db, 'extraction ready', () => {
            this.rows.ready(row.id, {
                filePath: path,
                files: files.length,
                bytes: result.bytes,
                at: now,
                expiresAt: now + limits.extractRetentionHours * HOUR,
            });
            // Counts only: never names or contents.
            this.audit(
                row,
                {
                    correlationId,
                    phase: 'outcome',
                    decision: 'allow',
                    action: 'git:extract',
                    grantId: row.standingGrantId ?? undefined,
                    status: 'ready',
                    detail: `commit=${row.commitId} paths=${row.paths.length} files=${files.length} bytes=${result.bytes} dropped=${result.dropped}`,
                },
                true,
            );
        });
        return { files: files.length, bytes: result.bytes };
    }

    /**
     * An app's read (delivery): the extraction's app must be the one whose
     * data token the caller (the apps' route) verified, and the person the
     * `cbob_`'s, a live socio grant for that app or the person's own live
     * session on it. Reads are allowed for 10 minutes after the first.
     */
    async deliver(input: { id: string; appId: string; obo: string | undefined }): Promise<ExtractionDelivery> {
        void this.prune().catch(() => undefined);
        const correlationId = `extract-read-${randomUUID()}`;
        const row = this.rows.get(input.id);
        const deny = (status: 401 | 403 | 404 | 410, reason: string, error: string): ExtractionDelivery => {
            if (row) {
                this.audit(row, {
                    correlationId,
                    phase: 'outcome',
                    decision: 'deny',
                    reason,
                    action: 'git:extract:read',
                    status: String(status),
                });
            }
            return { status, error };
        };
        if (!row || row.appId !== input.appId) {
            return deny(404, 'audience_mismatch', 'No such extraction.');
        }
        const claims = this.sources.actors.credentials.openObo(input.obo, input.appId);
        if (!claims) {
            return deny(401, 'credential_invalid', 'Send the request’s x-cb-obo.');
        }
        let personId: string | undefined;
        if (claims.grantId) {
            const grant = this.sources.actors.grants.get(claims.grantId);
            const decision = grant ? await this.sources.actors.authorizer.authorizeGrant(grant.id) : undefined;
            if (grant && decision?.allowed && grant.audiences.includes(`app:${input.appId}` as Audience)) {
                // A socio's request reads only what that socio asked for:
                // another socio of the same person is refused.
                if (grant.socioId !== row.socioId) {
                    return deny(403, 'turn_mismatch', 'This extraction isn’t for this request’s person.');
                }
                personId = grant.personId;
            }
        } else if (claims.sessionHash) {
            const session = appSessionByHash(this.db, claims.sessionHash);
            const app = this.sources.apps.get(input.appId);
            if (
                session &&
                app &&
                session.appId === input.appId &&
                session.expiresAt > Date.now() &&
                this.sources.apps.access(session.userId, app)
            ) {
                personId = session.userId;
            }
        }
        if (!personId || personId !== row.personId) {
            return deny(403, 'person_no_access', 'This extraction isn’t for this request’s person.');
        }
        // Delivery re-checks what the request did: the features still on for
        // the person, and the app still a promoted one they may open that
        // accepts extractions now, not only when it was asked.
        if (!this.featuresOn(row.personId)) {
            return deny(403, 'feature_off', 'Repository extraction isn’t on for this person.');
        }
        try {
            await this.eligibleApp(row.personId, row.appId);
        } catch (error) {
            if (!(error instanceof ExtractionRefused)) {
                throw error;
            }
            return deny(403, 'app_ineligible', 'This app doesn’t accept repository extractions now.');
        }
        const now = Date.now();
        if (row.status !== 'ready' || !row.filePath) {
            return deny(404, 'extraction_not_ready', 'The extraction isn’t ready.');
        }
        if (row.expiresAt <= now || row.removedAt !== null) {
            return deny(410, 'extraction_expired', 'The extraction has expired.');
        }
        if (row.firstReadAt !== null && now - row.firstReadAt > EXTRACT_READ_WINDOW_MS) {
            return deny(410, 'read_window_over', 'The extraction was read already.');
        }
        let body: Buffer;
        try {
            const { data } = await this.sources.data.getFile({ kind: 'user', userId: row.personId }, row.filePath);
            body = gunzipSync(this.open(row, Buffer.from(data)));
        } catch {
            return deny(410, 'extraction_expired', 'The extraction is gone.');
        }
        await transaction(this.db, 'extraction read', () => {
            this.rows.firstRead(row.id, now);
            this.audit(
                row,
                {
                    correlationId,
                    phase: 'outcome',
                    decision: 'allow',
                    action: 'git:extract:read',
                    status: '200',
                    detail: `bytes=${body.length}`,
                },
                true,
            );
        });
        return { status: 200, body, contentType: 'application/json' };
    }

    /** Expired extractions: their sealed files deleted, rows kept (counts). */
    async prune(now = Date.now()) {
        let removed = 0;
        for (const row of this.rows.due(now)) {
            if (row.filePath) {
                await this.sources.data.deleteFile(row.personId, row.filePath, { by: 'system' }).catch(() => undefined);
            }
            await transaction(this.db, 'extraction removed', () => this.rows.removed(row.id, now));
            removed += 1;
        }
        return removed;
    }
}

/**
 * Delivery for the route `GET /api/apps/actor/extractions/:id` (CB-239):
 * the route verifies the app's data token and passes its app id and the
 * request's `x-cb-obo`; everything else is checked here.
 */
export async function deliverExtractionFrom(
    sources: GatewaySources,
    input: { id: string; appId: string; obo: string | undefined },
): Promise<ExtractionDelivery> {
    const { gitGatewayOf } = await import('./git.js');
    return gitGatewayOf(sources).extractions.deliver(input);
}
