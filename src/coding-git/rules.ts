import { hasSocioToken } from '@socio/foundation/actors/redact';

/**
 * What a push may not carry and an extraction may not hold (CB-239). Pure
 * functions, shared by the `coding-git` service (which applies them to
 * hostile packs) and the app (which validates what a socio asks for before
 * any card is made).
 */

export interface GitIdentity {
    name: string;
    email: string;
}

// Characters that render as nothing (zero-width, bidi controls, soft
// hyphen…): `.git` + U+200B + `hub` must count as `.github`.
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;

/**
 * A path as it is compared: Unicode NFKC (so a full-width `.ｇｉｔｈｕｂ` is
 * `.github`), ignorable characters removed and case folded, as a
 * case-insensitive file system or a reviewer would read it.
 */
export function comparablePath(path: string) {
    return path.normalize('NFKC').replace(IGNORABLE, '').toLowerCase();
}

/**
 * `.github/` (workflows, actions, Dependabot, CODEOWNERS) and CODEOWNERS
 * wherever GitHub reads it, compared after `comparablePath`, so the check
 * is case- and lookalike-proof.
 */
export function isProtectedPath(path: string) {
    const comparable = comparablePath(path);
    return /^\.github(\/|$)/.test(comparable) || /(^|\/)codeowners$/.test(comparable);
}

/** `.gitmodules` anywhere: submodules are a non-goal. */
export const isSubmoduleFile = (path: string) => /(^|\/)\.gitmodules$/.test(comparablePath(path));

/** A path with a `.git` segment, which no extraction includes. */
export const hasGitSegment = (path: string) =>
    comparablePath(path)
        .split('/')
        .some((segment) => segment === '.git');

export const GITLINK_MODE = '160000';
export const SYMLINK_MODE = '120000';
export const FILE_MODES = ['100644', '100755'];

/** One commit object, as `git cat-file commit` prints it. */
export interface ParsedCommit {
    parents: string[];
    author?: GitIdentity;
    committer?: GitIdentity;
    /** The `encoding` header, when the commit declares one. */
    encoding?: string;
    message: string;
}

const PERSON = /^(.*) <([^<>]*)> \d+ [+-]\d{4}$/;

export function parseCommit(raw: string): ParsedCommit {
    const end = raw.indexOf('\n\n');
    const head = end < 0 ? raw : raw.slice(0, end);
    const message = end < 0 ? '' : raw.slice(end + 2);
    const parents: string[] = [];
    let author: GitIdentity | undefined;
    let committer: GitIdentity | undefined;
    let encoding: string | undefined;
    for (const line of head.split('\n')) {
        // Continuation lines (a signature's) start with a space.
        if (line.startsWith(' ')) {
            continue;
        }
        const space = line.indexOf(' ');
        const key = line.slice(0, space);
        const value = line.slice(space + 1);
        if (key === 'parent') {
            parents.push(value);
        }
        if (key === 'encoding') {
            encoding = value;
        }
        if (key === 'author' || key === 'committer') {
            const match = PERSON.exec(value);
            const who = match ? { name: match[1], email: match[2] } : undefined;
            if (key === 'author') {
                author = who;
            } else {
                committer = who;
            }
        }
    }
    return {
        parents,
        author,
        committer,
        ...(encoding !== undefined ? { encoding } : {}),
        message,
    };
}

const sameIdentity = (who: GitIdentity | undefined, expected: GitIdentity) =>
    !!who && who.name === expected.name && who.email === expected.email;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const TRAILER = /^\s*(co-authored-by|signed-off-by)\s*:\s*(.*?)\s*$/gim;
