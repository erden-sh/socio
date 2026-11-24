import { createHmac } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { transaction } from '@socio/data/open';
import {
    CODING_BRANCH,
    CODING_BRANCH_PREFIX,
    CODING_GIT_LIMIT_BOUNDS,
    validCodingRepository,
    type CodingGitLimits,
    type CodingRepositoryInput,
    type CodingRepositoryView,
} from '@socio/shared/coding/coding-repos';

import type { ActorAuditShape } from '../actors/contract.js';
import type { CodingRepositoriesShape } from '../coding/contract.js';

import { GitSettingRows, MintRows, RepositoryRows } from './infra/git-rows.js';

/**
 * Settings → Coding → Repositories (CB-239) and the Git proxy's
 * limits (CB-267): admin-editable in the Settings UI over environment
 * defaults. Every change is a `setting` row in `actor_audit`, in the same
 * transaction, with the admin and the old and new values.
 */

export class RepositorySettingError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 404 | 409 = 400,
    ) {
        super(message);
    }
}

/** The environment's defaults for the limits (`CODING_GIT_*`, `CODING_EXTRACT_*`). */
export function gitLimitsFromEnv(env: Record<string, string | undefined>): CodingGitLimits {
    const read = (name: string, key: keyof CodingGitLimits, fallback: number) => {
        const raw = env[name]?.trim();
        if (!raw) {
            return fallback;
        }
        const value = Number(raw);
        const { min, max } = CODING_GIT_LIMIT_BOUNDS[key];
        if (!Number.isInteger(value) || value < min || value > max) {
            throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
        }
        return value;
    };
    return {
        gitRequestsPerMinute: read('CODING_GIT_REQUESTS_PER_MINUTE', 'gitRequestsPerMinute', 30),
        tokensPerHour: read('CODING_GIT_TOKENS_PER_HOUR', 'tokensPerHour', 1_000),
        // One session can't spend the instance's ceiling.
        tokensPerSessionHour: read('CODING_GIT_TOKENS_PER_SESSION_HOUR', 'tokensPerSessionHour', 200),
        extractMaxMb: read('CODING_EXTRACT_MAX_MB', 'extractMaxMb', 50),
        extractMaxFiles: read('CODING_EXTRACT_MAX_FILES', 'extractMaxFiles', 20_000),
        extractRetentionHours: read('CODING_EXTRACT_RETENTION_HOURS', 'extractRetentionHours', 24),
    };
}

/** What a change to a repository ends (the Git proxy calls `platform.actors.revoke`). */
export interface RepositoryChange {
    repository: string;
    removed: boolean;
    pushOff: boolean;
    extractionOff: boolean;
    standingOff: boolean;
}

export interface GitRepositoriesOptions {
    audit: ActorAuditShape;
    limitDefaults: CodingGitLimits;
    /** Known people, for the "listed people" choice. */
    personExists: (id: string) => boolean;
    /** Called after a change commits: ends the grants it no longer allows. */
    changed?: (change: RepositoryChange, by: string) => Promise<void>;
    now?: () => number;
}

const LIST_MAX = { baseBranches: 20, users: 500 };
/** `actor_audit.detail`'s limit. */
const AUDIT_DETAIL_MAX = 2000;

export class GitRepositories implements CodingRepositoriesShape {
    private rows: RepositoryRows;
    private settings: GitSettingRows;
    readonly mints: MintRows;
    private now: () => number;
    constructor(
        private db: DatabaseSync,
        private options: GitRepositoriesOptions,
    ) {
        this.rows = new RepositoryRows(db);
        this.settings = new GitSettingRows(db);
        this.mints = new MintRows(db);
        this.now = options.now ?? Date.now;
    }

    /** The shared connection, for the transactions callers open around rows. */
    get database() {
        return this.db;
    }

    get(repository: string) {
        return validCodingRepository(repository) ? this.rows.get(repository) : undefined;
    }
    list() {
        return this.rows.list();
    }

    /** The limits in force: the admin's values over the environment's. */
    limits(): CodingGitLimits {
        const saved = this.settings.all();
        const out = { ...this.options.limitDefaults };
        for (const key of Object.keys(out) as Array<keyof CodingGitLimits>) {
            const value = Number(saved[key]);
            const { min, max } = CODING_GIT_LIMIT_BOUNDS[key];
            if (saved[key] !== undefined && Number.isInteger(value) && value >= min && value <= max) {
                out[key] = value;
            }
        }
        return out;
    }
    get limitDefaults() {
        return { ...this.options.limitDefaults };
    }

