import type { IssueComponentLabel } from '@socio/shared/issues/issue-components';
import type { IssueSummary } from '@socio/shared/issues/issue-types';

/** Summaries contain scalar fields and scalar arrays; compare every returned field. */
function sameSummary(left: IssueSummary, right: IssueSummary) {
    if (left === right) {
        return true;
    }
    const keys = Object.keys(left) as Array<keyof IssueSummary>;
    return (
        keys.length === Object.keys(right).length &&
        keys.every((key) => {
            if (!Object.hasOwn(right, key)) {
                return false;
            }
            const before = left[key],
                after = right[key];
            return Array.isArray(before) && Array.isArray(after)
                ? before.length === after.length && before.every((value, i) => value === after[i])
                : before === after;
        })
    );
}

/** A full server snapshot may add, remove or reorder rows without replacing unchanged rows. */
export function shareIssueCollection(current: IssueSummary[] | undefined, incoming: IssueSummary[]): IssueSummary[] {
    if (!current) {
        return incoming;
    }
    const previous = new Map(current.map((issue) => [issue.number, issue]));
    const shared = incoming.map((issue) => {
        const before = previous.get(issue.number);
        return before && sameSummary(before, issue) ? before : issue;
    });
    return shared.length === current.length && shared.every((issue, i) => issue === current[i]) ? current : shared;
}

/** Full lists are authoritative; detail responses merge their partial names before calling this. */
export function shareIssueUsers(
    current: Record<string, string>,
    incoming: Record<string, string>,
): Record<string, string> {
    if (current === incoming) {
        return current;
    }
    const keys = Object.keys(current);
    return keys.length === Object.keys(incoming).length && keys.every((key) => current[key] === incoming[key])
        ? current
        : incoming;
}

/** The same for the component label map (CB-442): unchanged labels keep the current object. */
export function shareIssueLabels(
    current: Readonly<Record<string, IssueComponentLabel>>,
    incoming: Readonly<Record<string, IssueComponentLabel>>,
): Readonly<Record<string, IssueComponentLabel>> {
    if (current === incoming) {
        return current;
    }
    const same = (a: IssueComponentLabel | undefined, b: IssueComponentLabel | undefined) =>
        !!a && !!b && a.label === b.label && a.kind === b.kind && a.state === b.state && a.ownerName === b.ownerName;
    const keys = Object.keys(current);
    return keys.length === Object.keys(incoming).length && keys.every((key) => same(current[key], incoming[key]))
        ? current
        : incoming;
}
