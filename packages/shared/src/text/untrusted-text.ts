/**
 * Text a coding agent wrote (its summary, commit messages, file names) or a
 * person typed (an issue's title), made inert before it reaches GitHub
 * (CB-32): no email addresses, no closing keywords that would close an
 * issue on merge, no mentions that would notify someone. Copilot code
 * review and people read it there, so it must not act on anything.
 */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/** Every email address but `keep`'s becomes `[email removed]`. */
export function noEmails(text: string, keep: string[] = []) {
    const kept = new Set(keep.map((email) => email.toLowerCase()));
    return text.replace(EMAIL, (email) => (kept.has(email.toLowerCase()) ? email : '[email removed]'));
}

// GitHub's closing keywords, then a reference: #12, owner/name#12 or an
// issue's address. "Fixes #12" becomes "Fixes issue #12", which closes
// nothing (a squash merge copies the PR body into the commit message).
const CLOSING = /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(\s*:?\s*)(?=(?:[\w.-]+\/[\w.-]+)?#\d|https?:\/\/)/gi;
// GitHub's CI skip directives: in a commit message (or a squash merge's,
// which copies the PR text) they stop workflows for that commit, so an
// agent could switch CI off for its own pull request. "[skip ci]" becomes
// "(skip ci)" and "skip-checks: true" becomes "skip-checks (ignored) true".
const SKIP_CI = /\[\s*(skip[\s_-]*ci|ci[\s_-]*skip|no[\s_-]*ci|skip[\s_-]*actions|actions[\s_-]*skip)\s*\]/gi;
const SKIP_CHECKS = /\b(skip-checks)\s*:\s*(true)\b/gi;
// @user and @org/team, not inside a word (emails are gone by then).
const MENTION = /(^|[^\w`@/])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[\w.-]+)?)/g;

/**
 * Emails removed (but `keep`'s), closing keywords and CI skip directives
 * broken, and mentions put in code spans, where they notify nobody.
 */
export function inert(text: string, keep: string[] = []) {
    return noEmails(text, keep)
        .replace(CLOSING, (_, keyword: string, gap: string) => `${keyword}${gap || ' '}issue `)
        .replace(SKIP_CI, '($1)')
        .replace(SKIP_CHECKS, '$1 (ignored) $2')
        .replace(MENTION, '$1`@$2`');
}

/**
 * `text` as a fenced code block that it can't close early: the fence is
 * longer than any run of backticks in it. Markdown, images, HTML and
 * mentions inside show as plain text.
 */
export function fenced(text: string, info = 'text') {
    const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return `${fence}${info}\n${text}\n${fence}`;
}
