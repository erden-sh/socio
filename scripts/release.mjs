#!/usr/bin/env node
// Cuts a release (CB-165): moves docs/RELEASE-NOTES.md's Unreleased into a
// new `## vX.Y.Z (date)` section, leaves Unreleased empty, sets the version
// in package.json (pnpm-lock.yaml holds none, CB-183), commits "Release
// vX.Y.Z" and makes the annotated tag vX.Y.Z. It never pushes.
//
//   pnpm release:check [--json] [--notes-only]
//   pnpm release --draft-summary [--json]
//   pnpm release [--json] [--summary "One or two plain sentences."]
//     [--highlight "What people notice (CB-n)" ...] [--major|--minor|--patch]
//     [--yes] [--date YYYY-MM-DD] [--dry-run]
//
// - Run it on main with a clean tree (untracked files don't count).
// - The version is package.json's, bumped by what Unreleased holds:
//   Breaking makes a major release, New a minor one, and only Changed,
//   Fixed or Upgrading a patch. --major, --minor or --patch decides instead.
// - Before 1.0 (Socio is 0.x), Breaking makes a minor release: the script
//   never goes to 1.0.0 by itself. Only --major does, and only with --yes,
//   because 1.0 is a product decision.
// - The summary and highlights (1 to 5; 3 to 5 read best on a card) come
//   from --summary and --highlight, or from a `### Summary` in Unreleased:
//   a paragraph, then a list of highlights, as a release has them.
// - The date is today's, in this computer's time zone, unless --date.
// - Before committing, it runs tests/release-notes.test.ts on the new files
//   and undoes the release if that fails.
// - Then it builds the server and records the release's migrations in
//   src/server/modules/released-migrations.json (scripts/released-migrations.mjs),
//   which goes in the release commit.
// - --dry-run prints the new release and changes nothing.
// - For agents (docs/RELEASING.md): --json prints one JSON object instead of
//   text, for --dry-run and for a real run, and for errors too ({ ok: false,
//   error, missing }); the exit code is 1 when not ok. release:check
//   validates Unreleased (summary, highlights, issue keys, "Dot" wording,
//   sections) without changing anything; --notes-only skips the summary and
//   highlights, for CI on every change. --draft-summary prints the Unreleased
//   bullets and a highlights list to rewrite.
// - With --json, run `pnpm -s release ... --json` (or `node --import tsx
//   scripts/release.mjs ... --json`): without -s pnpm prints its own banner
//   on stdout first, and the output is no longer JSON.
// - pnpm passes a `--` after the script's name on to it (npm didn't); the
//   script skips it, so `pnpm release -- --dry-run` works too.
// Then push the commit and the tag yourself (docs/RELEASING.md).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    bumpReason,
    checkUnreleased,
    draftSummary,
    parseReleaseNotes,
    planRelease,
    ReleaseNotesError,
    subsections,
    unreleasedBullets,
} from '@socio/shared/updates/release-notes';

const NOTES = 'docs/RELEASE-NOTES.md';
const MIGRATIONS_SCRIPT = 'scripts/released-migrations.mjs';
const MIGRATIONS_LOCK = 'src/server/modules/released-migrations.json';

function parseFlags(argv) {
    const flags = { highlights: [], dryRun: false, json: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const value = () => {
            const next = argv[++i];
            if (next === undefined || next.startsWith('--')) {
                throw new ReleaseNotesError(`${arg} needs a value: ${arg} "…".`);
            }
            return next;
        };
        if (arg === '--') {
            continue;
        } else if (arg === '--dry-run') {
            flags.dryRun = true;
        } else if (arg === '--yes') {
            flags.yes = true;
        } else if (arg === '--json') {
            flags.json = true;
        } else if (arg === '--check') {
            flags.check = true;
        } else if (arg === '--notes-only') {
            flags.notesOnly = true;
        } else if (arg === '--draft-summary') {
            flags.draft = true;
        } else if (['--major', '--minor', '--patch'].includes(arg)) {
            if (flags.kind) {
                throw new ReleaseNotesError(`Give one of --major, --minor or --patch.`);
            }
            flags.kind = arg.slice(2);
        } else if (arg === '--summary') {
            flags.summary = value();
        } else if (arg === '--highlight') {
            flags.highlights.push(value());
        } else if (arg === '--date') {
            flags.date = value();
        } else {
            throw new ReleaseNotesError(
                `Unknown option: ${arg}. Options: --summary, --highlight, --major, --minor, --patch, --yes, --date, --dry-run, --json, --check, --notes-only, --draft-summary.`,
            );
        }
    }
    return flags;
}