// GitHub's closing keywords followed by an issue reference: #12,
// owner/name#12 or an issue's address (untrusted-text.ts's CLOSING).
const CLOSING =
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*(?:(?:[\w.-]+\/[\w.-]+)?#\d+|https?:\/\/\S+\/(?:issues|pull)\/\d+)/i;
// GitHub's CI skip directives (untrusted-text.ts's SKIP_CI, SKIP_CHECKS).
const SKIP_CI = /\[\s*(?:skip[\s_-]*ci|ci[\s_-]*skip|no[\s_-]*ci|skip[\s_-]*actions|actions[\s_-]*skip)\s*\]/i;
const SKIP_CHECKS = /\bskip-checks\s*:\s*true\b/i;

/** Why a push is refused: a closed list, as the audit's reason codes. */
export type PushRefusal =
    | 'protected_path'
    | 'submodule'
    | 'token_shape'
    | 'foreign_identity'
    | 'commit_text'
    | 'not_a_commit'
    | 'too_many_commits'
    | 'pack_invalid'
    | 'pack_too_large';

export interface CommitProblem {
    reason: PushRefusal;
    detail: string;
}

/**
 * Who made a new commit and what its message says: author and committer
 * must be the session's socio identity; its message may have no
 * `Co-authored-by` or `Signed-off-by` naming anyone else, no other email
 * address, no closing keyword with an issue reference and no CI skip
 * directive. These reach GitHub as written.
 */
export function commitProblems(commit: ParsedCommit, identity: GitIdentity): CommitProblem | undefined {
    if (!sameIdentity(commit.author, identity) || !sameIdentity(commit.committer, identity)) {
        return {
            reason: 'foreign_identity',
            detail: `commits must be authored and committed as ${identity.name} <${identity.email}>`,
        };
    }
    // The checks below read the message as UTF-8; one that declares
    // another encoding reaches GitHub reading otherwise.
    if (commit.encoding !== undefined && !/^utf-?8$/i.test(commit.encoding.trim())) {
        return {
            reason: 'commit_text',
            detail: 'commit messages must be UTF-8 (no encoding header)',
        };
    }
    const own = `${identity.name} <${identity.email}>`;
    for (const match of commit.message.matchAll(TRAILER)) {
        if (match[2] !== own) {
            return {
                reason: 'commit_text',
                detail: `a ${match[1]} trailer names someone other than the socio`,
            };
        }
    }
    for (const match of commit.message.matchAll(EMAIL)) {
        if (match[0].toLowerCase() !== identity.email.toLowerCase()) {
            return {
                reason: 'commit_text',
                detail: 'the message holds an email address',
            };
        }
    }
    if (CLOSING.test(commit.message)) {
        return {
            reason: 'commit_text',
            detail: 'the message closes an issue (a closing keyword and a reference)',
        };
    }
    if (SKIP_CI.test(commit.message) || SKIP_CHECKS.test(commit.message)) {
        return {
            reason: 'commit_text',
            detail: 'the message holds a CI skip directive',
        };
    }
    if (hasSocioToken(commit.message)) {
        return {
            reason: 'token_shape',
            detail: 'the message holds something shaped like a Socio token',
        };
    }
    return undefined;
}

/** One changed path of `git diff-tree --raw` (combined for merges). */
export interface RawChange {
    path: string;
    /** The parents' modes, then the result's. */
    modes: string[];
    status: string;
}

/**
 * Parses `git diff-tree -r -z --raw [-c]` output: `:modes… shas… status`
 * NUL path NUL, with one colon per parent.
 */
export function parseRawDiff(output: Buffer): RawChange[] {
    const parts = output.toString('utf8').split('\0');
    const changes: RawChange[] = [];
    for (let at = 0; at + 1 < parts.length; at += 2) {
        const meta = parts[at];
        if (!meta.startsWith(':')) {
            at -= 1;
            continue;
        }
        const colons = /^:+/.exec(meta)![0].length;
        const fields = meta.slice(colons).split(' ');
        changes.push({
            path: parts[at + 1],
            modes: fields.slice(0, colons + 1),
            status: fields.at(-1) ?? '',
        });
    }
    return changes;
}

/** What a changed path does wrong, if anything. */
export function pathProblem(change: RawChange): CommitProblem | undefined {
    if (isProtectedPath(change.path)) {
        return {
            reason: 'protected_path',
            detail: '.github/ and CODEOWNERS are a person’s to change',
        };
    }
    if (isSubmoduleFile(change.path) || change.modes.includes(GITLINK_MODE)) {
        return {
            reason: 'submodule',
            detail: 'submodules (.gitmodules, gitlinks) are not accepted',
        };
    }
    // A file name reaches GitHub as written too; the added-line scan never
    // sees it.
    if (hasSocioToken(change.path)) {
        return {
            reason: 'token_shape',
            detail: 'a file name holds something shaped like a Socio token',
        };
    }
    return undefined;
}

/**
 * Scans `git diff-tree -p` output for added lines shaped like a Socio
 * token (by shape, live or not). `width` is the number of parents
 * (the prefix columns of a combined diff); a line counts as added only
 * when it is new against every parent.
 */
export class AddedLineScanner {
    private inHunk = false;
    private tail = '';
    found = false;
    constructor(private width: number) {}
    push(chunk: string) {
        const text = this.tail + chunk;
        const lines = text.split('\n');
        this.tail = lines.pop() ?? '';
        for (const line of lines) {
            this.line(line);
        }
    }
    end() {
        if (this.tail) {
            this.line(this.tail);
        }
        this.tail = '';
        return this.found;
    }
    private line(line: string) {
        if (line.startsWith('diff ')) {
            this.inHunk = false;
            return;
        }
        if (line.startsWith('@@')) {
            this.inHunk = true;
            return;
        }
        if (!this.inHunk) {
            return;
        }
        const prefix = line.slice(0, this.width);
        if (prefix.length === this.width && /^\++$/.test(prefix)) {
            if (hasSocioToken(line.slice(this.width))) {
                this.found = true;
            }
        }
    }
}

/** Path scope of an extraction (CB-267): 1 to 20 prefixes or globs. */
export const MAX_SCOPE_PATHS = 20;

/**
 * Why a requested extraction path is refused, or undefined when it is
 * fine: relative, no `..`, no backslashes or control characters, no
 * `.git` segment, and only `*`, `**` and `?` as globs.
 */
export function scopePathProblem(path: string) {
    if (!path || path.length > 200) {
        return 'is empty or too long';
    }
    // oxlint-disable-next-line no-control-regex -- refusing control characters
    if (/[\u0000-\u001f\u007f\\]/.test(path)) {
        return 'holds a backslash or a control character';
    }
    if (path.startsWith('/')) {
        return 'is absolute';
    }
    if (/[[\]{}!]/.test(path)) {
        return 'uses a glob form other than *, ** and ?';
    }
    const segments = path.replace(/\/$/, '').split('/');
    if (segments.some((segment) => segment === '' || /^\.+$/.test(segment))) {
        return 'has an empty, . or .. part';
    }
    if (hasGitSegment(path)) {
        return 'names .git';
    }
    return undefined;
}

const escapeRegExp = (text: string) => text.replace(/[.+^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a file path is inside the scope. A plain entry is a prefix
 * (`src/` or `src` match everything under `src/`, and a file named `src`);
 * one with `*`, `**` or `?` is a glob over the whole path. Both sides are
 * compared after NFC normalization; case matters, as in Git.
 */
export function compileScope(paths: readonly string[]) {
    const matchers = paths.map((raw) => {
        const pattern = raw.normalize('NFC');
        if (!/[*?]/.test(pattern)) {
            const dir = pattern.endsWith('/') ? pattern : `${pattern}/`;
            return (path: string) => path === pattern.replace(/\/$/, '') || path.startsWith(dir);
        }
        let source = '';
        for (let at = 0; at < pattern.length; at++) {
            const char = pattern[at];
            if (char === '*' && pattern[at + 1] === '*') {
                at += 1;
                if (pattern[at + 1] === '/') {
                    at += 1;
                    source += '(?:.*/)?';
                } else {
                    source += '.*';
                }
            } else if (char === '*') {
                source += '[^/]*';
            } else if (char === '?') {
                source += '[^/]';
            } else {
                source += escapeRegExp(char);
            }
        }
        const regex = new RegExp(`^${source}$`, 'u');
        return (path: string) => regex.test(path);
    });
    return (path: string) => {
        const normal = path.normalize('NFC');
        return matchers.some((matches) => matches(normal));
    };
}

/**
 * Whether every entry of `asked` lies within `granted` (a standing grant's
 * scope, CB-267): equal, or a plain prefix under a granted plain prefix.
 */
export function scopeWithin(asked: readonly string[], granted: readonly string[]) {
    return asked.every((entry) =>
        granted.some((scope) => {
            if (entry === scope) {
                return true;
            }
            if (/[*?]/.test(scope)) {
                return false;
            }
            const dir = scope.endsWith('/') ? scope : `${scope}/`;
            return entry.startsWith(dir);
        }),
    );
}
