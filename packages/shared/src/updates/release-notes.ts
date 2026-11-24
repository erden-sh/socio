import { releasePath, type Release, type ReleaseHighlight } from './releases.js';

/**
 * docs/RELEASE-NOTES.md as data (CB-165, CB-168), for the app's build
 * (scripts/release-data.mjs) and for cutting a release
 * (scripts/release.mjs). The file's format:
 *
 *     ## Unreleased
 *     ### Summary     (optional until the release: what its heading gets)
 *     ### Breaking    (a major release; a minor one before 1.0)
 *     ### New         (a minor release)
 *     ### Changed, ### Fixed, ### Upgrading  (a patch release)
 *
 *     ## v0.5.0 (2026-10-21)
 *     One or two plain sentences.
 *
 *     - A highlight (CB-146)
 *
 *     ### New
 *     …
 *
 * Releases are newest first. Text before the first `## ` heading, and HTML
 * comments, are for people editing the file and are left out.
 */

export class ReleaseNotesError extends Error {}

export type ReleaseKind = 'major' | 'minor' | 'patch';

export interface ReleaseNotes {
    /** The `## Unreleased` section's text (without its heading); null when there is none. */
    unreleased: string | null;
    /** Newest first, as in the file. */
    releases: Release[];
}

const RELEASE_HEADING = /^## v(\d+\.\d+\.\d+) \((\d{4}-\d{2}-\d{2})\)$/;
const UNRELEASED = '## Unreleased';
const ISSUE_KEY = /\s*\((CB-\d+)\)$/;
/** The `### ` sections whose bullets decide the bump, highest first. */
const BUMPS: [section: string, kind: ReleaseKind][] = [
    ['Breaking', 'major'],
    ['New', 'minor'],
    ['Changed', 'patch'],
    ['Fixed', 'patch'],
    ['Upgrading', 'patch'],
];
export const MAX_HIGHLIGHTS = 5;

const stripComments = (text: string) => text.replace(/<!--[\s\S]*?-->/g, '');

/** The `## ` sections of the file: each heading with the text under it. */
function topSections(markdown: string) {
    const sections: { heading: string; body: string[] }[] = [];
    for (const line of stripComments(markdown).split('\n')) {
        if (line.startsWith('## ')) {
            sections.push({ heading: line.trimEnd(), body: [] });
        } else {
            sections.at(-1)?.body.push(line);
        }
    }
    return sections.map(({ heading, body }) => ({
        heading,
        body: body.join('\n').trim(),
    }));
}

