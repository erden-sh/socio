import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it } from 'vitest';

// @ts-expect-error: a plain script, without types.
import { release } from '../scripts/release.mjs';

// CB-165: `pnpm release` on a repository of its own: it checks the
// branch and the tree, commits "Release vX.Y.Z" and tags it, and pushes
// nothing (the repository has no remote).

type Plan = { version: string; tag: string; kind: string; dryRun: boolean };
const cut = release as (argv: string[], options: { cwd: string; log: (line: string) => void }) => Plan;

const NOTES = `# Release notes

## Unreleased

### Fixed

- **A fix (CB-201).** It works now.

## v0.1.0 (2026-10-07)

The first release.

- Everyone signs in

### New

- **Accounts.** Text.
`;

// pnpm's lockfile holds no version of the project's own (CB-183).
const LOCK = `lockfileVersion: '9.0'

importers:

  .: {}
`;

let dir: string;
const saved = { ...process.env };
const git = (...args: string[]) => execFileSync('git', args, { cwd: dir }).toString().trim();
const lines: string[] = [];
const run = (...argv: string[]) => cut(argv, { cwd: dir, log: (line) => lines.push(line) });

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'socio-release-'));
    // No one's own git settings (signing, hooks) and a made-up identity.
    Object.assign(process.env, {
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Release Test',
        GIT_AUTHOR_EMAIL: 'release-test@example.invalid',
        GIT_COMMITTER_NAME: 'Release Test',
        GIT_COMMITTER_EMAIL: 'release-test@example.invalid',
    });
    git('init', '-q', '-b', 'main');
    execFileSync('mkdir', ['-p', join(dir, 'docs')]);
    writeFileSync(join(dir, 'docs/RELEASE-NOTES.md'), NOTES);
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'socio', version: '0.1.0' }, null, 4)}\n`);
    writeFileSync(join(dir, 'pnpm-lock.yaml'), LOCK);
    git('add', '.');
    git('commit', '-q', '-m', 'Start');
    lines.length = 0;
});
afterEach(() => {
    process.env = { ...saved };
    rmSync(dir, { recursive: true, force: true });
});

const args = ['--summary', 'A plain summary.', '--highlight', 'A fix (CB-201)'];

it('cuts a patch release from Unreleased, commits and tags it', () => {
    const plan = run(...args, '--date', '2026-10-23');
    expect(plan).toMatchObject({
        version: '0.1.1',
        tag: 'v0.1.1',
        dryRun: false,
    });
    expect(git('log', '-1', '--format=%s')).toBe('Release v0.1.1');
    expect(git('status', '--porcelain')).toBe('');
    // An annotated tag on that commit, with the summary and highlights.
    expect(git('cat-file', '-t', 'v0.1.1')).toBe('tag');
    expect(git('rev-parse', 'v0.1.1^{commit}')).toBe(git('rev-parse', 'HEAD'));
    expect(git('tag', '-l', '--format=%(contents)', 'v0.1.1')).toBe(
        'Socio v0.1.1 (2026-10-23)\n\nA plain summary.\n\n- A fix (CB-201)',
    );
    const notes = readFileSync(join(dir, 'docs/RELEASE-NOTES.md'), 'utf8');
    expect(notes).toContain(
        '## Unreleased\n\n## v0.1.1 (2026-10-23)\n\nA plain summary.\n\n- A fix (CB-201)\n\n### Fixed\n',
    );
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(
        `${JSON.stringify({ name: 'socio', version: '0.1.1' }, null, 4)}\n`,
    );
    // Only package.json and the notes: the lockfile has nothing to bump.
    expect(readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')).toBe(LOCK);
    expect(git('show', '--format=', '--name-only', 'HEAD').split('\n')).toEqual([
        'docs/RELEASE-NOTES.md',
        'package.json',
    ]);
    expect(git('remote')).toBe('');
    expect(lines.join('\n')).toMatch(/Nothing was pushed/);
});

it('says pnpm is missing, and undoes the release, when it can’t run the notes test', () => {
    // The notes test exists, and PATH has git but no pnpm.
    execFileSync('mkdir', ['-p', join(dir, 'tests'), join(dir, 'bin')]);
    writeFileSync(join(dir, 'tests/release-notes.test.ts'), '');
    writeFileSync(join(dir, '.gitignore'), 'bin\n');
    git('add', '.');
    git('commit', '-q', '-m', 'Notes test');
    const head = git('rev-parse', 'HEAD');
    const gitPath = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
    symlinkSync(gitPath, join(dir, 'bin', 'git'));
    process.env.PATH = join(dir, 'bin');
    expect(() => run(...args)).toThrow(
        /^pnpm is not on PATH, so tests\/release-notes\.test\.ts could not run; nothing was committed/,
    );
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(git('status', '--porcelain')).toBe('');
    expect(git('tag')).toBe('');
});

it('changes nothing on a dry run', () => {
    const head = git('rev-parse', 'HEAD');
    expect(run(...args, '--minor', '--dry-run')).toMatchObject({
        version: '0.2.0',
        dryRun: true,
    });
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(git('status', '--porcelain')).toBe('');
    expect(git('tag')).toBe('');
});

it('refuses another branch, a changed tree and a missing summary', () => {
    writeFileSync(join(dir, 'package.json'), '{"version": "0.1.0"}\n');
    expect(() => run(...args)).toThrow(/uncommitted changes. Commit them/);
    git('checkout', '-q', '--', 'package.json');
    // Untracked files don't count.
    writeFileSync(join(dir, 'scratch.txt'), 'x');
    expect(() => run('--highlight', 'A fix (CB-201)')).toThrow(/needs a summary/);
    git('checkout', '-q', '-b', 'topic');
    expect(() => run(...args)).toThrow(/cut on main, not topic/);
    git('checkout', '-q', 'main');
    expect(() => run(...args, '--sideways')).toThrow(/Unknown option/);
    expect(git('tag')).toBe('');
});

it('stays before 1.0 unless 1.0 is asked for and confirmed', () => {
    // A breaking change before 1.0 is a minor release.
    const notes = join(dir, 'docs/RELEASE-NOTES.md');
    writeFileSync(notes, NOTES.replace('### Fixed', '### Breaking'));
    git('commit', '-q', '-am', 'A breaking change');
    expect(run(...args, '--dry-run')).toMatchObject({
        version: '0.2.0',
        kind: 'minor',
    });
    expect(() => run(...args, '--major')).toThrow(
        /going to 1\.0 is a product decision, not a bump\. Only with the owner's go, add --yes/,
    );
    expect(git('tag')).toBe('');
    expect(run(...args, '--major', '--yes', '--date', '2026-10-23')).toMatchObject({
        version: '1.0.0',
        tag: 'v1.0.0',
    });
    expect(git('log', '-1', '--format=%s')).toBe('Release v1.0.0');
});

// CB-178: for agents acting for a developer.

const out = () =>
    JSON.parse(lines.join('\n')) as Record<
        string,
        any // oxlint-disable-line typescript/no-explicit-any
    >;
const commitNotes = (notes: string) => {
    writeFileSync(join(dir, 'docs/RELEASE-NOTES.md'), notes);
    git('commit', '-q', '-am', 'Notes');
};

it('prints a dry run as JSON: version, why, sections, push command', () => {
    run(...args, '--dry-run', '--json');
    expect(out()).toMatchObject({
        ok: true,
        dryRun: true,
        committed: false,
        version: '0.1.1',
        tag: 'v0.1.1',
        kind: 'patch',
        summary: 'A plain summary.',
        highlights: [{ title: 'A fix', issue: 'CB-201' }],
        sections: [{ title: 'Fixed', bullets: 1 }],
        missing: [],
        pushCommand: 'git push origin main v0.1.1',
    });
    expect(out().reason).toMatch(/bullets under Fixed: patch/);
    expect(git('tag')).toBe('');
});

it('prints a real run as JSON, with the commit and nothing pushed', () => {
    run(...args, '--json', '--date', '2026-10-23');
    expect(out()).toMatchObject({ ok: true, committed: true, pushed: false });
    expect(out().commit).toBe(git('rev-parse', '--short', 'HEAD'));
});

it('says what is missing as JSON instead of throwing', () => {
    const result = run('--dry-run', '--json');
    expect(result).toMatchObject({ ok: false });
    const report = out();
    expect(report.error).toMatch(/needs a summary/);
    expect(report.missing.join('\n')).toMatch(/no summary/);
    expect(report.missing.join('\n')).toMatch(/0 highlights/);
    // Text mode still throws.
    expect(() => run('--dry-run')).toThrow(/needs a summary/);
});

it('reports the pre-1.0 bump reason', () => {
    commitNotes(NOTES.replace('### Fixed', '### Breaking'));
    run(...args, '--dry-run', '--json');
    expect(out().reason).toMatch(/before 1\.0/);
    expect(out().kind).toBe('minor');
});

it('release:check passes a ready Unreleased and lists every problem otherwise', () => {
    commitNotes(NOTES.replace('### Fixed', '### Summary\n\nWhat changed.\n\n- A fix (CB-201)\n\n### Fixed'));
    expect(run('--check', '--json')).toMatchObject({ ok: true, problems: [] });
    lines.length = 0;
    commitNotes(
        NOTES.replace(
            '- **A fix (CB-201).** It works now.',
            '- **A Dot fix (cb-7).** It works now.\nstray line\n\n### Mystery\n\n- x',
        ),
    );
    const result = run('--check', '--json') as unknown as {
        ok: boolean;
        problems: string[];
    };
    expect(result.ok).toBe(false);
    const text = result.problems.join('\n');
    expect(text).toMatch(/no summary/);
    expect(text).toMatch(/0 highlights/);
    expect(text).toMatch(/"cb-7"/);
    expect(text).toMatch(/old word for socios/);
    expect(text).toMatch(/"### Mystery" is not a section/);
    expect(text).toMatch(/not a bullet \("stray line"\)/);
    // CI on every change: only the notes' shape.
    lines.length = 0;
    commitNotes(NOTES);
    expect(run('--check', '--notes-only')).toMatchObject({ ok: true });
    expect(run('--check')).toMatchObject({ ok: false });
});

it('allows the old word in quotes', () => {
    commitNotes(NOTES.replace('It works now.', 'It said "Dot" before, and `Dots`.'));
    expect(run('--check', '--notes-only')).toMatchObject({ ok: true });
});

it('refuses a summary that says Dot', () => {
    expect(() => run('--summary', 'A Dot got better.', '--highlight', 'A fix (CB-201)')).toThrow(/old word for socios/);
});

it('drafts the summary from the Unreleased bullets', () => {
    commitNotes(NOTES.replace('### Fixed', '### New\n\n- **A new thing (CB-300).** Details.\n\n### Fixed'));
    run('--draft-summary', '--json');
    expect(out().suggested).toEqual(['A new thing (CB-300)', 'A fix (CB-201)']);
    expect(out().candidates[0]).toMatchObject({
        section: 'New',
        title: 'A new thing',
        issue: 'CB-300',
    });
    lines.length = 0;
    run('--draft-summary');
    expect(lines.join('\n')).toMatch(/### Summary[\s\S]*- A new thing \(CB-300\)/);
});

it("passes the repository's own notes in shape", () => {
    const cwd = join(__dirname, '..');
    const lines2: string[] = [];
    const result = cut(['--check', '--notes-only'], {
        cwd,
        log: (l) => lines2.push(l),
    }) as unknown as { problems: string[] };
    expect(result.problems).toEqual([]);
});

it('answers flag errors with JSON too, in either order', () => {
    for (const argv of [
        ['--json', '--bogus'],
        ['--bogus', '--json'],
        ['--json', '--dry-run', '--summary'],
        ['--json', '--highlight', '--dry-run'],
    ]) {
        lines.length = 0;
        const result = run(...argv) as unknown as { ok: boolean; error: string };
        expect(result.ok).toBe(false);
        const printed = JSON.parse(lines.join('\n'));
        expect(printed).toMatchObject({ ok: false, missing: expect.any(Array) });
        expect(printed.error).toMatch(/Unknown option|needs a value/);
    }
    // Without --json the error is still thrown.
    expect(() => run('--bogus')).toThrow(/Unknown option/);
});

it('answers other failures with JSON under --json, not a stack trace', () => {
    git('remote', 'add', 'origin', '/nonexistent');
    git('checkout', '-q', '--detach');
    lines.length = 0;
    run('--json', ...args);
    expect(JSON.parse(lines.join('\n'))).toMatchObject({ ok: false });
});

it('prints only JSON on stdout from the documented command, and exits 1 when not ok', () => {
    const root = join(__dirname, '..');
    const node = (argv: string[]) =>
        spawnSync(process.execPath, ['--import', 'tsx', 'scripts/release.mjs', ...argv], {
            cwd: root,
            encoding: 'utf8',
        });
    const ok = node(['--check', '--notes-only', '--json']);
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ ok: true });
    const bad = node(['--json', '--bogus']);
    expect(bad.status).toBe(1);
    expect(JSON.parse(bad.stdout)).toMatchObject({ ok: false });
    // pnpm's banner goes to stdout unless -s: the docs say to pass it. pnpm
    // passes a `--` on to the script, which skips it.
    for (const argv of [
        ['-s', 'release:check', '--notes-only', '--json'],
        ['-s', 'release:check', '--', '--notes-only', '--json'],
    ]) {
        const pnpm = spawnSync('pnpm', argv, { cwd: root, encoding: 'utf8' });
        expect(JSON.parse(pnpm.stdout)).toMatchObject({ ok: true });
    }
});
