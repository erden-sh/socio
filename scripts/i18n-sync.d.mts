export const CANDIDATE_ID: RegExp;

export interface ExportCandidate {
    id: string;
    ns: string;
    key: string;
    sourceHash?: string;
    inherit?: boolean;
    values: Record<string, string> | null;
    author?: string;
    origin?: string;
    selfApproved?: boolean;
    approvedAt?: number;
    returnedFrom?: number | null;
}
export interface ExportBody {
    commit: string | null;
    generatedAt: number;
    locales: Record<string, { parent: string | null; candidates: ExportCandidate[]; contributors: string[] }>;
    /** Approved candidates that failed the app's re-validation, left out of `locales`. */
    withheld?: string[];
}
export interface PullRequestState {
    number: number;
    state: 'open' | 'closed' | 'merged';
}

export function isTranslatedLocale(locale: unknown): boolean;
export function sparseParent(locale: string): string | null;
export function pullRequestStates(list: unknown): PullRequestState[];
export function importPayload(options: {
    commit: string;
    localesDir: string;
    i18nDir: string;
    pullRequests?: PullRequestState[];
}): { body: Record<string, unknown> & { commit: string }; hash: string };
export function removeKey(tree: Record<string, unknown>, key: string): void;
export function keyPath(english: Record<string, unknown>, key: string): string[];
export function withheldIds(exported: unknown): string[];
export function checkCandidate(candidate: unknown): string | null;
export function aliasForBody(alias: unknown): string;
export function applyLocale(options: { exported: ExportBody; locale: string; localesDir: string }): {
    ids: string[];
    body: string;
    skipped: { id: string; why: string }[];
    changed: string[];
};
export function bodySection(
    exported: ExportBody,
    locale: string,
    written: ExportCandidate[],
    skipped?: { id: string; why: string }[],
): string;
