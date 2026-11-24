import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
    bumpVersion,
    checkReleases,
    compareVersions,
    parseHighlight,
    parseReleaseNotes,
    planRelease,
    releaseKind,
    ReleaseNotesError,
} from '@socio/shared/updates/release-notes';

// CB-165: docs/RELEASE-NOTES.md as versioned releases, the bump rule and
// cutting a release (scripts/release.mjs uses planRelease).

const NOTES = `# Release notes

Intro for people editing the file.

<!--
    ## v9.9.9 (2099-01-01)
-->

## Unreleased

### New

- **A new thing (CB-200).** It does things.

### Fixed

- **A fix (CB-201).** It works now.

## v1.1.0 (2026-10-21)

Two plain sentences. About the release.

- First highlight (CB-10)
- Second highlight, wrapped
  onto a second line (CB-11).
- Third, with no issue

### New

- **The first (CB-10).** Text.

### Fixed

- **The second (CB-11).** Text.

## v1.0.0 (2026-10-07)

The first release.

- Everyone signs in

### New

- **Accounts.** Text.
`;

describe('parseReleaseNotes', () => {
    it('reads each release with its summary, highlights and notes, newest first', () => {
        const { unreleased, releases } = parseReleaseNotes(NOTES);
        expect(unreleased).toContain('A new thing (CB-200)');
        expect(releases.map((release) => release.tag)).toEqual(['v1.1.0', 'v1.0.0']);
        const [latest] = releases;
        expect(latest).toMatchObject({
            version: '1.1.0',
            date: '2026-10-21',
            url: '/releases/v1.1.0',
            summary: 'Two plain sentences. About the release.',
            highlights: [
                { title: 'First highlight', issue: 'CB-10' },
                {
                    title: 'Second highlight, wrapped onto a second line',
                    issue: 'CB-11',
                },
                { title: 'Third, with no issue' },
            ],
        });
        expect(latest!.notesMarkdown).toMatch(/^### New\n/);
        expect(latest!.notesMarkdown).toContain('### Fixed');
        expect(latest!.notesMarkdown).not.toContain('Two plain sentences');
        expect(checkReleases(releases)).toEqual([]);
    });

    it('refuses a heading that is not a release', () => {
        expect(() => parseReleaseNotes('## Unreleased\n\n## Release 2 (2026-10)\n')).toThrow(ReleaseNotesError);
    });

    it('finds what a card would miss', () => {
        const { releases } = parseReleaseNotes(
            '## v1.0.0 (2026-10-07)\n\n### New\n\n- a\n\n## v1.1.0 (2026-10-08)\n\nS.\n\n- h\n',
        );
        expect(checkReleases(releases)).toEqual([
            'v1.0.0 has no summary.',
            'v1.0.0 has 0 highlights (1 to 5).',
            'v1.0.0 comes before v1.1.0: newest first.',
            'v1.0.0 is dated before v1.1.0.',
            'v1.1.0 has no notes.',
        ]);
    });

    it('reads a highlight’s issue key', () => {
        expect(parseHighlight('Steer a socio while it works (CB-151).')).toEqual({
            title: 'Steer a socio while it works',
            issue: 'CB-151',
        });
        expect(parseHighlight('Backups and a health check')).toEqual({
            title: 'Backups and a health check',
        });
    });
});

describe('the bump rule', () => {
    const unreleased = (...sections: string[]) =>
        sections.map((title) => `### ${title}\n\n- **A change.** Text.`).join('\n\n');
    it('makes Breaking major, New minor, and only Changed, Fixed or Upgrading a patch', () => {
        expect(releaseKind(unreleased('New', 'Breaking', 'Fixed'))).toBe('major');
        expect(releaseKind(unreleased('Fixed', 'New'))).toBe('minor');
        expect(releaseKind(unreleased('Changed', 'Fixed'))).toBe('patch');
        expect(releaseKind(unreleased('Upgrading'))).toBe('patch');
        expect(releaseKind('### New\n\n### Fixed\n')).toBeNull();
        expect(releaseKind('')).toBeNull();
    });
    it('makes Breaking a minor release before 1.0', () => {
        expect(releaseKind(unreleased('Breaking', 'New'), '0.6.1')).toBe('minor');
        expect(releaseKind(unreleased('Breaking'), '0.6.1')).toBe('minor');
        expect(releaseKind(unreleased('New'), '0.6.1')).toBe('minor');
        expect(releaseKind(unreleased('Fixed', 'Changed'), '0.6.1')).toBe('patch');
        expect(releaseKind(unreleased('Breaking'), '1.0.0')).toBe('major');
    });
    it('bumps a version', () => {
        expect(bumpVersion('1.5.1', 'major')).toBe('2.0.0');
        expect(bumpVersion('1.5.1', 'minor')).toBe('1.6.0');
        expect(bumpVersion('1.5.1', 'patch')).toBe('1.5.2');
    });
});

describe('planRelease', () => {
    const options = {
        current: '1.1.0',
        date: '2026-10-23',
        summary: 'A plain summary.',
        highlights: ['A new thing (CB-200)', 'A fix (CB-201)'],
    };

    it('moves Unreleased into the next version and leaves it empty', () => {
        const plan = planRelease(NOTES, options);
        expect(plan).toMatchObject({
            version: '1.2.0',
            tag: 'v1.2.0',
            kind: 'minor',
        });
        const { unreleased, releases } = parseReleaseNotes(plan.markdown);
        expect(unreleased).toBe('');
        expect(releases.map((release) => release.tag)).toEqual(['v1.2.0', 'v1.1.0', 'v1.0.0']);
        expect(releases[0]).toMatchObject({
            date: '2026-10-23',
            summary: 'A plain summary.',
            highlights: [
                { title: 'A new thing', issue: 'CB-200' },
                { title: 'A fix', issue: 'CB-201' },
            ],
        });
        expect(releases[0]!.notesMarkdown).toBe(
            '### New\n\n- **A new thing (CB-200).** It does things.\n\n### Fixed\n\n- **A fix (CB-201).** It works now.',
        );
        // Everything before Unreleased and every older release stays as it was.
        const at = (text: string, from: string) => text.slice(text.indexOf(from));
        expect(at(plan.markdown, '## v1.1.0')).toBe(at(NOTES, '## v1.1.0'));
        expect(plan.markdown.split('## Unreleased')[0]).toBe(NOTES.split('## Unreleased')[0]);
        expect(plan.markdown).toContain('## Unreleased\n\n## v1.2.0 (2026-10-23)\n');
        expect(checkReleases(releases)).toEqual([]);
    });

    it('follows a flag over Unreleased', () => {
        expect(planRelease(NOTES, { ...options, kind: 'major' })).toMatchObject({
            version: '2.0.0',
            forced: true,
        });
        const fixes = NOTES.replace(/### New\n\n- \*\*A new thing.*\n\n/, '');
        expect(planRelease(fixes, options).version).toBe('1.1.1');
    });

    it('goes to 1.0 only when asked for, with a confirmation', () => {
        const early = NOTES.replace('## v1.1.0 (', '## v0.6.1 (').replace('## v1.0.0 (', '## v0.1.0 (');
        const pre = { ...options, current: '0.6.1' };
        const breaking = early.replace('### New\n', '### Breaking\n');
        expect(planRelease(breaking, pre)).toMatchObject({
            version: '0.7.0',
            kind: 'minor',
        });
        expect(() => planRelease(early, { ...pre, kind: 'major' })).toThrow(
            /--major would make 1\.0\.0: going to 1\.0 is a product decision, not a bump\. Only with the owner's go, add --yes\./,
        );
        expect(planRelease(early, { ...pre, kind: 'major', firstMajor: true })).toMatchObject({
            version: '1.0.0',
            kind: 'major',
            forced: true,
        });
    });

    it('takes the summary and highlights from a ### Summary in Unreleased', () => {
        const written = NOTES.replace(
            '## Unreleased\n',
            '## Unreleased\n\n### Summary\n\nWritten ahead.\n\n- One (CB-200)\n- Two (CB-201)\n- Three\n',
        );
        const plan = planRelease(written, { current: '1.1.0', date: '2026-10-23' });
        expect(plan.release.summary).toBe('Written ahead.');
        expect(plan.release.highlights).toHaveLength(3);
        expect(plan.release.notesMarkdown).not.toContain('Summary');
        // A flag wins over the block.
        expect(planRelease(written, { ...options }).release.summary).toBe('A plain summary.');
    });

    it('refuses a release it can’t make', () => {
        const refused = (markdown: string, extra: Partial<typeof options> = {}) => {
            try {
                planRelease(markdown, { ...options, ...extra });
            } catch (error) {
                expect(error).toBeInstanceOf(ReleaseNotesError);
                return (error as Error).message;
            }
            throw new Error('planned');
        };
        expect(refused(NOTES, { summary: undefined })).toMatch(/needs a summary/);
        expect(refused(NOTES, { highlights: [] })).toMatch(/1 to 5 highlights/);
        expect(refused(NOTES, { highlights: ['a', 'b', 'c', 'd', 'e', 'f'] })).toMatch(/1 to 5 highlights/);
        expect(refused(NOTES, { current: '1.0.0' })).toMatch(
            /package.json says 1.0.0 but the newest release in the notes is v1.1.0/,
        );
        expect(refused(NOTES, { date: '23/10/2026' })).toMatch(/not a date/);
        const empty = NOTES.replace(/## Unreleased[\s\S]*?(?=## v1\.1\.0)/, '## Unreleased\n\n');
        expect(refused(empty)).toMatch(/nothing to release/);
        expect(refused(NOTES.replace('## Unreleased\n', '## Unreleased\n\nStray.\n'))).toMatch(/outside a ### section/);
    });
});

describe('docs/RELEASE-NOTES.md', () => {
    const markdown = readFileSync(new URL('../docs/RELEASE-NOTES.md', import.meta.url), 'utf8');
    const { releases } = parseReleaseNotes(markdown);
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

    // The releases up to v0.6.1 are history: their entries never change. A new
    // release goes in front of them, so this list does not grow.
    const HISTORY = [
        'v0.6.1 2026-10-22',
        'v0.6.0 2026-10-22',
        'v0.5.1 2026-10-21',
        'v0.5.0 2026-10-21',
        'v0.4.0 2026-10-21',
        'v0.3.0 2026-10-21',
        'v0.2.0 2026-10-21',
        'v0.1.0 2026-10-07',
    ];

    it('has a version for each deploy, newest first, ready for cards', () => {
        expect(checkReleases(releases)).toEqual([]);
        const listed = releases.map((release) => `${release.tag} ${release.date}`);
        // The known history is the ordered tail; newer releases sit in front.
        expect(listed.slice(-HISTORY.length)).toEqual(HISTORY);
        expect(releases.at(-1)!.tag).toBe('v0.1.0');
        // Strictly newest first, each a plain 0.x version.
        for (const [index, release] of releases.entries()) {
            expect(release.version, release.tag).toMatch(/^0\.\d+\.\d+$/);
            const older = releases[index + 1];
            if (older) {
                expect(compareVersions(release.version, older.version), release.tag).toBeGreaterThan(0);
            }
        }
        // Before 1.0: nothing says otherwise.
        expect(markdown).not.toMatch(/\bv1\.\d+\.\d+|Release 1\b/);
        // package.json is the newest release.
        expect(releases[0]!.version).toBe(pkg.version);
        for (const release of releases) {
            expect(release.summary.length, release.tag).toBeGreaterThan(0);
            expect(release.summary.length, release.tag).toBeLessThan(400);
            expect(release.highlights.length, release.tag).toBeGreaterThan(0);
            // Each highlight's issue is one the release's notes are about.
            for (const { issue } of release.highlights) {
                if (issue) {
                    expect(release.notesMarkdown, release.tag).toContain(issue);
                }
            }
        }
    });

    it('can cut the next release from it, still before 1.0', () => {
        // A copy with a synthetic Unreleased, so it works whether the live one is
        // empty (right after a release) or not.
        const fixture = markdown.replace(
            /## Unreleased\n[\s\S]*?(?=\n## v\d)/,
            '## Unreleased\n\n### Fixed\n\n- **A fix (CB-1).** It works now.\n',
        );
        expect(parseReleaseNotes(fixture).unreleased).toContain('A fix (CB-1)');
        const plan = planRelease(fixture, {
            current: pkg.version,
            date: '2099-01-01',
            summary: 'Next.',
            highlights: ['Next (CB-1)'],
        });
        expect(plan.kind).toBe('patch');
        expect(plan.version).toBe(bumpVersion(pkg.version, 'patch'));
        expect(plan.version).toMatch(/^0\.\d+\.\d+$/);
        const next = parseReleaseNotes(plan.markdown).releases;
        expect(next[0]!.tag).toBe(plan.tag);
        expect(next.slice(1).map((release) => release.tag)).toEqual(releases.map((release) => release.tag));
        expect(checkReleases(next)).toEqual([]);
    });
});