    /** Saves the admin's limits; `null` returns one to the environment's. */
    async saveLimits(input: Partial<Record<keyof CodingGitLimits, number | null>>, by: string) {
        const keys = Object.keys(CODING_GIT_LIMIT_BOUNDS) as Array<keyof CodingGitLimits>;
        for (const [key, value] of Object.entries(input)) {
            if (!keys.includes(key as keyof CodingGitLimits)) {
                throw new RepositorySettingError(`Unknown limit ${key}.`);
            }
            if (value === null) {
                continue;
            }
            const { min, max } = CODING_GIT_LIMIT_BOUNDS[key as keyof CodingGitLimits];
            if (!Number.isInteger(value) || value! < min || value! > max) {
                throw new RepositorySettingError(`${key} must be a whole number from ${min} to ${max}.`);
            }
        }
        const now = this.now();
        await transaction(this.db, 'save coding git limits', () => {
            const before = this.limits();
            for (const [key, value] of Object.entries(input)) {
                this.settings.set(key, value === null ? null : String(value), now, by);
            }
            const after = this.limits();
            if (JSON.stringify(before) !== JSON.stringify(after)) {
                this.options.audit.recordIn({
                    at: now,
                    correlationId: `setting-${now}`,
                    phase: 'setting',
                    actorBy: by,
                    action: 'coding.git_limits',
                    detail: JSON.stringify({ old: before, new: after }),
                });
            }
        });
        return this.limits();
    }

    /**
     * Adds or changes a listed repository. Turning push on needs the
     * checklist confirmed; standing extraction needs extraction.
     */
    async save(repository: string, input: CodingRepositoryInput, by: string): Promise<CodingRepositoryView> {
        if (!validCodingRepository(repository)) {
            throw new RepositorySettingError('Give the repository as owner/name.');
        }
        const now = this.now();
        // The row is read and merged inside the transaction, so two saves
        // can't both start from the same old row and lose one.
        const { before, next } = await transaction(this.db, 'save coding repository', () => {
            const before = this.rows.get(repository);
            const next: CodingRepositoryView = {
                repository: before?.repository ?? repository,
                baseBranches: before?.baseBranches ?? [],
                branchPrefix: before?.branchPrefix ?? 'socio',
                push: before?.push ?? false,
                pushChecklist: before?.pushChecklist ?? null,
                users: before ? before.users : null,
                extraction: before?.extraction ?? false,
                standingExtraction: before?.standingExtraction ?? false,
                updatedAt: now,
                updatedBy: by,
            };
            const list = (value: unknown, max: number, check: (item: string) => boolean, what: string) => {
                if (
                    !Array.isArray(value) ||
                    value.length > max ||
                    !value.every((item) => typeof item === 'string' && check(item))
                ) {
                    throw new RepositorySettingError(`Check the ${what}.`);
                }
                return [...new Set(value as string[])];
            };
            if (input.branchPrefix !== undefined) {
                if (!CODING_BRANCH_PREFIX.test(input.branchPrefix)) {
                    throw new RepositorySettingError(
                        'A branch prefix is one lowercase word (letters, digits, - and _).',
                    );
                }
                next.branchPrefix = input.branchPrefix;
            }
            if (input.baseBranches !== undefined) {
                next.baseBranches = list(
                    input.baseBranches,
                    LIST_MAX.baseBranches,
                    (branch) => CODING_BRANCH.test(branch),
                    'base branches',
                );
            }
            if (
                next.baseBranches.some(
                    (branch) => branch === next.branchPrefix || branch.startsWith(`${next.branchPrefix}/`),
                )
            ) {
                throw new RepositorySettingError('A base branch can’t be under the session branch prefix.');
            }
            if (input.users !== undefined) {
                next.users =
                    input.users === null
                        ? null
                        : list(input.users, LIST_MAX.users, (id) => this.options.personExists(id), 'listed people');
            }
            if (input.push !== undefined) {
                if (input.push && !next.push) {
                    if (input.pushChecklistConfirmed !== true) {
                        throw new RepositorySettingError('Confirm the checklist before turning push on.', 409);
                    }
                    next.pushChecklist = { at: now, by };
                }
                next.push = input.push;
            }
            if (input.extraction !== undefined) {
                next.extraction = input.extraction;
            }
            if (input.standingExtraction !== undefined) {
                next.standingExtraction = input.standingExtraction;
            }
            if (!next.extraction) {
                if (input.standingExtraction === true) {
                    throw new RepositorySettingError('Standing extraction needs extraction allowed.');
                }
                next.standingExtraction = false;
            }
            this.rows.upsert(next, now);
            this.audit(repository, before, next, by, now);
            return { before, next };
        });
        if (before) {
            await this.options.changed?.(
                {
                    repository: next.repository,
                    removed: false,
                    pushOff: before.push && !next.push,
                    extractionOff: before.extraction && !next.extraction,
                    standingOff: before.standingExtraction && !next.standingExtraction,
                },
                by,
            );
        }
        return this.rows.get(repository)!;
    }