/** A section's text before its first `### ` heading, and the rest. */
function splitIntro(body: string) {
    const at = body.search(/^### /m);
    return at < 0
        ? { intro: body.trim(), notes: '' }
        : { intro: body.slice(0, at).trim(), notes: body.slice(at).trim() };
}

/** The `### ` sections of a release or of Unreleased, by title. */
export function subsections(body: string) {
    const found: { title: string; body: string }[] = [];
    for (const line of splitIntro(body).notes.split('\n')) {
        if (line.startsWith('### ')) {
            found.push({ title: line.slice(4).trim(), body: '' });
        } else if (found.length) {
            found.at(-1)!.body += `${line}\n`;
        }
    }
    return found.map(({ title, body }) => ({ title, body: body.trim() }));
}

/** "Title (CB-146)" as a highlight; a trailing full stop is dropped. */
export function parseHighlight(text: string): ReleaseHighlight {
    const line = text.trim().replace(/\.$/, '');
    const key = line.match(ISSUE_KEY);
    return key ? { title: line.slice(0, key.index).trim(), issue: key[1] } : { title: line };
}

export const formatHighlight = ({ title, issue }: ReleaseHighlight) => (issue ? `${title} (${issue})` : title);

/** A summary paragraph and its highlights list, as a release's heading has them. */
function parseIntro(intro: string) {
    const summary: string[] = [];
    const items: string[] = [];
    for (const line of intro.split('\n')) {
        const item = line.match(/^[-*] (.+)$/);
        if (item) {
            items.push(item[1]!);
        } else if (line.trim() && !items.length) {
            summary.push(line.trim());
        }
        // A highlight wrapped onto the next line.
        else if (line.trim() && /^\s+\S/.test(line) && items.length) {
            items[items.length - 1] += ` ${line.trim()}`;
        }
    }
    return { summary: summary.join(' '), highlights: items.map(parseHighlight) };
}

/** Reads the file. Throws ReleaseNotesError on a `## ` heading it doesn't know. */
export function parseReleaseNotes(markdown: string): ReleaseNotes {
    let unreleased: string | null = null;
    const releases: Release[] = [];
    for (const { heading, body } of topSections(markdown)) {
        if (heading === UNRELEASED) {
            unreleased = body;
            continue;
        }
        const match = heading.match(RELEASE_HEADING);
        if (!match) {
            throw new ReleaseNotesError(
                `"${heading}" is not a release heading: use "## v0.1.2 (YYYY-MM-DD)" or "${UNRELEASED}".`,
            );
        }
        const [, version, date] = match as unknown as [string, string, string];
        const { intro, notes } = splitIntro(body);
        const tag = `v${version}`;
        releases.push({
            version,
            tag,
            date,
            ...parseIntro(intro),
            url: releasePath(tag),
            notesMarkdown: notes,
        });
    }
    return { unreleased, releases };
}

/** Problems a release would show on its card or page; empty when there are none. */
export function checkReleases(releases: readonly Release[]) {
    const problems: string[] = [];
    releases.forEach((release, index) => {
        const name = release.tag;
        if (!release.summary) {
            problems.push(`${name} has no summary.`);
        }
        if (!release.highlights.length || release.highlights.length > MAX_HIGHLIGHTS) {
            problems.push(`${name} has ${release.highlights.length} highlights (1 to ${MAX_HIGHLIGHTS}).`);
        }
        if (!release.notesMarkdown) {
            problems.push(`${name} has no notes.`);
        }
        const older = releases[index + 1];
        if (older && compareVersions(release.version, older.version) <= 0) {
            problems.push(`${name} comes before ${older.tag}: newest first.`);
        }
        if (older && release.date < older.date) {
            problems.push(`${name} is dated before ${older.tag}.`);
        }
    });
    return problems;
}

export function compareVersions(a: string, b: string) {
    const left = a.split('.').map(Number);
    const right = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if (left[i] !== right[i]) {
            return (left[i] ?? 0) - (right[i] ?? 0);
        }
    }
    return 0;
}

export function bumpVersion(version: string, kind: ReleaseKind) {
    const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!match) {
        throw new ReleaseNotesError(`"${version}" is not a version.`);
    }
    const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
    return kind === 'major'
        ? `${major + 1}.0.0`
        : kind === 'minor'
          ? `${major}.${minor + 1}.0`
          : `${major}.${minor}.${patch + 1}`;
}

const hasBullets = (body: string) => /^[-*] /m.test(body);

const preRelease = (version: string) => version.startsWith('0.');

/**
 * The bump Unreleased calls for: Breaking makes a major release, New a
 * minor one, and only Changed, Fixed or Upgrading a patch. Before 1.0
 * (`current` is 0.x) Breaking makes a minor release too: 1.0 is a product
 * decision, never a bump (planRelease). Null when it has nothing to
 * release.
 */
export function releaseKind(unreleased: string, current?: string): ReleaseKind | null {
    const found = subsections(unreleased).filter((section) => hasBullets(section.body));
    for (const [title, kind] of BUMPS) {
        if (found.some((section) => section.title === title)) {
            return kind === 'major' && current && preRelease(current) ? 'minor' : kind;
        }
    }
    return null;
}

/** Why `releaseKind` gives the bump it does, in a sentence for people and agents. */
export function bumpReason(unreleased: string, current: string, forced?: ReleaseKind) {
    if (forced) {
        return `${forced} as asked (--${forced}), whatever Unreleased holds.`;
    }
    const found = subsections(unreleased)
        .filter((section) => hasBullets(section.body))
        .map((section) => section.title);
    for (const [title, kind] of BUMPS) {
        if (found.includes(title)) {
            return kind === 'major' && preRelease(current)
                ? `Unreleased has Breaking notes, which make a major release, but Socio is before 1.0 (${current}), so it is a minor one. 1.0 is the owner's decision.`
                : `Unreleased has bullets under ${title}: ${kind} release.`;
        }
    }
    return 'Unreleased has no bullets under Breaking, New, Changed, Fixed or Upgrading: nothing to release.';
}

