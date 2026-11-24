/**
 * The links a filing asks for (blocked by, blocks, related), added after
 * the item. Moved from `issues/filings.ts`, which re-exports them.
 * `issues` is the Board's issues service (`BoardIssues` in
 * `issues/contract.ts`), or the slice of it each needs.
 */
import type { IssueLinkRef } from '@socio/shared/issues/issue-types';

export type FilingDependencies = {
    blockedBy?: string[];
    blocks?: string[];
    related?: string[];
};
/**
 * Whether a filing asks for a blocking link (admins only). Related links
 * are anyone's (CB-274).
 */
export const hasBlockingDependencies = (input: FilingDependencies) =>
    !!(input.blockedBy?.length || input.blocks?.length);
/** Caller owns permission checks and the encompassing filing transaction. */
export async function addFilingDependencies(
    issues: {
        addBlocker(number: number, blockerNumber: number, actorId: string, now?: number): Promise<unknown>;
        addRelated(number: number, otherNumber: number, actorId: string, now?: number): Promise<unknown>;
    },
    number: number,
    input: FilingDependencies,
    actorId: string,
    now: number,
) {
    for (const ref of new Set(input.blockedBy ?? [])) {
        await issues.addBlocker(number, Number(/(\d+)$/.exec(ref)![1]), actorId, now);
    }
    for (const ref of new Set(input.blocks ?? [])) {
        await issues.addBlocker(Number(/(\d+)$/.exec(ref)![1]), number, actorId, now);
    }
    for (const ref of new Set(input.related ?? [])) {
        await issues.addRelated(number, Number(/(\d+)$/.exec(ref)![1]), actorId, now);
    }
}

/** The issues a filing linked, besides itself: their histories changed too. */
export async function linkedIssues(
    issues: {
        blockedBy(issueId: string): Promise<IssueLinkRef[]>;
        blocks(issueId: string): Promise<IssueLinkRef[]>;
        related(issueId: string): Promise<IssueLinkRef[]>;
    },
    issueId: string,
) {
    return [
        ...(await issues.blockedBy(issueId)),
        ...(await issues.blocks(issueId)),
        ...(await issues.related(issueId)),
    ];
}