    /** Takes a repository off the list; its sessions' and extractions' grants end. */
    async remove(repository: string, by: string) {
        const before = this.get(repository);
        if (!before) {
            throw new RepositorySettingError('That repository isn’t listed.', 404);
        }
        const now = this.now();
        await transaction(this.db, 'remove coding repository', () => {
            this.rows.remove(repository);
            this.audit(repository, before, null, by, now);
        });
        await this.options.changed?.(
            {
                repository: before.repository,
                removed: true,
                pushOff: true,
                extractionOff: true,
                standingOff: true,
            },
            by,
        );
    }

    private audit(
        repository: string,
        before: CodingRepositoryView | undefined | null,
        after: CodingRepositoryView | null,
        by: string,
        now: number,
    ) {
        const strip = (view: CodingRepositoryView | null | undefined) =>
            view
                ? {
                      baseBranches: view.baseBranches,
                      branchPrefix: view.branchPrefix,
                      push: view.push,
                      users: view.users === null ? 'code-access list' : view.users.length,
                      extraction: view.extraction,
                      standingExtraction: view.standingExtraction,
                  }
                : null;
        // Who was added and who removed, by id, sorted; a count alone reads
        // [A, B] → [A, C] as no change. Ids are dropped from the longer list
        // (and counted) until the row fits the audit's limit.
        const ids = (view: CodingRepositoryView | null | undefined) => new Set(view?.users ?? []);
        const was = ids(before);
        const is = ids(after);
        const added = [...is].filter((id) => !was.has(id)).sort();
        const removed = [...was].filter((id) => !is.has(id)).sort();
        let omitted = 0;
        const detail = () =>
            JSON.stringify({
                old: strip(before),
                new: strip(after),
                ...(added.length || removed.length || omitted
                    ? { users: { added, removed, ...(omitted ? { omitted } : {}) } }
                    : {}),
            });
        let text = detail();
        while (text.length > AUDIT_DETAIL_MAX && (added.length || removed.length)) {
            (added.length >= removed.length ? added : removed).pop();
            omitted += 1;
            text = detail();
        }
        this.options.audit.recordIn({
            at: now,
            correlationId: `setting-${now}`,
            phase: 'setting',
            actorBy: by,
            action: after?.push && !before?.push ? 'coding.repository.push_checklist' : 'coding.repository',
            resourceKind: 'repository',
            resourceId: repository.toLowerCase(),
            detail: text.slice(0, AUDIT_DETAIL_MAX),
        });
    }

    /**
     * Whether the person may use a listed repository: on the
     * code-access list (CB-124, `onCodeList`), and, when the repository lists
     * people, among them.
     */
    personMay(personId: string, repository: CodingRepositoryView, onCodeList: boolean) {
        return onCodeList && (repository.users === null || repository.users.includes(personId));
    }
}

/**
 * The commit identity of a socio (CB-239): its name with "(Socio)"
 * and `socio-<opaque id>@users.noreply.<apps host>`, the same for every
 * session of that socio. Never the person's name or address: it goes to
 * GitHub. The push check enforces it; the sandbox's gitconfig and the
 * coding sessions set it.
 */
export function socioCommitIdentity(secret: string, socio: { id: string; name: string }, host: string) {
    const opaque = createHmac('sha256', secret)
        .update(`socio-commit-identity\u0000${socio.id}`)
        .digest('hex')
        .slice(0, 16);
    const name = `${
        socio.name
            .replace(/[<>\n\r\0]/g, '')
            .trim()
            .slice(0, 60) || 'Socio'
    } (Socio)`;
    return { name, email: `socio-${opaque}@users.noreply.${host}` };
}