export interface UnreleasedBullet {
    section: string;
    /** The whole bullet, on one line. */
    text: string;
    /** Its bold lead, without the issue key and the full stop. */
    title: string;
    issue?: string;
}

/** The bullets of Unreleased's sections (not Summary), in the order the bump ranks them. */
export function unreleasedBullets(unreleased: string): UnreleasedBullet[] {
    const rank = (title: string) => {
        const at = BUMPS.findIndex(([name]) => name === title);
        return at < 0 ? BUMPS.length : at;
    };
    const found: UnreleasedBullet[] = [];
    const sections = subsections(unreleased)
        .filter((section) => section.title !== 'Summary')
        .sort((a, b) => rank(a.title) - rank(b.title));
    for (const section of sections) {
        const items: string[] = [];
        for (const line of section.body.split('\n')) {
            const item = line.match(/^[-*] (.+)$/);
            if (item) {
                items.push(item[1]!);
            } else if (line.trim() && /^\s+\S/.test(line) && items.length) {
                items[items.length - 1] += ` ${line.trim()}`;
            }
        }
        for (const text of items) {
            const lead = text.match(/^\*\*(.+?)\*\*/)?.[1];
            const first = lead ?? text.split(/(?<=[.!?])\s/)[0]!;
            found.push({ section: section.title, text, ...parseHighlight(first) });
        }
    }
    return found;
}

/** A starting point for the summary and highlights (`--draft-summary`): to rewrite, not to paste as is. */
export function draftSummary(markdown: string) {
    const notes = parseReleaseNotes(markdown);
    if (notes.unreleased === null) {
        throw new ReleaseNotesError(
            `The notes have no "${UNRELEASED}" section: add one at the top of docs/RELEASE-NOTES.md.`,
        );
    }
    const candidates = unreleasedBullets(notes.unreleased);
    return {
        candidates,
        suggested: candidates.slice(0, MAX_HIGHLIGHTS).map(({ title, issue }) => formatHighlight({ title, issue })),
    };
}

const CB_LOOSE = /\bcb[-_ ]?\d+\b|\bCB-(?!\d)/gi;
const quoted = /"[^"\n]*"|“[^”\n]*”|`[^`\n]*`/g;

/** Wrong issue keys in `text`, such as "cb-12" or "CB 12" (the form is CB-12). */
export function badIssueKeys(text: string) {
    return (text.match(CB_LOOSE) ?? []).filter((key) => !/^CB-[1-9]\d*$/.test(key));
}

/**
 * The words "Dot" and "Dots" in `text` (the product is Socio, the agents are
 * socios), except in quotes or code, where the notes may name the old word.
 */
export function dotWording(text: string) {
    return /\bDots?\b/.test(text.replace(quoted, ''));
}

/**
 * What stops Unreleased from becoming a release, one sentence each with the
 * fix; empty when it is ready. `requireSummary: false` checks only that the
 * notes are well formed (for CI on every change). `summary` and `highlights`
 * stand in for the ones `pnpm run release` is given as flags.
 */