const today = () => {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

/** The release, from the repository at `cwd`; returns what it did. */
export function release(argv, { cwd = process.cwd(), log = console.log } = {}) {
    // Flag errors count too: an agent asking for --json gets JSON for them.
    const json = argv.includes('--json');
    let flags = { highlights: [], dryRun: false, json };
    try {
        flags = parseFlags(argv);
        return run(flags, { cwd, log });
    } catch (error) {
        if (!json) {
            throw error;
        }
        // An agent reads one JSON object, also when it can't go on.
        let missing = [];
        try {
            const root = repoRoot(cwd);
            missing = checkUnreleased(readFileSync(join(root, NOTES), 'utf8'), {
                summary: flags.summary,
                highlights: flags.highlights,
            });
        } catch {
            // The notes themselves can't be read: the error says so.
        }
        // Git errors and the like are not ReleaseNotesErrors; the message is
        // still the one thing to read.
        const failure = {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            missing,
        };
        log(JSON.stringify(failure, null, 2));
        return failure;
    }
}

function repoRoot(cwd) {
    try {
        return execFileSync('git', ['rev-parse', '--show-toplevel'], {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
        })
            .toString()
            .trim();
    } catch {
        return cwd;
    }
}

function run(flags, { cwd, log }) {
    const git = (...args) =>
        execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
            .toString()
            .trim();
    const root = repoRoot(cwd);
    const read = (file) => readFileSync(join(root, file), 'utf8');
    if (flags.check) {
        const problems = checkUnreleased(read(NOTES), {
            requireSummary: !flags.notesOnly,
            summary: flags.summary,
            highlights: flags.highlights,
        });
        if (flags.json) {
            log(JSON.stringify({ ok: !problems.length, problems }, null, 2));
        } else if (problems.length) {
            log(`Unreleased is not ready (${problems.length}):`);
            for (const problem of problems) {
                log(`- ${problem}`);
            }
        } else {
            log('Unreleased is ready to release.');
        }
        return { ok: !problems.length, problems };
    }
    if (flags.draft) {
        const draft = draftSummary(read(NOTES));
        if (flags.json) {
            log(JSON.stringify({ ok: true, ...draft }, null, 2));
        } else {
            log('Unreleased notes, most important first:');
            for (const c of draft.candidates) {
                log(`- [${c.section}] ${c.title}${c.issue ? ` (${c.issue})` : ''}`);
            }
            log(
                '\nA starting point. Rewrite it in plain words for people (3 to 5 highlights), then put it in docs/RELEASE-NOTES.md under Unreleased:\n\n### Summary\n\nOne or two plain sentences about the release.\n',
            );
            for (const item of draft.suggested) {
                log(`- ${item}`);
            }
        }
        return { ok: true, ...draft };
    }
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
    if (branch !== 'main') {
        throw new ReleaseNotesError(
            `Releases are cut on main, not ${branch}. Merge your work to main, then: git switch main`,
        );
    }
    const dirty = git('status', '--porcelain', '--untracked-files=no');
    if (dirty) {
        throw new ReleaseNotesError(
            `The tree has uncommitted changes. Commit them (git commit) or put them aside (git stash), then run this again:\n${dirty}`,
        );
    }
    const pkg = JSON.parse(read('package.json'));
    const plan = planRelease(read(NOTES), {
        current: pkg.version,
        date: flags.date ?? today(),
        kind: flags.kind,
        summary: flags.summary,
        highlights: flags.highlights,
        firstMajor: flags.yes,
    });
    const existing = git('tag', '--list', plan.tag);
    if (existing) {
        throw new ReleaseNotesError(
            `The tag ${plan.tag} exists already: a release was cut for this version. Check git log, or delete the stray tag with git tag -d ${plan.tag} if it was never pushed.`,
        );
    }
    const { release: cut } = plan;
    const unreleased = parseReleaseNotes(read(NOTES)).unreleased ?? '';
    const report = {
        ok: true,
        current: pkg.version,
        version: plan.version,
        tag: plan.tag,
        kind: plan.kind,
        forced: plan.forced,
        reason: bumpReason(unreleased, pkg.version, flags.kind),
        date: cut.date,
        summary: cut.summary,
        highlights: cut.highlights,
        sections: subsections(unreleased)
            .filter((s) => s.title !== 'Summary' && s.body)
            .map((s) => ({
                title: s.title,
                bullets: unreleasedBullets(`### ${s.title}\n${s.body}`).length,
            })),
        missing: [],
        pushCommand: `git push origin main ${plan.tag}`,
    };
    if (!flags.json) {
        log(
            `${pkg.version} → ${plan.version} (${plan.kind}${plan.forced ? ', as asked' : ', from Unreleased'}), ${cut.date}`,
        );
        log(`${report.reason}\n\n${cut.summary}\n`);
        for (const item of cut.highlights) {
            log(`- ${item.title}${item.issue ? ` (${item.issue})` : ''}`);
        }
    }
    if (flags.dryRun) {
        if (flags.json) {
            log(JSON.stringify({ ...report, dryRun: true, committed: false }, null, 2));
        } else {
            log(`\nDry run: nothing changed. Without --dry-run this commits and tags ${plan.tag}.`);
        }
        return { ...plan, ...report, dryRun: true };
    }
    writeFileSync(join(root, NOTES), plan.markdown);
    // The file's own indentation (oxfmt formats JSON with 4 spaces) and a
    // final newline, so the release commit passes `pnpm run check-format`.
    // Only package.json holds the version: pnpm-lock.yaml has none to bump.
    const indent = /^\{\r?\n([ \t]+)"/.exec(read('package.json'))?.[1] ?? '    ';
    writeFileSync(join(root, 'package.json'), `${JSON.stringify({ ...pkg, version: plan.version }, null, indent)}\n`);
    // The notes test reads the files just written: a release that breaks it
    // would break main, so it is undone here, before the commit.
    if (existsSync(join(root, 'tests/release-notes.test.ts'))) {
        try {
            execFileSync('pnpm', ['exec', 'vitest', 'run', 'tests/release-notes.test.ts', '--silent'], {
                cwd: root,
                env: { ...process.env, DO_NOT_TRACK: '1' },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (error) {
            git('checkout', '--', NOTES, 'package.json');
            if (error.code === 'ENOENT') {
                throw new ReleaseNotesError(
                    `pnpm is not on PATH, so tests/release-notes.test.ts could not run; nothing was committed and the files are back as they were. Install it (corepack enable pnpm), then run this again.`,
                );
            }
            const out = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
            throw new ReleaseNotesError(
                `tests/release-notes.test.ts fails with ${plan.tag}, so nothing was committed and the files are back as they were. Fix the test or the notes, then run this again:\n${out}`,
            );
        }
    }
    // The release's migrations are recorded as built (scripts/released-migrations.mjs):
    // from here on, the build fails when one of them changes.
    const added = [NOTES, 'package.json'];
    if (existsSync(join(root, MIGRATIONS_SCRIPT))) {
        try {
            for (const args of [
                ['run', '-s', 'build:packages'],
                ['run', '-s', 'build:server'],
            ]) {
                execFileSync('pnpm', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
            }
            execFileSync('node', [MIGRATIONS_SCRIPT, '--record'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
            git('checkout', '--', NOTES, 'package.json', MIGRATIONS_LOCK);
            const out = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim() || String(error.message);
            throw new ReleaseNotesError(
                `Recording the released migrations failed, so nothing was committed and the files are back as they were:\n${out}`,
            );
        }
        added.push(MIGRATIONS_LOCK);
    }
    git('add', ...added);
    git('commit', '-q', '-m', `Release ${plan.tag}`, '-m', cut.summary);
    const message = [
        `Socio ${plan.tag} (${cut.date})`,
        cut.summary,
        cut.highlights.map((item) => `- ${item.title}${item.issue ? ` (${item.issue})` : ''}`).join('\n'),
    ].join('\n\n');
    git('tag', '-a', plan.tag, '-m', message);
    const commit = git('rev-parse', '--short', 'HEAD');
    if (flags.json) {
        log(JSON.stringify({ ...report, dryRun: false, committed: true, commit, pushed: false }, null, 2));
    } else {
        log(`\nCommitted "Release ${plan.tag}" and tagged ${plan.tag} (${commit}).`);
        log(`Nothing was pushed. Only with the owner's go: ${report.pushCommand}`);
    }
    return { ...plan, ...report, dryRun: false, commit };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    try {
        const result = release(process.argv.slice(2));
        if (result?.ok === false) {
            process.exit(1);
        }
    } catch (error) {
        if (!(error instanceof ReleaseNotesError)) {
            throw error;
        }
        console.error(`release: ${error.message}`);
        process.exit(1);
    }
}
