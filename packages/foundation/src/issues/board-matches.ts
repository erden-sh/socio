/**
 * The board list's excerpts and its search box (CB-71). Moved from
 * `issues/board-search.ts`, which re-exports them.
 */
import { issueExcerpt, issueKey, type Issue } from '@socio/shared/issues/issue-types';
import { foldText } from '@socio/shared/pages/page-search';

/**
 * `make` of a text, kept for the last 10,000 texts: the board's list and
 * its search read every description each time, and descriptions rarely
 * change (CB-71). Dropped all at once when full.
 */
function kept(make: (text: string) => string) {
    const made = new Map<string, string>();
    return (text: string) => {
        let value = made.get(text);
        if (value === undefined) {
            if (made.size >= 10_000) {
                made.clear();
            }
            value = make(text);
            made.set(text, value);
        }
        return value;
    };
}

/** A description's excerpt for the board's list (`issueExcerpt`). */
export const boardExcerpt = kept((body) => issueExcerpt(body));
const foldedBody = kept(foldText);

/**
 * The board's search box (CB-71): the numbers of `issues` whose key, title
 * or description has every word of `query` anywhere in a word, folded, in
 * their order. Plainer than the Dots' scored search below, and the same
 * as the board did in the browser while its list carried descriptions.
 * Words have no spaces, so each is looked for in each part on its own.
 */
export function boardMatches(issues: readonly Pick<Issue, 'number' | 'title' | 'body'>[], query: string) {
    const words = foldText(query).split(' ').filter(Boolean);
    if (!words.length) {
        return issues.map((issue) => issue.number);
    }
    return issues
        .filter((issue) => {
            const parts = [foldText(`${issueKey(issue.number)} ${issue.title}`), foldedBody(issue.body)];
            return words.every((word) => parts.some((part) => part.includes(word)));
        })
        .map((issue) => issue.number);
}