export function checkUnreleased(
    markdown: string,
    {
        requireSummary = true,
        summary: givenSummary,
        highlights: givenHighlights = [],
    }: { requireSummary?: boolean; summary?: string; highlights?: string[] } = {},
) {
    const problems: string[] = [];
    let notes: ReleaseNotes;
    try {
        notes = parseReleaseNotes(markdown);
    } catch (error) {
        if (error instanceof ReleaseNotesError) {
            return [error.message];
        }
        throw error;
    }
    if (notes.unreleased === null) {
        return [`The notes have no "${UNRELEASED}" section: add one at the top of docs/RELEASE-NOTES.md.`];
    }
    const { intro } = splitIntro(notes.unreleased);
    if (intro) {
        problems.push(
            `Unreleased has text outside a ### section ("${intro.split('\n')[0]}"): put it in a bullet under ### New, ### Changed or ### Fixed.`,
        );
    }
    const known = ['Summary', ...BUMPS.map(([title]) => title)];
    const seen = new Set<string>();
    const sections = subsections(notes.unreleased);
    for (const section of sections) {
        if (!known.includes(section.title)) {
            problems.push(`"### ${section.title}" is not a section: use ${known.map((t) => `### ${t}`).join(', ')}.`);
        }
        if (seen.has(section.title)) {
            problems.push(`"### ${section.title}" appears twice: merge the two.`);
        }
        seen.add(section.title);
        if (section.title === 'Summary') {
            continue;
        }
        if (!section.body) {
            problems.push(`"### ${section.title}" is empty: add a bullet or delete the heading.`);
        } else {
            if (!hasBullets(section.body)) {
                problems.push(
                    `"### ${section.title}" has no bullets: write each note as "- **Lead (CB-n).** What changed."`,
                );
            }
            const stray = section.body.split('\n').find((line) => line.trim() && !/^([-*] |\s+\S)/.test(line));
            if (stray) {
                problems.push(
                    `"### ${section.title}" has a line that is not a bullet ("${stray.slice(0, 50)}"): start it with "- ".`,
                );
            }
        }
    }
    if (requireSummary && !sections.some((s) => s.title !== 'Summary' && hasBullets(s.body))) {
        problems.push('Unreleased has nothing to release: add a bullet under ### New, ### Changed or ### Fixed.');
    }
    const written = sections.find((section) => section.title === 'Summary');
    const fromBlock = written ? parseIntro(written.body) : undefined;
    const summary = (givenSummary ?? fromBlock?.summary ?? '').trim();
    const highlights = givenHighlights.length ? givenHighlights.map(parseHighlight) : (fromBlock?.highlights ?? []);
    if (requireSummary || written || givenSummary || givenHighlights.length) {
        if (!summary) {
            problems.push(
                'There is no summary: add "### Summary" to Unreleased with one or two plain sentences, or pass --summary "…". `pnpm run release --draft-summary` lists the highlights to start from.',
            );
        }
        if (!highlights.length || highlights.length > MAX_HIGHLIGHTS) {
            problems.push(
                `There are ${highlights.length} highlights (1 to ${MAX_HIGHLIGHTS}, 3 to 5 read best): list them under ### Summary after the paragraph as "- What people notice (CB-n)", or pass --highlight "…" for each.`,
            );
        }
    }
    const text = [notes.unreleased, summary, ...highlights.map(formatHighlight)].join('\n');
    const keys = [...new Set(badIssueKeys(text.replace(quoted, '')))];
    if (keys.length) {
        problems.push(
            `Not valid issue keys: ${keys.map((k) => `"${k}"`).join(', ')}. Write them as CB-12 (capital letters, a hyphen, no leading zeros).`,
        );
    }
    const dot = text.split('\n').find((line) => dotWording(line));
    if (dot) {
        problems.push(
            `Unreleased uses the old word for socios ("${dot.trim().slice(0, 60)}…"): the product is Socio and its agents are socios. Quote the old word if you must name it.`,
        );
    }
    problems.push(...checkReleases(notes.releases));
    return problems;
}

export interface ReleasePlan {
    version: string;
    tag: string;
    kind: ReleaseKind;
    /** Whether the kind came from a flag instead of Unreleased. */
    forced: boolean;
    release: Release;
    /** The new file: an empty Unreleased, then the release. */
    markdown: string;
}

/**
 * Moves Unreleased into a new `## vX.Y.Z (date)` section (scripts/release.mjs).
 * The summary and highlights come from the arguments, else from
 * Unreleased's `### Summary`; a release needs both.
 */
export function planRelease(
    markdown: string,
    {
        current,
        date,
        kind: forcedKind,
        summary: givenSummary,
        highlights: givenHighlights = [],
        firstMajor = false,
    }: {
        /** package.json's version: the newest release. */
        current: string;
        date: string;
        kind?: ReleaseKind;
        summary?: string;
        highlights?: string[];
        /** Confirms a forced major from 0.x: going to 1.0.0 (`--yes`). */
        firstMajor?: boolean;
    },
): ReleasePlan {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new ReleaseNotesError(`"${date}" is not a date (YYYY-MM-DD).`);
    }
    const notes = parseReleaseNotes(markdown);
    if (notes.unreleased === null) {
        throw new ReleaseNotesError(`The notes have no "${UNRELEASED}" section.`);
    }
    const latest = notes.releases[0];
    if (latest && latest.version !== current) {
        throw new ReleaseNotesError(
            `package.json says ${current} but the newest release in the notes is ${latest.tag}: make them agree (is a release missing from docs/RELEASE-NOTES.md, or was package.json edited by hand?).`,
        );
    }
    const { intro } = splitIntro(notes.unreleased);
    if (intro) {
        throw new ReleaseNotesError(`Unreleased has text outside a ### section: "${intro.split('\n')[0]}".`);
    }
    const sections = subsections(notes.unreleased);
    const written = sections.find((section) => section.title === 'Summary');
    const kept = sections.filter((section) => section.title !== 'Summary' && section.body);
    const derived = releaseKind(notes.unreleased, current);
    if (forcedKind === 'major' && preRelease(current) && !firstMajor) {
        throw new ReleaseNotesError(
            `--major would make ${bumpVersion(current, 'major')}: going to 1.0 is a product decision, not a bump. Only with the owner's go, add --yes.`,
        );
    }
    if (!derived && !forcedKind) {
        throw new ReleaseNotesError(
            'Unreleased has nothing to release: add a bullet under ### New, ### Changed or ### Fixed in docs/RELEASE-NOTES.md first.',
        );
    }
    if (!kept.length) {
        throw new ReleaseNotesError('Unreleased has no notes to release.');
    }
    const kind = forcedKind ?? derived!;
    const fromBlock = written ? parseIntro(written.body) : undefined;
    const summary = (givenSummary ?? fromBlock?.summary ?? '').trim();
    const highlights = givenHighlights.length ? givenHighlights.map(parseHighlight) : (fromBlock?.highlights ?? []);
    if (!summary) {
        throw new ReleaseNotesError(
            'A release needs a summary: add "### Summary" to Unreleased in docs/RELEASE-NOTES.md (a paragraph, then the highlights as a list), or pass --summary "…". `pnpm run release --draft-summary` lists the highlights to start from.',
        );
    }
    if (!highlights.length || highlights.length > MAX_HIGHLIGHTS) {
        throw new ReleaseNotesError(
            `A release needs 1 to ${MAX_HIGHLIGHTS} highlights (3 to 5 read best): --highlight "… (CB-n)", repeated, or a list under ### Summary.`,
        );
    }
    const bad = [summary, ...highlights.map(formatHighlight)].filter(
        (text) => dotWording(text) || badIssueKeys(text).length,
    );
    if (bad.length) {
        throw new ReleaseNotesError(
            `The summary or a highlight uses the old word for socios or a wrong issue key ("${bad[0]!.slice(0, 60)}"): say socio, and write keys as CB-12.`,
        );
    }
    const version = bumpVersion(current, kind);
    const tag = `v${version}`;
    if (notes.releases.some((release) => release.version === version)) {
        throw new ReleaseNotesError(`${tag} is already in the notes.`);
    }
    const notesMarkdown = kept.map((section) => `### ${section.title}\n\n${section.body}`).join('\n\n');
    const section = [
        `## ${tag} (${date})`,
        summary,
        highlights.map((item) => `- ${formatHighlight(item)}`).join('\n'),
        notesMarkdown,
    ].join('\n\n');
    // Everything outside Unreleased stays byte for byte: only its body moves.
    const lines = markdown.split('\n');
    const start = lines.findIndex((line) => line.trimEnd() === UNRELEASED);
    const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
    const before = lines.slice(0, start + 1).join('\n');
    const after = next < 0 ? '' : lines.slice(next).join('\n');
    const result = `${before}\n\n${section}\n${after ? `\n${after}` : ''}`;
    const release = parseReleaseNotes(result).releases[0]!;
    return {
        version,
        tag,
        kind,
        forced: !!forcedKind,
        release,
        markdown: result.endsWith('\n') ? result : `${result}\n`,
    };
}
