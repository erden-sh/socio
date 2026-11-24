/**
 * Settings → Coding → Repositories (CB-239) and the Git proxy's limits
 * and extraction limits (CB-267),
 * shared by the server's routes and the admin's settings section.
 */

/** `owner/name` as GitHub allows it, with no `..` (CB-239). */
export const CODING_REPOSITORY = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

export const validCodingRepository = (value: string) =>
    CODING_REPOSITORY.test(value) && !value.includes('..') && !/\.git$/i.test(value.split('/')[1] ?? '');

/** A branch name the settings accept (a base branch, never a session's). */
export const CODING_BRANCH = /^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*\/$)[A-Za-z0-9._/-]{1,100}$/;

/** A branch prefix: one segment, so session branches are `<prefix>/<socio>/<session>`. */
export const CODING_BRANCH_PREFIX = /^[a-z0-9][a-z0-9_-]{0,29}$/;

export interface CodingRepositoryView {
    /** `owner/name`, as the admin entered it. */
    repository: string;
    /** Base branches sessions may start from; [] means the default, `main`. */
    baseBranches: string[];
    /** Session branches are `<prefix>/<socio>/<session>` (default `socio`). */
    branchPrefix: string;
    /** Whether sessions may push (only after the checklist). */
    push: boolean;
    /** When and by whom the push checklist was confirmed. */
    pushChecklist: { at: number; by: string } | null;
    /** Null: everyone on the code-access list; else those listed people. */
    users: string[] | null;
    /** CB-267: whether workspace apps may get extractions (default off). */
    extraction: boolean;
    /** CB-267: whether people may make standing extraction grants (default off). */
    standingExtraction: boolean;
    updatedAt: number;
    updatedBy: string;
}

export interface CodingRepositoryInput {
    baseBranches?: string[];
    branchPrefix?: string;
    push?: boolean;
    /** Required true when turning push on: the admin confirmed the checklist. */
    pushChecklistConfirmed?: boolean;
    users?: string[] | null;
    extraction?: boolean;
    standingExtraction?: boolean;
}

/** What turning push on asks the admin to confirm. */
export const PUSH_CHECKLIST = [
    'CI that runs on push, or on pull requests from this repository, for socio/** branches gets no deployment or publishing secrets.',
    'Those secrets sit in GitHub environments with required reviewers.',
    'Branch protection covers the base branches.',
] as const;

/** The Git proxy's and extraction's limits, admin-editable over env defaults. */
export interface CodingGitLimits {
    /** Git requests a minute per session, per runtime. */
    gitRequestsPerMinute: number;
    /** Installation tokens minted per hour for the whole instance. */
    tokensPerHour: number;
    /** Installation tokens one session may mint an hour, per runtime. */
    tokensPerSessionHour: number;
    /** CB-267: the most an extraction may hold, in MB (default 50). */
    extractMaxMb: number;
    /** CB-267: the most files an extraction may hold (default 20 000). */
    extractMaxFiles: number;
    /** CB-267: how long an extraction is kept, in hours (default 24). */
    extractRetentionHours: number;
}

export const CODING_GIT_LIMIT_BOUNDS: Record<keyof CodingGitLimits, { min: number; max: number }> = {
    gitRequestsPerMinute: { min: 1, max: 600 },
    tokensPerHour: { min: 1, max: 4_000 },
    tokensPerSessionHour: { min: 1, max: 4_000 },
    extractMaxMb: { min: 1, max: 200 },
    extractMaxFiles: { min: 1, max: 100_000 },
    extractRetentionHours: { min: 1, max: 168 },
};

export interface CodingRepositoriesView {
    repositories: CodingRepositoryView[];
    limits: CodingGitLimits;
    /** The environment's values the limits fall back to. */
    limitDefaults: CodingGitLimits;
    checklist: readonly string[];
}

/** Whether the central App can mint tokens for a listed repository. */
export interface CodingRepositoryCheck {
    installed: boolean;
    message: string;
}
