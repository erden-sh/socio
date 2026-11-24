#!/usr/bin/env node
// Writes dist/server/releases.json for the app (CB-165, CB-168): the
// version from package.json, the commit it is built from, and every
// release in docs/RELEASE-NOTES.md. Run by `pnpm run build`, after tsc (it
// reads the notes with the compiled parser); docs/ isn't in the app's
// image, so the server reads this file instead.
//
//   node scripts/release-data.mjs
//
// The commit is APP_COMMIT (the image build passes it; there is no .git
// in the build), else `git rev-parse --short HEAD`, else unknown. Fails
// when a release has no summary, a wrong number of highlights or is out of
// order, so a broken notes file never ships.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const { parseReleaseNotes, checkReleases } = await import('@socio/shared/updates/release-notes');
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
let commit = process.env.APP_COMMIT?.trim() || null;
if (!commit) {
    try {
        commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
            stdio: ['ignore', 'pipe', 'ignore'],
        })
            .toString()
            .trim();
    } catch {
        commit = null;
    }
}
const { releases } = parseReleaseNotes(readFileSync('docs/RELEASE-NOTES.md', 'utf8'));
const problems = checkReleases(releases);
if (problems.length) {
    console.error(`docs/RELEASE-NOTES.md:\n  ${problems.join('\n  ')}`);
    process.exit(1);
}
writeFileSync('dist/server/releases.json', `${JSON.stringify({ version, commit, releases })}\n`);
console.log(`[release-data] ${version}${commit ? ` (${commit})` : ''}, ${releases.length} releases`);
